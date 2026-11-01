// オフラインテスト（外部APIは使わずモックで動作確認）
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.DATA_DIR = tmp;
process.env.OFFLINE = '1';
process.env.ACCESS_TOKEN = 'secret';
process.env.PORT = '18787';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(buf) {
  let n = BigInt('0x' + Buffer.from(buf).toString('hex'));
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = '1' + s; else break; }
  return s;
}
const addr = () => b58(crypto.randomBytes(32));

const { extractMints, isSolAddress } = await import('../src/util.js');
const { db, getSettings, saveSettings } = await import('../src/db.js');
const { parseChannelHtml } = await import('../src/sources/telegram.js');
const pp = await import('../src/sources/pumpportal.js');
const live = await import('../src/live.js');
const { evaluateOne } = await import('../src/evaluator.js');
const { applyPrices, performance } = await import('../src/tracker.js');
const { train, predict } = await import('../src/learn.js');
const { encryptPayload, vapidKeys } = await import('../src/push.js');
const { computeFeatures, FEATURE_KEYS, breakevenProb, expectedValue } = await import('../src/score.js');
const { updateWalletStats, importWallets } = await import('../src/wallets.js');
const { analyzeHolders, fundingSource } = await import('../src/sources/cluster.js');

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('✓', name); };

await t('CA抽出', () => {
  const a = addr();
  const txt = `新しいの来た ${a} https://dexscreener.com/solana/${a} So11111111111111111111111111111111111111112 abc`;
  assert.deepEqual(extractMints(txt), [a]);
  assert.equal(isSolAddress('0xabc'), false);
});

await t('Telegram公開ページの解析', () => {
  const a = addr(), b = addr();
  const html = `<div class="tgme_widget_message" data-post="CAVE_JPN/101"><div class="tgme_widget_message_text js-message_text" dir="auto">🔥 注目<br>${a}</div>
   <a class="tgme_widget_message_date" href="#"><time datetime="2026-11-01T09:00:00+00:00">x</time></a></div>
   <div class="tgme_widget_message" data-post="CAVE_JPN/102"><div class="tgme_widget_message_text">チャート <a href="https://pump.fun/coin/${b}">link</a></div><time datetime="2026-11-01T09:05:00+00:00"></time></div>`;
  const posts = parseChannelHtml(html, 'CAVE_JPN');
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0].mints, [a]);
  assert.deepEqual(posts[1].mints, [b]);
  assert.equal(posts[0].ts, Date.parse('2026-11-01T09:00:00+00:00'));
});

// ---- 取引記録（スナイパー・初期勢の含み益） ----
const good = addr(), bad = addr(), dev = addr();
await t('PumpPortalイベント→記録', () => {
  pp.handle({ txType: 'create', mint: good, traderPublicKey: dev, initialBuy: 20_000_000, solAmount: 0.6, marketCapSol: 28, symbol: 'GOOD', name: 'Good', bondingCurveKey: addr() });
  const sniper = addr();
  pp.handle({ txType: 'buy', mint: good, traderPublicKey: sniper, tokenAmount: 30_000_000, solAmount: 1, marketCapSol: 30 });
  for (let i = 0; i < 40; i++) pp.handle({ txType: 'buy', mint: good, traderPublicKey: addr(), tokenAmount: 2_000_000, solAmount: 0.5, marketCapSol: 300 + i, _ts: Date.now() + 5000 + i });
  pp.handle({ txType: 'sell', mint: good, traderPublicKey: sniper, tokenAmount: 30_000_000, solAmount: 8, marketCapSol: 340, _ts: Date.now() + 6000 });
  pp.handle({ txType: 'migrate', mint: good });
  live.flush();
  const tok = db.prepare('SELECT * FROM tokens WHERE mint=?').get(good);
  assert.ok(Math.abs(tok.dev_pct - 2) < 1e-9);
  assert.ok(Math.abs(tok.sniper_pct - 3) < 1e-9, 'sniper 3%');
  assert.ok(tok.migrated_at);
  const fl = live.flowStats(good);
  assert.equal(fl.uniqueBuyers, 42);
  assert.ok(fl.vwapMcSol > 30);
  const ov = live.overhang(good, 400);
  assert.ok(ov.pct >= 2 - 1e-9, 'devの含み益玉'); // devは28→400で5倍以上・未売却
});

const mkPair = (mint, o = {}) => ({
  baseToken: { address: mint, symbol: o.sym || 'TKN', name: 'Token' }, priceUsd: String(o.price ?? 0.0004), priceNative: String((o.price ?? 0.0004) / 200),
  marketCap: o.mcap ?? 400000, liquidity: { usd: o.liq ?? 80000 }, txns: { m5: { buys: o.b5 ?? 60, sells: o.s5 ?? 30 }, h1: { buys: 400, sells: 300 } },
  volume: { m5: 20000, h1: 150000 }, priceChange: { m5: o.pc5 ?? 8, h1: 40, h6: 120 }, pairCreatedAt: Date.now() - 50 * 60e3,
  info: { socials: [{ type: 'twitter' }, { type: 'telegram' }], websites: [{ url: 'x' }] },
});
const rcGood = (mint) => ({ mint, mintAuthority: null, freezeAuthority: null, creator: dev, token: { decimals: 6 },
  topHolders: [{ address: addr(), owner: 'POOL', pct: 18 }, ...Array.from({ length: 10 }, () => ({ address: addr(), owner: addr(), pct: 1.2 }))],
  knownAccounts: { POOL: { name: 'PumpSwap', type: 'AMM' } }, risks: [], score_normalised: 2 });
const fetchers = { rugcheck: async (m) => (m === bad ? { ...rcGood(m), mintAuthority: addr() } : rcGood(m)), sellQuote: async () => ({ ok: true, impact: 0.02 }) };

await t('評価: 安全なトークンは通過、Mint権限ありは除外', async () => {
  // スマートウォレットを1つ登録して保有させる
  const sw = addr();
  db.prepare(`INSERT INTO wallets(address,label,kind,source,added_at) VALUES(?,?,?,?,?)`).run(sw, 'smart1', 'smart', 'auto', Date.now());
  pp.handle({ txType: 'buy', mint: good, traderPublicKey: sw, tokenAmount: 1_000_000, solAmount: 1, marketCapSol: 350 });
  live.flush();
  const r = await evaluateOne(good, mkPair(good, { sym: 'GOOD' }), { fetchers, model: null });
  assert.notEqual(r.decision, 'reject', JSON.stringify(r.bad));
  assert.ok(r.features.smart_holding === 1);
  assert.ok(r.features.top10 < 15, 'プールは除外される');
  const r2 = await evaluateOne(bad, mkPair(bad), { fetchers, model: null });
  assert.equal(r2.decision, 'reject');
  assert.ok(r2.bad.some((x) => x.includes('Mint')));
  const hot = addr();
  const r3 = await evaluateOne(hot, mkPair(hot, { pc5: 120 }), { fetchers, model: null });
  assert.ok(r3.decision !== 'notify' && r3.bad.some((x) => x.includes('押し目')), '急騰中は押し目待ち');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM paper').get().n, 3, '価格のある評価はペーパー記録');
});


await t('自前バブルマップ: 同じ資金元のウォレット群を検出、プールは除外', async () => {
  const mint = addr(), pool = addr(), poolProg = addr(), boss = addr(), cex = addr();
  const sy = [addr(), addr(), addr()], indep = [addr(), addr()], old = addr();
  const T = Date.now();
  const holders = [[pool, 300e6], [sy[0], 40e6], [sy[1], 35e6], [sy[2], 30e6], [indep[0], 20e6], [indep[1], 15e6], [old, 10e6]];
  const tokAcc = holders.map(() => addr());
  const first = {
    [sy[0]]: { funder: boss, ts: T - 2 * 3600e3 }, [sy[1]]: { funder: boss, ts: T - 1.5 * 3600e3 }, [sy[2]]: { funder: boss, ts: T - 1 * 3600e3 },
    [indep[0]]: { funder: cex, ts: T - 300 * 24 * 3600e3 }, [indep[1]]: { funder: cex, ts: T - 100 * 24 * 3600e3 },
  };
  const sigOf = (w) => 'sig_' + w;
  const call = async (method, params) => {
    if (method === 'getTokenLargestAccounts') return { value: holders.map(([, amt], i) => ({ address: tokAcc[i], uiAmount: amt })) };
    if (method === 'getTokenSupply') return { value: { uiAmount: 1e9 } };
    if (method === 'getMultipleAccounts') {
      const keys = params[0];
      if (params[1].encoding === 'jsonParsed') return { value: keys.map((k) => ({ data: { parsed: { info: { owner: holders[tokAcc.indexOf(k)][0] } } } })) };
      return { value: keys.map((k) => (k === pool ? { owner: poolProg } : { owner: '11111111111111111111111111111111' })) };
    }
    if (method === 'getSignaturesForAddress') {
      const w = params[0];
      if (w === old) return Array.from({ length: 1000 }, (_, i) => ({ signature: 'o' + i, blockTime: 1 }));
      return [{ signature: 'x' }, { signature: sigOf(w), blockTime: Math.floor(first[w].ts / 1000) }];
    }
    if (method === 'getTransaction') {
      const w = params[0].slice(4);
      return { blockTime: Math.floor(first[w].ts / 1000), transaction: { message: { accountKeys: [{ pubkey: first[w].funder }], instructions: [
        { program: 'system', parsed: { type: 'transfer', info: { source: first[w].funder, destination: w, lamports: 1e8 } } }] } }, meta: { innerInstructions: [] } };
    }
    throw new Error('unexpected ' + method);
  };
  const r = await analyzeHolders(mint, { call, t: T });
  assert.equal(r.analyzed, 6, 'プールを除いた6人');
  assert.equal(r.clusters.length, 1, 'CEXから遠い時期に送られた2人はつながらない');
  assert.equal(r.clusters[0].n, 3);
  assert.ok(Math.abs(r.maxClusterPct - 10.5) < 1e-9);
  assert.ok(Math.abs(r.freshPct - 10.5) < 1e-9);
  const f = await fundingSource(old, call);
  assert.equal(f.old, true);

  // 評価に組み込まれ、クラスタが大きいと除外される
  const m2 = addr();
  const big = { maxClusterPct: 22, clusters: [{ pct: 22, n: 4, funder: boss, members: sy }], freshPct: 30, analyzed: 12 };
  const r2 = await evaluateOne(m2, mkPair(m2), { fetchers: { ...fetchers, clusters: async () => big }, model: null });
  assert.equal(r2.decision, 'reject');
  assert.ok(r2.bad.some((x) => x.includes('つながったウォレット群')));
  const m3 = addr();
  const clean = { maxClusterPct: 0, clusters: [], freshPct: 5, analyzed: 15 };
  const r3 = await evaluateOne(m3, mkPair(m3), { fetchers: { ...fetchers, clusters: async () => clean }, model: null });
  assert.notEqual(r3.decision, 'reject');
  assert.ok(r3.good.some((x) => x.includes('つながりなし')));
});

await t('期待値と損益分岐', () => {
  const S = { tp: 1, sl: 0.4, cost: 0.06 };
  assert.ok(Math.abs(breakevenProb(S) - 0.46 / 1.4) < 1e-9);
  assert.ok(Math.abs(expectedValue(breakevenProb(S), S)) < 1e-9);
  assert.ok(Math.abs(breakevenProb({ tp: 0.5, sl: 0.4, cost: 0.06 }) - 0.5111) < 1e-3);
});

await t('答え合わせ: TP/SL/ラグ判定', () => {
  const rows = db.prepare('SELECT id, mint, entry_price FROM paper').all();
  const m = new Map();
  m.set(rows[0].mint, { price: rows[0].entry_price * 2.1, liq: 90000 });
  if (rows[1]) m.set(rows[1].mint, { price: rows[1].entry_price * 0.5, liq: 30000 });
  applyPrices(m);
  const after = db.prepare('SELECT outcome FROM paper ORDER BY id').all().map((r) => r.outcome);
  assert.deepEqual(after.slice(0, 2), ['tp', 'sl']);
  const p = performance();
  assert.equal(p.passed.n + p.rejected.n, 2);
  assert.equal(p.rejected.n, 1, 'Mint権限ありの除外分も答え合わせされる');
});

await t('学習: 信号のあるデータでモデルが初期ルールを上回る', () => {
  const rows = [];
  for (let i = 0; i < 500; i++) {
    const f = Object.fromEntries(FEATURE_KEYS.map((k) => [k, Math.random()]));
    f.smart_holding = Math.floor(Math.random() * 4);
    f.secret = 0;
    // 本当の効き目: liq_to_mcap と overhang（ルールとは違う重み）
    const z = -1.5 + 4 * (f.liq_to_mcap - 0.5) - 3 * (f.dev_prev_mig_rate - 0.5) + 2 * (f.has_web - 0.5);
    rows.push({ y: Math.random() < 1 / (1 + Math.exp(-z)) ? 1 : 0, ts: i, f });
  }
  const m = train(rows);
  assert.ok(m.holdout.model.auc > 0.6, 'AUC ' + m.holdout.model.auc);
  assert.equal(m.use, true, m.note);
  const pr = predict(rows[0].f, m);
  assert.ok(pr.p > 0 && pr.p < 1 && pr.w > 0);
  assert.equal(train([]).use, false);
});

await t('Web Push暗号化（受信側で復号できる）', () => {
  // 受信端末（iPhone）側の鍵
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = { endpoint: 'https://web.push.apple.com/x', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  const msg = JSON.stringify({ title: 'テスト', body: '日本語OK' });
  const enc = encryptPayload(sub, msg);
  // RFC 8291 に沿って復号
  const salt = enc.subarray(0, 16), idlen = enc[20], asPub = enc.subarray(21, 21 + idlen), ct = enc.subarray(21 + idlen);
  const shared = ua.computeSecret(asPub);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(pt[pt.length - 1], 2);
  assert.equal(pt.subarray(0, -1).toString(), msg);
  assert.equal(enc.readUInt32BE(16), 4096);
  const k = vapidKeys();
  assert.equal(Buffer.from(k.publicKey, 'base64url').length, 65);
});

await t('ウォレット: 一括登録と自動集計', () => {
  assert.equal(importWallets(`${addr()} KOL_A\n${addr()},KOL_B\nnot-an-address`), 2);
  // 6時間以上前の取引で勝ちが多いウォレット → smart
  const w = addr();
  const old = Date.now() - 8 * 3600e3;
  for (let i = 0; i < 8; i++) db.prepare(`INSERT INTO wallet_token(wallet,mint,buy_sol,sell_sol,buy_tok,sell_tok,first_ts,last_ts,first_mcap_sol,sniper) VALUES(?,?,?,?,?,?,?,?,?,0)`)
    .run(w, addr(), 1, i < 5 ? 3 : 0.5, 1e6, 1e6, old, old, 100);
  const r = updateWalletStats();
  assert.ok(r.smart >= 1);
  assert.equal(db.prepare('SELECT kind FROM wallets WHERE address=?').get(w).kind, 'smart');
});

await t('設定の保存', () => {
  saveSettings({ tp: '1.5', bogus: 1, caveChannels: 'CAVE_JPN,other' });
  const S = getSettings();
  assert.equal(S.tp, 1.5);
  assert.equal(S.caveChannels, 'CAVE_JPN,other');
  assert.equal(S.bogus, undefined);
  saveSettings({ tp: 1 });
});

await t('HTTP API（認証・一覧・詳細）', async () => {
  const { startServer } = await import('../src/server.js');
  const srv = startServer();
  await new Promise((r) => setTimeout(r, 200));
  const base = 'http://127.0.0.1:18787';
  assert.equal((await fetch(base + '/api/feed')).status, 401);
  const h = { 'x-token': 'secret' };
  const feed = await (await fetch(base + '/api/feed?view=all', { headers: h })).json();
  assert.ok(feed.length >= 2);
  const det = await (await fetch(base + '/api/token/' + good, { headers: h })).json();
  assert.equal(det.tok.symbol, 'GOOD');
  const stats = await (await fetch(base + '/api/stats', { headers: h })).json();
  assert.ok(stats.perf && stats.calibration.length === 7);
  const html = await (await fetch(base + '/')).text();
  assert.ok(html.includes('Meme Scout'));
  assert.equal((await fetch(base + '/sw.js')).headers.get('content-type').startsWith('text/javascript'), true);
  srv.close();
});

console.log(`\n${passed} tests passed`);
process.exit(0);

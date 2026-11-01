// 自前バブルマップ: 上位ホルダーの「資金の出どころ」をたどって、同一人物の複数ウォレット（クラスタ）を検出
// Solana RPC（無料の公開RPC、または .env の RPC_URL）だけで動く
import { ENV } from '../config.js';
import { fetchRaw, log, now, sleep } from '../util.js';

const SYSTEM = '11111111111111111111111111111111';
const BURN = new Set(['1nc1nerator11111111111111111111111111111111']);
const H = 3600e3;

// ---- RPC（同時実行と速度を制限、429は待って再試行） ----
let active = 0;
let lastCall = 0;
const MIN_GAP = () => (ENV.RPC_URL.includes('mainnet-beta') ? 160 : 40); // 公開RPCは控えめに
export async function rpc(method, params) {
  while (active >= 3) await sleep(30);
  active++;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = lastCall + MIN_GAP() - now();
      if (wait > 0) await sleep(wait);
      lastCall = now();
      const r = await fetchRaw(ENV.RPC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        timeout: 20000,
      });
      if (r.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
      if (!r.ok) throw new Error(`RPC HTTP ${r.status}`);
      const j = await r.json();
      if (j.error) throw new Error(`RPC ${method}: ${j.error.message}`);
      return j.result;
    }
    throw new Error(`RPC ${method}: rate limited`);
  } finally {
    active--;
  }
}

/** ウォレットが最初にSOLを受け取った相手（資金元）と時刻 */
export async function fundingSource(wallet, call = rpc) {
  let before;
  let oldest = null;
  for (let page = 0; page < 2; page++) {
    const sigs = await call('getSignaturesForAddress', [wallet, { limit: 1000, ...(before ? { before } : {}) }]);
    if (!sigs || !sigs.length) break;
    oldest = sigs[sigs.length - 1];
    if (sigs.length < 1000) { before = null; break; }
    before = oldest.signature;
  }
  if (!oldest) return { funder: null, firstTs: null, old: false };
  if (before) return { funder: null, firstTs: null, old: true }; // 取引が2000件超 = 古い・活発なウォレット
  const tx = await call('getTransaction', [oldest.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
  const firstTs = (oldest.blockTime || tx?.blockTime || 0) * 1000 || null;
  const ins = [...(tx?.transaction?.message?.instructions || [])];
  for (const ii of tx?.meta?.innerInstructions || []) ins.push(...(ii.instructions || []));
  let funder = null;
  for (const i of ins) {
    const p = i.parsed;
    if (i.program === 'system' && p && /transfer|createAccount/i.test(p.type) && (p.info?.destination === wallet || p.info?.newAccount === wallet)) {
      funder = p.info.source;
      break;
    }
  }
  if (!funder) {
    const keys = tx?.transaction?.message?.accountKeys || [];
    const payer = keys[0]?.pubkey || keys[0];
    if (payer && payer !== wallet) funder = payer;
  }
  return { funder, firstTs, old: false };
}

const fundCache = new Map(); // ウォレットの資金元は変わらないので長く保持
async function cachedFunding(w, call) {
  const c = fundCache.get(w);
  if (c) return c;
  const f = await fundingSource(w, call);
  fundCache.set(w, f);
  if (fundCache.size > 50000) fundCache.delete(fundCache.keys().next().value);
  return f;
}

/**
 * 上位ホルダーを分析
 * 返り値: { maxClusterPct, clusters:[{pct, n, funder, members}], freshPct, analyzed, holdersPct }
 */
export async function analyzeHolders(mint, { call = rpc, maxHolders = 15, linkWindowMs = 6 * H, t = now() } = {}) {
  const [largest, supplyRes] = await Promise.all([
    call('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]),
    call('getTokenSupply', [mint]),
  ]);
  const supply = Number(supplyRes?.value?.uiAmount || 0);
  const accs = (largest?.value || []).filter((a) => Number(a.uiAmount) > 0);
  if (!supply || !accs.length) return null;
  // トークン口座 → 持ち主ウォレット
  const tokInfo = await call('getMultipleAccounts', [accs.map((a) => a.address), { encoding: 'jsonParsed' }]);
  const holders = new Map(); // owner -> amount
  accs.forEach((a, i) => {
    const owner = tokInfo?.value?.[i]?.data?.parsed?.info?.owner;
    if (!owner || BURN.has(owner)) return;
    holders.set(owner, (holders.get(owner) || 0) + Number(a.uiAmount));
  });
  // 持ち主がプログラム（プール・ボンディングカーブ・ロッカー等）なら除外
  const owners = [...holders.keys()];
  const ownInfo = await call('getMultipleAccounts', [owners, { encoding: 'base64' }]);
  const people = owners.filter((o, i) => {
    const acc = ownInfo?.value?.[i];
    return !acc || acc.owner === SYSTEM; // 通常のウォレットのみ
  }).slice(0, maxHolders);

  const info = [];
  for (const w of people) {
    try {
      const f = await cachedFunding(w, call);
      info.push({ w, pct: (holders.get(w) / supply) * 100, ...f });
    } catch (e) {
      info.push({ w, pct: (holders.get(w) / supply) * 100, funder: null, firstTs: null, old: false });
      log('資金元の取得失敗', w.slice(0, 6), e.message);
    }
  }

  // つながり: ①同じ資金元から近い時間に作られた ②ホルダー同士で資金をやり取り
  const parent = new Map(info.map((x) => [x.w, x.w]));
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  const union = (a, b) => parent.set(find(a), find(b));
  const byFunder = new Map();
  for (const x of info) {
    if (!x.funder) continue;
    if (parent.has(x.funder)) union(x.w, x.funder);
    if (!byFunder.has(x.funder)) byFunder.set(x.funder, []);
    byFunder.get(x.funder).push(x);
  }
  for (const group of byFunder.values()) {
    group.sort((a, b) => (a.firstTs || 0) - (b.firstTs || 0));
    for (let i = 1; i < group.length; i++) {
      const a = group[i - 1], b = group[i];
      if (a.firstTs && b.firstTs && b.firstTs - a.firstTs <= linkWindowMs) union(a.w, b.w);
    }
  }
  const clusters = new Map();
  for (const x of info) {
    const r = find(x.w);
    if (!clusters.has(r)) clusters.set(r, { pct: 0, n: 0, members: [], funder: null });
    const c = clusters.get(r);
    c.pct += x.pct; c.n++; c.members.push(x.w); c.funder ||= x.funder;
  }
  const real = [...clusters.values()].filter((c) => c.n >= 2).sort((a, b) => b.pct - a.pct);
  const fresh = info.filter((x) => x.firstTs && t - x.firstTs < 3 * 24 * H);
  return {
    maxClusterPct: real[0]?.pct || 0,
    clusters: real.slice(0, 5).map((c) => ({ pct: +c.pct.toFixed(2), n: c.n, funder: c.funder, members: c.members })),
    freshPct: fresh.reduce((a, x) => a + x.pct, 0),
    freshCount: fresh.length,
    analyzed: info.length,
    holdersPct: info.reduce((a, x) => a + x.pct, 0),
  };
}

const cache = new Map();
/** 30分キャッシュ付き。失敗時は null */
export async function holderClusters(mint, opts = {}) {
  const c = cache.get(mint);
  if (c && now() - c.ts < 30 * 60e3) return c.d;
  let d = null;
  try {
    d = await analyzeHolders(mint, opts);
  } catch (e) {
    log('クラスタ分析エラー', mint.slice(0, 6), e.message);
    if (c) return c.d;
  }
  cache.set(mint, { ts: now(), d });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return d;
}

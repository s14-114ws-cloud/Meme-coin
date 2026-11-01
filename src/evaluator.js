// 1トークンを評価 → 保存 → ペーパートレード → 通知
import { db, getSettings } from './db.js';
import { ENV } from './config.js';
import { dexPairs, rugcheck, sellQuote, bubblemaps, summarizeRugcheck } from './sources/market.js';
import { mentionStats } from './sources/telegram.js';
import { regime } from './sources/pumpportal.js';
import { flowStats, overhang, trackedInvolvement } from './live.js';
import { computeFeatures, runFilters, decide, breakevenProb } from './score.js';
import { predict, loadModel } from './learn.js';
import { openPaper, hasRecentPaper } from './tracker.js';
import { notifyAll } from './push.js';
import { now, num, fmtUsd, log } from './util.js';

const SOFT_FAILS = new Set(['liq', 'mcap_low', 'no_pair', 'sell_impact', 'no_sell']);
const bmCache = new Map();

const ensureTok = db.prepare(`INSERT INTO tokens(mint,first_seen,sources) VALUES(?,?,?) ON CONFLICT(mint) DO NOTHING`);
const addSource = db.prepare(`UPDATE tokens SET sources = CASE WHEN instr(','||sources||',', ','||?||',')>0 THEN sources ELSE trim(sources||','||?, ',') END WHERE mint=?`);
const getTok = db.prepare('SELECT * FROM tokens WHERE mint=?');
const setMeta = db.prepare('UPDATE tokens SET symbol=COALESCE(?,symbol), name=COALESCE(?,name), creator=COALESCE(creator,?) WHERE mint=?');
const setEval = db.prepare('UPDATE tokens SET last_eval=?, last_decision=? WHERE mint=?');
const setNotified = db.prepare('UPDATE tokens SET notified_at=? WHERE mint=?');
const insEval = db.prepare(`INSERT INTO evals(mint,ts,price,mcap,liq,features,filters,p_rule,p,ev,decision,reasons) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
const devStats = db.prepare(`SELECT COUNT(*) prev, SUM(CASE WHEN migrated_at IS NOT NULL THEN 1 ELSE 0 END) mig FROM tokens WHERE creator=? AND mint<>?`);
const highMc = db.prepare('SELECT MAX(mcap) m FROM evals WHERE mint=?');

export function touchToken(mint, source) {
  ensureTok.run(mint, now(), source || '');
  if (source) addSource.run(source, source, mint);
}

export async function evaluateMany(mints, opts = {}) {
  const pairs = await dexPairs(mints);
  const out = [];
  for (const m of mints) {
    try {
      out.push(await evaluateOne(m, pairs.get(m) || null, opts));
    } catch (e) {
      log('評価エラー', m.slice(0, 6), e.message);
    }
  }
  return out;
}

export async function evaluateOne(mint, pair, { manual = false, model = loadModel(), fetchers = {} } = {}) {
  const S = getSettings();
  const t = now();
  touchToken(mint, manual ? 'manual' : '');
  if (pair) setMeta.run(pair.baseToken?.symbol || null, pair.baseToken?.name || null, null, mint);
  let tok = getTok.get(mint);
  const rcRaw = await (fetchers.rugcheck || rugcheck)(mint);
  const rc = summarizeRugcheck(rcRaw, tok?.bonding_curve);
  if (rc?.creator && !tok.creator) { setMeta.run(null, null, rc.creator, mint); tok = getTok.get(mint); }
  const priceUsd = num(pair?.priceUsd), priceNative = num(pair?.priceNative);
  const solUsd = priceUsd > 0 && priceNative > 0 ? priceUsd / priceNative : 0;
  const jup = pair ? await (fetchers.sellQuote || sellQuote)(mint, priceNative, rc?.decimals ?? 6, S.positionSol) : null;
  let bm = null;
  if (ENV.BUBBLEMAPS_API_KEY && pair) {
    const c = bmCache.get(mint);
    if (c && t - c.ts < 30 * 60e3) bm = c.d;
    else { bm = await bubblemaps(mint); bmCache.set(mint, { ts: t, d: bm }); }
  }
  const mcap = num(pair?.marketCap || pair?.fdv);
  const curMcSol = solUsd > 0 ? mcap / solUsd : null;
  const creator = tok?.creator || rc?.creator;
  const ds = creator ? devStats.get(creator, mint) : null;
  const dev = ds ? { prev: ds.prev, migRate: ds.prev ? (ds.mig || 0) / ds.prev : 0 } : null;
  const ctx = {
    now: t, pair, rc, bm, jup, tok, solUsd,
    flow: flowStats(mint), over: overhang(mint, curMcSol), inv: trackedInvolvement(mint),
    ment: mentionStats(mint), dev, regime: regime(), highMcap: Math.max(num(highMc.get(mint)?.m), mcap),
  };
  const f = computeFeatures(ctx);
  const filt = runFilters(ctx, f, S);
  const pr = predict(f, model);
  const d = decide(ctx, f, filt, pr.p, S);
  const ev = d.ev ?? null;
  const evalId = insEval.run(mint, t, priceUsd, mcap, num(pair?.liquidity?.usd), JSON.stringify(f), JSON.stringify(filt),
    pr.pRule, pr.p, ev, d.decision, JSON.stringify({ good: d.good, bad: d.reasons, smartNames: ctx.inv.names })).lastInsertRowid;
  const soft = !filt.pass && filt.fails.every((x) => SOFT_FAILS.has(x[0]));
  setEval.run(t, d.decision === 'reject' && soft ? 'reject_soft' : d.decision, mint);

  // ペーパートレード（学習用）: トークンごと24時間に1回 + 通知時
  if (priceUsd > 0) {
    if (!hasRecentPaper(mint, 24 * 3600e3)) {
      openPaper({ evalId, mint, notified: d.decision === 'notify' && !manual, passed: filt.pass, firstFail: filt.fails[0]?.[0], price: priceUsd, S, ts: t });
    } else if (d.decision === 'notify' && !manual && !hasRecentPaper(mint, 24 * 3600e3, true)) {
      openPaper({ evalId, mint, notified: true, passed: true, price: priceUsd, S, ts: t });
    }
  }

  const result = {
    mint, symbol: pair?.baseToken?.symbol || tok?.symbol || '?', decision: d.decision, p: pr.p, pRule: pr.pRule, ev,
    breakeven: breakevenProb(S), mcap, liq: num(pair?.liquidity?.usd), priceUsd, good: d.good, bad: d.reasons,
    maxBuySol: solUsd > 0 ? (num(pair?.liquidity?.usd) * 0.01) / solUsd : null, features: f,
  };

  if (d.decision === 'notify' && !manual) {
    const fresh = getTok.get(mint);
    const hour = (new Date(t).getUTCHours() + 9) % 24;
    const quiet = S.quietStart >= 0 && (S.quietStart <= S.quietEnd ? hour >= S.quietStart && hour < S.quietEnd : hour >= S.quietStart || hour < S.quietEnd);
    if (!fresh.notified_at || t - fresh.notified_at > 12 * 3600e3) {
      setNotified.run(t, mint);
      if (!quiet) {
        await notifyAll({
          mint,
          title: `🚀 $${result.symbol}  2倍先行 ${(pr.p * 100).toFixed(0)}% / 期待値 ${ev >= 0 ? '+' : ''}${(ev * 100).toFixed(0)}%`,
          body: `時価総額 ${fmtUsd(mcap)}・流動性 ${fmtUsd(result.liq)}${result.maxBuySol ? `・上限目安 ${result.maxBuySol.toFixed(2)} SOL` : ''}\n${d.good.slice(0, 3).join(' / ')}`,
        });
      }
    }
  }
  return result;
}

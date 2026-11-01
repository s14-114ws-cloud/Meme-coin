// ペーパートレード（実際には買わず、通知時点の価格から結果を自動記録）
import { db } from './db.js';
import { dexPairs } from './sources/market.js';
import { now, num } from './util.js';

const H = 3600e3;
const ins = db.prepare(`INSERT INTO paper(eval_id,mint,notified,passed,first_fail,entry_price,entry_ts,tp,sl,cost)
  VALUES(?,?,?,?,?,?,?,?,?,?)`);

export function openPaper({ evalId, mint, notified, passed, firstFail, price, S, ts = now() }) {
  if (!(price > 0)) return null;
  return ins.run(evalId, mint, notified ? 1 : 0, passed ? 1 : 0, firstFail || null, price, ts, S.tp, S.sl, S.cost).lastInsertRowid;
}

export function hasRecentPaper(mint, withinMs, notifiedOnly = false) {
  return !!db.prepare(`SELECT 1 FROM paper WHERE mint=? AND entry_ts>? ${notifiedOnly ? 'AND notified=1' : ''} LIMIT 1`).get(mint, now() - withinMs);
}

const upd = db.prepare(`UPDATE paper SET max_mult=?, min_mult=?, last_mult=?, mult_1h=COALESCE(mult_1h,?), mult_6h=COALESCE(mult_6h,?),
  mult_24h=COALESCE(mult_24h,?), outcome=COALESCE(outcome,?), outcome_ts=COALESCE(outcome_ts,?) WHERE id=?`);

/** 価格を更新して決着判定。priceMap: Map<mint,{price, liq}> */
export function applyPrices(priceMap, t = now()) {
  const open = db.prepare(`SELECT * FROM paper WHERE (outcome IS NULL OR mult_24h IS NULL) AND entry_ts>?`).all(t - 25 * H);
  let closed = 0;
  for (const r of open) {
    const q = priceMap.get(r.mint);
    if (!q) continue;
    const mult = q.price > 0 ? q.price / r.entry_price : r.last_mult;
    const maxM = Math.max(r.max_mult, mult), minM = Math.min(r.min_mult, mult);
    const age = t - r.entry_ts;
    let outcome = null;
    if (!r.outcome) {
      // 毎分の値で判定（同じ分に両方は「損切り優先」で保守的に）
      if (minM <= 1 - r.sl) outcome = 'sl';
      else if (maxM >= 1 + r.tp) outcome = 'tp';
      else if (num(q.liq) < 1000) outcome = 'rug';
      else if (age >= 24 * H) outcome = 'timeout';
      if (outcome) closed++;
    }
    upd.run(maxM, minM, mult, age >= H ? mult : null, age >= 6 * H ? mult : null, age >= 24 * H ? mult : null,
      outcome, outcome ? t : null, r.id);
  }
  return closed;
}

export async function trackOnce() {
  const mints = db.prepare(`SELECT DISTINCT mint FROM paper WHERE (outcome IS NULL OR mult_24h IS NULL) AND entry_ts>?`).all(now() - 25 * H).map((r) => r.mint);
  if (!mints.length) return 0;
  const pairs = await dexPairs(mints);
  const m = new Map();
  for (const [mint, p] of pairs) m.set(mint, { price: num(p.priceUsd), liq: num(p.liquidity?.usd) });
  return applyPrices(m);
}

/** 手数料込みの実現リターン */
export function realized(r) {
  if (r.outcome === 'tp') return r.tp - r.cost;
  if (r.outcome === 'sl') return -r.sl - r.cost;
  if (r.outcome === 'rug') return Math.max(-1, r.last_mult - 1 - r.cost);
  if (r.outcome === 'timeout') return Math.max(-1, Math.min(r.tp, (r.mult_24h ?? r.last_mult) - 1) - r.cost);
  return null;
}

export function performance(sinceMs = 30 * 24 * H) {
  const rows = db.prepare('SELECT * FROM paper WHERE entry_ts>? AND outcome IS NOT NULL').all(now() - sinceMs);
  const group = (fn) => {
    const g = rows.filter(fn);
    const rets = g.map(realized);
    const n = g.length;
    const wins = g.filter((r) => r.outcome === 'tp').length;
    const sum = rets.reduce((a, b) => a + b, 0);
    return { n, wins, winRate: n ? wins / n : null, avgRet: n ? sum / n : null, rugs: g.filter((r) => r.outcome === 'rug').length,
      avgMax: n ? g.reduce((a, r) => a + r.max_mult, 0) / n : null };
  };
  // 足切りごとの「除外したが実は上がった」率
  const audit = {};
  for (const r of rows.filter((r) => !r.passed)) {
    const k = r.first_fail || '?';
    audit[k] ||= { n: 0, wouldWin: 0, rugs: 0 };
    audit[k].n++;
    if (r.outcome === 'tp') audit[k].wouldWin++;
    if (r.outcome === 'rug' || r.min_mult < 0.2) audit[k].rugs++;
  }
  return { notified: group((r) => r.notified), passed: group((r) => r.passed), rejected: group((r) => !r.passed), audit,
    open: db.prepare('SELECT COUNT(*) n FROM paper WHERE outcome IS NULL').get().n };
}

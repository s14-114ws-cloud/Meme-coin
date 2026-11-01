// 取引の記録（メモリ上の直近ウィンドウ + DBの集計）
import { db, tx } from './db.js';
import { now } from './util.js';

const PUMP_SUPPLY = 1e9; // pump.fun系の総供給
const windows = new Map(); // mint -> [{ts, w, side, sol, tok, mc}]
const WINDOW_MS = 60 * 60 * 1000;
let pending = [];

const upsert = db.prepare(`
INSERT INTO wallet_token(wallet,mint,buy_sol,sell_sol,buy_tok,sell_tok,first_ts,last_ts,first_mcap_sol,sniper)
VALUES(?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(wallet,mint) DO UPDATE SET
  buy_sol=buy_sol+excluded.buy_sol, sell_sol=sell_sol+excluded.sell_sol,
  buy_tok=buy_tok+excluded.buy_tok, sell_tok=sell_tok+excluded.sell_tok,
  last_ts=excluded.last_ts,
  first_mcap_sol=COALESCE(first_mcap_sol, excluded.first_mcap_sol),
  sniper=MAX(sniper, excluded.sniper)`);
const tokCreated = db.prepare('SELECT created_at, creator FROM tokens WHERE mint=?');
const addSniper = db.prepare('UPDATE tokens SET sniper_pct=COALESCE(sniper_pct,0)+? WHERE mint=?');

const createdCache = new Map();
function createdInfo(mint) {
  if (createdCache.has(mint)) return createdCache.get(mint);
  const r = tokCreated.get(mint) || null;
  if (createdCache.size > 20000) createdCache.clear();
  createdCache.set(mint, r);
  return r;
}
export function forgetCreated(mint) {
  createdCache.delete(mint);
}

/** t: {mint, wallet, side:'buy'|'sell', sol, tok, mcapSol, ts} */
export function recordTrade(t) {
  const ts = t.ts || now();
  let arr = windows.get(t.mint);
  if (!arr) windows.set(t.mint, (arr = []));
  arr.push({ ts, w: t.wallet, side: t.side, sol: t.sol, tok: t.tok, mc: t.mcapSol });
  if (arr.length > 5000) arr.splice(0, arr.length - 5000);
  const c = createdInfo(t.mint);
  const sniper = c && c.created_at && t.side === 'buy' && ts - c.created_at <= 3000 && t.wallet !== c.creator ? 1 : 0;
  pending.push([t, ts, sniper]);
}

export function flush() {
  if (!pending.length) return;
  const batch = pending;
  pending = [];
  tx(() => {
    for (const [t, ts, sniper] of batch) {
      const buy = t.side === 'buy';
      upsert.run(t.wallet, t.mint, buy ? t.sol : 0, buy ? 0 : t.sol, buy ? t.tok : 0, buy ? 0 : t.tok, ts, ts, buy ? t.mcapSol ?? null : null, sniper);
      if (sniper) addSniper.run((t.tok / PUMP_SUPPLY) * 100, t.mint);
    }
  });
}

export function pruneWindows() {
  const cut = now() - WINDOW_MS;
  for (const [m, arr] of windows) {
    const i = arr.findIndex((x) => x.ts >= cut);
    if (i === -1) windows.delete(m);
    else if (i > 0) arr.splice(0, i);
  }
}

export function lastTradeTs(mint) {
  const a = windows.get(mint);
  return a && a.length ? a[a.length - 1].ts : 0;
}

/** 直近の売買フロー */
export function flowStats(mint, ms = 15 * 60 * 1000) {
  const arr = windows.get(mint) || [];
  const cut = now() - ms;
  const buyers = new Set();
  const sellers = new Set();
  let buySol = 0, sellSol = 0, nb = 0, ns = 0;
  for (const x of arr) {
    if (x.ts < cut) continue;
    if (x.side === 'buy') { buyers.add(x.w); buySol += x.sol; nb++; }
    else { sellers.add(x.w); sellSol += x.sol; ns++; }
  }
  // 30分VWAP（時価総額SOLベース、出来高加重）
  const cut30 = now() - 30 * 60 * 1000;
  let vs = 0, vw = 0;
  for (const x of arr) if (x.ts >= cut30 && x.mc) { vw += x.mc * x.sol; vs += x.sol; }
  const lastMc = arr.length ? arr[arr.length - 1].mc : null;
  return {
    has: arr.length > 0,
    uniqueBuyers: buyers.size,
    uniqueSellers: sellers.size,
    buySol, sellSol, nb, ns,
    netSol: buySol - sellSol,
    vwapMcSol: vs > 0 ? vw / vs : null,
    lastMcSol: lastMc,
  };
}

/** 初期勢の売り圧（大きな含み益のまま未売却の供給%） */
export function overhang(mint, curMcapSol) {
  if (!curMcapSol) return { pct: null, sniperHeldPct: null };
  const rows = db.prepare('SELECT buy_tok, sell_tok, first_mcap_sol, sniper FROM wallet_token WHERE mint=? AND buy_tok>0').all(mint);
  let held = 0, sniperHeld = 0;
  for (const r of rows) {
    const rem = Math.max(0, r.buy_tok - r.sell_tok);
    if (r.sniper) sniperHeld += rem;
    if (r.first_mcap_sol && curMcapSol / r.first_mcap_sol >= 5) held += rem;
  }
  return rows.length ? { pct: (held / PUMP_SUPPLY) * 100, sniperHeldPct: (sniperHeld / PUMP_SUPPLY) * 100 } : { pct: null, sniperHeldPct: null };
}

/** 登録ウォレット（スマート/KOL）の関与 */
export function trackedInvolvement(mint) {
  const rows = db.prepare(`SELECT w.address, w.label, w.kind, w.score, t.buy_tok, t.sell_tok, t.first_ts
    FROM wallet_token t JOIN wallets w ON w.address=t.wallet
    WHERE t.mint=? AND w.kind IN ('smart','kol','manual')`).all(mint);
  let smartHolding = 0, kolHolding = 0, kolSold = 0, firstKolTs = null;
  const names = [];
  for (const r of rows) {
    const holding = r.buy_tok > 0 && r.sell_tok < r.buy_tok * 0.5;
    const sold = r.buy_tok > 0 && r.sell_tok >= r.buy_tok * 0.5;
    if (r.kind === 'smart' && holding) smartHolding++;
    if (r.kind !== 'smart') {
      if (holding) kolHolding++;
      if (sold) kolSold++;
      if (r.first_ts && (!firstKolTs || r.first_ts < firstKolTs)) firstKolTs = r.first_ts;
    }
    if (holding) names.push(r.label || r.address.slice(0, 4));
  }
  return { smartHolding, kolHolding, kolSold, firstKolTs, names };
}

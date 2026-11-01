// PumpPortal データWebSocket（新規トークン・卒業・指定ウォレット/トークンの売買）
// 接続は1本だけにすること（多重接続はBANの原因）
import { db } from '../db.js';
import { ENV } from '../config.js';
import { log, now } from '../util.js';
import { recordTrade, lastTradeTs, forgetCreated } from '../live.js';

const URL = 'wss://pumpportal.fun/api/data';
let ws = null;
let backoff = 2000;
const tokenSubs = new Set();
const accountSubs = new Set();
export const status = { connected: false, lastMsg: 0, newTokens: 0, migrations: 0, trades: 0 };
const migrationTimes = [];
const createTimes = [];

let handlers = { onMigration: () => {}, onTrackedBuy: () => {} };
export function setHandlers(h) {
  handlers = { ...handlers, ...h };
}

const insTok = db.prepare(`INSERT INTO tokens(mint,symbol,name,first_seen,created_at,creator,dev_pct,bonding_curve,sources)
  VALUES(?,?,?,?,?,?,?,?,'pump') ON CONFLICT(mint) DO NOTHING`);
const setMig = db.prepare(`INSERT INTO tokens(mint,first_seen,migrated_at,sources) VALUES(?,?,?,'migrate')
  ON CONFLICT(mint) DO UPDATE SET migrated_at=excluded.migrated_at`);

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

export function connect() {
  if (ENV.OFFLINE) return;
  ws = new WebSocket(URL);
  ws.onopen = () => {
    status.connected = true;
    backoff = 2000;
    log('PumpPortal 接続');
    send({ method: 'subscribeMigration' });
    if (ENV.TRACK_NEW_TOKENS) send({ method: 'subscribeNewToken' });
    if (tokenSubs.size) send({ method: 'subscribeTokenTrade', keys: [...tokenSubs] });
    if (accountSubs.size) send({ method: 'subscribeAccountTrade', keys: [...accountSubs] });
  };
  ws.onmessage = (ev) => {
    status.lastMsg = now();
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    try {
      handle(m);
    } catch (e) {
      log('PumpPortal 処理エラー', e.message);
    }
  };
  ws.onclose = () => {
    status.connected = false;
    log(`PumpPortal 切断 → ${backoff / 1000}秒後に再接続`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 60000);
  };
  ws.onerror = () => {};
}

export function handle(m) {
  if (!m || !m.txType) return;
  const ts = m._ts || now(); // _ts はテスト用
  if (m.txType === 'create') {
    status.newTokens++;
    createTimes.push(ts);
    const devPct = (Number(m.initialBuy) || 0) / 1e9 * 100;
    insTok.run(m.mint, m.symbol || null, m.name || null, ts, ts, m.traderPublicKey || null, devPct, m.bondingCurveKey || null);
    forgetCreated(m.mint);
    if (m.traderPublicKey && m.initialBuy) {
      recordTrade({ mint: m.mint, wallet: m.traderPublicKey, side: 'buy', sol: +m.solAmount || 0, tok: +m.initialBuy || 0, mcapSol: +m.marketCapSol || null, ts });
    }
    if (ENV.TRACK_NEW_TOKENS) subscribeToken(m.mint);
    return;
  }
  if (m.txType === 'migrate') {
    status.migrations++;
    migrationTimes.push(ts);
    setMig.run(m.mint, ts, ts);
    subscribeToken(m.mint);
    handlers.onMigration(m.mint);
    return;
  }
  if (m.txType === 'buy' || m.txType === 'sell') {
    status.trades++;
    const t = { mint: m.mint, wallet: m.traderPublicKey, side: m.txType, sol: +m.solAmount || 0, tok: +m.tokenAmount || 0, mcapSol: +m.marketCapSol || null, ts };
    recordTrade(t);
    if (accountSubs.has(m.traderPublicKey) && m.txType === 'buy') handlers.onTrackedBuy(m.mint, m.traderPublicKey);
  }
}

export function subscribeToken(mint) {
  if (tokenSubs.has(mint)) return;
  if (tokenSubs.size >= ENV.MAX_TOKEN_SUBS) pruneTokenSubs(true);
  tokenSubs.add(mint);
  send({ method: 'subscribeTokenTrade', keys: [mint] });
}

// 10分取引がないトークンは購読解除（keepは評価中のもの）
export function pruneTokenSubs(force = false, keep = new Set()) {
  const cut = now() - (force ? 3 : 10) * 60 * 1000;
  const drop = [];
  for (const m of tokenSubs) {
    if (keep.has(m)) continue;
    if (lastTradeTs(m) < cut) drop.push(m);
  }
  for (const m of drop) tokenSubs.delete(m);
  if (drop.length) send({ method: 'unsubscribeTokenTrade', keys: drop });
  return drop.length;
}

export function setAccountSubs(addresses) {
  const next = new Set(addresses);
  const add = [...next].filter((a) => !accountSubs.has(a));
  const del = [...accountSubs].filter((a) => !next.has(a));
  for (const a of del) accountSubs.delete(a);
  for (const a of add) accountSubs.add(a);
  if (del.length) send({ method: 'unsubscribeAccountTrade', keys: del });
  if (add.length) send({ method: 'subscribeAccountTrade', keys: add });
}

/** 地合い: 直近1時間の卒業数・新規作成数 */
export function regime() {
  const cut = now() - 3600e3;
  while (migrationTimes.length && migrationTimes[0] < cut) migrationTimes.shift();
  while (createTimes.length && createTimes[0] < cut) createTimes.shift();
  return { migrations1h: migrationTimes.length, creates1h: createTimes.length };
}
export const subCounts = () => ({ tokens: tokenSubs.size, accounts: accountSubs.size });

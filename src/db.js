// SQLite（Node.js標準の node:sqlite）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { ENV, DEFAULT_SETTINGS } from './config.js';

fs.mkdirSync(ENV.DATA_DIR, { recursive: true });
export const db = new DatabaseSync(process.env.DB_PATH || path.join(ENV.DATA_DIR, 'memescout.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS tokens(
  mint TEXT PRIMARY KEY, symbol TEXT, name TEXT, first_seen INTEGER, created_at INTEGER,
  migrated_at INTEGER, creator TEXT, dev_pct REAL, sniper_pct REAL, bonding_curve TEXT,
  sources TEXT DEFAULT '', last_eval INTEGER, last_decision TEXT, notified_at INTEGER
);
CREATE INDEX IF NOT EXISTS tokens_creator ON tokens(creator);
CREATE TABLE IF NOT EXISTS evals(
  id INTEGER PRIMARY KEY, mint TEXT, ts INTEGER, price REAL, mcap REAL, liq REAL,
  features TEXT, filters TEXT, p_rule REAL, p REAL, ev REAL, decision TEXT, reasons TEXT
);
CREATE INDEX IF NOT EXISTS evals_mint ON evals(mint, ts);
CREATE INDEX IF NOT EXISTS evals_ts ON evals(ts);
CREATE TABLE IF NOT EXISTS paper(
  id INTEGER PRIMARY KEY, eval_id INTEGER, mint TEXT, notified INTEGER, passed INTEGER,
  first_fail TEXT, entry_price REAL, entry_ts INTEGER, max_mult REAL DEFAULT 1, min_mult REAL DEFAULT 1,
  last_mult REAL DEFAULT 1, mult_1h REAL, mult_6h REAL, mult_24h REAL,
  outcome TEXT, outcome_ts INTEGER, tp REAL, sl REAL, cost REAL
);
CREATE INDEX IF NOT EXISTS paper_open ON paper(outcome, entry_ts);
CREATE INDEX IF NOT EXISTS paper_mint ON paper(mint);
CREATE TABLE IF NOT EXISTS wallets(
  address TEXT PRIMARY KEY, label TEXT, kind TEXT, source TEXT, added_at INTEGER,
  n_tokens INTEGER DEFAULT 0, wins INTEGER DEFAULT 0, pnl_sol REAL DEFAULT 0,
  sniper_rate REAL DEFAULT 0, score REAL DEFAULT 0, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS wallet_token(
  wallet TEXT, mint TEXT, buy_sol REAL DEFAULT 0, sell_sol REAL DEFAULT 0,
  buy_tok REAL DEFAULT 0, sell_tok REAL DEFAULT 0, first_ts INTEGER, last_ts INTEGER,
  first_mcap_sol REAL, sniper INTEGER DEFAULT 0, PRIMARY KEY(wallet, mint)
);
CREATE INDEX IF NOT EXISTS wt_mint ON wallet_token(mint);
CREATE INDEX IF NOT EXISTS wt_first ON wallet_token(first_ts);
CREATE TABLE IF NOT EXISTS mentions(
  source TEXT, msg_id TEXT, mint TEXT, ts INTEGER, text TEXT, PRIMARY KEY(source, msg_id, mint)
);
CREATE INDEX IF NOT EXISTS mentions_mint ON mentions(mint);
CREATE TABLE IF NOT EXISTS push_subs(endpoint TEXT PRIMARY KEY, sub TEXT, created INTEGER);
CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY, ts INTEGER, mint TEXT, title TEXT, body TEXT);
`);

const kvGet = db.prepare('SELECT value FROM kv WHERE key=?');
const kvSet = db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
export function getKV(key, def = null) {
  const r = kvGet.get(key);
  if (!r) return def;
  try {
    return JSON.parse(r.value);
  } catch {
    return def;
  }
}
export function setKV(key, val) {
  kvSet.run(key, JSON.stringify(val));
}

export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(getKV('settings', {}) || {}) };
}
export function saveSettings(patch) {
  const cur = getSettings();
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    cur[k] = typeof DEFAULT_SETTINGS[k] === 'number' ? Number(v) : String(v);
  }
  setKV('settings', cur);
  return cur;
}

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

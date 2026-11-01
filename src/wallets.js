// スマートウォレットの自動発掘・KOL登録
import { db } from './db.js';
import { ENV } from './config.js';
import { fetchJson, isSolAddress, log, now } from './util.js';

const H = 3600e3;

/**
 * 決着済み（6時間以上前に初回購入）のトークンで、ウォレットごとの成績を集計。
 * 発行3秒以内に買うことが多いウォレットは「スナイパー」としてスマート扱いしない。
 */
export function updateWalletStats() {
  const cut = now() - 6 * H;
  const rows = db.prepare(`SELECT wallet, COUNT(*) n,
      SUM(CASE WHEN sell_sol > buy_sol*1.3 THEN 1 ELSE 0 END) wins,
      SUM(sell_sol - buy_sol) pnl, AVG(sniper) sniper_rate, AVG(buy_sol) avg_buy
    FROM wallet_token WHERE first_ts < ? AND first_ts > ? AND buy_sol > 0.05 AND sell_sol > 0
    GROUP BY wallet HAVING n >= 5`).all(cut, now() - 21 * 24 * H);
  const upsert = db.prepare(`INSERT INTO wallets(address,kind,source,added_at,n_tokens,wins,pnl_sol,sniper_rate,score,updated_at)
    VALUES(?,?, 'auto', ?, ?,?,?,?,?,?)
    ON CONFLICT(address) DO UPDATE SET n_tokens=excluded.n_tokens, wins=excluded.wins, pnl_sol=excluded.pnl_sol,
      sniper_rate=excluded.sniper_rate, score=excluded.score, updated_at=excluded.updated_at,
      kind=CASE WHEN wallets.kind IN ('kol','manual') THEN wallets.kind ELSE excluded.kind END`);
  let smart = 0;
  db.exec('BEGIN');
  for (const r of rows) {
    const winRate = r.wins / r.n;
    // スコア: 勝率×件数の信頼度×利益（対数）
    const score = winRate * Math.min(1, r.n / 20) * Math.log10(1 + Math.max(0, r.pnl));
    const isSmart = winRate >= 0.45 && r.pnl > 2 && r.sniper_rate < 0.3 && r.n <= 400;
    const kind = isSmart ? 'smart' : r.sniper_rate >= 0.3 ? 'sniper' : 'trader';
    if (isSmart) smart++;
    upsert.run(r.wallet, kind, now(), r.n, r.wins, r.pnl, r.sniper_rate, score, now());
  }
  db.exec('COMMIT');
  // 古い集計データを削除（ディスク節約、14日）
  db.prepare('DELETE FROM wallet_token WHERE last_ts < ?').run(now() - 14 * 24 * H);
  return { evaluated: rows.length, smart };
}

/** 監視対象: KOL/手動 + スコア上位のスマート */
export function watchedAddresses(maxSmart = 150) {
  const fixed = db.prepare(`SELECT address FROM wallets WHERE kind IN ('kol','manual')`).all().map((r) => r.address);
  const smart = db.prepare(`SELECT address FROM wallets WHERE kind='smart' ORDER BY score DESC LIMIT ?`).all(maxSmart).map((r) => r.address);
  return [...new Set([...fixed, ...smart])];
}

export function addWallet(address, label = '', kind = 'manual', source = 'manual') {
  if (!isSolAddress(address)) throw new Error('アドレスが不正');
  db.prepare(`INSERT INTO wallets(address,label,kind,source,added_at) VALUES(?,?,?,?,?)
    ON CONFLICT(address) DO UPDATE SET label=COALESCE(NULLIF(excluded.label,''),wallets.label), kind=excluded.kind, source=excluded.source`)
    .run(address, label, kind, source, now());
}

/** 「アドレス,名前」形式の行をまとめて登録 */
export function importWallets(text, kind = 'kol') {
  let n = 0;
  for (const line of String(text).split(/\r?\n/)) {
    const [addr, ...rest] = line.split(/[,\t ]+/).filter(Boolean);
    if (addr && isSolAddress(addr)) { addWallet(addr, rest.join(' ').slice(0, 40), kind, 'import'); n++; }
  }
  return n;
}

/** Solana Tracker のKOLリーダーボードから取り込み（APIキーがある場合） */
export async function importKolsFromSolanaTracker(period = '30d', limit = 100) {
  if (!ENV.SOLANATRACKER_API_KEY) throw new Error('SOLANATRACKER_API_KEY が未設定');
  const d = await fetchJson(`https://data.solanatracker.io/v2/pnl/leaderboard/kols/period?period=${period}&sort=realized&direction=desc&limit=${limit}`,
    { headers: { 'x-api-key': ENV.SOLANATRACKER_API_KEY } });
  const list = d?.traders || d?.data || d?.kols || [];
  let n = 0;
  for (const k of list) {
    const addr = k.wallet || k.address || k.walletAddress;
    const name = k.name || k.twitter || k.username || '';
    if (addr && isSolAddress(addr)) { addWallet(addr, String(name).slice(0, 40), 'kol', 'solanatracker'); n++; }
  }
  log('KOL取り込み', n);
  return n;
}

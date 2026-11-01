// Meme Scout 本体: 収集 → 評価 → 通知 → 答え合わせ → 学習 を24時間まわす
import { db, getSettings } from './db.js';
import { ENV } from './config.js';
import * as pp from './sources/pumpportal.js';
import { dexDiscover } from './sources/market.js';
import { pollChannels, status as tgStatus } from './sources/telegram.js';
import { flush, pruneWindows } from './live.js';
import { evaluateMany, touchToken } from './evaluator.js';
import { trackOnce, performance } from './tracker.js';
import { updateWalletStats, watchedAddresses } from './wallets.js';
import { train } from './learn.js';
import { notifyAll, vapidKeys } from './push.js';
import { startServer, setStatusFn } from './server.js';
import { log, now, pct } from './util.js';

if (!ENV.ACCESS_TOKEN) log('⚠ ACCESS_TOKEN が未設定です。.env に設定してください（外部公開するなら必須）');
vapidKeys();

// ---- 評価キュー ----
const queue = new Map(); // mint -> {reasons:Set, at}
const lastEval = new Map();
let busy = false;
const started = now();
const timers = {};

function enqueue(mint, reason) {
  if (reason !== 'watch') touchToken(mint, reason);
  const q = queue.get(mint) || { reasons: new Set(), at: now() };
  q.reasons.add(reason);
  queue.set(mint, q);
}

async function processQueue() {
  if (busy || !queue.size) return;
  busy = true;
  try {
    const pick = [];
    for (const [m] of queue) {
      if (now() - (lastEval.get(m) || 0) < 90e3) continue; // 90秒以内の再評価はしない
      pick.push(m);
      if (pick.length >= 15) break;
    }
    for (const m of pick) { queue.delete(m); lastEval.set(m, now()); }
    if (lastEval.size > 50000) lastEval.clear();
    if (pick.length) await evaluateMany(pick);
  } catch (e) {
    log('キュー処理エラー', e.message);
  } finally {
    busy = false;
  }
}

// 卒業したトークンは少し時間をおいて評価（直後は価格が荒れるため 2分後と10分後）
pp.setHandlers({
  onMigration: (mint) => {
    setTimeout(() => enqueue(mint, 'migrate'), 2 * 60e3);
    setTimeout(() => enqueue(mint, 'migrate'), 10 * 60e3);
  },
  onTrackedBuy: (mint) => {
    pp.subscribeToken(mint);
    enqueue(mint, 'wallet');
  },
});

function every(name, ms, fn) {
  const run = async () => {
    try { await fn(); } catch (e) { log(`${name} エラー`, e.message); }
  };
  timers[name] = setInterval(run, ms);
  return run;
}

function watchList() {
  const S = getSettings();
  return db.prepare(`SELECT t.mint FROM tokens t WHERE t.last_decision IN ('watch','notify','reject_soft') AND t.last_eval > ?
    AND (SELECT MIN(ts) FROM evals WHERE mint=t.mint) > ?`).all(now() - S.watchHours * 3600e3, now() - S.watchHours * 3600e3).map((r) => r.mint);
}

function status() {
  return {
    uptimeMin: Math.round((now() - started) / 60000),
    pumpportal: { ...pp.status, subs: pp.subCounts(), regime: pp.regime() },
    telegram: tgStatus,
    queue: queue.size,
  };
}
setStatusFn(status);

startServer();
pp.connect();

every('flush', 1000, flush);
every('queue', 4000, processQueue);
every('tracker', 60e3, trackOnce);
const cave = every('telegram', 60e3, async () => {
  const chans = getSettings().caveChannels.split(',').map((s) => s.trim()).filter(Boolean);
  for (const m of await pollChannels(chans)) { pp.subscribeToken(m.mint); enqueue(m.mint, 'cave'); }
});
every('dexscreener', 120e3, async () => {
  for (const m of await dexDiscover()) if (now() - (lastEval.get(m) || 0) > 30 * 60e3) enqueue(m, 'dex');
});
every('watch', 180e3, () => { for (const m of watchList()) enqueue(m, 'watch'); });
every('prune', 60e3, () => {
  pruneWindows();
  pp.pruneTokenSubs(false, new Set(watchList()));
});
const hourly = every('hourly', 3600e3, () => {
  const ws = updateWalletStats();
  pp.setAccountSubs(watchedAddresses());
  const m = train();
  log('毎時更新', `スマート${ws.smart}件`, m.note || '');
});
// 毎朝9時(JST)に前日のまとめ
let lastSummaryDay = -1;
every('summary', 60e3, async () => {
  const d = new Date(now() + 9 * 3600e3);
  if (d.getUTCHours() !== 9 || d.getUTCDate() === lastSummaryDay) return;
  lastSummaryDay = d.getUTCDate();
  const p = performance(24 * 3600e3).notified;
  if (!p.n) return;
  await notifyAll({ title: '📊 昨日の成績（ペーパー）', body: `通知${p.n}件・2倍到達${p.wins}件（${pct(p.winRate)}）・平均${(p.avgRet * 100).toFixed(0)}%（手数料込み）・ラグ${p.rugs}件` });
});

setTimeout(cave, 3000);
setTimeout(hourly, 15000);

process.on('SIGTERM', () => { flush(); db.close(); process.exit(0); });
process.on('SIGINT', () => { flush(); db.close(); process.exit(0); });
log(`Meme Scout 起動（オフライン=${ENV.OFFLINE ? 'はい' : 'いいえ'}）`);

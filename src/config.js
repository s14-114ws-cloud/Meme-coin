// 環境変数(.env) と 戦略設定(DBに保存・画面から変更可)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^".*"$|^'.*'$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotEnv();

const e = process.env;
export const ENV = {
  PORT: +(e.PORT || 8787),
  HOST: e.HOST || '127.0.0.1',
  DATA_DIR: e.DATA_DIR || path.join(ROOT, 'data'),
  ACCESS_TOKEN: e.ACCESS_TOKEN || '',
  VAPID_SUBJECT: e.VAPID_SUBJECT || 'mailto:admin@example.com',
  TELEGRAM_BOT_TOKEN: e.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: e.TELEGRAM_CHAT_ID || '',
  SOLANATRACKER_API_KEY: e.SOLANATRACKER_API_KEY || '',
  BUBBLEMAPS_API_KEY: e.BUBBLEMAPS_API_KEY || '',
  RPC_URL: e.RPC_URL || (e.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${e.HELIUS_API_KEY}` : 'https://api.mainnet-beta.solana.com'),
  OWN_CLUSTER: (e.OWN_CLUSTER || '1') === '1', // 自前バブルマップ
  BUBBLEMAPS_KEY_HEADER: e.BUBBLEMAPS_KEY_HEADER || 'x-api-key',
  TRACK_NEW_TOKENS: (e.TRACK_NEW_TOKENS || '1') === '1',
  MAX_TOKEN_SUBS: +(e.MAX_TOKEN_SUBS || 600),
  OFFLINE: e.OFFLINE === '1', // テスト用: 外部接続しない
};

// 戦略の初期値（画面の「設定」から変更でき、DBに保存される）
export const DEFAULT_SETTINGS = {
  tp: 1.0, // 利確 +100%（2倍）
  sl: 0.4, // 損切り -40%
  cost: 0.06, // 往復コスト（DEX手数料+Bot手数料+スリッページ+優先手数料）
  minEv: 0.05, // 通知に必要な期待値（手数料込み、1トレードあたり）
  minLiqUsd: 15000,
  minMcapUsd: 40000,
  maxMcapUsd: 5000000,
  maxAgeH: 72,
  maxTop10: 30, // 上位10ホルダー合計%（プール除く）
  maxSingle: 5, // 単独ホルダー最大%
  maxCluster: 15, // つながったウォレット群の合計%
  maxDev: 5, // dev保有%
  maxSniper: 20, // 発行3秒以内の購入が供給に占める%
  maxSerialDev: 30, // 同じdevが作った（卒業できなかった）トークン数
  maxOverextM5: 60, // 5分で+60%以上は「飛びつき」として押し目待ち
  maxAboveVwap: 0.5, // 30分VWAPより50%以上上なら押し目待ち
  maxSellImpact: 0.15,
  maxFresh: 30, // 作成3日以内の新しいウォレットが持つ供給%（これ以上は警告） // 売却時の価格インパクト上限
  watchHours: 6, // 監視中トークンを再評価し続ける時間
  positionSol: 0.5, // 想定の1回の購入額（SOL）
  caveChannels: 'CAVE_JPN', // 監視する公開Telegramチャンネル（カンマ区切り）
  quietStart: -1, // 通知しない時間帯（JST, -1で無効）
  quietEnd: -1,
};

// 共通ユーティリティ
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => Date.now();
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const num = (x, d = 0) => (Number.isFinite(+x) ? +x : d);

export function log(...a) {
  const t = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${t}]`, ...a);
}

const UA = 'Mozilla/5.0 (memescout; personal use)';

export async function fetchRaw(url, { headers = {}, timeout = 12000, method = 'GET', body } = {}) {
  const ctl = new AbortController();
  const id = setTimeout(() => ctl.abort(), timeout);
  try {
    return await fetch(url, {
      method,
      headers: { 'user-agent': UA, ...headers },
      body,
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(id);
  }
}

export async function fetchJson(url, opts = {}) {
  const r = await fetchRaw(url, { ...opts, headers: { accept: 'application/json', ...(opts.headers || {}) } });
  if (!r.ok) {
    const e = new Error(`HTTP ${r.status} ${url}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

export async function fetchText(url, opts = {}) {
  const r = await fetchRaw(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.text();
}

// ---- Base58 / Solanaアドレス ----
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58MAP = Object.fromEntries([...B58].map((c, i) => [c, BigInt(i)]));
export function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const v = B58MAP[c];
    if (v === undefined) throw new Error('bad b58');
    n = n * 58n + v;
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 255n));
    n >>= 8n;
  }
  for (const c of s) {
    if (c === '1') bytes.unshift(0);
    else break;
  }
  return Uint8Array.from(bytes);
}
export function isSolAddress(s) {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
  try {
    return b58decode(s).length === 32;
  } catch {
    return false;
  }
}
// 通貨として扱わないアドレス（SOL/USDC/USDTなど）
const IGNORE = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  '11111111111111111111111111111111',
]);
export function extractMints(text) {
  const m = String(text || '').match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || [];
  return [...new Set(m.filter((x) => !IGNORE.has(x) && isSolAddress(x)))];
}

export const sigmoid = (z) => 1 / (1 + Math.exp(-z));
export const fmtUsd = (x) => {
  x = num(x);
  if (x >= 1e9) return `$${(x / 1e9).toFixed(2)}B`;
  if (x >= 1e6) return `$${(x / 1e6).toFixed(2)}M`;
  if (x >= 1e3) return `$${(x / 1e3).toFixed(1)}k`;
  return `$${x.toFixed(0)}`;
};
export const pct = (x, d = 0) => `${(num(x) * 100).toFixed(d)}%`;

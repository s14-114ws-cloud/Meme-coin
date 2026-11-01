// DexScreener（価格・流動性・出来高） / RugCheck（安全性） / Jupiter（売却ルート・インパクト） / Bubblemaps（任意）
import { fetchJson, log, now } from '../util.js';
import { ENV } from '../config.js';

const DS = 'https://api.dexscreener.com';
const SOL = 'So11111111111111111111111111111111111111112';

/** 複数トークンの最良ペア（流動性最大）を返す Map<mint, pair> */
export async function dexPairs(mints) {
  const out = new Map();
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    try {
      const arr = await fetchJson(`${DS}/tokens/v1/solana/${chunk.join(',')}`);
      for (const p of Array.isArray(arr) ? arr : arr?.pairs || []) {
        const m = p?.baseToken?.address;
        if (!m || !chunk.includes(m)) continue;
        const cur = out.get(m);
        if (!cur || (p.liquidity?.usd || 0) > (cur.liquidity?.usd || 0)) out.set(m, p);
      }
    } catch (e) {
      log('DexScreener エラー', e.message);
    }
  }
  return out;
}

/** 新しくブースト/プロフィール登録されたSolanaトークン */
export async function dexDiscover() {
  const found = new Set();
  for (const path of ['/token-boosts/latest/v1', '/token-profiles/latest/v1', '/token-boosts/top/v1']) {
    try {
      const arr = await fetchJson(DS + path);
      for (const x of Array.isArray(arr) ? arr : []) if (x.chainId === 'solana' && x.tokenAddress) found.add(x.tokenAddress);
    } catch (e) {
      log('DexScreener discover エラー', e.message);
    }
  }
  return [...found];
}

const rcCache = new Map();
export async function rugcheck(mint, maxAgeMs = 10 * 60e3) {
  const c = rcCache.get(mint);
  if (c && now() - c.ts < maxAgeMs) return c.data;
  try {
    const data = await fetchJson(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { timeout: 15000 });
    rcCache.set(mint, { ts: now(), data });
    if (rcCache.size > 3000) rcCache.delete(rcCache.keys().next().value);
    return data;
  } catch (e) {
    log('RugCheck エラー', mint.slice(0, 6), e.message);
    return c?.data || null;
  }
}

const jupCache = new Map();
/** positionSol相当のトークンを売るルートがあるか、価格インパクトは？ */
export async function sellQuote(mint, priceNative, decimals, positionSol) {
  const c = jupCache.get(mint);
  if (c && now() - c.ts < 10 * 60e3) return c.data;
  let data = { ok: null, impact: null };
  if (priceNative > 0 && Number.isFinite(decimals)) {
    const amount = BigInt(Math.floor((positionSol / priceNative) * 10 ** decimals));
    try {
      const q = await fetchJson(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${mint}&outputMint=${SOL}&amount=${amount}&slippageBps=2000`);
      data = { ok: !!q?.outAmount, impact: q?.priceImpactPct != null ? Math.abs(+q.priceImpactPct) : null };
    } catch (e) {
      data = { ok: e.status === 400 ? false : null, impact: null }; // 400=ルートなし
    }
  }
  jupCache.set(mint, { ts: now(), data });
  if (jupCache.size > 3000) jupCache.delete(jupCache.keys().next().value);
  return data;
}

/** Bubblemaps（APIキーがある場合のみ）: 最大クラスタの供給シェア% */
export async function bubblemaps(mint) {
  if (!ENV.BUBBLEMAPS_API_KEY) return null;
  try {
    const d = await fetchJson(`https://api.bubblemaps.io/v0/tokens/map/solana/${mint}`, {
      headers: { [ENV.BUBBLEMAPS_KEY_HEADER]: ENV.BUBBLEMAPS_API_KEY },
      timeout: 20000,
    });
    const clusters = d?.clusters || [];
    let maxShare = 0;
    for (const c of clusters) {
      let s = +(c.share ?? c.supply_share ?? c.percentage ?? 0);
      if (s <= 1) s *= 100;
      maxShare = Math.max(maxShare, s);
    }
    return { maxClusterPct: maxShare, nClusters: clusters.length };
  } catch (e) {
    log('Bubblemaps エラー', e.message);
    return null;
  }
}

/** RugCheckレポートから保有集中・クラスタ・危険フラグを要約 */
export function summarizeRugcheck(rc, bondingCurve) {
  if (!rc) return null;
  const known = rc.knownAccounts || {};
  const isPoolish = (h) => {
    const k = known[h.owner] || known[h.address];
    if (k && /AMM|LOCKER|BURN|PROGRAM|POOL|CURVE/i.test(String(k.type || '') + String(k.name || ''))) return true;
    if (bondingCurve && (h.owner === bondingCurve || h.address === bondingCurve)) return true;
    return false;
  };
  const holders = (rc.topHolders || []).filter((h) => !isPoolish(h));
  const pcts = holders.map((h) => +h.pct || 0).sort((a, b) => b - a);
  const top10 = pcts.slice(0, 10).reduce((a, b) => a + b, 0);
  const single = pcts[0] || 0;
  const insiderPct = holders.filter((h) => h.insider).reduce((a, h) => a + (+h.pct || 0), 0);
  const risks = rc.risks || [];
  const riskNames = risks.map((r) => `${r.name}`);
  const dangerExt = risks.some((r) => /permanent delegate|transfer hook|transfer fee|non[- ]?transferable|default account state/i.test(r.name || ''));
  const creatorPct = (() => {
    const h = (rc.topHolders || []).find((x) => x.owner === rc.creator || x.address === rc.creator);
    return h ? +h.pct || 0 : null;
  })();
  // 主要マーケットのLPロック率
  let lpLocked = null;
  const mk = (rc.markets || []).slice().sort((a, b) => (b.lp?.quoteUSD || 0) - (a.lp?.quoteUSD || 0))[0];
  if (mk && mk.lp && mk.lp.lpLockedPct != null) lpLocked = +mk.lp.lpLockedPct;
  return {
    mintAuth: !!rc.mintAuthority,
    freezeAuth: !!rc.freezeAuthority,
    dangerExt: dangerExt || (+rc.transferFee?.pct || 0) > 0,
    rugged: !!rc.rugged,
    top10, single, insiderPct,
    insiderNetworks: (rc.insiderNetworks || []).length,
    graphInsiders: +rc.graphInsidersDetected || 0,
    creatorPct,
    lpLocked,
    decimals: rc.token?.decimals != null ? +rc.token.decimals : null,
    scoreNorm: rc.score_normalised != null ? +rc.score_normalised : null,
    mutable: !!rc.tokenMeta?.mutable,
    riskNames,
    creator: rc.creator || null,
  };
}

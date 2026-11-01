// 評価ロジック: ①足切り ②伸び代 ③タイミング ④手数料込み期待値
import { clamp, num, sigmoid } from './util.js';

/**
 * ctx = { now, pair(DexScreener), rc(要約), bm, jup, tok(DB行), flow, over, inv, ment, dev, regime, solUsd }
 * 特徴量はすべて数値（欠損は0 + has_* フラグ）
 */
export function computeFeatures(ctx) {
  const p = ctx.pair || {};
  const rc = ctx.rc || {};
  const mcap = num(p.marketCap || p.fdv);
  const liq = num(p.liquidity?.usd);
  const createdAt = ctx.tok?.created_at || p.pairCreatedAt || null;
  const ageMin = createdAt ? (ctx.now - createdAt) / 60000 : null;
  const tx5 = p.txns?.m5 || {}, tx1 = p.txns?.h1 || {};
  const b5 = num(tx5.buys), s5 = num(tx5.sells), b1 = num(tx1.buys), s1 = num(tx1.sells);
  const flow = ctx.flow || {};
  const over = ctx.over || {};
  const inv = ctx.inv || {};
  const ment = ctx.ment || {};
  const socials = p.info?.socials || [];
  const solUsd = num(ctx.solUsd, 0);
  const curMcSol = solUsd > 0 ? mcap / solUsd : null;
  const aboveVwap = flow.vwapMcSol && curMcSol ? curMcSol / flow.vwapMcSol - 1 : 0;
  const high = num(ctx.highMcap, mcap);
  const f = {
    log_mcap: Math.log10(Math.max(mcap, 1)),
    log_liq: Math.log10(Math.max(liq, 1)),
    liq_to_mcap: mcap > 0 ? liq / mcap : 0,
    log_age_min: ageMin != null ? Math.log10(Math.max(ageMin, 1)) : 0,
    has_age: ageMin != null ? 1 : 0,
    top10: num(rc.top10),
    single: num(rc.single),
    insider_pct: num(rc.insiderPct),
    cluster_pct: Math.max(num(ctx.bm?.maxClusterPct), num(rc.insiderPct)),
    insider_networks: num(rc.insiderNetworks),
    dev_pct: num(rc.creatorPct ?? ctx.tok?.dev_pct),
    sniper_pct: num(ctx.tok?.sniper_pct),
    has_early: ctx.tok?.created_at ? 1 : 0,
    dev_prev_tokens: Math.log10(1 + num(ctx.dev?.prev)),
    dev_prev_mig_rate: num(ctx.dev?.migRate),
    rc_score: num(rc.scoreNorm),
    mutable: rc.mutable ? 1 : 0,
    buy_ratio_m5: b5 + s5 > 0 ? b5 / (b5 + s5) : 0.5,
    buy_ratio_h1: b1 + s1 > 0 ? b1 / (b1 + s1) : 0.5,
    tx_m5: Math.log10(1 + b5 + s5),
    vol_h1_liq: liq > 0 ? num(p.volume?.h1) / liq : 0,
    vol_m5_liq: liq > 0 ? num(p.volume?.m5) / liq : 0,
    pc_m5: num(p.priceChange?.m5) / 100,
    pc_h1: num(p.priceChange?.h1) / 100,
    pc_h6: num(p.priceChange?.h6) / 100,
    from_high: high > 0 ? mcap / high - 1 : 0, // 0=高値圏、-0.4=高値から-40%
    above_vwap: aboveVwap,
    uniq_buyers_15m: Math.log10(1 + num(flow.uniqueBuyers)),
    net_flow_sol_15m: clamp(num(flow.netSol), -200, 200),
    has_flow: flow.has ? 1 : 0,
    overhang_pct: num(over.pct),
    sniper_held_pct: num(over.sniperHeldPct),
    smart_holding: num(inv.smartHolding),
    kol_holding: num(inv.kolHolding),
    kol_sold: num(inv.kolSold),
    min_since_kol: inv.firstKolTs ? Math.log10(1 + (ctx.now - inv.firstKolTs) / 60000) : 0,
    mentions: num(ment.n),
    mention_sources: num(ment.sources),
    has_twitter: socials.some((s) => /twitter|x/i.test(s.type || '')) ? 1 : 0,
    has_tg: socials.some((s) => /telegram/i.test(s.type || '')) ? 1 : 0,
    has_web: (p.info?.websites || []).length ? 1 : 0,
    boosted: num(p.boosts?.active) > 0 ? 1 : 0,
    sell_impact: num(ctx.jup?.impact),
    migrations_1h: Math.log10(1 + num(ctx.regime?.migrations1h)),
    migrated: ctx.tok?.migrated_at ? 1 : 0,
  };
  return f;
}
export const FEATURE_KEYS = Object.keys(computeFeatures({ now: 0 }));

/** ①足切り: 1つでも該当→除外。データ欠損は「不明」として警告のみ */
export function runFilters(ctx, f, S) {
  const fails = [];
  const warns = [];
  const p = ctx.pair;
  const rc = ctx.rc;
  if (!p) fails.push(['no_pair', 'DEXの取引ペアが見つからない']);
  if (!rc) warns.push(['no_rc', 'RugCheck取得失敗（安全性未確認）']);
  if (rc) {
    if (rc.mintAuth) fails.push(['mint_auth', '追加発行（Mint）権限が残っている']);
    if (rc.freezeAuth) fails.push(['freeze_auth', '凍結（Freeze）権限が残っている']);
    if (rc.dangerExt) fails.push(['danger_ext', 'Token-2022の危険な拡張（送金手数料/永久委任など）']);
    if (rc.rugged) fails.push(['rugged', 'RugCheckでラグ判定済み']);
    if (rc.lpLocked != null && rc.lpLocked < 80 && !ctx.tok?.migrated_at) fails.push(['lp_unlocked', `LPロック ${rc.lpLocked.toFixed(0)}%`]);
    if (f.top10 > S.maxTop10) fails.push(['top10', `上位10ホルダー ${f.top10.toFixed(1)}%`]);
    if (f.single > S.maxSingle) fails.push(['single', `単独ホルダー ${f.single.toFixed(1)}%`]);
    if (f.dev_pct > S.maxDev) fails.push(['dev', `dev保有 ${f.dev_pct.toFixed(1)}%`]);
  }
  if (f.cluster_pct > S.maxCluster) fails.push(['cluster', `つながったウォレット群 ${f.cluster_pct.toFixed(1)}%`]);
  if (f.sniper_pct > S.maxSniper) fails.push(['sniper', `発行3秒以内の買い ${f.sniper_pct.toFixed(1)}%`]);
  if (ctx.dev && ctx.dev.prev >= S.maxSerialDev && ctx.dev.migRate < 0.05) fails.push(['serial_dev', `devが${ctx.dev.prev}個発行、ほぼ全滅`]);
  if (p) {
    const liq = num(p.liquidity?.usd), mcap = num(p.marketCap || p.fdv);
    if (liq < S.minLiqUsd) fails.push(['liq', `流動性 $${Math.round(liq)} 不足`]);
    if (mcap < S.minMcapUsd) fails.push(['mcap_low', '時価総額が小さすぎる']);
    if (mcap > S.maxMcapUsd) fails.push(['mcap_high', '時価総額が大きく伸び代が小さい']);
    const created = ctx.tok?.created_at || p.pairCreatedAt;
    if (created && ctx.now - created > S.maxAgeH * 3600e3) fails.push(['old', 'ローンチから時間が経ちすぎ']);
  }
  if (ctx.jup && ctx.jup.ok === false) fails.push(['no_sell', '売却ルートなし（ハニーポットの疑い）']);
  if (ctx.jup && ctx.jup.impact != null && ctx.jup.impact > S.maxSellImpact) fails.push(['sell_impact', `売却インパクト ${(ctx.jup.impact * 100).toFixed(0)}%`]);
  if (f.kol_sold >= 2 && f.kol_holding === 0) warns.push(['kol_exit', 'KOLが既に売り抜け']);
  if (f.vol_h1_liq > 40) warns.push(['wash', '出来高/流動性が異常（自作自演の疑い）']);
  return { pass: fails.length === 0, fails, warns };
}

/** 学習前の初期推定（学習データが貯まるとモデルに置き換わる） */
export function ruleLogit(f) {
  let z = -1.75; // 基準 ≒ 15%
  z += 0.45 * Math.min(f.smart_holding, 4);
  z += 0.15 * Math.min(f.kol_holding, 3);
  z -= 0.5 * Math.min(f.kol_sold, 3);
  z += 1.2 * (f.buy_ratio_m5 - 0.5);
  z += 0.6 * (f.uniq_buyers_15m - 1.3);
  z += 0.35 * Math.min(f.mention_sources, 2);
  z += f.liq_to_mcap >= 0.15 ? 0.25 : f.liq_to_mcap < 0.07 ? -0.3 : 0;
  z -= f.pc_m5 > 0.4 ? 0.6 : 0;
  z -= 1.5 * Math.max(0, f.above_vwap - 0.2);
  z += f.from_high < -0.3 && f.from_high > -0.6 && f.buy_ratio_m5 >= 0.5 ? 0.25 : 0;
  z -= 0.06 * f.overhang_pct;
  z -= 0.04 * f.sniper_held_pct;
  z -= 0.02 * Math.max(0, f.top10 - 15);
  z += 0.15 * (f.has_twitter + f.has_tg + f.has_web > 1 ? 1 : 0);
  z -= f.log_mcap > 6.5 ? 0.4 : 0;
  z -= 0.3 * Math.min(f.dev_prev_tokens, 2);
  z += 0.3 * (f.migrations_1h - 1.3);
  return z;
}
export const ruleProb = (f) => sigmoid(ruleLogit(f));

/** 期待値（手数料込み・1トレードあたり） */
export function expectedValue(p, S) {
  return p * (S.tp - S.cost) - (1 - p) * (S.sl + S.cost);
}
export const breakevenProb = (S) => (S.sl + S.cost) / (S.tp + S.sl);

/** ③タイミング判定と最終判断 */
export function decide(ctx, f, filt, p, S) {
  const reasons = [];
  const good = [];
  if (!filt.pass) return { decision: 'reject', reasons: filt.fails.map((x) => '✗ ' + x[1]), good };
  const ev = expectedValue(p, S);
  // 伸び代・安心材料
  if (f.smart_holding) good.push(`スマートマネー${f.smart_holding}件が保有中`);
  if (f.kol_holding) good.push(`KOL${f.kol_holding}件が保有中`);
  if (f.mentions) good.push(`コミュニティ言及${f.mentions}件`);
  if (f.liq_to_mcap >= 0.15) good.push('時価総額に対して流動性が厚い');
  if (f.top10 && f.top10 < 15) good.push(`保有が分散（上位10: ${f.top10.toFixed(0)}%）`);
  if (f.buy_ratio_m5 >= 0.6) good.push('直近5分は買い優勢');
  if (f.has_flow && f.uniq_buyers_15m >= 1.5) good.push(`15分で新規買い手 ${Math.round(10 ** f.uniq_buyers_15m - 1)}人`);
  if (f.from_high < -0.3 && f.from_high > -0.6) good.push(`高値から${Math.round(-f.from_high * 100)}%押し`);
  // 注意
  for (const w of filt.warns) reasons.push('⚠ ' + w[1]);
  if (f.overhang_pct > 10) reasons.push(`⚠ 初期勢の含み益玉 ${f.overhang_pct.toFixed(0)}%（売り圧）`);
  if (f.kol_sold) reasons.push(`⚠ KOL ${f.kol_sold}件が売却済み`);
  // タイミング（飛びつき防止）
  const overext = f.pc_m5 * 100 > S.maxOverextM5 || f.above_vwap > S.maxAboveVwap;
  if (overext) reasons.push('⏸ 急騰中（押し目待ち）');
  let decision = 'watch';
  if (!overext && ev >= S.minEv && p >= breakevenProb(S)) decision = 'notify';
  return { decision, reasons, good, ev };
}

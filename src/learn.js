// 学習: 「手数料込みで+TPと-SLのどちらに先に届くか」をロジスティック回帰で予測
// 時系列の後ろ20%で検証し、初期ルールより良いときだけモデルを使う（過学習対策）
import { db, getKV, setKV } from './db.js';
import { FEATURE_KEYS, ruleLogit } from './score.js';
import { sigmoid, log, now, clamp } from './util.js';

export function loadModel() {
  return getKV('model', null);
}

export function predict(f, model = loadModel()) {
  const pRule = sigmoid(ruleLogit(f));
  if (!model || !model.use) return { p: pRule, pRule, pModel: null, w: 0 };
  let z = model.b;
  for (let i = 0; i < model.keys.length; i++) {
    const k = model.keys[i];
    const x = ((f[k] ?? 0) - model.mean[i]) / model.std[i];
    z += model.w[i] * clamp(x, -6, 6);
  }
  const pModel = sigmoid(z);
  const w = model.blend;
  return { p: w * pModel + (1 - w) * pRule, pRule, pModel, w };
}

function auc(ys, ps) {
  const pos = [], neg = [];
  ys.forEach((y, i) => (y ? pos : neg).push(ps[i]));
  if (!pos.length || !neg.length) return 0.5;
  let s = 0;
  for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0;
  return s / (pos.length * neg.length);
}
const logloss = (ys, ps) => -ys.reduce((a, y, i) => a + (y ? Math.log(Math.max(ps[i], 1e-6)) : Math.log(Math.max(1 - ps[i], 1e-6))), 0) / Math.max(ys.length, 1);

function fitLR(X, y, { l2 = 0.5, iters = 400, lr = 0.3 } = {}) {
  const d = X[0].length, n = X.length;
  const w = new Array(d).fill(0);
  let b = Math.log((y.reduce((a, c) => a + c, 0) + 1) / (n - y.reduce((a, c) => a + c, 0) + 1));
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * X[i][j];
      const e = sigmoid(z) - y[i];
      gb += e;
      for (let j = 0; j < d; j++) gw[j] += e * X[i][j];
    }
    b -= (lr * gb) / n;
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + (l2 * w[j]) / n);
  }
  return { w, b };
}

/** 学習データ: 決着したペーパートレード（足切り通過分） */
export function trainingRows() {
  return db.prepare(`SELECT p.outcome, p.entry_ts, e.features FROM paper p JOIN evals e ON e.id=p.eval_id
    WHERE p.outcome IS NOT NULL AND p.passed=1 ORDER BY p.entry_ts`).all()
    .map((r) => ({ y: r.outcome === 'tp' ? 1 : 0, ts: r.entry_ts, f: JSON.parse(r.features) }));
}

export function train(rows = trainingRows()) {
  const n = rows.length;
  const npos = rows.filter((r) => r.y).length;
  const info = { n, npos, trainedAt: now() };
  if (n < 60 || npos < 8 || n - npos < 8) {
    const m = { ...info, use: false, note: `学習データ不足（${n}件・成功${npos}件。60件・成功8件以上で学習開始）` };
    setKV('model', m);
    return m;
  }
  const keys = FEATURE_KEYS;
  const mean = keys.map((k) => rows.reduce((a, r) => a + (r.f[k] ?? 0), 0) / n);
  const std = keys.map((k, j) => Math.sqrt(rows.reduce((a, r) => a + ((r.f[k] ?? 0) - mean[j]) ** 2, 0) / n) || 1);
  const toX = (r) => keys.map((k, j) => clamp(((r.f[k] ?? 0) - mean[j]) / std[j], -6, 6));
  const cut = Math.floor(n * 0.8);
  const tr = rows.slice(0, cut), te = rows.slice(cut);
  const m1 = fitLR(tr.map(toX), tr.map((r) => r.y));
  const pm = te.map((r) => sigmoid(m1.b + toX(r).reduce((a, x, j) => a + x * m1.w[j], 0)));
  const pr = te.map((r) => sigmoid(ruleLogit(r.f)));
  const yt = te.map((r) => r.y);
  const evalM = { auc: auc(yt, pm), logloss: logloss(yt, pm) };
  const evalR = { auc: auc(yt, pr), logloss: logloss(yt, pr) };
  const better = evalM.auc > evalR.auc + 0.01 && evalM.logloss <= evalR.logloss + 0.02;
  const full = fitLR(rows.map(toX), rows.map((r) => r.y));
  const blend = better ? clamp((n - 60) / 400, 0.25, 1) : 0;
  const top = keys.map((k, j) => [k, full.w[j]]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 12);
  const m = { ...info, use: better, blend, keys, mean, std, w: full.w, b: full.b, holdout: { model: evalM, rule: evalR, n: te.length }, top,
    note: better ? `モデル採用（検証AUC ${evalM.auc.toFixed(2)} > 初期ルール ${evalR.auc.toFixed(2)}）` : `初期ルールの方が良いので継続（モデルAUC ${evalM.auc.toFixed(2)} / ルール ${evalR.auc.toFixed(2)}）` };
  setKV('model', m);
  log('学習完了', m.note);
  return m;
}

/** 予測と実際のズレ（確率帯ごとの実際の成功率） */
export function calibration() {
  const rows = db.prepare(`SELECT p.outcome, e.p FROM paper p JOIN evals e ON e.id=p.eval_id WHERE p.outcome IS NOT NULL AND p.passed=1`).all();
  const bins = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 1.01].slice(0, -1).map((lo, i, a) => ({ lo, hi: [0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 1.01][i], n: 0, hit: 0, pSum: 0 }));
  for (const r of rows) {
    const b = bins.find((x) => r.p >= x.lo && r.p < x.hi);
    if (!b) continue;
    b.n++; b.pSum += r.p; if (r.outcome === 'tp') b.hit++;
  }
  return bins.map((b) => ({ range: `${Math.round(b.lo * 100)}-${Math.round(Math.min(b.hi, 1) * 100)}%`, n: b.n, predicted: b.n ? b.pSum / b.n : null, actual: b.n ? b.hit / b.n : null }));
}

// HTTP API + PWA配信
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, getSettings, saveSettings } from './db.js';
import { ENV, ROOT, DEFAULT_SETTINGS } from './config.js';
import { vapidKeys, saveSubscription, notifyAll } from './push.js';
import { evaluateMany } from './evaluator.js';
import { performance } from './tracker.js';
import { loadModel, calibration, train } from './learn.js';
import { addWallet, importWallets, importKolsFromSolanaTracker } from './wallets.js';
import { addManualMention } from './sources/telegram.js';
import { breakevenProb } from './score.js';
import { isSolAddress, extractMints, log } from './util.js';

const WEB = path.join(ROOT, 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };

let statusFn = () => ({});
export function setStatusFn(fn) { statusFn = fn; }

function send(res, code, obj) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'content-type': typeof obj === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
async function readBody(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 1e6) throw new Error('too large'); }
  return s ? JSON.parse(s) : {};
}
function authed(req, url) {
  if (!ENV.ACCESS_TOKEN) return true;
  const t = req.headers['x-token'] || url.searchParams.get('t') || '';
  const a = Buffer.from(String(t)), b = Buffer.from(ENV.ACCESS_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const latestEvalJoin = `SELECT t.mint, t.symbol, t.name, t.sources, t.created_at, t.migrated_at, t.notified_at, t.last_decision,
  e.ts, e.price, e.mcap, e.liq, e.p, e.ev, e.decision, e.reasons,
  (SELECT json_object('outcome',p.outcome,'max',p.max_mult,'last',p.last_mult,'entry',p.entry_price) FROM paper p WHERE p.mint=t.mint ORDER BY p.notified DESC, p.entry_ts DESC LIMIT 1) paper
  FROM tokens t JOIN evals e ON e.id=(SELECT id FROM evals WHERE mint=t.mint ORDER BY ts DESC LIMIT 1)`;

function feed(view) {
  const since = Date.now() - 48 * 3600e3;
  let where = 't.last_eval > ?';
  let order = 'e.ts DESC';
  if (view === 'notify') { where += ' AND t.notified_at IS NOT NULL'; order = 't.notified_at DESC'; }
  else if (view === 'watch') { where += " AND t.last_decision IN ('watch','notify')"; order = 'e.p DESC'; }
  const rows = db.prepare(`${latestEvalJoin} WHERE ${where} ORDER BY ${order} LIMIT 120`).all(since);
  return rows.map((r) => ({ ...r, reasons: JSON.parse(r.reasons || '{}'), paper: r.paper ? JSON.parse(r.paper) : null }));
}

function tokenDetail(mint) {
  const tok = db.prepare('SELECT * FROM tokens WHERE mint=?').get(mint);
  if (!tok) return null;
  const evals = db.prepare('SELECT id, ts, price, mcap, liq, p, ev, decision, reasons, filters, features FROM evals WHERE mint=? ORDER BY ts DESC LIMIT 40').all(mint)
    .map((e) => ({ ...e, reasons: JSON.parse(e.reasons), filters: JSON.parse(e.filters), features: JSON.parse(e.features) }));
  const papers = db.prepare('SELECT * FROM paper WHERE mint=? ORDER BY entry_ts DESC').all(mint);
  const mentions = db.prepare('SELECT source, ts, text FROM mentions WHERE mint=? ORDER BY ts DESC LIMIT 20').all(mint);
  const wallets = db.prepare(`SELECT w.address, w.label, w.kind, t.buy_sol, t.sell_sol, t.first_ts FROM wallet_token t JOIN wallets w ON w.address=t.wallet
    WHERE t.mint=? AND w.kind IN ('smart','kol','manual') ORDER BY t.first_ts`).all(mint);
  return { tok, evals, papers, mentions, wallets };
}

export function startServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (!p.startsWith('/api/')) {
        let f = path.normalize(path.join(WEB, p === '/' ? 'index.html' : p));
        if (!f.startsWith(WEB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(WEB, 'index.html');
        res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': p.endsWith('sw.js') ? 'no-cache' : 'public, max-age=300' });
        return fs.createReadStream(f).pipe(res);
      }
      if (p === '/api/vapid') return send(res, 200, { publicKey: vapidKeys().publicKey });
      if (!authed(req, url)) return send(res, 401, { error: 'unauthorized' });
      const M = req.method;
      if (p === '/api/ping') return send(res, 200, { ok: true });
      if (p === '/api/push/subscribe' && M === 'POST') { saveSubscription((await readBody(req)).subscription); return send(res, 200, { ok: true }); }
      if (p === '/api/push/test' && M === 'POST') {
        await notifyAll({ title: '✅ テスト通知', body: 'Meme Scoutからの通知が届きました' });
        return send(res, 200, { ok: true, subs: db.prepare('SELECT COUNT(*) n FROM push_subs').get().n });
      }
      if (p === '/api/feed') return send(res, 200, feed(url.searchParams.get('view') || 'watch'));
      if (p.startsWith('/api/token/')) {
        const d = tokenDetail(p.split('/').pop());
        return d ? send(res, 200, d) : send(res, 404, { error: 'not found' });
      }
      if (p === '/api/check' && M === 'POST') {
        const b = await readBody(req);
        const mints = extractMints(b.text || b.mint || '').slice(0, 5);
        if (!mints.length) return send(res, 400, { error: 'CA（コントラクトアドレス）が見つかりません' });
        if (b.source) for (const m of mints) addManualMention(m, b.source, b.text);
        return send(res, 200, await evaluateMany(mints, { manual: true }));
      }
      if (p === '/api/stats') {
        const S = getSettings();
        return send(res, 200, { perf: performance(), model: loadModel(), calibration: calibration(), breakeven: breakevenProb(S), status: statusFn(),
          counts: { tokens: db.prepare('SELECT COUNT(*) n FROM tokens').get().n, evals: db.prepare('SELECT COUNT(*) n FROM evals').get().n,
            smart: db.prepare("SELECT COUNT(*) n FROM wallets WHERE kind='smart'").get().n } });
      }
      if (p === '/api/train' && M === 'POST') return send(res, 200, train());
      if (p === '/api/notifications') return send(res, 200, db.prepare('SELECT * FROM notifications ORDER BY ts DESC LIMIT 50').all());
      if (p === '/api/settings') {
        if (M === 'POST') return send(res, 200, saveSettings(await readBody(req)));
        return send(res, 200, { settings: getSettings(), defaults: DEFAULT_SETTINGS });
      }
      if (p === '/api/wallets') {
        if (M === 'POST') {
          const b = await readBody(req);
          if (b.import) return send(res, 200, { added: importWallets(b.import, b.kind || 'kol') });
          if (b.solanatracker) return send(res, 200, { added: await importKolsFromSolanaTracker(b.period || '30d') });
          addWallet(b.address, b.label || '', b.kind || 'manual');
          return send(res, 200, { ok: true });
        }
        if (M === 'DELETE') {
          const a = url.searchParams.get('address');
          if (!isSolAddress(a)) return send(res, 400, { error: 'bad address' });
          db.prepare('DELETE FROM wallets WHERE address=?').run(a);
          return send(res, 200, { ok: true });
        }
        const kind = url.searchParams.get('kind') || 'all';
        const rows = kind === 'all'
          ? db.prepare(`SELECT * FROM wallets WHERE kind IN ('kol','manual','smart') ORDER BY kind, score DESC LIMIT 300`).all()
          : db.prepare('SELECT * FROM wallets WHERE kind=? ORDER BY score DESC LIMIT 300').all(kind);
        return send(res, 200, rows);
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      log('APIエラー', p, e.message);
      return send(res, 500, { error: e.message });
    }
  });
  server.listen(ENV.PORT, ENV.HOST, () => log(`HTTP http://${ENV.HOST}:${ENV.PORT}`));
  return server;
}

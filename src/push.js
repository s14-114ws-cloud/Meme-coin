// 通知: Web Push（iPhoneのホーム画面アプリ向け、RFC 8291/8292 を標準cryptoで実装） + Telegram（任意）
import crypto from 'node:crypto';
import { db, getKV, setKV } from './db.js';
import { ENV } from './config.js';
import { fetchRaw, log, now } from './util.js';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url');

export function vapidKeys() {
  let k = getKV('vapid', null);
  if (!k) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = privateKey.export({ format: 'jwk' });
    const pub = Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]);
    k = { publicKey: b64u(pub), jwk };
    setKV('vapid', k);
    void publicKey;
  }
  return k;
}

function vapidHeader(endpoint) {
  const k = vapidKeys();
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64u(JSON.stringify({ aud, exp: Math.floor(now() / 1000) + 12 * 3600, sub: ENV.VAPID_SUBJECT }));
  const key = crypto.createPrivateKey({ key: k.jwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${payload}.${b64u(sig)}, k=${k.publicKey}`;
}

/** aes128gcm でペイロードを暗号化（RFC 8291） */
export function encryptPayload(sub, plaintext, { asKeys, salt } = {}) {
  const uaPublic = unb64u(sub.keys.p256dh);
  const authSecret = unb64u(sub.keys.auth);
  const ecdh = crypto.createECDH('prime256v1');
  if (asKeys) ecdh.setPrivateKey(asKeys); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  salt = salt || crypto.randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

export async function sendWebPush(sub, data) {
  const body = encryptPayload(sub, JSON.stringify(data));
  const r = await fetchRaw(sub.endpoint, {
    method: 'POST',
    headers: {
      authorization: vapidHeader(sub.endpoint),
      ttl: '3600',
      urgency: 'high',
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
    },
    body,
  });
  if (r.status === 404 || r.status === 410) {
    db.prepare('DELETE FROM push_subs WHERE endpoint=?').run(sub.endpoint);
    return 'gone';
  }
  if (!r.ok) log('WebPush失敗', r.status, (await r.text()).slice(0, 200));
  return r.status;
}

export function saveSubscription(sub) {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error('購読情報が不正');
  db.prepare('INSERT INTO push_subs(endpoint,sub,created) VALUES(?,?,?) ON CONFLICT(endpoint) DO UPDATE SET sub=excluded.sub')
    .run(sub.endpoint, JSON.stringify(sub), now());
}

async function telegram(text) {
  if (!ENV.TELEGRAM_BOT_TOKEN || !ENV.TELEGRAM_CHAT_ID) return;
  try {
    await fetchRaw(`https://api.telegram.org/bot${ENV.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: ENV.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
  } catch (e) {
    log('Telegram送信失敗', e.message);
  }
}

/** すべての通知先へ送る */
export async function notifyAll({ title, body, mint, url }) {
  db.prepare('INSERT INTO notifications(ts,mint,title,body) VALUES(?,?,?,?)').run(now(), mint || null, title, body);
  if (ENV.OFFLINE) return;
  const subs = db.prepare('SELECT sub FROM push_subs').all().map((r) => JSON.parse(r.sub));
  await Promise.allSettled(subs.map((s) => sendWebPush(s, { title, body, url: url || (mint ? `/#t=${mint}` : '/'), tag: mint || 'info' })));
  await telegram(`${title}\n${body}${mint ? `\nhttps://dexscreener.com/solana/${mint}` : ''}`);
}

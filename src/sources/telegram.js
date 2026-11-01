// 公開Telegramチャンネル（例: CAVE_JPN）のWeb公開ページから投稿を取得し、CAを抽出
import { db } from '../db.js';
import { ENV } from '../config.js';
import { fetchText, extractMints, log, now } from '../util.js';

const ins = db.prepare('INSERT OR IGNORE INTO mentions(source,msg_id,mint,ts,text) VALUES(?,?,?,?,?)');
export const status = { lastPoll: 0, lastError: null, lastCount: 0 };

const decode = (s) =>
  s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();

/** HTML → [{id, ts, text, mints}] */
export function parseChannelHtml(html, channel) {
  const out = [];
  const parts = html.split(/data-post="/).slice(1);
  for (const p of parts) {
    const id = p.slice(0, p.indexOf('"'));
    if (!id.toLowerCase().startsWith(channel.toLowerCase() + '/')) continue;
    const tm = p.match(/<time[^>]*datetime="([^"]+)"/);
    const ts = tm ? Date.parse(tm[1]) : now();
    const txt = p.match(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const text = txt ? decode(txt[1]) : '';
    const hrefs = [...p.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).join(' ');
    const mints = extractMints(text + ' ' + hrefs);
    out.push({ id, ts, text: text.slice(0, 500), mints });
  }
  return out;
}

/** 新しい言及（24時間以内）を返す: [{mint, source, ts}] */
export async function pollChannels(channels) {
  const fresh = [];
  if (ENV.OFFLINE) return fresh;
  for (const ch of channels) {
    try {
      const html = await fetchText(`https://t.me/s/${encodeURIComponent(ch)}`);
      const posts = parseChannelHtml(html, ch);
      status.lastCount = posts.length;
      for (const post of posts) {
        if (now() - post.ts > 24 * 3600e3) continue;
        for (const mint of post.mints) {
          const r = ins.run(ch, post.id, mint, post.ts, post.text);
          if (r.changes) fresh.push({ mint, source: ch, ts: post.ts });
        }
      }
      status.lastError = null;
    } catch (e) {
      status.lastError = e.message;
      log('Telegram取得エラー', ch, e.message);
    }
  }
  status.lastPoll = now();
  return fresh;
}

export function mentionStats(mint) {
  const r = db.prepare('SELECT COUNT(*) n, COUNT(DISTINCT source) s, MIN(ts) first FROM mentions WHERE mint=?').get(mint);
  return { n: r.n, sources: r.s, first: r.first };
}

/** 手動貼り付け（BBなど）も言及として記録 */
export function addManualMention(mint, source, text = '') {
  ins.run(source || 'manual', `m-${now()}`, mint, now(), String(text).slice(0, 500));
}

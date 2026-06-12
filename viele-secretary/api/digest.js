// VIELE secretary — まとめ(ニュース)取得API（Vercelサーバーレス関数）
// RSSをサーバー側で取得・統合して返す（ブラウザのCORS制約を回避）。
// GEMINI_API_KEY が設定されていれば、見出しから「今日の3行ブリーフィング」も生成。
// キーが無ければ要約なしで見出しだけ返す（＝無料で動く）。

import { geminiText } from "./_gemini.js";
import { requireUser } from "./_auth.js";
import { consumeQuota } from "./_quota.js";

const DEFAULT_FEEDS = [
  "https://news.google.com/rss?hl=ja&gl=JP&ceid=JP:ja",
  "https://news.google.com/rss/search?q=SNS%20マーケティング%20集客&hl=ja&gl=JP&ceid=JP:ja",
  "https://news.google.com/rss/search?q=個人事業主%20フリーランス&hl=ja&gl=JP&ceid=JP:ja",
];

// SSRF対策：http(s) かつ 内部/予約アドレスでない公開URLだけを許可する。
// （クラウドのメタデータ 169.254.169.254 や localhost/内部ネットへのフェッチを遮断）
function isSafeFeedUrl(furl) {
  let u;
  try { u = new URL(furl); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = (u.hostname || "").toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (host === "0.0.0.0" || host.includes(":")) return false; // IPv6リテラル(::1等)は一律拒否
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    const p = host.split(".").map(Number);
    if (
      p[0] === 0 || p[0] === 127 || p[0] === 10 ||
      (p[0] === 169 && p[1] === 254) ||              // link-local / クラウドメタデータ
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127)    // CGNAT
    ) return false;
  }
  return true;
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, "&");
}
function stripTags(s) { return String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); }
function cdata(s) { const m = String(s || "").match(/<!\[CDATA\[([\s\S]*?)\]\]>/); return m ? m[1] : s; }
function tag(xml, name) {
  const m = String(xml || "").match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : "";
}

function parseFeed(xml, sourceName) {
  const out = [];
  const blocks = xml.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/gi) || [];
  for (const b of blocks) {
    const title = stripTags(decodeEntities(cdata(tag(b, "title"))));
    let link = stripTags(cdata(tag(b, "link")));
    if (!link) { const m = b.match(/<link[^>]*href="([^"]+)"/i); if (m) link = m[1]; }
    const date = stripTags(tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || "");
    let snip = stripTags(decodeEntities(cdata(tag(b, "description") || tag(b, "summary") || tag(b, "content"))));
    if (snip.length > 140) snip = snip.slice(0, 140) + "…";
    if (title) out.push({ title, link, source: sourceName, date, snippet: snip });
  }
  return out;
}

async function geminiBriefing(apiKey, items) {
  const titles = items.slice(0, 20).map((it, i) => `${i + 1}. ${it.title}`).join("\n");
  const prompt =
    `あなたは一人社長の優秀な秘書です。次のニュース見出しから、今日おさえるべき要点を日本語で3つ、各1文で簡潔にまとめてください。` +
    `箇条書き（・）のみ、前置き・結びは不要。\n\n${titles}`;
  return await geminiText(apiKey, prompt);
}

export default async function handler(req, res) {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const u = new URL(req.url, "http://localhost");
    const feedsParam = u.searchParams.get("feeds");
    const summarize = u.searchParams.get("summarize") === "1";
    const feeds = (feedsParam
      ? feedsParam.split(",").map((s) => { try { return decodeURIComponent(s); } catch { return s; } }).filter(Boolean)
      : DEFAULT_FEEDS
    ).filter(isSafeFeedUrl); // SSRF対策：内部アドレス等を除外

    const results = await Promise.all(
      feeds.slice(0, 8).map(async (furl) => {
        try {
          const resp = await fetch(furl, { headers: { "User-Agent": "Mozilla/5.0 VIELE-secretary" } });
          if (!resp.ok) return [];
          const xml = await resp.text();
          const head = xml.split(/<item|<entry/i)[0];
          const channel = stripTags(decodeEntities(cdata(tag(head, "title")))) || "ニュース";
          return parseFeed(xml, channel);
        } catch { return []; }
      })
    );

    let items = results.flat();
    const seen = new Set();
    items = items.filter((it) => { if (seen.has(it.title)) return false; seen.add(it.title); return true; });
    items.forEach((it) => { it.ts = Date.parse(it.date) || 0; });
    items.sort((a, b) => b.ts - a.ts);
    items = items.slice(0, 40);

    let briefing = "";
    let quotaExceeded = false;
    const key = process.env.GEMINI_API_KEY;
    if (summarize && key && items.length) {
      const quota = await consumeQuota(user.uid);
      if (quota.ok) {
        try { briefing = await geminiBriefing(key, items); } catch { briefing = ""; }
      } else {
        quotaExceeded = true; // 上限超過時は見出しのみ返す（エラーにはしない）
      }
    }

    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
    res.status(200).json({ briefing, items, aiEnabled: !!key, quotaExceeded, count: items.length, generatedAt: Date.now() });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}

// VIELE secretary — まとめ(ニュース)取得API（Vercelサーバーレス関数）
// RSSをサーバー側で取得・統合して返す（ブラウザのCORS制約を回避）。
// GEMINI_API_KEY が設定されていれば、見出しから「今日の3行ブリーフィング」も生成。
// キーが無ければ要約なしで見出しだけ返す（＝無料で動く）。

const DEFAULT_FEEDS = [
  "https://news.google.com/rss?hl=ja&gl=JP&ceid=JP:ja",
  "https://news.google.com/rss/search?q=SNS%20マーケティング%20集客&hl=ja&gl=JP&ceid=JP:ja",
  "https://news.google.com/rss/search?q=個人事業主%20フリーランス&hl=ja&gl=JP&ceid=JP:ja",
];

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
  const model = process.env.GEMINI_MODEL || "gemini-1.5-flash";
  const titles = items.slice(0, 20).map((it, i) => `${i + 1}. ${it.title}`).join("\n");
  const prompt =
    `あなたは一人社長の優秀な秘書です。次のニュース見出しから、今日おさえるべき要点を日本語で3つ、各1文で簡潔にまとめてください。` +
    `箇条書き（・）のみ、前置き・結びは不要。\n\n${titles}`;
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
  );
  if (!r.ok) throw new Error("gemini " + r.status);
  const j = await r.json();
  return (j?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
}

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, "http://localhost");
    const feedsParam = u.searchParams.get("feeds");
    const summarize = u.searchParams.get("summarize") === "1";
    const feeds = feedsParam
      ? feedsParam.split(",").map((s) => { try { return decodeURIComponent(s); } catch { return s; } }).filter(Boolean)
      : DEFAULT_FEEDS;

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
    const key = process.env.GEMINI_API_KEY;
    if (summarize && key && items.length) { try { briefing = await geminiBriefing(key, items); } catch { briefing = ""; } }

    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
    res.status(200).json({ briefing, items, aiEnabled: !!key, count: items.length, generatedAt: Date.now() });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}

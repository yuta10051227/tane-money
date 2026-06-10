// Gmail から「ルールに合う重要メールだけ」を取得して返す。
// POST { refresh, keywords } → { mails: [{id,from,subject,snippet,dateISO,link}] }
// gcal-events.js と同じ refresh→access token パターンを踏襲。
const CLIENT_ID = "752964285770-94aqtjgb7v33g854l7osvndvgh26jc70.apps.googleusercontent.com";

// refresh_token → access_token（gcal-events.js と同一ロジック）
async function accessFromRefresh(refresh) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: refresh,
    grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    let t = "";
    try { t = await r.text(); } catch { /* ignore */ }
    const e = new Error(`token ${r.status} ${t.slice(0, 120)}`);
    e.status = r.status;
    throw e;
  }
  return (await r.json()).access_token;
}

// Gmail API の検索クエリを組み立てる。
// キーワードに空白が含まれる場合は二重引用符で囲む。
function buildQuery(keywords) {
  const kws = (keywords || []).filter((k) => typeof k === "string" && k.trim() !== "");
  if (kws.length === 0) return null; // キーワードなし → 検索不要
  const parts = kws.map((k) => (/\s/.test(k.trim()) ? `"${k.trim()}"` : k.trim()));
  return `newer_than:14d in:inbox (${parts.join(" OR ")})`;
}

// ヘッダ配列から特定ヘッダの値を取得するユーティリティ。
function getHeader(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}

// "表示名 <address>" から表示名だけを抜く。なければメールアドレスを返す。
function parseFromName(fromHeader) {
  if (!fromHeader) return "";
  const m = fromHeader.match(/^(.+?)\s*<[^>]+>$/);
  if (m) return m[1].trim().replace(/^["']|["']$/g, ""); // 前後の引用符を除去
  // "address" だけの形式
  const addrOnly = fromHeader.match(/<([^>]+)>/);
  return addrOnly ? addrOnly[1] : fromHeader.trim();
}

// internalDate(ms文字列) または RFC 2822 の Date ヘッダ → ISO 8601 文字列。
function toISO(dateHeader, internalDate) {
  if (dateHeader) {
    const d = new Date(dateHeader);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  if (internalDate) {
    const d = new Date(Number(internalDate));
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return "";
}

export default async function handler(req, res) {
  // POST 以外は拒否
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  try {
    // リクエストボディのパース（Vercel は通常オブジェクトで渡るが文字列も考慮）
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};

    const refresh = body.refresh;
    const keywords = Array.isArray(body.keywords) ? body.keywords : [];

    // 必須チェック
    if (!process.env.GOOGLE_CLIENT_SECRET) {
      res.status(200).json({ error: "GOOGLE_CLIENT_SECRET未設定（Vercel環境変数）" });
      return;
    }
    if (!refresh) {
      res.status(400).json({ error: "refresh token がありません" });
      return;
    }

    // キーワード空なら即空返却（API 呼び出し不要）
    const q = buildQuery(keywords);
    if (!q) {
      res.status(200).json({ mails: [] });
      return;
    }

    // access token を取得
    const at = await accessFromRefresh(refresh);

    // Step 1: メッセージID 一覧を取得（最大 30 件）
    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    listUrl.searchParams.set("q", q);
    listUrl.searchParams.set("maxResults", "30");
    const listRes = await fetch(listUrl.toString(), {
      headers: { Authorization: `Bearer ${at}` },
    });
    if (!listRes.ok) {
      const t = await listRes.text().catch(() => "");
      console.error("[gmail-fetch] messages.list error", listRes.status, t.slice(0, 200));
      res.status(200).json({ error: "メールの取得に失敗しました" });
      return;
    }
    const listJson = await listRes.json();
    const messageIds = (listJson.messages || []).slice(0, 15).map((m) => m.id);

    if (messageIds.length === 0) {
      res.status(200).json({ mails: [] });
      return;
    }

    // Step 2: 各メッセージのメタデータを並列取得（最大 15 件）
    const metaFetches = messageIds.map((id) => {
      const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`);
      url.searchParams.set("format", "metadata");
      url.searchParams.append("metadataHeaders", "From");
      url.searchParams.append("metadataHeaders", "Subject");
      url.searchParams.append("metadataHeaders", "Date");
      return fetch(url.toString(), {
        headers: { Authorization: `Bearer ${at}` },
      }).then((r) => {
        if (!r.ok) return null;
        return r.json();
      }).catch(() => null);
    });

    const metaResults = await Promise.all(metaFetches);

    // Step 3: 整形 → 新しい順ソート
    const mails = metaResults
      .filter(Boolean)
      .map((msg) => {
        const headers = (msg.payload && msg.payload.headers) || [];
        const fromHeader = getHeader(headers, "From");
        const subjectHeader = getHeader(headers, "Subject");
        const dateHeader = getHeader(headers, "Date");
        const dateISO = toISO(dateHeader, msg.internalDate);
        const snippet = typeof msg.snippet === "string"
          ? msg.snippet.slice(0, 80)
          : "";
        return {
          id: msg.id,
          from: parseFromName(fromHeader),
          subject: subjectHeader || "(件名なし)",
          snippet,
          dateISO,
          link: `https://mail.google.com/mail/u/0/#all/${msg.id}`,
        };
      })
      .filter((m) => m.dateISO !== "") // 日付不明なものは除外
      .sort((a, b) => new Date(b.dateISO) - new Date(a.dateISO));

    res.status(200).json({ mails });
  } catch (e) {
    const st = e && e.status;
    if (st === 400 || st === 401) {
      // トークン失効 → クライアントに再認証を促す（gcal-events.js と同じ形式）
      res.status(200).json({ error: String((e && e.message) || e), needReconnect: true });
      return;
    }
    console.error("[gmail-fetch] unexpected error", e);
    res.status(200).json({ error: "メールの取得に失敗しました" });
  }
}

// アプリからGoogleカレンダーへ予定を作成・更新・削除する。
// リフレッシュトークンからアクセストークンを発行して書き込む（calendar.events スコープが必要）。
const CLIENT_ID = "752964285770-94aqtjgb7v33g854l7osvndvgh26jc70.apps.googleusercontent.com";

async function accessFromRefresh(refresh) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: refresh,
    grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  if (!r.ok) { let t = ""; try { t = await r.text(); } catch { /* ignore */ } const e = new Error(`token ${r.status} ${t.slice(0, 120)}`); e.status = r.status; throw e; }
  return (await r.json()).access_token;
}

// アプリのイベント表現 → Google Calendar API のボディに変換
function toGcalBody(ev) {
  const body = { summary: ev.title || "(無題)" };
  if (ev.allDay) {
    // 終日：date（YYYY-MM-DD）。終了は開始翌日（未指定なら開始＋1日）
    const start = ev.startISO.slice(0, 10);
    const end = (ev.endISO ? ev.endISO.slice(0, 10) : null) || nextDay(start);
    body.start = { date: start };
    body.end = { date: end };
  } else {
    const tz = "Asia/Tokyo";
    body.start = { dateTime: ev.startISO, timeZone: tz };
    body.end = { dateTime: ev.endISO || addHourISO(ev.startISO, 1), timeZone: tz };
  }
  if (ev.description) body.description = ev.description;
  return body;
}
function nextDay(ymd) { const d = new Date(ymd + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }
function addHourISO(iso, h) { const d = new Date(iso); d.setHours(d.getHours() + h); return d.toISOString(); }

export default async function handler(req, res) {
  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};
    const { refresh, action, calendarId, eventId, event } = body;
    if (!process.env.GOOGLE_CLIENT_SECRET) { res.status(200).json({ error: "GOOGLE_CLIENT_SECRET未設定（Vercel環境変数）" }); return; }
    if (!refresh) { res.status(400).json({ error: "refresh token がありません" }); return; }
    const calId = calendarId || "primary";

    const at = await accessFromRefresh(refresh);
    const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`;
    const headers = { Authorization: `Bearer ${at}`, "Content-Type": "application/json" };

    if (action === "delete") {
      if (!eventId) { res.status(400).json({ error: "eventId がありません" }); return; }
      const r = await fetch(`${base}/${encodeURIComponent(eventId)}`, { method: "DELETE", headers });
      if (!r.ok && r.status !== 410) { const t = await r.text().catch(() => ""); throw withStatus(new Error(`delete ${r.status} ${t.slice(0, 160)}`), r.status); }
      res.status(200).json({ ok: true }); return;
    }

    if (!event || !event.startISO) { res.status(400).json({ error: "予定の内容（日時）がありません" }); return; }
    const gbody = toGcalBody(event);

    if (action === "update") {
      if (!eventId) { res.status(400).json({ error: "eventId がありません" }); return; }
      const r = await fetch(`${base}/${encodeURIComponent(eventId)}`, { method: "PATCH", headers, body: JSON.stringify(gbody) });
      if (!r.ok) { const t = await r.text().catch(() => ""); throw withStatus(new Error(`update ${r.status} ${t.slice(0, 160)}`), r.status); }
      res.status(200).json({ ok: true, event: await r.json() }); return;
    }

    // 既定: create
    const r = await fetch(base, { method: "POST", headers, body: JSON.stringify(gbody) });
    if (!r.ok) { const t = await r.text().catch(() => ""); throw withStatus(new Error(`create ${r.status} ${t.slice(0, 160)}`), r.status); }
    res.status(200).json({ ok: true, event: await r.json() });
  } catch (e) {
    const st = e && e.status;
    res.status(200).json({ error: String((e && e.message) || e), needReconnect: st === 400 || st === 401 || st === 403 });
  }
}
function withStatus(e, st) { e.status = st; return e; }

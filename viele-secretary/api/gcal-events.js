// リフレッシュトークンから毎回アクセストークンを発行し、今週〜約3ヶ月先のカレンダー予定を返す。
// これにより「一度連携すれば維持され続ける」（トークン失効しても自動再発行）。
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
async function getCalendars(at) {
  const r = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&maxResults=250", { headers: { Authorization: `Bearer ${at}` } });
  if (!r.ok) throw new Error("calendarList " + r.status);
  const j = await r.json();
  return (j.items || []).map((c) => ({ id: c.id, summary: c.summaryOverride || c.summary || c.id, primary: !!c.primary, accessRole: c.accessRole || "reader" }));
}
async function getEvents(at, calId, timeMin, timeMax) {
  const p = new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "250" });
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?${p}`, { headers: { Authorization: `Bearer ${at}` } });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.items || []).filter((e) => e.start).map((e) => ({
    id: e.id, calendarId: calId, title: e.summary || "(無題)",
    allDay: !e.start.dateTime, startISO: e.start.dateTime || e.start.date, endISO: (e.end && (e.end.dateTime || e.end.date)) || null,
  }));
}

export default async function handler(req, res) {
  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};
    const refresh = body.refresh;
    if (!process.env.GOOGLE_CLIENT_SECRET) { res.status(200).json({ error: "GOOGLE_CLIENT_SECRET未設定（Vercel環境変数）" }); return; }
    if (!refresh) { res.status(400).json({ error: "refresh token がありません" }); return; }

    const at = await accessFromRefresh(refresh);
    const calendars = await getCalendars(at);
    const now = new Date();
    const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7)); monday.setHours(0, 0, 0, 0);
    const timeMin = monday.toISOString();
    const timeMax = new Date(now.getTime() + 100 * 86400000).toISOString(); // 約3ヶ月先
    const events = (await Promise.all(calendars.map((c) => getEvents(at, c.id, timeMin, timeMax).catch(() => [])))).flat();
    res.status(200).json({ calendars, events });
  } catch (e) {
    const st = e && e.status;
    res.status(200).json({ error: String((e && e.message) || e), needReconnect: st === 400 || st === 401 });
  }
}

// Google OAuth コールバック。code を refresh_token に交換し、アプリへ #gcalrefresh= で返す。
// refresh_token はクライアント側で本人のFirestoreに保存（本人のみ読み書き可）。
const CLIENT_ID = "752964285770-94aqtjgb7v33g854l7osvndvgh26jc70.apps.googleusercontent.com";

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, "http://localhost");
    const code = u.searchParams.get("code");
    const redirectUri = `https://${req.headers.host}/api/gcal-callback`;
    if (!code) { res.writeHead(302, { Location: "/?gcalerror=nocode" }); res.end(); return; }
    if (!process.env.GOOGLE_CLIENT_SECRET) { res.writeHead(302, { Location: "/?gcalerror=nosecret" }); res.end(); return; }

    const body = new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const j = await r.json();
    const refresh = j.refresh_token || "";
    if (!refresh) { res.writeHead(302, { Location: "/?gcalerror=norefresh" }); res.end(); return; }
    // フラグメントで返す（サーバーログに残らない）。クライアントがFirestoreへ保存。
    res.writeHead(302, { Location: `/?gcal=ok#gcalrefresh=${encodeURIComponent(refresh)}` });
    res.end();
  } catch (e) {
    res.writeHead(302, { Location: "/?gcalerror=" + encodeURIComponent(String((e && e.message) || e)).slice(0, 60) });
    res.end();
  }
}

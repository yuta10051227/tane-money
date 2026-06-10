// Google OAuth 開始（リフレッシュトークン取得のためのリダイレクト）。
// access_type=offline + prompt=consent で refresh_token を得る。フルページ遷移なのでiOS PWAでも可。
const CLIENT_ID = "752964285770-94aqtjgb7v33g854l7osvndvgh26jc70.apps.googleusercontent.com";

export default function handler(req, res) {
  const u = new URL(req.url, "http://localhost");
  const state = u.searchParams.get("state") || "";
  const redirectUri = `https://${req.headers.host}/api/gcal-callback`;
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.searchParams.set("client_id", CLIENT_ID);
  auth.searchParams.set("redirect_uri", redirectUri);
  auth.searchParams.set("response_type", "code");
  // events: 予定の作成・更新・削除（書き込み） / readonly: カレンダー一覧の取得 / gmail.readonly: 重要メール抽出用
  auth.searchParams.set("scope", "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.readonly");
  auth.searchParams.set("access_type", "offline");
  auth.searchParams.set("prompt", "consent");
  auth.searchParams.set("include_granted_scopes", "true");
  auth.searchParams.set("state", state);
  res.writeHead(302, { Location: auth.toString() });
  res.end();
}

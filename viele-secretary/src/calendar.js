// Googleカレンダー連携（クライアント側・複数カレンダー対応）。
// Firebaseの Google ログインに calendar スコープを足して得たアクセストークンで
// Calendar REST API を直接叩く。バックエンド不要。トークンは短命(約1時間)。
// 注: 書き込み(イベント作成)に対応するため calendar.readonly → calendar に拡張。
//     既存ユーザーは初回の書き込み時に同意画面で再承認が必要。

export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";

export const pad2 = (n) => String(n).padStart(2, "0");

// 今週（月曜0時）の開始日
export function startOfWeekMonday(now = new Date()) {
  const d = new Date(now);
  const offset = (d.getDay() + 6) % 7; // 月曜=0
  d.setDate(d.getDate() - offset);
  d.setHours(0, 0, 0, 0);
  return d;
}

// タイトルから役割(cat)と軸(axis)を推定。一致しなければ「その他」。
const CAT_RULES = [
  { cat: "施術", axis: "労働", kw: ["施術", "セッション", "予約", "来店", "対面", "整体", "マッサージ", "ヒーリング", "面談", "相談", "カウンセ"] },
  { cat: "制作", axis: "仕組み", kw: ["収録", "撮影", "編集", "制作", "執筆", "ブログ", "動画", "ショート", "コンテンツ", "講座", "教材", "スライド", "原稿"] },
  { cat: "集客", axis: "仕組み", kw: ["集客", "LP", "広告", "SNS", "投稿", "配信", "メルマガ", "LINE", "ローンチ", "セミナー", "ウェビナー", "告知", "ライブ", "インスタ"] },
  { cat: "経営", axis: "労働", kw: ["経理", "請求", "会議", "ミーティング", "MTG", "面接", "採用", "計画", "振り返り", "レビュー", "事務", "打ち合わせ"] },
];

export function classifyEvent(title) {
  const t = (title || "").toLowerCase();
  for (const r of CAT_RULES) {
    if (r.kw.some((k) => t.includes(k.toLowerCase()))) return { cat: r.cat, axis: r.axis };
  }
  return { cat: "その他", axis: "労働" };
}

// 「今後の予定」に出す重要イベントの判定用キーワード（仕事カレンダー向け）
export const NOTABLE_KEYWORDS = [
  "出張", "遠征", "登壇", "セミナー", "ウェビナー", "イベント", "ライブ", "配信",
  "インスタ", "収録", "撮影", "ローンチ", "説明会", "開催", "旅行", "合宿", "実習", "面談",
];

export function isNotable(ev) {
  if (ev.allDay) return true; // 終日予定は重要扱い（旅行・休み等）
  const t = ev.title || "";
  return NOTABLE_KEYWORDS.some((k) => t.includes(k));
}

const AUTH = (token) => ({ headers: { Authorization: `Bearer ${token}` } });

function apiError(res, detail) {
  const err = new Error(`Calendar API ${res.status} ${detail || ""}`.trim());
  err.status = res.status;
  return err;
}

// 利用可能なカレンダー一覧
export async function fetchCalendarList(token) {
  const res = await fetch(
    "https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&maxResults=250",
    AUTH(token)
  );
  if (!res.ok) {
    let d = ""; try { d = (await res.json())?.error?.message || ""; } catch { /* ignore */ }
    throw apiError(res, d);
  }
  const j = await res.json();
  return (j.items || []).map((c) => ({
    id: c.id,
    summary: c.summaryOverride || c.summary || c.id,
    primary: !!c.primary,
  }));
}

// 指定カレンダーの期間内イベント（終日予定も含む）
export async function fetchEvents(token, calendarId, timeMinISO, timeMaxISO) {
  const params = new URLSearchParams({
    timeMin: timeMinISO,
    timeMax: timeMaxISO,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  });
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
    AUTH(token)
  );
  if (!res.ok) {
    let d = ""; try { d = (await res.json())?.error?.message || ""; } catch { /* ignore */ }
    throw apiError(res, d);
  }
  const j = await res.json();
  return (j.items || [])
    .filter((e) => e.start)
    .map((e) => ({
      id: e.id,
      calendarId,
      title: e.summary || "(無題)",
      allDay: !e.start.dateTime,
      startISO: e.start.dateTime || e.start.date,
      endISO: (e.end && (e.end.dateTime || e.end.date)) || null,
    }));
}

// イベントを1件作成（書き込み）。event は Calendar API の Events リソース形式。
export async function createEvent(token, calendarId, event) {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(event),
    }
  );
  if (!res.ok) {
    let d = ""; try { d = (await res.json())?.error?.message || ""; } catch { /* ignore */ }
    throw apiError(res, d);
  }
  return res.json();
}

// 同タイトル・同日付の重複判定。dateStr は "YYYY-MM-DD"。
// その日の範囲でイベントを引き、タイトル一致があれば true。判定不能時は false（登録を止めない）。
export async function checkDuplicate(token, calendarId, title, dateStr) {
  if (!dateStr) return false;
  const timeMin = new Date(`${dateStr}T00:00:00`).toISOString();
  const timeMax = new Date(`${dateStr}T23:59:59`).toISOString();
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: "true",
    maxResults: "250",
  });
  let res;
  try {
    res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
      AUTH(token)
    );
  } catch {
    return false;
  }
  if (!res.ok) return false;
  let j; try { j = await res.json(); } catch { return false; }
  const norm = (s) => String(s || "").trim();
  const target = norm(title);
  return (j.items || []).some((e) => norm(e.summary) === target);
}

// Googleカレンダー連携（クライアント側）。
// Firebaseの Google ログインに calendar.readonly スコープを足して得たアクセストークンで
// Calendar REST API を直接叩く。バックエンド不要。トークンは短命(約1時間)。

export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

const p2 = (n) => String(n).padStart(2, "0");

// 今週（月曜0時〜翌週月曜0時）
function weekRange(now = new Date()) {
  const d = new Date(now);
  const offset = (d.getDay() + 6) % 7; // 月曜=0
  const start = new Date(d);
  start.setDate(d.getDate() - offset);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 7);
  return { start, end };
}

// タイトルから役割(cat)と軸(axis)を推定。一致しなければ「その他」。
const CAT_RULES = [
  { cat: "施術", axis: "労働", kw: ["施術", "セッション", "予約", "来店", "対面", "整体", "マッサージ", "ヒーリング", "面談", "相談", "カウンセ"] },
  { cat: "制作", axis: "仕組み", kw: ["収録", "撮影", "編集", "制作", "執筆", "ブログ", "動画", "ショート", "コンテンツ", "講座", "教材", "スライド", "原稿"] },
  { cat: "集客", axis: "仕組み", kw: ["集客", "LP", "広告", "SNS", "投稿", "配信", "メルマガ", "LINE", "ローンチ", "セミナー", "ウェビナー", "告知", "ライブ"] },
  { cat: "経営", axis: "労働", kw: ["経理", "請求", "会議", "ミーティング", "MTG", "面接", "採用", "計画", "振り返り", "レビュー", "事務", "打ち合わせ"] },
];

export function classifyEvent(title) {
  const t = title || "";
  for (const r of CAT_RULES) {
    if (r.kw.some((k) => t.toLowerCase().includes(k.toLowerCase()))) return { cat: r.cat, axis: r.axis };
  }
  return { cat: "その他", axis: "労働" };
}

// 生イベント → メーター/今日の予定で使う形へ
export function eventToEntry(e) {
  const start = new Date(e.startISO);
  const end = e.endISO ? new Date(e.endISO) : null;
  const hours = end ? Math.max(0.25, (end - start) / 3600000) : 1;
  const { cat, axis } = classifyEvent(e.title);
  return {
    id: e.id,
    wd: start.getDay(),
    time: `${p2(start.getHours())}:${p2(start.getMinutes())}`,
    title: e.title,
    cat,
    axis,
    hours: Math.round(hours * 10) / 10,
  };
}

// 今週の（時間指定）予定を primary カレンダーから取得
export async function fetchWeekEvents(token) {
  const { start, end } = weekRange();
  const params = new URLSearchParams({
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  });
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json())?.error?.message || ""; } catch { /* ignore */ }
    const err = new Error(`Calendar API ${res.status} ${detail}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  return (json.items || [])
    .filter((e) => e.start && e.start.dateTime) // 終日予定は除外
    .map((e) => ({
      id: e.id,
      title: e.summary || "(無題)",
      startISO: e.start.dateTime,
      endISO: e.end && e.end.dateTime,
    }));
}

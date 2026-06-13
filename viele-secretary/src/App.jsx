import { useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, GoogleAuthProvider } from "firebase/auth";
import { doc, setDoc } from "firebase/firestore";
import { auth, googleProvider, firebaseEnabled, db } from "./firebase";
import { useCloud } from "./useCloud";
import { useLocal } from "./useLocal";
import { CALENDAR_SCOPE, fetchCalendarList, fetchEvents, classifyEvent, isNotable, startOfWeekMonday, pad2 } from "./calendar";
import { revokeToken } from "./gauth";
import { computeChart, dayEnergy, stancesFor, sanmei } from "./natal";
import { initAnalytics, identifyUser, track, resetAnalytics } from "./analytics";

const STORE_KEY = "viele-secretary";

// 認証付き fetch：ログイン中なら Firebase IDトークンを Authorization ヘッダに付与してAPIを呼ぶ。
// サーバー(api/_auth.js)が検証し、未ログイン/許可リスト外の第三者からの呼び出しを弾く。
async function authedFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  try {
    const u = auth && auth.currentUser;
    if (u) headers.Authorization = `Bearer ${await u.getIdToken()}`;
  } catch { /* トークン取得に失敗してもそのまま投げ、サーバー側で401を返させる */ }
  return fetch(url, { ...options, headers });
}

// OAuthコールバックから戻った refresh token をURLフラグメントから回収（Firestoreへ保存して永続化）
const PENDING_GCAL_REFRESH = (() => {
  try {
    const m = (window.location.hash || "").match(/gcalrefresh=([^&]+)/);
    if (m) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      return decodeURIComponent(m[1]);
    }
  } catch { /* ignore */ }
  return null;
})();

/* ──────────────────────────────────────────────────────────────
   配色（落ち着いた秘書ダッシュボード）
   ────────────────────────────────────────────────────────────── */
const C = {
  bg: "#0F1115",
  panel: "#171A21",
  panel2: "#1E222B",
  line: "#2A2F3A",
  text: "#E8EAED",
  sub: "#C5CBD3",
  faint: "#AAB2BD",
  accent: "#C9A227", // gold
  green: "#3FB984",
  orange: "#E8A13E",
  red: "#E2554B",
  blue: "#5B8DEF",
  purple: "#9A7BE0",
};

// 役割カテゴリ（施術/制作/集客/経営）の色
const CAT = {
  施術: C.green,
  制作: C.blue,
  集客: C.purple,
  経営: C.accent,
};
const FAMILY_COLOR = "#C77B9C"; // 家族・プライベートの色（仕事と区別）
const catColor = (cat) => CAT[cat] || (cat === "家族" ? FAMILY_COLOR : C.faint);

/* ──────────────────────────────────────────────────────────────
   日付ユーティリティ
   ────────────────────────────────────────────────────────────── */
const DAY_MS = 86400000;
const WD = ["日", "月", "火", "水", "木", "金", "土"];

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function iso(d) {
  const x = startOfDay(d);
  // 不正な日付でも toISOString() でアプリ全体が落ちないようフォールバック
  const safe = isNaN(x.getTime()) ? startOfDay(new Date()) : x;
  return safe.toISOString().slice(0, 10);
}
function addDays(base, n) {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d;
}
function daysUntil(dateISO) {
  return Math.round((startOfDay(new Date(dateISO)) - startOfDay(new Date())) / DAY_MS);
}
function fmt(dateISO) {
  const d = new Date(dateISO);
  return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
}

/* ──────────────────────────────────────────────────────────────
   信号ロジック（緑=済 / 橙=もうすぐ / 赤=遅れ）
   ────────────────────────────────────────────────────────────── */
function itemSignal(item, eventISO) {
  if (item.done) return { key: "done", color: C.green, dot: "🟢", label: "済" };
  const deadlineISO = iso(addDays(new Date(eventISO), -item.daysBefore));
  const diff = daysUntil(deadlineISO);
  if (diff < 0)
    return { key: "late", color: C.red, dot: "🔴", label: `${-diff}日遅れ`, deadlineISO };
  if (diff <= 3)
    return { key: "soon", color: C.orange, dot: "🟠", label: `あと${diff}日`, deadlineISO };
  return { key: "ok", color: C.faint, dot: "⚪️", label: `あと${diff}日`, deadlineISO };
}

function deadlineSignal(dateISO) {
  const diff = daysUntil(dateISO);
  if (diff < 0) return { color: C.red, dot: "🔴", label: `${-diff}日経過` };
  if (diff <= 7) return { color: C.orange, dot: "🟠", label: `あと${diff}日` };
  return { color: C.green, dot: "🟢", label: `あと${diff}日` };
}

/* ローンチの締切を正規化して返す（旧 deadline は本申込締切として後方互換）。
   返り値: [{ stage:"先行登録", date }, { stage:"本申込", date }]（存在するものだけ） */
function launchDeadlines(L) {
  const out = [];
  if (L.deadlineReg) out.push({ stage: "先行登録", date: L.deadlineReg });
  const cv = L.deadlineCv || L.deadline;
  if (cv) out.push({ stage: "本申込", date: cv });
  return out;
}

/* 「今日の要対応」集約：遅れ(late) と もうすぐ(soon) を抽出（取りこぼし防止） */
// VAPID公開鍵(Base64URL)を Push API が要求する Uint8Array へ変換
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function computeAlerts(data) {
  const late = [];
  const soon = [];
  (data.trips || []).forEach((t) => {
    (t.items || []).forEach((it) => {
      if (it.done) return;
      const diff = daysUntil(iso(addDays(new Date(t.date), -it.daysBefore)));
      const e = { label: `${it.label}（${t.title}）`, diff };
      if (diff < 0) late.push(e);
      else if (diff <= 3) soon.push(e);
    });
  });
  (data.deadlines || []).forEach((d) => {
    const diff = daysUntil(d.date);
    if (diff >= 0 && diff <= 7) soon.push({ label: d.title, diff });
  });
  // ローンチKPI：段ごとに「その段の締切が近い(7日以内)/過ぎた のに進捗が目標の80%未満」なら要対応に出す
  (data.launches || []).forEach((L) => {
    const reg = Number(L.reg) || 0, goalReg = Number(L.goalReg) || 0;
    const cv = Number(L.cv) || 0, goalCv = Number(L.goalCv) || 0;
    const rev = cv * (Number(L.price) || 0), goalRev = Number(L.goalRev) || 0;
    const regPct = goalReg ? (reg / goalReg) * 100 : 100;
    const cvPct = goalCv ? (cv / goalCv) * 100 : 100;
    const revPct = goalRev ? (rev / goalRev) * 100 : 100;
    // 各段の締切と進捗をチェックして、遅れていれば要対応へ
    const check = (dl, pct, lag) => {
      if (!dl) return;
      const diff = daysUntil(dl);
      if (diff > 7 || diff < -30) return; // まだ先 / 終わって久しい ものは出さない
      if (pct >= 80) return;             // 8割以上届いていれば警告しない
      const item = { label: `📣 ${L.name}：${lag}（達成${Math.round(pct)}%）`, diff };
      if (diff < 0) late.push(item); else soon.push(item);
    };
    check(L.deadlineReg, regPct, `先行登録 ${reg}/${goalReg}人`);
    // 本申込締切（旧 deadline は本申込締切扱い）には 本申込・売上 の遅れを集約
    const cvDL = L.deadlineCv || L.deadline;
    const stagePct = Math.min(cvPct, revPct);
    const lag = cvPct <= revPct ? `本申込 ${cv}/${goalCv}人` : `売上 ${Math.round(revPct)}%`;
    check(cvDL, stagePct, lag);
  });
  late.sort((a, b) => a.diff - b.diff);
  soon.sort((a, b) => a.diff - b.diff);
  return { late, soon };
}

/* 運気AIへ渡す「今の事業状況」サマリ（実データ反映） */
function buildSituation(data) {
  const lines = [];
  const { late, soon } = computeAlerts(data);
  if (late.length) lines.push(`遅れている手配: ${late.slice(0, 3).map((x) => x.label).join("、")}`);
  if (soon.length) lines.push(`間近の締切: ${soon.slice(0, 3).map((x) => `${x.label}(あと${x.diff}日)`).join("、")}`);
  const out = (data.money || []).filter((x) => !x.done).reduce((s, x) => s + (Number(x.amount) || 0), 0);
  if (out > 0) lines.push(`未処理の請求/支払: 約¥${out.toLocaleString("ja-JP")}`);
  const c = (data.content || []).filter((x) => !x.done).map((x) => x.title);
  if (c.length) lines.push(`制作中のコンテンツ: ${c.slice(0, 3).join("、")}`);
  const tk = (data.tasks || []).filter((x) => !x.done);
  if (tk.length) lines.push(`未完タスク${tk.length}件: ${tk.slice(0, 2).map((x) => x.title).join("、")}`);
  const trip = (data.trips || []).map((t) => ({ t, d: daysUntil(t.date) })).filter((x) => x.d >= 0).sort((a, b) => a.d - b.d)[0];
  if (trip) lines.push(`次の遠征/イベント: ${trip.t.title}(あと${trip.d}日)`);
  // 進行中ローンチ（本申込締切が近い順に1件）の進捗を要約
  const lc = (data.launches || [])
    .map((L) => ({ L, d: daysUntil((L.deadlineCv || L.deadline || L.deadlineReg)) }))
    .filter((x) => Number.isFinite(x.d) && x.d >= -30 && x.d <= 60)
    .sort((a, b) => a.d - b.d)[0];
  if (lc) {
    const L = lc.L;
    const rev = (Number(L.cv) || 0) * (Number(L.price) || 0);
    lines.push(`進行中ローンチ: ${L.name}（先行登録${Number(L.reg) || 0}/${Number(L.goalReg) || 0}人・本申込${Number(L.cv) || 0}/${Number(L.goalCv) || 0}人・売上¥${rev.toLocaleString("ja-JP")}/¥${(Number(L.goalRev) || 0).toLocaleString("ja-JP")}・本申込${lc.d >= 0 ? `締切あと${lc.d}日` : `締切${-lc.d}日経過`}）`);
  }
  return lines.join("\n");
}

/* ──────────────────────────────────────────────────────────────
   逆算チェーンの型テンプレート（遠方登壇 / 日帰り / 海外実習）
   各項目: { label, daysBefore }  本番から daysBefore 日前が締切
   ────────────────────────────────────────────────────────────── */
const TEMPLATES = {
  遠方登壇: [
    { label: "新幹線・交通手配", daysBefore: 14 },
    { label: "ホテル予約", daysBefore: 14 },
    { label: "登壇スライド初稿", daysBefore: 10 },
    { label: "配布資料の印刷手配", daysBefore: 5 },
    { label: "機材・備品チェック", daysBefore: 2 },
    { label: "参加者へリマインド送信", daysBefore: 1 },
  ],
  日帰り: [
    { label: "往復チケット確保", daysBefore: 7 },
    { label: "施術メニュー確定", daysBefore: 5 },
    { label: "持ち物パッキング", daysBefore: 1 },
  ],
  海外実習: [
    { label: "パスポート残存確認", daysBefore: 60 },
    { label: "航空券予約", daysBefore: 45 },
    { label: "海外旅行保険", daysBefore: 30 },
    { label: "現地コーディネート確定", daysBefore: 21 },
    { label: "両替・eSIM手配", daysBefore: 7 },
    { label: "持ち物パッキング", daysBefore: 1 },
  ],
  打ち合わせ: [
    { label: "アジェンダ・議題を整理", daysBefore: 5 },
    { label: "必要な資料を準備", daysBefore: 3 },
    { label: "場所／オンラインURLを確定・共有", daysBefore: 2 },
    { label: "参加者へリマインド送信", daysBefore: 1 },
  ],
  旅行: [
    { label: "宿・交通を予約", daysBefore: 30 },
    { label: "行程・プランを作成", daysBefore: 14 },
    { label: "持ち物リストを作成", daysBefore: 7 },
    { label: "天気・現地情報をチェック", daysBefore: 3 },
    { label: "パッキング", daysBefore: 1 },
  ],
  "入学式・式典": [
    { label: "服装・スーツ・靴を準備", daysBefore: 30 },
    { label: "提出書類・持ち物を確認", daysBefore: 21 },
    { label: "写真・カメラの準備", daysBefore: 7 },
    { label: "集合時間・場所・交通を確認", daysBefore: 3 },
    { label: "持ち物の最終チェック", daysBefore: 1 },
  ],
  "誕生日・記念日": [
    { label: "プレゼントを決める", daysBefore: 14 },
    { label: "プレゼントを購入・予約", daysBefore: 7 },
    { label: "ケーキ・お店を予約", daysBefore: 5 },
    { label: "メッセージカード・飾り付けを準備", daysBefore: 2 },
    { label: "当日の段取りを確認", daysBefore: 1 },
  ],
};

/* 二段ローンチ等の「逆算テンプレ」。基準日(offset 0)からの相対日数で締切群を自動生成 */
const LAUNCH_TEMPLATES = {
  二段ローンチ標準: {
    anchorLabel: "本申込 開始日",
    steps: [
      { title: "予告・教育コンテンツ開始", stage: "予告", offset: -14 },
      { title: "LINE先行登録 開始", stage: "先行登録", offset: -10 },
      { title: "先行登録 締切", stage: "先行登録", offset: -1 },
      { title: "本申込 開始", stage: "本申込", offset: 0 },
      { title: "締切リマインド送信", stage: "本申込", offset: 4 },
      { title: "本申込 締切", stage: "本申込", offset: 6 },
    ],
  },
  セミナー集客: {
    anchorLabel: "セミナー開催日",
    steps: [
      { title: "告知開始", stage: "告知", offset: -21 },
      { title: "申込ページ公開", stage: "募集", offset: -18 },
      { title: "リマインド①", stage: "募集", offset: -7 },
      { title: "申込締切", stage: "募集", offset: -1 },
      { title: "セミナー開催", stage: "開催", offset: 0 },
    ],
  },
  単発ローンチ: {
    anchorLabel: "販売開始日",
    steps: [
      { title: "予告開始", stage: "予告", offset: -7 },
      { title: "販売開始", stage: "販売", offset: 0 },
      { title: "締切リマインド送信", stage: "販売", offset: 5 },
      { title: "販売締切", stage: "販売", offset: 7 },
    ],
  },
};

// テンプレ＋基準日から締切群を生成
function buildLaunch(name, anchorISO) {
  const tpl = LAUNCH_TEMPLATES[name];
  if (!tpl) return [];
  return tpl.steps.map((s) => ({
    title: s.title,
    stage: s.stage,
    date: iso(addDays(new Date(anchorISO), s.offset)),
  }));
}

function templateItems(name) {
  return (TEMPLATES[name] || []).map((it) => ({ ...it, done: false }));
}

// カレンダーのタイトルから逆算チェーンの型を自動判定するルール（上から順にマッチ）
// ※「打ち合わせ」は頻出しすぎて自動生成だと邪魔になるため、ここには入れず手動専用にしている
const AUTO_RULES = [
  { kw: /海外|外国|バリ|ハワイ|台湾|韓国|セブ|タイ|ベトナム|シンガポール|インドネシア/, tpl: "海外実習" },
  { kw: /入学式|入園式|卒業式|卒園式|入社式|式典|セレモニー/, tpl: "入学式・式典" },
  { kw: /誕生日|誕生会|バースデー|記念日|アニバーサリー|birthday/i, tpl: "誕生日・記念日" },
  { kw: /旅行|家族旅行|帰省| travel|trip/i, tpl: "旅行" },
  { kw: /日帰り/, tpl: "日帰り" },
  { kw: /出張|登壇|遠征|遠方|セミナー|講演|イベント/, tpl: "遠方登壇" },
];

// タイトルにマッチする型名を返す（なければ null）。自動逆算チェーンの生成判定に使う
function matchAutoTemplate(title) {
  const s = String(title || "");
  const hit = AUTO_RULES.find((r) => r.kw.test(s));
  return hit ? hit.tpl : null;
}

// 自動検知でタイトルから最適な型を推定（未マッチ時は出張の標準型へフォールバック）
function pickTripTemplate(title) {
  return matchAutoTemplate(title) || "遠方登壇";
}

/* ──────────────────────────────────────────────────────────────
   今週の予定（時間配分メーターの元データ）
   Phase2でGoogleカレンダー連携に差し替える前提のローカル定数。
   cat: 施術/制作/集客/経営   axis: 労働(自分が動く) / 仕組み(資産になる)
   ────────────────────────────────────────────────────────────── */
const LOG = [
  { wd: 1, time: "10:00", title: "オンライン施術 2枠", cat: "施術", axis: "労働", hours: 3 },
  { wd: 1, time: "14:00", title: "YouTube収録", cat: "制作", axis: "仕組み", hours: 2 },
  { wd: 2, time: "09:30", title: "対面セッション", cat: "施術", axis: "労働", hours: 4 },
  { wd: 2, time: "16:00", title: "LP・導線の改善", cat: "集客", axis: "仕組み", hours: 2 },
  { wd: 3, time: "10:00", title: "メルマガ・LINE配信", cat: "集客", axis: "仕組み", hours: 1.5 },
  { wd: 3, time: "13:00", title: "講座コンテンツ制作", cat: "制作", axis: "仕組み", hours: 3 },
  { wd: 4, time: "10:00", title: "施術（指名）", cat: "施術", axis: "労働", hours: 3 },
  { wd: 4, time: "15:00", title: "経理・請求処理", cat: "経営", axis: "労働", hours: 1.5 },
  { wd: 5, time: "11:00", title: "数値レビュー・週次計画", cat: "経営", axis: "仕組み", hours: 1.5 },
  { wd: 5, time: "14:00", title: "ショート動画3本まとめ撮り", cat: "制作", axis: "仕組み", hours: 2 },
];

/* ──────────────────────────────────────────────────────────────
   初期データ（初回ログイン時にFirestoreへ自動投入）
   日付は「今日」基準の相対値で生成 → どの時点でも信号が機能する
   ────────────────────────────────────────────────────────────── */
function makeSeed() {
  const now = new Date();
  return {
    trips: [
      {
        id: "t1",
        title: "（例）登壇イベント",
        template: "遠方登壇",
        date: iso(addDays(now, 21)),
        items: templateItems("遠方登壇").map((it, i) => ({ ...it, done: i < 2 })),
      },
      {
        id: "t2",
        title: "（例）日帰り出張",
        template: "日帰り",
        date: iso(addDays(now, 9)),
        items: templateItems("日帰り").map((it, i) => ({ ...it, done: i < 1 })),
      },
    ],
    // 二段ローンチサンプル
    deadlines: [
      { id: "d1", title: "（例）先行登録 開始", date: iso(addDays(now, 25)), stage: "先行登録" },
      { id: "d2", title: "（例）本申込 開始", date: iso(addDays(now, 40)), stage: "本申込" },
    ],
    // ローンチKPI（先行登録→本申込CV→売上 の三角ファネル）
    launches: [
      {
        id: "L1",
        name: "（例）春の新講座ローンチ",
        goalReg: 100, reg: 67,   // 先行登録：目標/実績（人）
        goalCv: 30, cv: 12,      // 本申込：目標/実績（人）
        price: 40000,            // 客単価（円）
        goalRev: 800000,         // 売上目標（円）
        deadlineReg: iso(addDays(now, 1)),  // 先行登録 締切
        deadlineCv: iso(addDays(now, 10)),  // 本申込 締切
      },
    ],
    content: [
      { id: "c1", title: "（例）動画コンテンツ", phase: "撮影", done: false },
      { id: "c2", title: "（例）SNS投稿", phase: "編集", done: false },
      { id: "c3", title: "（例）ブログ記事", phase: "執筆", done: true },
    ],
    money: [
      { id: "m1", title: "（例）請求書 発行", amount: 0, kind: "請求", done: false },
      { id: "m2", title: "（例）入金確認", amount: 0, kind: "入金", done: false },
    ],
    tasks: [{ id: "k1", title: "（例）まず『サンプルを全部消す』で自分の予定に入れ替える", done: false }],
    // まとめ(ニュース)の情報源（編集可）
    feeds: [
      { id: "f1", name: "Googleニュース", url: "https://news.google.com/rss?hl=ja&gl=JP&ceid=JP:ja" },
      { id: "f2", name: "SNS集客・マーケ", url: "https://news.google.com/rss/search?q=SNS%20マーケティング%20集客&hl=ja&gl=JP&ceid=JP:ja" },
      { id: "f3", name: "個人事業・フリーランス", url: "https://news.google.com/rss/search?q=個人事業主%20フリーランス&hl=ja&gl=JP&ceid=JP:ja" },
    ],
    digest: null,
    newsCats: ["top", "business", "marketing", "solo"],
    birth: null,
    fortune: null,
    manualEvents: [], // スクショ取り込み(TimeTree等)の予定
    sampleNotice: true, // サンプルデータ識別フラグ
    updatedAt: Date.now(),
  };
}

/* ──────────────────────────────────────────────────────────────
   小物UI
   ────────────────────────────────────────────────────────────── */
function Panel({ title, accent, right, help, children }) {
  return (
    <section
      style={{
        background: C.panel,
        border: `1px solid ${C.line}`,
        borderRadius: 16,
        padding: 18,
        marginBottom: 16,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", marginBottom: 14, gap: 8 }}>
        <span style={{ width: 8, height: 20, borderRadius: 4, background: accent || C.accent }} />
        <h2 style={{ fontSize: 17, fontWeight: 700, letterSpacing: 0.4, margin: 0 }}>{title}</h2>
        {help && <Help text={help} />}
        <span style={{ flex: 1 }} />
        {right}
      </div>
      {children}
    </section>
  );
}

/* 用語の「?」ヘルプ（タップで説明をポップ） */
function Help({ text }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="説明"
        style={{ width: 22, height: 22, borderRadius: "50%", border: `1px solid ${C.line}`, background: "transparent", color: C.sub, fontSize: 13, cursor: "pointer", lineHeight: 1, display: "grid", placeItems: "center", flex: "0 0 auto" }}
      >?</button>
      {open && (
        <span
          onClick={() => setOpen(false)}
          style={{ position: "absolute", top: 26, left: 0, zIndex: 20, width: 240, background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 12px", fontSize: 13, color: C.text, fontWeight: 400, lineHeight: 1.6, boxShadow: "0 8px 24px rgba(0,0,0,0.45)" }}
        >{text}</span>
      )}
    </span>
  );
}

function Bar({ value, total, color }) {
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div style={{ height: 10, background: C.panel2, borderRadius: 6, overflow: "hidden" }}>
      <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 6 }} />
    </div>
  );
}

function Check({ done, onClick }) {
  return (
    <button
      onClick={onClick}
      aria-label={done ? "完了を取消" : "完了にする"}
      style={{
        width: 40,
        height: 40,
        borderRadius: 8,
        border: `1.5px solid ${done ? C.green : C.line}`,
        background: done ? C.green : "transparent",
        color: "#0B0D11",
        cursor: "pointer",
        flex: "0 0 auto",
        display: "grid",
        placeItems: "center",
        fontSize: 16,
        lineHeight: 1,
      }}
    >
      {done ? "✓" : ""}
    </button>
  );
}

/* ──────────────────────────────────────────────────────────────
   逆算チェーン（出張・遠征）
   ────────────────────────────────────────────────────────────── */
// 本番日のコンディション(占術)から、逆算チェーン全体への一言ガイドを作る（決定論・AI不使用）
function tripStanceHint(rel, dleft) {
  if (!rel) return null;
  const s = rel.stance;
  if (s === "攻め") return { color: C.green, text: dleft < 0 ? "本番は攻めの日。仕上げ・追い込みが伸びる流れ。" : "本番は攻めの日。当日に営業・追い込みを置くと伸びやすい。" };
  if (s === "守り") return { color: C.red, text: "本番は守りの日。準備は前倒しで、当日は欲張らず守りの段取りに。" };
  if (s === "労い") return { color: C.blue, text: "本番は労いの日。人や場に支えられる。受け取る姿勢で臨もう。" };
  return { color: C.accent, text: "本番は整える日。淡々と予定通りに進めるのが吉。" };
}

function TripChain({ trips, birth, onToggle, onAdd, onRemove, onEditTrip, onAddItem, onEditItem, onRemoveItem }) {
  // 各予定の本番日＋各手配の締切日の「気」をまとめて計算（命式計算は1回だけ・出生情報がある時のみ）
  const stances = useMemo(() => {
    if (!(birth && birth.date)) return {};
    const dates = [];
    for (const t of trips || []) {
      if (!t.date) continue;
      dates.push(t.date);
      for (const it of t.items || []) dates.push(iso(addDays(new Date(t.date), -(it.daysBefore || 0))));
    }
    return stancesFor(birth, dates);
  }, [birth && birth.date, birth && birth.time, JSON.stringify((trips || []).map((t) => [t.date, (t.items || []).map((i) => i.daysBefore)]))]);
  const [editTripId, setEditTripId] = useState(null);
  const [te, setTe] = useState({ title: "", date: "" });
  const [editItem, setEditItem] = useState(null); // { tripId, idx }
  const [ie, setIe] = useState({ label: "", daysBefore: 0 });
  const [addItemFor, setAddItemFor] = useState(null);
  const [ni, setNi] = useState({ label: "", daysBefore: 7 });

  const startTrip = (t) => { setEditTripId(t.id); setTe({ title: t.title, date: t.date }); };
  const saveTrip = () => { if (te.title.trim()) onEditTrip(editTripId, { title: te.title.trim(), date: te.date }); setEditTripId(null); };
  const startItem = (tripId, idx, item) => { setEditItem({ tripId, idx }); setIe({ label: item.label, daysBefore: item.daysBefore }); };
  const saveItem = () => { if (ie.label.trim()) onEditItem(editItem.tripId, editItem.idx, { label: ie.label.trim(), daysBefore: Number(ie.daysBefore) || 0 }); setEditItem(null); };

  return (
    <Panel title="予定の逆算チェーン" accent={C.green} help="本番日から逆算して、各準備の締切と信号（🟢=済 🟠=もうすぐ 🔴=遅れ）を自動表示します。出張・旅行・打ち合わせ・入学式・誕生日など、前もって準備が要る予定に対応。Googleカレンダーに『出張・旅行・式典・誕生日』などを含む予定があれば、3ヶ月先まで自動で逆算チェーン（🤖自動）を作ります。「型から追加」で手動追加も可能。" right={<AddTrip onAdd={onAdd} />}>
      {(!trips || trips.length === 0) && <Empty>逆算したい予定はまだありません。右上の「＋型から追加」で作成。</Empty>}
      <div style={{ display: "grid", gap: 14 }}>
        {(trips || []).map((trip) => {
          const dleft = daysUntil(trip.date);
          const doneCount = trip.items.filter((i) => i.done).length;
          return (
            <div key={trip.id} style={{ background: C.panel2, borderRadius: 12, padding: 14 }}>
              {editTripId === trip.id ? (
                <div style={{ marginBottom: 10 }}>
                  <input value={te.title} onChange={(e) => setTe({ ...te, title: e.target.value })} placeholder="タイトル" style={inp} />
                  <input type="date" value={te.date} onChange={(e) => setTe({ ...te, date: e.target.value })} style={inp} />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={saveTrip} style={{ ...chipBtn, background: C.accent, color: "#0B0D11", borderColor: C.accent }}>保存</button>
                    <button onClick={() => setEditTripId(null)} style={chipBtn}>取消</button>
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <strong style={{ fontSize: 14 }}>{trip.title}</strong>
                  {trip.auto && <span title="カレンダーの「出張」予定から自動作成" style={{ fontSize: 11, fontWeight: 700, color: C.green, background: C.greenSoft || C.panel2, border: `1px solid ${C.green}`, borderRadius: 8, padding: "1px 6px" }}>🤖自動</span>}
                  <span style={{ fontSize: 11, color: C.sub, border: `1px solid ${C.line}`, borderRadius: 8, padding: "1px 6px" }}>{trip.template}</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 12, color: C.sub }}>本番 {fmt(trip.date)}</span>
                  <button onClick={() => startTrip(trip)} style={iconBtn} title="編集">✎</button>
                  <button onClick={() => onRemove(trip.id)} style={iconBtn} title="削除">✕</button>
                </div>
              )}
              <div style={{ fontSize: 12, color: dleft < 0 ? C.red : C.accent, margin: "4px 0 8px" }}>
                {dleft < 0 ? `本番から${-dleft}日経過` : `本番まであと ${dleft}日`} ・ 手配 {doneCount}/{trip.items.length}
              </div>
              {(() => {
                const hint = tripStanceHint(stances[trip.date], dleft);
                return hint ? (
                  <div style={{ display: "flex", gap: 6, alignItems: "flex-start", background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: "6px 9px", marginBottom: 10 }}>
                    <span style={{ flex: "0 0 auto", fontSize: 13 }}>🧭</span>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 12, lineHeight: 1.45, color: hint.color, fontWeight: 600 }}>{hint.text}</span>
                  </div>
                ) : null;
              })()}
              <div style={{ display: "grid", gap: 6 }}>
                {trip.items.map((item, idx) => {
                  const sig = itemSignal(item, trip.date);
                  if (editItem && editItem.tripId === trip.id && editItem.idx === idx) {
                    return (
                      <div key={idx} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <input value={ie.label} onChange={(e) => setIe({ ...ie, label: e.target.value })} style={{ ...inp, marginBottom: 0, flex: "1 1 120px" }} />
                        <input value={ie.daysBefore} onChange={(e) => setIe({ ...ie, daysBefore: e.target.value })} inputMode="numeric" title="本番の何日前" style={{ ...inp, marginBottom: 0, width: 56 }} />
                        <span style={{ fontSize: 11, color: C.sub }}>日前</span>
                        <button onClick={saveItem} style={chipBtn}>保存</button>
                        <button onClick={() => setEditItem(null)} style={iconBtn} title="取消">✕</button>
                      </div>
                    );
                  }
                  return (
                    <div key={idx} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                      <Check done={item.done} onClick={() => onToggle(trip.id, idx)} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ flex: 1, minWidth: 0, fontSize: 14, lineHeight: 1.35, textDecoration: item.done ? "line-through" : "none", color: item.done ? C.faint : C.text }}>
                            {item.label}
                          </span>
                          <button onClick={() => startItem(trip.id, idx, item)} style={iconBtn} title="編集">✎</button>
                          <button onClick={() => onRemoveItem(trip.id, idx)} style={iconBtn} title="削除">✕</button>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 2 }}>
                          {!item.done && <span style={{ fontSize: 12, color: C.sub }}>締切 {fmt(sig.deadlineISO)}</span>}
                          <span style={{ fontSize: 12, color: sig.color, fontWeight: 600 }}>{sig.dot} {sig.label}</span>
                        </div>
                        {!item.done && stances[sig.deadlineISO] && stances[sig.deadlineISO].stance === "守り" && (
                          <div style={{ fontSize: 11, color: C.red, marginTop: 2 }}>🧭 締切が守りの日。1日前倒すと楽です</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {addItemFor === trip.id ? (
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                  <input autoFocus value={ni.label} onChange={(e) => setNi({ ...ni, label: e.target.value })} placeholder="手配項目" style={{ ...inp, marginBottom: 0, flex: "1 1 120px" }} />
                  <input value={ni.daysBefore} onChange={(e) => setNi({ ...ni, daysBefore: e.target.value })} inputMode="numeric" style={{ ...inp, marginBottom: 0, width: 56 }} />
                  <span style={{ fontSize: 11, color: C.sub }}>日前</span>
                  <button onClick={() => { if (!ni.label.trim()) return; onAddItem(trip.id, { label: ni.label.trim(), daysBefore: Number(ni.daysBefore) || 0 }); setNi({ label: "", daysBefore: 7 }); setAddItemFor(null); }} style={chipBtn}>追加</button>
                  <button onClick={() => setAddItemFor(null)} style={iconBtn} title="閉じる">✕</button>
                </div>
              ) : (
                <button onClick={() => setAddItemFor(trip.id)} style={{ ...chipBtn, marginTop: 8, fontSize: 11 }}>＋手配項目を追加</button>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function AddTrip({ onAdd }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [template, setTemplate] = useState("遠方登壇");
  const [date, setDate] = useState(iso(addDays(new Date(), 14)));
  if (!open) return <button onClick={() => setOpen(true)} style={chipBtn}>＋型から追加</button>;
  return (
    <div style={{ position: "absolute", right: 18, marginTop: 36, zIndex: 5, background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, width: 240 }}>
      <input placeholder="タイトル（例：大阪登壇／家族旅行）" value={title} onChange={(e) => setTitle(e.target.value)} style={inp} />
      <select value={template} onChange={(e) => setTemplate(e.target.value)} style={inp}>
        {Object.keys(TEMPLATES).map((t) => <option key={t}>{t}</option>)}
      </select>
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inp} />
      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
        <button
          style={{ ...chipBtn, background: C.accent, color: "#0B0D11", borderColor: C.accent }}
          onClick={() => {
            if (!title.trim()) return;
            onAdd({ title: title.trim(), template, date });
            setTitle("");
            setOpen(false);
          }}
        >追加</button>
        <button style={chipBtn} onClick={() => setOpen(false)}>閉じる</button>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   締切の逆算（二段ローンチ）
   ────────────────────────────────────────────────────────────── */
// 告知文の下書き（LINE/SNS/メール）をAIで生成して表示
function DraftPanel({ context }) {
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState(null);
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState("");
  useEffect(() => {
    let cancel = false;
    (async () => {
      setLoading(true); setErr(null);
      try {
        const r = await authedFetch("/api/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ context }) });
        const text = await r.text();
        let j; try { j = JSON.parse(text); } catch { console.error("[VIELE] draft parse error", r.status, text.slice(0, 200)); throw new Error("サーバーとの通信に失敗しました。少し時間をおいて再度お試しください。"); }
        if (!r.ok || j.error) throw new Error(j.error || "サーバーとの通信に失敗しました。少し時間をおいて再度お試しください。");
        if (j.aiEnabled === false) throw new Error("AI機能は現在オフです");
        track("ai_used", { feature: "draft" });
        if (!cancel) setDrafts(j.drafts || (j.raw ? { line: j.raw } : {}));
      } catch (e) { if (!cancel) setErr(e); }
      if (!cancel) setLoading(false);
    })();
    return () => { cancel = true; };
  }, [context]);
  const copy = (t) => { try { navigator.clipboard.writeText(t); setCopied(t.slice(0, 10)); setTimeout(() => setCopied(""), 1500); } catch { /* ignore */ } };
  const labels = { line: "公式LINE", sns: "SNS投稿", mail: "メール" };
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: 12, marginTop: 8 }}>
      {loading && <div style={{ fontSize: 12, color: C.sub }}>✍️ 下書きを作成中…</div>}
      {err && <div style={{ fontSize: 12, color: C.red, wordBreak: "break-word" }}>失敗：{String(err.message || err)}</div>}
      {drafts && ["line", "sns", "mail"].map((k) => drafts[k] && (
        <div key={k} style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 11, color: C.accent, fontWeight: 700 }}>{labels[k] || k}</span>
            <span style={{ flex: 1 }} />
            <button onClick={() => copy(drafts[k])} style={{ ...chipBtn, fontSize: 11, padding: "3px 10px" }}>{copied === drafts[k].slice(0, 10) ? "コピー済✓" : "コピー"}</button>
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", color: C.text, background: C.panel2, borderRadius: 8, padding: "8px 10px" }}>{drafts[k]}</div>
        </div>
      ))}
    </div>
  );
}

// 締切日のコンディション(占術)から、告知トーンの一言を作る（攻め/守りの日のみ）
function deadlineStanceHint(rel) {
  if (!rel) return null;
  if (rel.stance === "攻め") return { color: C.green, text: "攻めの日。締切前の追い込み配信を強めに。" };
  if (rel.stance === "守り") return { color: C.red, text: "守りの日。煽りすぎず、案内は丁寧に。" };
  return null;
}

function DeadlineBoard({ deadlines, linked, birth, onAdd, onAddBulk, onEdit, onRemove }) {
  // 手動の締切＋売上タブのローンチ締切(linked)を時系列に統合表示
  const sorted = [...(deadlines || []), ...(linked || [])].sort((a, b) => new Date(a.date) - new Date(b.date));
  // 各締切日の「気」をまとめて計算（命式計算は1回だけ・出生情報がある時のみ）
  const stances = useMemo(
    () => (birth && birth.date ? stancesFor(birth, sorted.map((d) => d.date)) : {}),
    [birth && birth.date, birth && birth.time, sorted.map((d) => d.date).join(",")]
  );
  const [mode, setMode] = useState(null); // null | "single" | "template"
  const blank = { title: "", stage: "", date: iso(addDays(new Date(), 14)) };
  const [f, setF] = useState(blank);
  const [editId, setEditId] = useState(null);
  const [draftId, setDraftId] = useState(null);
  const [e, setE] = useState(blank);
  const [tpl, setTpl] = useState(Object.keys(LAUNCH_TEMPLATES)[0]);
  const [anchor, setAnchor] = useState(iso(addDays(new Date(), 21)));
  const startEdit = (d) => { setEditId(d.id); setE({ title: d.title, stage: d.stage || "", date: d.date }); };
  const saveEdit = () => { if (e.title.trim()) onEdit(editId, { title: e.title.trim(), stage: e.stage, date: e.date }); setEditId(null); };
  const preview = buildLaunch(tpl, anchor);

  return (
    <Panel
      title="締切からの逆算（準備の段取り）"
      accent={C.purple}
      help="セミナーや出張、講座の販売（ローンチ）など本番の日が決まっている予定について、準備の節目（締切）を時系列に並べ、残り日数を信号で表示します。「型で一括作成」を使うと、本申込日などの基準日を1つ入れるだけで、予告・先行登録・リマインド・締切までを逆算してまとめて作れます。売上タブで登録したローンチの『先行登録/本申込 締切』(📣)も、ここに自動で並びます（編集は売上タブ側）。"
      right={
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => setMode(mode === "template" ? null : "template")} style={chipBtn}>型で一括</button>
          <button onClick={() => setMode(mode === "single" ? null : "single")} style={chipBtn}>＋締切</button>
        </div>
      }
    >
      {mode === "single" && (
        <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, marginBottom: 12 }}>
          <input value={f.title} onChange={(ev) => setF({ ...f, title: ev.target.value })} placeholder="締切名（例：本申込 開始）" style={inp} />
          <input value={f.stage} onChange={(ev) => setF({ ...f, stage: ev.target.value })} placeholder="段階（例：先行登録 / 本申込）" style={inp} />
          <input type="date" value={f.date} onChange={(ev) => setF({ ...f, date: ev.target.value })} style={inp} />
          <button
            style={{ ...chipBtn, background: C.accent, color: "#0B0D11", borderColor: C.accent }}
            onClick={() => { if (!f.title.trim()) return; onAdd({ title: f.title.trim(), stage: f.stage, date: f.date }); setF(blank); setMode(null); }}
          >追加</button>
        </div>
      )}
      {mode === "template" && (
        <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: C.sub, marginBottom: 6 }}>型を選び、基準日を入れると締切を逆算して一括作成します。</div>
          <select value={tpl} onChange={(ev) => setTpl(ev.target.value)} style={inp}>
            {Object.keys(LAUNCH_TEMPLATES).map((t) => <option key={t}>{t}</option>)}
          </select>
          <label style={{ fontSize: 12, color: C.sub, display: "block", marginBottom: 4 }}>{LAUNCH_TEMPLATES[tpl].anchorLabel}</label>
          <input type="date" value={anchor} onChange={(ev) => setAnchor(ev.target.value)} style={inp} />
          <div style={{ background: C.panel, borderRadius: 8, padding: "8px 10px", marginBottom: 8 }}>
            {preview.map((p, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.sub, padding: "2px 0" }}>
                <span>{p.title}</span><span>{fmt(p.date)}</span>
              </div>
            ))}
          </div>
          <button
            style={{ ...chipBtn, background: C.accent, color: "#0B0D11", borderColor: C.accent }}
            onClick={() => { onAddBulk(preview); setMode(null); }}
          >{preview.length}件まとめて追加</button>
        </div>
      )}
      {sorted.length === 0 && <Empty>締切は登録されていません。右上から追加できます。</Empty>}
      <div style={{ display: "grid", gap: 10 }}>
        {sorted.map((d, i) => {
          if (!d.linked && editId === d.id) {
            return (
              <div key={d.id} style={{ background: C.panel2, borderRadius: 12, padding: 12 }}>
                <input value={e.title} onChange={(ev) => setE({ ...e, title: ev.target.value })} placeholder="締切名" style={inp} />
                <input value={e.stage} onChange={(ev) => setE({ ...e, stage: ev.target.value })} placeholder="段階" style={inp} />
                <input type="date" value={e.date} onChange={(ev) => setE({ ...e, date: ev.target.value })} style={inp} />
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={saveEdit} style={{ ...chipBtn, background: C.accent, color: "#0B0D11", borderColor: C.accent }}>保存</button>
                  <button onClick={() => setEditId(null)} style={chipBtn}>取消</button>
                </div>
              </div>
            );
          }
          const sig = deadlineSignal(d.date);
          return (
            <div key={d.id}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, background: C.panel2, borderRadius: 12, padding: "12px 14px", borderLeft: d.linked ? `3px solid ${C.accent}` : undefined }}>
                <span style={{ width: 28, height: 28, borderRadius: "50%", background: C.panel, border: `1px solid ${C.line}`, display: "grid", placeItems: "center", fontSize: 13, color: C.sub, flex: "0 0 auto" }}>
                  {i + 1}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15 }}>{d.linked ? "📣 " : ""}{d.title}</div>
                  <div style={{ fontSize: 12, color: C.sub }}>{d.stage} ・ {fmt(d.date)}{d.linked ? " ・ 売上タブのローンチ" : ""}</div>
                  {(() => { const h = deadlineStanceHint(stances[d.date]); return h ? <div style={{ fontSize: 11, color: h.color, marginTop: 2 }}>🧭 {h.text}</div> : null; })()}
                </div>
                <span style={{ fontSize: 13, color: sig.color, fontWeight: 600 }}>{sig.dot} {sig.label}</span>
                <button onClick={() => setDraftId(draftId === d.id ? null : d.id)} style={iconBtn} title="告知文を作る">✍️</button>
                {!d.linked && <button onClick={() => startEdit(d)} style={iconBtn} title="編集">✎</button>}
                {!d.linked && <button onClick={() => onRemove(d.id)} style={iconBtn} title="削除">✕</button>}
              </div>
              {draftId === d.id && <DraftPanel context={`${d.stage ? d.stage + "：" : ""}「${d.title}」（${fmt(d.date)}）の告知`} />}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

/* ──────────────────────────────────────────────────────────────
   今週の時間配分メーター（役割 ＋ 労働⟷仕組みの2軸）
   ────────────────────────────────────────────────────────────── */
function TimeMeter({ entries, source, status, error, count, onConnect, connecting, onRefresh, refreshing }) {
  const r1 = (n) => Math.round(n * 10) / 10;
  const total = entries.reduce((s, e) => s + e.hours, 0);
  const cats = Array.from(new Set([...Object.keys(CAT), ...entries.map((e) => e.cat)]));
  const byCat = {};
  cats.forEach((c) => (byCat[c] = 0));
  entries.forEach((e) => { byCat[e.cat] = (byCat[e.cat] || 0) + e.hours; });
  const labor = entries.filter((e) => e.axis === "労働").reduce((s, e) => s + e.hours, 0);
  const system = total - labor;
  const systemPct = total > 0 ? Math.round((system / total) * 100) : 0;

  return (
    <Panel title="今週の時間配分メーター" accent={C.accent} help="今週の時間を役割（施術/制作/集客/経営）別に表示します。さらに『労働＝自分が動く時間』と『仕組み＝後から自動で売れる資産になる時間』の2軸で、仕組みづくりに時間を回せているかを％で見ます。" right={<span style={{ fontSize: 13, color: C.sub }}>計 {r1(total)}h</span>}>
      <CalStatusNote source={source} status={status} error={error} count={count} onConnect={onConnect} connecting={connecting} onRefresh={onRefresh} refreshing={refreshing} />
      {total === 0 ? (
        <Empty>{source === "calendar" ? "今週の時間指定の予定が見つかりませんでした。" : "データがありません。"}</Empty>
      ) : (
        <>
          <div style={{ display: "grid", gap: 12 }}>
            {cats.filter((c) => byCat[c] > 0).map((cat) => (
              <div key={cat}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                  <span style={{ color: CAT[cat] || C.faint }}>● {cat}</span>
                  <span style={{ color: C.sub }}>{r1(byCat[cat])}h</span>
                </div>
                <Bar value={byCat[cat]} total={total} color={CAT[cat] || C.faint} />
              </div>
            ))}
          </div>
          <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px solid ${C.line}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: C.sub, marginBottom: 6 }}>
              <span>労働（自分が動く） {r1(labor)}h</span>
              <span>仕組み（資産になる） {r1(system)}h</span>
            </div>
            <div style={{ display: "flex", height: 12, borderRadius: 6, overflow: "hidden" }}>
              <div style={{ width: `${100 - systemPct}%`, background: C.orange }} />
              <div style={{ width: `${systemPct}%`, background: C.green }} />
            </div>
            <div style={{ fontSize: 13, color: systemPct >= 40 ? C.green : C.orange, marginTop: 8 }}>
              仕組み化 {systemPct}% — {systemPct >= 40 ? "資産づくりに時間が回っています。" : "労働比率が高め。仕組み側へ寄せる余地あり。"}
            </div>
          </div>
        </>
      )}
    </Panel>
  );
}

/* ──────────────────────────────────────────────────────────────
   今日の予定（カレンダー連携 or サンプルから本日の曜日を抽出）
   ────────────────────────────────────────────────────────────── */
const CAT_CYCLE = ["施術", "制作", "集客", "経営", "その他"];

// 予定1件の行（今日の予定／日別ビュー共通）
function ScheduleRow({ e, source, onSetCat, writableIds, onEditEvent, onDeleteEvent, busy }) {
  const isFamily = e.role === "family";
  const canCat = source === "calendar" && !!onSetCat && !isFamily;
  const editable = source === "calendar" && !e.manual && !!onEditEvent && !!e.id && writableIds && writableIds.has(e.calendarId);
  const [editing, setEditing] = useState(false);
  const [ef, setEf] = useState({ title: "", date: "", allDay: false, start: "10:00" });
  const startEdit = () => { setEf({ title: e.title, date: iso(e.start), allDay: !!e.allDay, start: e.allDay ? "10:00" : e.time }); setEditing(true); };
  const save = async () => {
    const dur = e.endISO && !e.allDay ? Math.max(900000, new Date(e.endISO) - new Date(e.startISO)) : 3600000;
    const ev = ef.allDay
      ? { title: ef.title.trim() || "(無題)", allDay: true, startISO: ef.date }
      : (() => { const s = new Date(`${ef.date}T${ef.start}:00`); return { title: ef.title.trim() || "(無題)", allDay: false, startISO: s.toISOString(), endISO: new Date(s.getTime() + dur).toISOString() }; })();
    const ok = await onEditEvent(e.calendarId, e.id, ev);
    if (ok) setEditing(false);
  };
  if (editing) {
    return (
      <div style={{ background: C.panel2, borderRadius: 10, padding: 10 }}>
        <input value={ef.title} onChange={(x) => setEf({ ...ef, title: x.target.value })} style={inp} />
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
          <input type="date" value={ef.date} onChange={(x) => setEf({ ...ef, date: x.target.value })} style={{ ...inp, marginBottom: 0, flex: "1 1 130px" }} />
          {!ef.allDay && <input type="time" value={ef.start} onChange={(x) => setEf({ ...ef, start: x.target.value })} style={{ ...inp, marginBottom: 0, width: 110 }} />}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={save} disabled={busy} style={{ ...chipBtn, background: C.blue, color: "#0B0D11", borderColor: C.blue }}>{busy ? "保存中…" : "保存"}</button>
          <button onClick={() => setEditing(false)} style={chipBtn}>取消</button>
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
      <span style={{ fontVariantNumeric: "tabular-nums", color: C.sub, fontSize: 14, width: 46, flex: "0 0 auto", paddingTop: 1 }}>{e.time}</span>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: catColor(e.cat), flex: "0 0 auto", marginTop: 7 }} />
      <span style={{ flex: 1, minWidth: 0, fontSize: 15, lineHeight: 1.35, color: isFamily ? C.sub : C.text }}>{e.title}</span>
      {canCat ? (
        <button
          onClick={() => onSetCat(e.title, CAT_CYCLE[(CAT_CYCLE.indexOf(e.cat) + 1) % CAT_CYCLE.length])}
          style={{ flex: "0 0 auto", fontSize: 12, color: catColor(e.cat), background: "transparent", border: `1px solid ${C.line}`, borderRadius: 6, padding: "2px 8px", cursor: "pointer" }}
        >{e.cat} ⇄</button>
      ) : (
        <span style={{ fontSize: 12, color: catColor(e.cat), flex: "0 0 auto" }}>{e.cat}</span>
      )}
      {editable && <button onClick={startEdit} style={iconBtn} title="時間・内容を編集">✎</button>}
      {editable && <button onClick={() => onDeleteEvent(e.calendarId, e.id)} style={iconBtn} title="Googleカレンダーから削除">✕</button>}
    </div>
  );
}

/* Googleカレンダーへ予定を追加する小さなバー（今日の予定の上に置く） */
function AddEventBar({ calList, onCreate, busy, msg, onReconnect }) {
  const writable = (calList || []).filter((c) => c.accessRole === "owner" || c.accessRole === "writer");
  const defaultCal = ((writable.find((c) => c.primary) || writable[0]) || {}).id || "primary";
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ title: "", date: iso(new Date()), allDay: false, start: "10:00", end: "11:00", calendarId: "" });
  const calId = f.calendarId || defaultCal;
  const submit = async () => {
    if (!f.title.trim()) return;
    const ev = f.allDay
      ? { title: f.title.trim(), allDay: true, startISO: f.date }
      : { title: f.title.trim(), allDay: false, startISO: new Date(`${f.date}T${f.start}:00`).toISOString(), endISO: new Date(`${f.date}T${f.end}:00`).toISOString() };
    const ok = await onCreate(calId, ev);
    if (ok) { setF({ ...f, title: "" }); setOpen(false); }
  };
  const noWritable = writable.length === 0;
  return (
    <div style={{ marginBottom: 12 }}>
      {!open ? (
        <button onClick={() => setOpen(true)} disabled={noWritable} title={noWritable ? "書き込み権限の再連携が必要です" : ""} style={{ ...chipBtn, background: noWritable ? "transparent" : C.blue, color: noWritable ? C.faint : "#0B0D11", borderColor: C.blue, fontWeight: 700 }}>
          ＋ 予定を追加（Googleカレンダー）
        </button>
      ) : (
        <div style={{ background: C.panel2, borderRadius: 12, padding: 12, border: `1px solid ${C.line}` }}>
          <input autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="予定のタイトル（例：オンライン施術）" style={inp} />
          <input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} style={inp} />
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.sub, margin: "2px 0 8px" }}>
            <input type="checkbox" checked={f.allDay} onChange={(e) => setF({ ...f, allDay: e.target.checked })} /> 終日
          </label>
          {!f.allDay && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
              <input type="time" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} style={{ ...inp, marginBottom: 0 }} />
              <span style={{ color: C.faint }}>〜</span>
              <input type="time" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} style={{ ...inp, marginBottom: 0 }} />
            </div>
          )}
          {writable.length > 1 && (
            <select value={calId} onChange={(e) => setF({ ...f, calendarId: e.target.value })} style={inp}>
              {writable.map((c) => <option key={c.id} value={c.id}>{c.summary}{c.primary ? "（メイン）" : ""}</option>)}
            </select>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={submit} disabled={busy || !f.title.trim()} style={{ ...chipBtn, background: C.blue, color: "#0B0D11", borderColor: C.blue, fontWeight: 700 }}>{busy ? "追加中…" : "追加"}</button>
            <button onClick={() => setOpen(false)} style={chipBtn}>閉じる</button>
          </div>
        </div>
      )}
      {msg && <div style={{ fontSize: 12, color: msg.startsWith("失敗") || msg.includes("必要") ? C.red : C.green, marginTop: 6 }}>{msg}</div>}
      {(noWritable || (msg && msg.includes("必要"))) && onReconnect && (
        <button onClick={onReconnect} style={{ ...chipBtn, marginTop: 8, background: C.text, color: "#0B0D11", borderColor: C.text, fontWeight: 700 }}>
          書き込みを許可する（再連携）
        </button>
      )}
    </div>
  );
}

// 横スワイプで今日→明日→明後日…と切り替わる日別スケジュール
// 汎用の横スワイプ表示（slides = [{key,label,content}]）
function SwipeView({ slides, accent = C.blue, hint }) {
  const scroller = useRef(null);
  const [idx, setIdx] = useState(0);
  const goTo = (i) => {
    const n = Math.max(0, Math.min(slides.length - 1, i));
    const el = scroller.current;
    if (el) el.scrollTo({ left: el.clientWidth * n, behavior: "smooth" });
    setIdx(n);
  };
  const onScroll = () => {
    const el = scroller.current;
    if (el) setIdx(Math.round(el.scrollLeft / el.clientWidth));
  };
  if (!slides.length) return null;
  const cur = slides[Math.min(idx, slides.length - 1)];
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <button onClick={() => goTo(idx - 1)} disabled={idx === 0} style={{ ...iconBtn, width: 36, height: 36, fontSize: 18, opacity: idx === 0 ? 0.3 : 1 }} aria-label="前へ">‹</button>
        <div style={{ flex: 1, textAlign: "center", fontSize: 14, fontWeight: 700 }}>{cur.label}</div>
        <button onClick={() => goTo(idx + 1)} disabled={idx >= slides.length - 1} style={{ ...iconBtn, width: 36, height: 36, fontSize: 18, opacity: idx >= slides.length - 1 ? 0.3 : 1 }} aria-label="次へ">›</button>
      </div>
      <div ref={scroller} onScroll={onScroll} data-hscroll="1" style={{ display: "flex", overflowX: "auto", scrollSnapType: "x mandatory", WebkitOverflowScrolling: "touch", scrollbarWidth: "none" }}>
        {slides.map((s) => (
          <div key={s.key} style={{ flex: "0 0 100%", minWidth: "100%", scrollSnapAlign: "start", boxSizing: "border-box" }}>{s.content}</div>
        ))}
      </div>
      {slides.length > 1 && (
        <div style={{ display: "flex", justifyContent: "center", gap: 6, marginTop: 12 }}>
          {slides.map((s, i) => (
            <button key={s.key} onClick={() => goTo(i)} aria-label={String(s.label)} style={{ width: i === idx ? 18 : 7, height: 7, borderRadius: 4, border: "none", padding: 0, cursor: "pointer", background: i === idx ? accent : C.line }} />
          ))}
        </div>
      )}
      {hint && <div aria-hidden="true" style={{ fontSize: 11, color: C.sub, marginTop: 8, textAlign: "center" }}>{hint}</div>}
    </>
  );
}

function Schedule({ days, source, status, error, count, onConnect, connecting, onSetCat, onRefresh, refreshing, writableIds, onEditEvent, onDeleteEvent, editBusy }) {
  const list = days || [];
  const slides = list.map((day) => ({
    key: day.key,
    label: `${day.label}（${day.date.getMonth() + 1}/${day.date.getDate()} ${WD[day.date.getDay()]}）`,
    content: day.items.length === 0
      ? <Empty>予定はありません。</Empty>
      : <div style={{ display: "grid", gap: 10 }}>{day.items.map((e, i) => <ScheduleRow key={e.id || i} e={e} source={source} onSetCat={onSetCat} writableIds={writableIds} onEditEvent={onEditEvent} onDeleteEvent={onDeleteEvent} busy={editBusy} />)}</div>,
  }));
  return (
    <Panel title="予定（横スワイプで先の日へ）" accent={C.blue}>
      <CalStatusNote source={source} status={status} error={error} count={count} onConnect={onConnect} connecting={connecting} onRefresh={onRefresh} refreshing={refreshing} />
      <SwipeView slides={slides} accent={C.blue} hint="← 横スワイプ / 矢印で 今日・明日・明後日… →" />
    </Panel>
  );
}

/* 今後の予定（先2ヶ月・重要イベント）。月ごとにまとめ、初期は10件表示。 */
function Upcoming({ events, writableIds, onEditEvent, onDeleteEvent, editBusy }) {
  const [showAll, setShowAll] = useState(false);
  const list = events || [];
  const shown = showAll ? list : list.slice(0, 10);
  // 月ごとにグルーピング
  const groups = [];
  shown.forEach((e) => {
    const key = `${e.start.getFullYear()}年${e.start.getMonth() + 1}月`;
    let g = groups.find((x) => x.key === key);
    if (!g) { g = { key, items: [] }; groups.push(g); }
    g.items.push(e);
  });
  return (
    <Panel title="今後の予定（先2ヶ月）" accent={FAMILY_COLOR} help="出張・登壇・ライブ・イベント等の重要予定と、家族・プライベートの予定（別色）を先まで表示します。✎で時間変更・✕で削除（Googleカレンダーに反映）。">
      {list.length === 0 ? (
        <Empty>先2ヶ月に重要な予定はありません。</Empty>
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          {groups.map((g) => (
            <div key={g.key}>
              <div style={{ fontSize: 12, color: C.sub, fontWeight: 700, marginBottom: 6 }}>{g.key}</div>
              <div style={{ display: "grid", gap: 8 }}>
                {g.items.map((e, i) => (
                  <UpcomingRow key={e.id || i} e={e} writableIds={writableIds} onEditEvent={onEditEvent} onDeleteEvent={onDeleteEvent} busy={editBusy} />
                ))}
              </div>
            </div>
          ))}
          {list.length > 10 && (
            <button onClick={() => setShowAll((v) => !v)} style={{ ...chipBtn, justifySelf: "start" }}>
              {showAll ? "閉じる" : `もっと見る（残り${list.length - 10}件）`}
            </button>
          )}
        </div>
      )}
    </Panel>
  );
}

function UpcomingRow({ e, writableIds, onEditEvent, onDeleteEvent, busy }) {
  const editable = !e.manual && !!onEditEvent && !!e.id && writableIds && writableIds.has(e.calendarId);
  const [editing, setEditing] = useState(false);
  const [ef, setEf] = useState({ title: "", date: "", allDay: false, start: "10:00" });
  const startEdit = () => { setEf({ title: e.title, date: iso(e.start), allDay: !!e.allDay, start: e.allDay ? "10:00" : e.time }); setEditing(true); };
  const save = async () => {
    const dur = e.endISO && !e.allDay ? Math.max(900000, new Date(e.endISO) - new Date(e.startISO)) : 3600000;
    const ev = ef.allDay
      ? { title: ef.title.trim() || "(無題)", allDay: true, startISO: ef.date }
      : (() => { const s = new Date(`${ef.date}T${ef.start}:00`); return { title: ef.title.trim() || "(無題)", allDay: false, startISO: s.toISOString(), endISO: new Date(s.getTime() + dur).toISOString() }; })();
    const ok = await onEditEvent(e.calendarId, e.id, ev);
    if (ok) setEditing(false);
  };
  if (editing) {
    return (
      <div style={{ background: C.panel2, borderRadius: 10, padding: 10 }}>
        <input value={ef.title} onChange={(x) => setEf({ ...ef, title: x.target.value })} style={inp} />
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
          <input type="date" value={ef.date} onChange={(x) => setEf({ ...ef, date: x.target.value })} style={{ ...inp, marginBottom: 0, flex: "1 1 130px" }} />
          {!ef.allDay && <input type="time" value={ef.start} onChange={(x) => setEf({ ...ef, start: x.target.value })} style={{ ...inp, marginBottom: 0, width: 110 }} />}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={save} disabled={busy} style={{ ...chipBtn, background: C.blue, color: "#0B0D11", borderColor: C.blue }}>{busy ? "保存中…" : "保存"}</button>
          <button onClick={() => setEditing(false)} style={chipBtn}>取消</button>
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
      <span style={{ fontVariantNumeric: "tabular-nums", color: C.sub, fontSize: 13, width: 78, flex: "0 0 auto", paddingTop: 1 }}>
        {e.start.getMonth() + 1}/{e.start.getDate()}({WD[e.start.getDay()]}){e.allDay ? "" : ` ${e.time}`}
      </span>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: catColor(e.cat), flex: "0 0 auto", marginTop: 6 }} />
      <span style={{ flex: 1, minWidth: 0, fontSize: 14, lineHeight: 1.35, color: e.role === "family" ? C.sub : C.text }}>{e.title}</span>
      {editable ? (
        <>
          <button onClick={startEdit} style={iconBtn} title="時間・内容を編集">✎</button>
          <button onClick={() => onDeleteEvent(e.calendarId, e.id)} style={iconBtn} title="Googleカレンダーから削除">✕</button>
        </>
      ) : (
        <span style={{ fontSize: 11, color: catColor(e.cat), fontWeight: 700, flex: "0 0 auto" }}>{e.role === "family" ? "家族" : e.cat}</span>
      )}
    </div>
  );
}

/* ニュースのカテゴリ（Googleニュース RSS）。選んだものを取得する。 */
const NEWS_CATEGORIES = [
  { key: "top", label: "総合", url: "https://news.google.com/rss?hl=ja&gl=JP&ceid=JP:ja" },
  { key: "business", label: "ビジネス", url: "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=ja&gl=JP&ceid=JP:ja" },
  { key: "marketing", label: "SNS・集客", url: "https://news.google.com/rss/search?q=SNS%20マーケティング%20集客&hl=ja&gl=JP&ceid=JP:ja" },
  { key: "solo", label: "個人事業", url: "https://news.google.com/rss/search?q=個人事業主%20フリーランス&hl=ja&gl=JP&ceid=JP:ja" },
  { key: "money", label: "経済・お金", url: "https://news.google.com/rss/search?q=経済%20確定申告%20税金&hl=ja&gl=JP&ceid=JP:ja" },
  { key: "beauty", label: "健康・美容", url: "https://news.google.com/rss/search?q=健康%20美容%20セルフケア&hl=ja&gl=JP&ceid=JP:ja" },
  { key: "tech", label: "テクノロジー", url: "https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=ja&gl=JP&ceid=JP:ja" },
  { key: "ent", label: "エンタメ", url: "https://news.google.com/rss/headlines/section/topic/ENTERTAINMENT?hl=ja&gl=JP&ceid=JP:ja" },
  { key: "game", label: "ゲーム", url: "https://news.google.com/rss/search?q=ゲーム%20OR%20eSports%20OR%20任天堂%20OR%20PS5&hl=ja&gl=JP&ceid=JP:ja" },
  { key: "sports", label: "スポーツ", url: "https://news.google.com/rss/headlines/section/topic/SPORTS?hl=ja&gl=JP&ceid=JP:ja" },
  { key: "science", label: "科学", url: "https://news.google.com/rss/headlines/section/topic/SCIENCE?hl=ja&gl=JP&ceid=JP:ja" },
  { key: "world", label: "国際", url: "https://news.google.com/rss/headlines/section/topic/WORLD?hl=ja&gl=JP&ceid=JP:ja" },
  { key: "nation", label: "国内", url: "https://news.google.com/rss/headlines/section/topic/NATION?hl=ja&gl=JP&ceid=JP:ja" },
];
const DEFAULT_NEWS_CATS = ["top", "business", "marketing", "solo"];

/* 既定の出生データ — 配布版では null（各ユーザーが自分で入力） */
const DEFAULT_BIRTH = null;

/* 都道府県→緯度経度（県庁所在地）。出生地選択で命式の精度を確保 */
const PREFS = [
  ["北海道", 43.06, 141.35], ["青森", 40.82, 140.74], ["岩手", 39.70, 141.15], ["宮城", 38.27, 140.87], ["秋田", 39.72, 140.10],
  ["山形", 38.24, 140.36], ["福島", 37.75, 140.47], ["茨城", 36.34, 140.45], ["栃木", 36.57, 139.88], ["群馬", 36.39, 139.06],
  ["埼玉", 35.86, 139.65], ["千葉", 35.61, 140.12], ["東京", 35.69, 139.69], ["神奈川", 35.45, 139.64], ["新潟", 37.90, 139.02],
  ["富山", 36.70, 137.21], ["石川", 36.59, 136.63], ["福井", 36.07, 136.22], ["山梨", 35.66, 138.57], ["長野", 36.65, 138.18],
  ["岐阜", 35.39, 136.72], ["静岡", 34.98, 138.38], ["愛知", 35.18, 136.91], ["三重", 34.73, 136.51], ["滋賀", 35.00, 135.87],
  ["京都", 35.02, 135.76], ["大阪", 34.69, 135.52], ["兵庫", 34.69, 135.18], ["奈良", 34.69, 135.83], ["和歌山", 34.23, 135.17],
  ["鳥取", 35.50, 134.24], ["島根", 35.47, 133.05], ["岡山", 34.66, 133.93], ["広島", 34.40, 132.46], ["山口", 34.19, 131.47],
  ["徳島", 34.07, 134.56], ["香川", 34.34, 134.04], ["愛媛", 33.84, 132.77], ["高知", 33.56, 133.53], ["福岡", 33.61, 130.42],
  ["佐賀", 33.25, 130.30], ["長崎", 32.74, 129.87], ["熊本", 32.79, 130.74], ["大分", 33.24, 131.61], ["宮崎", 31.91, 131.42],
  ["鹿児島", 31.56, 130.56], ["沖縄", 26.21, 127.68],
];

/* 今日のまとめ（ニュースRSS集約＋任意でAI要約） */
function DigestPanel({ digest, loading, error, onRefresh, feeds, onAddFeed, onRemoveFeed, selectedCats, onToggleCat }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const items = (digest && digest.items) || [];
  const briefLines = (digest && digest.briefing ? digest.briefing.split("\n") : []).filter((l) => l.trim());
  const cats = selectedCats || DEFAULT_NEWS_CATS;

  return (
    <Panel
      title="今日のまとめ（ニュース）"
      accent={C.blue}
      help="登録した情報源(RSS)の新着をまとめて表示します。サーバーのGeminiキーを設定すると、見出しから『今日の3行ブリーフィング』をAIが自動生成します(未設定でも見出しは出ます)。"
      right={<button onClick={onRefresh} disabled={loading} style={chipBtn}>{loading ? "取得中…" : "更新"}</button>}
    >
      {/* カテゴリ選択 */}
      <div data-hscroll="1" style={{ display: "flex", gap: 6, overflowX: "auto", scrollbarWidth: "none", marginBottom: 6, paddingBottom: 2 }}>
        {NEWS_CATEGORIES.map((c) => {
          const on = cats.includes(c.key);
          return (
            <button
              key={c.key}
              onClick={() => onToggleCat(c.key)}
              style={{ flex: "0 0 auto", fontSize: 12, padding: "5px 11px", borderRadius: 999, border: `1px solid ${on ? C.blue : C.line}`, background: on ? C.blue : "transparent", color: on ? "#fff" : C.sub, cursor: "pointer", fontWeight: on ? 700 : 400 }}
            >{c.label}</button>
          );
        })}
      </div>
      <div style={{ fontSize: 11, color: C.sub, marginBottom: 12 }}>カテゴリを選んで「更新」で反映されます（取りすぎると見づらいので3〜5個が目安）。</div>

      {error && (
        <div style={{ fontSize: 12, color: C.red, background: C.panel2, border: `1px solid ${C.red}`, borderRadius: 8, padding: "8px 10px", marginBottom: 10, wordBreak: "break-word" }}>
          取得に失敗：{String((error && error.message) || error)}
        </div>
      )}

      {briefLines.length > 0 && (
        <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 12px", marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: C.accent, fontWeight: 700, marginBottom: 6 }}>🤖 今日の3行ブリーフィング</div>
          {briefLines.map((l, i) => (
            <div key={i} style={{ fontSize: 13, lineHeight: 1.6, color: C.text }}>{l.replace(/^[・\-*\s]+/, "・")}</div>
          ))}
        </div>
      )}

      {items.length === 0 && !loading && <Empty>まだ記事がありません。「更新」を押すか、情報源を追加してください。</Empty>}

      {items.length > 0 && (() => {
        const renderItems = (arr) => (
          arr.length === 0 ? <Empty>記事がありません。</Empty> : (
            <div style={{ display: "grid", gap: 10 }}>
              {arr.slice(0, 25).map((it, i) => (
                <a key={i} href={it.link} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none", color: "inherit" }}>
                  <div style={{ display: "grid", gap: 2 }}>
                    <div style={{ fontSize: 14, lineHeight: 1.35, color: C.text }}>{it.title}</div>
                    <div style={{ fontSize: 11, color: C.sub }}>{it.source}{it.date ? ` ・ ${fmtNews(it.date)}` : ""}</div>
                  </div>
                </a>
              ))}
            </div>
          )
        );
        const sources = Array.from(new Set(items.map((it) => it.source).filter(Boolean)));
        const slides = [
          { key: "all", label: `すべて(${items.length})`, content: renderItems(items) },
          ...sources.map((s) => { const arr = items.filter((it) => it.source === s); return { key: s, label: `${s}(${arr.length})`, content: renderItems(arr) }; }),
        ];
        return <SwipeView slides={slides} accent={C.blue} hint="← 横スワイプで 情報源を切替 →" />;
      })()}

      {/* 情報源の編集 */}
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${C.line}` }}>
        <button onClick={() => setOpen((o) => !o)} style={{ ...chipBtn, fontSize: 11 }}>{open ? "情報源を閉じる" : "情報源を編集"}</button>
        {open && (
          <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
            {(feeds || []).map((f) => (
              <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name || f.url}</span>
                <button onClick={() => onRemoveFeed(f.id)} style={iconBtn} title="削除">✕</button>
              </div>
            ))}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="名前(任意)" style={{ ...inp, marginBottom: 0, width: 110 }} />
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="ニュース配信先(RSS)のURL" style={{ ...inp, marginBottom: 0, flex: "1 1 140px" }} />
              <button onClick={() => { if (!url.trim()) return; onAddFeed({ name: name.trim(), url: url.trim() }); setName(""); setUrl(""); }} style={chipBtn}>追加</button>
            </div>
            <div style={{ fontSize: 11, color: C.sub }}>RSS＝ニュースの自動受信先のこと。例：ブログ等のRSS、Googleニュース検索のRSS。記事は見出し＋出典リンクのみ表示します。</div>
          </div>
        )}
      </div>
    </Panel>
  );
}

// ニュース日時の簡易表示
function fmtNews(s) {
  const t = Date.parse(s);
  if (!t) return "";
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/* 運気（年運・月運・日運）。命式データを根拠にAIが鑑定。 */
// 運気の波グラフ（1〜5スコアの棒）
function FortuneBars({ values, highlight, color }) {
  const arr = Array.isArray(values) ? values : [];
  if (!arr.length) return null;
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: arr.length > 16 ? 1 : 3, height: 56, marginTop: 8 }}>
      {arr.map((v, i) => {
        const s = Math.max(1, Math.min(5, Number(v) || 1));
        const on = i === highlight;
        return (
          <div key={i} title={`${i + 1}: ${s}`} style={{ flex: 1, height: `${(s / 5) * 100}%`, background: on ? color : C.line, borderRadius: 2, minWidth: 2 }} />
        );
      })}
    </div>
  );
}

// 折りたたみセクション（タップで開閉）
function Acc({ title, color, badge, defaultOpen, children }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 12, marginBottom: 12, overflow: "hidden" }}>
      <button onClick={() => setOpen((o) => !o)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, background: "transparent", border: "none", color: C.text, padding: "12px 14px", cursor: "pointer", textAlign: "left", font: "inherit" }}>
        <strong style={{ fontSize: 14, color: color || C.text }}>{title}</strong>
        {badge}
        <span style={{ flex: 1 }} />
        <span style={{ color: C.sub, fontSize: 12 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && <div style={{ padding: "0 14px 14px" }}>{children}</div>}
    </div>
  );
}

// 出生情報エディタ（1回入力すれば保存され毎回反映）
function BirthEditor({ birth, onSave }) {
  const b = birth || {};
  const [name, setName] = useState(b.name || "");
  const [date, setDate] = useState(b.date || "");
  const [time, setTime] = useState(b.time || "");
  const [pref, setPref] = useState(b.place || "東京");
  const save = () => {
    const p = PREFS.find((x) => x[0] === pref) || PREFS.find((x) => x[0] === "東京");
    if (!date) { alert("生年月日を入れてください"); return; }
    onSave({ name: name.trim(), date, time: time || "12:00", place: pref, lat: p[1], lon: p[2], utcOffset: 9 });
  };
  const hasDate = !!(birth && birth.date);
  return (
    <Acc title={hasDate ? "出生情報の編集" : "出生情報を入力（あなたの運勢を占います）"} color={hasDate ? C.sub : C.purple} defaultOpen={!hasDate}>
      <div style={{ fontSize: 12, color: C.sub, marginBottom: 8 }}>一度入力して保存すれば、以後ずっと反映されます（全端末で同期）。</div>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="名前（任意）" style={inp} />
      <label style={{ fontSize: 12, color: C.sub, display: "block", marginBottom: 2 }}>生年月日</label>
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inp} />
      <label style={{ fontSize: 12, color: C.sub, display: "block", marginBottom: 2 }}>出生時刻（分かれば。不明は12:00でも可）</label>
      <input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={inp} />
      <label style={{ fontSize: 12, color: C.sub, display: "block", marginBottom: 2 }}>出生地（都道府県）</label>
      <select value={pref} onChange={(e) => setPref(e.target.value)} style={inp}>
        {PREFS.map((p) => <option key={p[0]}>{p[0]}</option>)}
      </select>
      <button onClick={save} style={{ ...chipBtn, background: C.accent, color: "#0B0D11", borderColor: C.accent }}>保存して占う</button>
    </Acc>
  );
}

// 画像を縮小してdataURL化（アップロード軽量化）
function downscaleImage(file, maxW, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width);
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("画像の読み込みに失敗")); };
    img.src = url;
  });
}

// 予定の取り込み（スクショ→AI読取）
function ScheduleImport({ importing, msg, count, onPick, onClear }) {
  const ref = useRef(null);
  return (
    <Panel title="予定の取り込み（TimeTree等）" accent={FAMILY_COLOR} help="TimeTree等のカレンダーのスクショを選ぶと、AIが予定を読み取って『家族レーン』として今日/今後の予定に反映します。Googleカレンダーは不要。">
      <input ref={ref} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; onPick(f); }} />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={() => ref.current && ref.current.click()} disabled={importing} style={{ ...chipBtn, background: importing ? "transparent" : C.text, color: importing ? C.sub : "#0B0D11", borderColor: importing ? C.line : C.text, fontWeight: 700 }}>
          {importing ? "読み取り中…" : "📷 スクショから取り込む"}
        </button>
        {count > 0 && <button onClick={onClear} style={chipBtn}>取り込み{count}件を消去</button>}
      </div>
      {msg && <div style={{ fontSize: 12, color: C.sub, marginTop: 8, wordBreak: "break-word" }}>{msg}</div>}
      <div style={{ fontSize: 11, color: C.sub, marginTop: 8 }}>※「週」や「リスト」表示のスクショが精度◎。複数回取り込めます。</div>
    </Panel>
  );
}

// 今朝のまとめ（運気・予定・要対応・売上・ニュースを1枚に束ねる）
function BriefingCard({ fortune, birth, today, late, soon, outstanding, brief, onTab, remaining, pendingTasks, hideFortune, hideNews }) {
  // 占術コンディションは決定論(dayEnergy)で常に算出 → AIが無くても「今日のスタンス」が出る。
  // AIの鑑定文(fortune.today)は付加情報として併用する。
  const energy = useMemo(() => {
    try { return birth && birth.date ? dayEnergy(birth, iso(new Date())) : null; }
    catch { return null; }
  }, [birth && birth.date, birth && birth.time]);
  const sm = useMemo(() => sanmei(birth), [birth && birth.date, birth && birth.time]);
  // 今週（今日から7日）の攻めの日 → 発信・営業を寄せる狙い目として提示
  const weekAttack = useMemo(() => {
    if (!(birth && birth.date)) return [];
    const days = Array.from({ length: 7 }, (_, i) => iso(addDays(new Date(), i)));
    const s = stancesFor(birth, days);
    return days.filter((d) => s[d] && s[d].stance === "攻め");
  }, [birth && birth.date, birth && birth.time]);
  const af = (fortune && fortune.today) || {};
  const et = (energy && energy.today) || {};
  const t = { ...af, ...et }; // 決定論の値(stance/score/focus)を優先しつつ、AIのtheme/action等を温存
  const h = new Date().getHours();
  const greet = h < 5 ? "おつかれさま" : h < 11 ? "おはようございます" : h < 18 ? "こんにちは" : "こんばんは";
  const next = (today || [])[0];
  const sc = Number(t.score) || 0;
  const byStance = {
    攻め: { label: "攻めの日", color: C.green, tip: t.action },
    守り: { label: "守りの日", color: C.red, tip: t.caution || t.action },
    整える: { label: "整える日", color: C.accent, tip: t.action },
    労い: { label: "労いの日", color: C.blue, tip: t.action },
  };
  const mode = t.stance ? byStance[t.stance]
    : sc >= 4 ? { label: "攻めの日", color: C.green, tip: t.action }
      : sc > 0 && sc <= 2 ? { label: "守りの日", color: C.red, tip: t.caution || t.action }
        : sc ? { label: "整える日", color: C.accent, tip: t.action } : null;
  const rem = Number(remaining) || 0;
  // 占術コンディション × あなたの実データ → 今日の具体的な「一手」（決定論・AI不使用）
  const advice = (() => {
    if (!mode) return null;
    const s = t.stance || (sc >= 4 ? "攻め" : sc > 0 && sc <= 2 ? "守り" : "整える");
    if (s === "攻め") {
      const tip = sm && sm.attack ? ` ${sm.emoji}${sm.attack}` : "";
      if (outstanding > 0) return `攻めどき。未処理の¥${outstanding.toLocaleString("ja-JP")}を回収して、売上を取りにいきましょう。${tip}`;
      if (next) return `攻めどき。まず「${next.time} ${next.title}」に集中を。${tip}`;
      return `攻めどき。発信・営業を今日の前半に寄せましょう。${tip}`;
    }
    if (s === "守り") {
      if (late + soon > 0) return `守りの日。まず${late ? `遅れ${late}件` : ""}${late && soon ? "・" : ""}${soon ? `もうすぐ${soon}件` : ""}の抜け漏れを片付けて、足場を固めましょう。`;
      return "守りの日。新規を広げるより、既存の見直しと準備の整理を。";
    }
    if (s === "労い") return "労いの日。詰め込みすぎず、休む時間も今日の予定に入れましょう。";
    return "整える日。今日の予定を淡々と。無理に広げないのが吉。";
  })();
  const Row = ({ icon, label, color, onClick }) => (
    <button onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", background: "transparent", border: "none", borderTop: `1px solid ${C.line}`, padding: "10px 0", cursor: "pointer", color: C.text, font: "inherit" }}>
      <span style={{ flex: "0 0 auto", fontSize: 16 }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 14, lineHeight: 1.4, color: color || C.text }}>{label}</span>
      <span style={{ flex: "0 0 auto", color: C.sub, fontSize: 13 }}>›</span>
    </button>
  );
  return (
    <section style={{ background: C.panel, border: `1px solid ${C.accent}`, borderRadius: 16, padding: "16px 18px", marginBottom: 16 }}>
      <div style={{ fontSize: 13, color: C.accent, fontWeight: 700 }}>☀️ {greet}・今朝のまとめ</div>
      {/* 今日の残り件数 KPI */}
      <button onClick={() => onTab("work")} style={{ width: "100%", textAlign: "left", background: "transparent", border: "none", cursor: "pointer", color: C.text, font: "inherit", padding: "10px 0 4px" }}>
        {rem === 0 ? (
          <div style={{ fontSize: 15, fontWeight: 700, color: C.green }}>今日の要対応はありません ✨</div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ fontSize: 13, color: C.sub }}>今日の残り</span>
              <span style={{ fontSize: 28, fontWeight: 700, color: C.accent, lineHeight: 1 }}>{rem}</span>
              <span style={{ fontSize: 13, color: C.sub }}>件</span>
            </div>
            <div style={{ fontSize: 13, color: C.sub, marginTop: 2 }}>
              {late > 0 && <span style={{ color: C.red, fontWeight: 700 }}>遅れ{late}</span>}
              {late > 0 && soon > 0 && <span>・</span>}
              {soon > 0 && <span style={{ color: C.orange, fontWeight: 700 }}>もうすぐ{soon}</span>}
              {(late > 0 || soon > 0) && pendingTasks > 0 && <span>・</span>}
              {pendingTasks > 0 && <span>タスク{pendingTasks}</span>}
            </div>
          </>
        )}
      </button>
      {t.theme && <div style={{ fontSize: 15, fontWeight: 700, margin: "6px 0 4px" }}>{t.theme}</div>}
      {mode && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span style={{ flex: "0 0 auto", fontSize: 12, fontWeight: 700, color: "#0B0D11", background: mode.color, borderRadius: 999, padding: "2px 10px" }}>今日は{mode.label}</span>
          {mode.tip && <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: C.sub, lineHeight: 1.4 }}>{mode.tip}</span>}
        </div>
      )}
      {advice && (
        <button onClick={() => onTab("fortune")} style={{ display: "flex", gap: 8, alignItems: "flex-start", width: "100%", textAlign: "left", background: C.panel2, border: "none", borderRadius: 10, padding: "9px 11px", margin: "2px 0 8px", cursor: "pointer", color: C.text, font: "inherit" }}>
          <span style={{ flex: "0 0 auto", fontSize: 15 }}>🧭</span>
          <span style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.5 }}><b style={{ color: mode.color }}>今日の一手</b>　{advice}</span>
        </button>
      )}
      {!hideFortune && weekAttack.length > 0 && (
        <Row icon="🟢" color={C.green} label={`今週の攻めの日 ${weekAttack.map((d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`).join("・")}（発信・営業を寄せて）`} onClick={() => onTab("fortune")} />
      )}
      {!hideFortune && <Row icon="🔮" label={`運気 ${sc ? "★".repeat(sc) : "—"}`} onClick={() => onTab("fortune")} />}
      <Row icon="📅" label={(today || []).length ? `今日の予定 ${today.length}件${next ? `／次 ${next.time} ${next.title}` : ""}` : "今日の予定はありません"} onClick={() => onTab("home")} />
      {(late + soon > 0) && <Row icon={late ? "🔴" : "🟠"} color={late ? C.red : C.orange} label={`要対応 ${late ? `遅れ${late}件 ` : ""}${soon ? `もうすぐ${soon}件` : ""}`} onClick={() => onTab("home")} />}
      {outstanding > 0 && <Row icon="💰" label={`未処理 ¥${outstanding.toLocaleString("ja-JP")}`} onClick={() => onTab("money")} />}
      {brief && !hideNews && <Row icon="📰" label={brief.replace(/^[・\-*\s]+/, "")} onClick={() => onTab("news")} />}
    </section>
  );
}

/* 経営カレンダー：その月の各日の「気」を決定論(占術)で色分けし、
   仕事タブの予定（本番日・締切・ローンチ締切）を重ねて「攻めの日に寄っているか」を可視化。
   → 発信・ローンチを攻めの日に寄せ、守りの日に重なった締切は前後へずらす提案を出す。 */
const STANCE_UI = {
  攻め: { color: C.green, mark: "攻", tip: "発信・営業・ローンチ向き" },
  労い: { color: C.blue, mark: "労", tip: "人に支えられる・受け取る日" },
  整える: { color: C.accent, mark: "整", tip: "淡々と整える日" },
  守り: { color: C.red, mark: "守", tip: "守りを固める・背伸びしない" },
};
function BizCalendar({ birth, trips, deadlines, launches, onPlan }) {
  const [offset, setOffset] = useState(0); // 0=今月, +1=来月 ...
  const [sel, setSel] = useState(null); // 選択中の日(ISO)
  const sm = useMemo(() => sanmei(birth), [birth && birth.date, birth && birth.time]);
  const base = new Date();
  const view = new Date(base.getFullYear(), base.getMonth() + offset, 1);
  const yy = view.getFullYear(), mm = view.getMonth();
  const dim = new Date(yy, mm + 1, 0).getDate();
  const firstW = new Date(yy, mm, 1).getDay(); // 0=日..6=土
  const isCurrent = offset === 0;
  const todayD = base.getDate();
  const dateList = useMemo(() => Array.from({ length: dim }, (_, i) => `${yy}-${pad2(mm + 1)}-${pad2(i + 1)}`), [yy, mm, dim]);
  const stances = useMemo(() => (birth && birth.date ? stancesFor(birth, dateList) : {}), [birth && birth.date, birth && birth.time, dateList.join(",")]);
  const marks = useMemo(() => {
    const m = {};
    const add = (d, label) => { if (!d) return; const k = String(d).slice(0, 10); (m[k] = m[k] || []).push(label); };
    for (const t of trips || []) add(t.date, t.title);
    for (const d of deadlines || []) add(d.date, d.title);
    for (const L of launches || []) { add(L.deadlineReg, `${L.name} 先行締切`); add(L.deadlineCv, `${L.name} 本申込締切`); }
    return m;
  }, [trips, deadlines, launches]);

  if (!birth || !birth.date) return null; // 出生情報が無いときは出さない（FortunePanel側で入力導線を出す）

  const inMonth = (k) => k.startsWith(`${yy}-${pad2(mm + 1)}-`);
  const attackDays = dateList.filter((d) => stances[d] && stances[d].stance === "攻め").map((d) => Number(d.slice(8, 10))).filter((dn) => !isCurrent || dn >= todayD);
  const misaligned = Object.keys(marks).filter((k) => inMonth(k) && stances[k] && stances[k].stance === "守り");
  const cells = [];
  for (let i = 0; i < firstW; i++) cells.push(null);
  for (let d = 1; d <= dim; d++) cells.push(d);

  return (
    <Panel
      title="経営カレンダー"
      accent={C.green}
      help="あなたの命式から、その月の各日の『気（攻め/守り/整える/労い）』を計算して色分けします。占いではなくコンディションの傾向です。攻めの日に発信・ローンチを寄せ、守りの日に重なった締切は前後にずらすと進めやすくなります。仕事タブの本番日・締切も●印で重ねて表示します。"
      right={
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button onClick={() => setOffset((o) => o - 1)} style={iconBtn} title="前の月">‹</button>
          <span style={{ fontSize: 13, color: C.sub, minWidth: 60, textAlign: "center" }}>{yy}/{mm + 1}</span>
          <button onClick={() => setOffset((o) => o + 1)} style={iconBtn} title="次の月">›</button>
        </div>
      }
    >
      {/* 曜日見出し */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4, marginBottom: 4 }}>
        {["日", "月", "火", "水", "木", "金", "土"].map((w, i) => (
          <div key={w} style={{ textAlign: "center", fontSize: 11, color: i === 0 ? C.red : i === 6 ? C.blue : C.sub }}>{w}</div>
        ))}
      </div>
      {/* 日セル */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4 }}>
        {cells.map((d, i) => {
          if (d == null) return <div key={`b${i}`} />;
          const k = `${yy}-${pad2(mm + 1)}-${pad2(d)}`;
          const st = stances[k];
          const ui = st ? STANCE_UI[st.stance] : null;
          const isToday = isCurrent && d === todayD;
          const hasMark = !!marks[k];
          const isSel = sel === k;
          return (
            <button key={k} onClick={() => setSel(isSel ? null : k)}
              title={`${mm + 1}/${d}${ui ? ` ・ ${st.stance}（${ui.tip}）` : ""}${hasMark ? ` ・ ${marks[k].join(" / ")}` : ""}`}
              style={{ position: "relative", aspectRatio: "1 / 1", borderRadius: 8, background: ui ? ui.color + (isSel ? "44" : "22") : C.panel2, border: isSel ? `2px solid ${C.purple}` : isToday ? `2px solid ${C.accent}` : `1px solid ${C.line}`, display: "grid", placeItems: "center", cursor: "pointer", padding: 0, font: "inherit" }}>
              <span style={{ display: "flex", flexDirection: "column", alignItems: "center", lineHeight: 1.05 }}>
                <span style={{ fontSize: 12, fontWeight: isToday ? 700 : 500, color: ui ? ui.color : C.sub }}>{d}</span>
                {ui && <span style={{ fontSize: 12, fontWeight: 700, color: ui.color }}>{ui.mark}</span>}
              </span>
              {hasMark && <span style={{ position: "absolute", bottom: 3, width: 5, height: 5, borderRadius: "50%", background: C.purple }} />}
            </button>
          );
        })}
      </div>
      {/* 選択した日の詳細 */}
      {sel && (() => {
        const st = stances[sel];
        const ui = st ? STANCE_UI[st.stance] : null;
        const md = Number(sel.slice(5, 7)), dd = Number(sel.slice(8, 10));
        return (
          <div style={{ background: C.panel2, border: `1px solid ${ui ? ui.color : C.line}`, borderRadius: 10, padding: "12px 14px", marginTop: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <strong style={{ fontSize: 14 }}>{md}/{dd}</strong>
              {ui && <span style={{ fontSize: 12, fontWeight: 700, color: "#0B0D11", background: ui.color, borderRadius: 999, padding: "1px 10px" }}>{st.stance}の日</span>}
              <span style={{ flex: 1 }} />
              <button onClick={() => setSel(null)} style={iconBtn} title="閉じる">✕</button>
            </div>
            {st && <div style={{ fontSize: 13, color: C.text, lineHeight: 1.6, marginTop: 6 }}>{st.focus}</div>}
            {st && st.stance === "攻め" && sm && sm.attack && <div style={{ fontSize: 12, color: C.green, lineHeight: 1.6, marginTop: 4 }}>{sm.emoji}あなたは{sm.star}。{sm.attack}</div>}
            {marks[sel] && (
              <div style={{ fontSize: 12, color: C.sub, marginTop: 6 }}>📌 この日の予定：{marks[sel].join(" / ")}</div>
            )}
            {onPlan && (
              <button onClick={() => { onPlan(sel); setSel(null); }} style={{ ...chipBtn, marginTop: 10, background: C.green, color: "#0B0D11", borderColor: C.green }}>＋この日に発信を入れる</button>
            )}
          </div>
        );
      })()}
      {/* 凡例 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 10, fontSize: 11, color: C.sub }}>
        {Object.entries(STANCE_UI).map(([k, v]) => (
          <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 16, height: 16, borderRadius: 4, background: v.color + "33", border: `1px solid ${v.color}`, color: v.color, fontSize: 11, fontWeight: 700, display: "grid", placeItems: "center" }}>{v.mark}</span>{k}
          </span>
        ))}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><span style={{ width: 5, height: 5, borderRadius: "50%", background: C.purple }} />予定あり</span>
      </div>
      {/* 狙い目（攻めの日） */}
      {attackDays.length > 0 && (
        <div style={{ background: C.panel2, borderRadius: 10, padding: "10px 12px", marginTop: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.green, marginBottom: 4 }}>🟢 {isCurrent ? "この先の" : "今月の"}狙い目（攻めの日）</div>
          <div style={{ fontSize: 13, color: C.text, lineHeight: 1.6 }}>{attackDays.map((d) => `${mm + 1}/${d}`).join("・")}</div>
          <div style={{ fontSize: 12, color: C.sub, marginTop: 4 }}>発信・営業・新講座の販売開始日をここに寄せると伸びやすい流れです。{sm && sm.attack ? `${sm.emoji}あなたは${sm.star}。${sm.attack}` : ""}</div>
        </div>
      )}
      {/* 守りの日に重なった締切の警告 */}
      {misaligned.length > 0 && (
        <div style={{ background: C.red + "12", border: `1px solid ${C.red}`, borderRadius: 10, padding: "10px 12px", marginTop: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.red, marginBottom: 4 }}>🔴 守りの日に重なっている予定</div>
          {misaligned.map((k) => (
            <div key={k} style={{ fontSize: 12, color: C.text, lineHeight: 1.6 }}>{Number(k.slice(5, 7))}/{Number(k.slice(8, 10))}：{marks[k].join(" / ")}</div>
          ))}
          <div style={{ fontSize: 12, color: C.sub, marginTop: 4 }}>無理に攻めず丁寧に。可能なら前後の攻めの日へずらすと進めやすくなります。</div>
        </div>
      )}
    </Panel>
  );
}

function FortunePanel({ fortune, loading, error, aiOff, onRefresh, birth, onSaveBirth }) {
  const f = fortune || {};
  const t = f.today || {};
  const tm = f.tomorrow || {};
  const m = f.month || {};
  const y = f.year || {};
  const now = new Date();
  const stars = (n) => "★★★★★".slice(0, Math.max(0, Math.min(5, Number(n) || 0))) + "☆☆☆☆☆".slice(0, 5 - Math.max(0, Math.min(5, Number(n) || 0)));
  const Line = ({ label, value, color }) => value ? (
    <div style={{ display: "flex", gap: 8, fontSize: 13, lineHeight: 1.5, padding: "2px 0" }}>
      <span style={{ flex: "0 0 auto", color: color || C.sub, width: 64 }}>{label}</span>
      <span style={{ flex: 1, minWidth: 0 }}>{value}</span>
    </div>
  ) : null;
  return (
    <Panel
      title="運気（年・月・日）"
      accent={C.purple}
      help="あなたの命式（四柱推命・西洋占星術・インド占星術）を根拠に、AIが年・月・日の運勢を鑑定します。各項目はタップで開閉。占いとして参考程度に。"
      right={<button onClick={onRefresh} disabled={loading} style={chipBtn}>{loading ? "占い中…" : "更新"}</button>}
    >
      {aiOff && <div style={{ fontSize: 12, color: C.sub, marginBottom: 8 }}>※ AI機能は現在オフです</div>}
      {(!birth || !birth.date) && (
        <div style={{ background: C.panel2, border: `1px solid ${C.purple}`, borderRadius: 12, padding: "14px 16px", marginBottom: 14 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.purple, marginBottom: 6 }}>
            まず、あなたの出生情報を入力してください
          </div>
          <div style={{ fontSize: 13, color: C.sub, lineHeight: 1.6 }}>
            占いはあなたの命式から計算します。下の「出生情報を入力」を開いて生年月日を登録すると、あなた専用の運気が出ます。
          </div>
        </div>
      )}
      {error && <div style={{ fontSize: 12, color: C.red, marginBottom: 10, wordBreak: "break-word" }}>取得に失敗：{String((error && error.message) || error)}</div>}

      {birth && birth.date && !fortune && !loading && !error && <Empty>「更新」を押すと運気が出ます。</Empty>}

      {birth && birth.date && (() => {
        const sm = sanmei(birth);
        return sm ? (
          <div style={{ background: C.purple + "12", border: `1px solid ${C.purple}`, borderRadius: 12, padding: "12px 14px", marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: C.purple, fontWeight: 700, marginBottom: 4 }}>あなたの経営キャラ（算命学・中心星）</div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{sm.emoji} {sm.star}・{sm.title}</div>
            <div style={{ fontSize: 13, color: C.text, lineHeight: 1.6, marginTop: 4 }}>{sm.desc}</div>
            <div style={{ fontSize: 13, color: C.sub, lineHeight: 1.6, marginTop: 4 }}>💡 {sm.biz}</div>
          </div>
        ) : null;
      })()}

      {birth && birth.date && (
        <>
          {t.theme && (
            <Acc title="今日" badge={<span style={{ color: C.accent, fontSize: 14 }}>{stars(t.score)}</span>} defaultOpen>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>{t.theme}</div>
              <Line label="仕事運" value={t.work} color={C.green} />
              <Line label="金運" value={t.money} color={C.accent} />
              <Line label="対人運" value={t.social} color={C.blue} />
              <Line label="やるべき" value={t.action} color={C.purple} />
              <Line label="戒め" value={t.caution} color={C.red} />
              <Line label="ラッキー" value={t.color} color={C.sub} />
            </Acc>
          )}

          {tm.theme && (
            <Acc title="明日" badge={<span style={{ color: C.accent, fontSize: 14 }}>{stars(tm.score)}</span>}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>{tm.theme}</div>
              <Line label="仕事運" value={tm.work} color={C.green} />
              <Line label="金運" value={tm.money} color={C.accent} />
              <Line label="対人運" value={tm.social} color={C.blue} />
              <Line label="やるべき" value={tm.action} color={C.purple} />
              <Line label="ラッキー" value={tm.color} color={C.sub} />
            </Acc>
          )}

          {m.theme && (
            <Acc title={`今月 ・ ${m.theme}`} color={C.blue}>
              <div style={{ fontSize: 13, lineHeight: 1.6 }}>{m.flow}</div>
              {m.advice && <div style={{ fontSize: 13, color: C.sub, marginTop: 6 }}>指針：{m.advice}</div>}
              {Array.isArray(m.days) && m.days.length > 0 && (
                <>
                  <FortuneBars values={m.days} highlight={now.getDate() - 1} color={C.blue} />
                  <div style={{ fontSize: 12, color: C.sub, display: "flex", justifyContent: "space-between", marginTop: 2 }}>
                    <span>1日</span><span>今日={now.getMonth() + 1}/{now.getDate()}</span><span>{m.days.length}日</span>
                  </div>
                </>
              )}
            </Acc>
          )}

          {y.theme && (
            <Acc title={`今年 ・ ${y.theme}`} color={C.purple}>
              <div style={{ fontSize: 13, lineHeight: 1.6 }}>{y.flow}</div>
              {y.peak && <Line label="好機" value={y.peak} color={C.green} />}
              {y.caution && <Line label="慎む時期" value={y.caution} color={C.red} />}
              {Array.isArray(y.months) && y.months.length === 12 && (
                <>
                  <FortuneBars values={y.months} highlight={now.getMonth()} color={C.purple} />
                  <div style={{ fontSize: 12, color: C.sub, display: "flex", justifyContent: "space-between", marginTop: 2 }}>
                    <span>1月</span><span>今月</span><span>12月</span>
                  </div>
                </>
              )}
            </Acc>
          )}
        </>
      )}

      <BirthEditor birth={birth} onSave={onSaveBirth} />

      <div style={{ fontSize: 11, color: C.sub, marginTop: 4 }}>
        ひとり秘書の鑑定AIによる占いです ・ 参考程度に
      </div>
    </Panel>
  );
}

/* どのカレンダーを仕事/家族として取り込むかの設定 */
function CalendarSettings({ calList, roleForCal, onSetRole, onDisconnect }) {
  const [open, setOpen] = useState(false);
  const ROLES = [
    { v: "work", label: "仕事" },
    { v: "family", label: "家族" },
    { v: "off", label: "取り込まない" },
  ];
  return (
    <Panel
      title="カレンダー設定"
      accent={C.sub}
      help="どのGoogleカレンダーを取り込むかを選びます。『仕事』は時間メーターに反映、『家族』は別色でブロッカー表示（メーター除外）、『取り込まない』は非表示。"
      right={<button onClick={() => setOpen((o) => !o)} style={chipBtn}>{open ? "閉じる" : "開く"}</button>}
    >
      {open && (
        <div style={{ display: "grid", gap: 10 }}>
          {calList.map((c) => {
            const role = roleForCal(c.id);
            return (
              <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 14 }}>{c.summary}{c.primary ? "（メイン）" : ""}</span>
                <div style={{ display: "flex", gap: 4, flex: "0 0 auto" }}>
                  {ROLES.map((r) => (
                    <button
                      key={r.v}
                      onClick={() => onSetRole(c.id, r.v)}
                      style={{ fontSize: 11, padding: "4px 8px", borderRadius: 8, cursor: "pointer", border: `1px solid ${role === r.v ? C.accent : C.line}`, background: role === r.v ? C.accent : "transparent", color: role === r.v ? "#0B0D11" : C.sub, fontWeight: role === r.v ? 700 : 400 }}
                    >{r.label}</button>
                  ))}
                </div>
              </div>
            );
          })}
          {onDisconnect && (
            <button onClick={onDisconnect} style={{ ...chipBtn, marginTop: 4, color: C.red, borderColor: C.line, justifySelf: "start" }}>
              カレンダー連携を解除
            </button>
          )}
        </div>
      )}
    </Panel>
  );
}

/* ──────────────────────────────────────────────────────────────
   汎用チェックリスト（コンテンツ / お金 / 追加タスク）
   ────────────────────────────────────────────────────────────── */
function CheckList({ title, accent, items, onToggle, onAdd, onEdit, onRemove, renderMeta, placeholder }) {
  const [text, setText] = useState("");
  const [editId, setEditId] = useState(null);
  const [editText, setEditText] = useState("");
  const list = items || [];
  const startEdit = (it) => { setEditId(it.id); setEditText(it.title); };
  const saveEdit = () => { if (editText.trim()) onEdit(editId, { title: editText.trim() }); setEditId(null); };
  return (
    <Panel title={title} accent={accent}>
      <div style={{ display: "grid", gap: 8 }}>
        {list.length === 0 && <Empty>項目はありません。</Empty>}
        {list.map((it) => (
          <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Check done={it.done} onClick={() => onToggle(it.id)} />
            {editId === it.id ? (
              <>
                <input
                  autoFocus
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") setEditId(null); }}
                  style={{ ...inp, marginBottom: 0, flex: 1 }}
                />
                <button onClick={saveEdit} style={chipBtn}>保存</button>
                <button onClick={() => setEditId(null)} style={iconBtn} title="取消">✕</button>
              </>
            ) : (
              <>
                <span style={{ flex: 1, fontSize: 14, textDecoration: it.done ? "line-through" : "none", color: it.done ? C.faint : C.text }}>
                  {it.title}
                </span>
                {renderMeta && renderMeta(it)}
                {onEdit && <button onClick={() => startEdit(it)} style={iconBtn} title="編集">✎</button>}
                <button onClick={() => onRemove(it.id)} style={iconBtn} title="削除">✕</button>
              </>
            )}
          </div>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          onAdd(text.trim());
          setText("");
        }}
        style={{ display: "flex", gap: 8, marginTop: 12 }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder || "追加…"} style={{ ...inp, marginBottom: 0, flex: 1 }} />
        <button type="submit" style={chipBtn}>追加</button>
      </form>
    </Panel>
  );
}

/* 請求・お金（金額・種別つき。未処理合計を表示） */
const yen = (n) => "¥" + (Number(n) || 0).toLocaleString("ja-JP");
// 万円表記（1万以上は「¥48万」のように圧縮。それ未満は通常表記）
const manYen = (n) => {
  n = Number(n) || 0;
  if (n >= 10000) return "¥" + (Math.round(n / 1000) / 10).toLocaleString("ja-JP") + "万";
  return yen(n);
};
const MONEY_KINDS = ["請求", "入金", "支払"];

/* ──────────────────────────────────────────────────────────────
   ローンチKPI：先行登録 → 本申込(CV) → 売上 の三角ファネル
   各ローンチごとに「目標 vs 実績」を1枚で俯瞰し、締切まで何日かを信号表示。
   売上実績は 本申込数 × 客単価 で自動計算。
   ────────────────────────────────────────────────────────────── */
function FunnelBar({ pct, color, width }) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div style={{ width: width || "100%", height: 12, background: C.panel, borderRadius: 6, overflow: "hidden", border: `1px solid ${C.line}` }}>
      <div style={{ width: `${p}%`, height: "100%", background: color, borderRadius: 6, transition: "width .3s" }} />
    </div>
  );
}

function LaunchFunnel({ L, onEdit, onRemove }) {
  const reg = Number(L.reg) || 0, goalReg = Number(L.goalReg) || 0;
  const cv = Number(L.cv) || 0, goalCv = Number(L.goalCv) || 0;
  const price = Number(L.price) || 0;
  const rev = cv * price, goalRev = Number(L.goalRev) || 0;
  const regPct = goalReg ? (reg / goalReg) * 100 : 0;
  const cvPct = goalCv ? (cv / goalCv) * 100 : 0;
  const revPct = goalRev ? (rev / goalRev) * 100 : 0;
  const cvRate = reg ? Math.round((cv / reg) * 100) : 0; // 本申込/先行登録 の転換率
  const sigReg = L.deadlineReg ? deadlineSignal(L.deadlineReg) : null;       // 先行登録締切
  const cvDL = L.deadlineCv || L.deadline;
  const sigCv = cvDL ? deadlineSignal(cvDL) : null;                          // 本申込締切（＝売上の締切）
  const done = (p) => (p >= 100 ? C.green : null);

  const stage = (no, name, color, sub, pct, width, sig) => (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 5 }}>
        <span style={{ fontSize: 12, color: C.faint, flex: "0 0 auto" }}>{no}</span>
        <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{name}</span>
        {sig && <span style={{ fontSize: 11, color: sig.color, fontWeight: 600, whiteSpace: "nowrap" }}>{sig.dot}{sig.label}</span>}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 13, color: done(pct) || color, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{sub}</span>
        <span style={{ fontSize: 12, color: C.sub, width: 42, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{Math.round(pct)}%</span>
      </div>
      <div style={{ display: "flex", justifyContent: "center" }}>
        <FunnelBar pct={pct} color={done(pct) || color} width={width} />
      </div>
    </div>
  );

  return (
    <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 12, padding: 14, marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 15, fontWeight: 700, flex: 1, minWidth: 0 }}>{L.name}</span>
        <button onClick={() => onEdit(L)} style={iconBtn} title="編集">✎</button>
        <button onClick={() => onRemove(L.id)} style={iconBtn} title="削除">✕</button>
      </div>
      {stage("①", "先行登録", C.blue, `${reg} / ${goalReg}人`, regPct, "100%", sigReg)}
      {stage("②", "本申込", C.purple, `${cv}人 · 申込率 ${cvRate}%`, cvPct, "82%", sigCv)}
      {stage("③", "売上", C.accent, `${manYen(rev)} / ${manYen(goalRev)}`, revPct, "64%", null)}
      <div style={{ fontSize: 12, color: C.sub, marginTop: 6, textAlign: "right" }}>客単価 {yen(price)} × 本申込{cv}人で自動計算</div>
    </div>
  );
}

function LaunchKpi({ launches, onAdd, onEdit, onRemove }) {
  const list = launches || [];
  const blankNew = { name: "", goalReg: 100, reg: 0, goalCv: 30, cv: 0, price: 30000, goalRev: 800000, deadlineReg: iso(addDays(new Date(), 14)), deadlineCv: iso(addDays(new Date(), 21)) };
  const [mode, setMode] = useState(null); // null | "new"
  const [f, setF] = useState(blankNew);
  const [editId, setEditId] = useState(null);
  const [e, setE] = useState(blankNew);

  const numF = (obj, set, key) => (ev) => set({ ...obj, [key]: ev.target.value });
  const startEdit = (L) => {
    setEditId(L.id);
    setE({
      name: L.name, goalReg: L.goalReg, reg: L.reg, goalCv: L.goalCv, cv: L.cv, price: L.price, goalRev: L.goalRev,
      deadlineReg: L.deadlineReg || iso(addDays(new Date(), 14)),
      deadlineCv: L.deadlineCv || L.deadline || iso(addDays(new Date(), 21)), // 旧 deadline を本申込締切として移行
    });
  };
  const toNums = (o) => ({
    name: (o.name || "").trim(),
    goalReg: Number(o.goalReg) || 0, reg: Number(o.reg) || 0,
    goalCv: Number(o.goalCv) || 0, cv: Number(o.cv) || 0,
    price: Number(o.price) || 0, goalRev: Number(o.goalRev) || 0,
    deadlineReg: o.deadlineReg, deadlineCv: o.deadlineCv,
  });
  const saveEdit = () => { if (e.name.trim()) onEdit(editId, toNums(e)); setEditId(null); };

  // 入力フォーム（新規/編集 共通レイアウト）
  const formFields = (obj, set) => (
    <>
      <input value={obj.name} onChange={numF(obj, set, "name")} placeholder="ローンチ名（例：春の新講座）" style={inp} />
      <div style={{ display: "flex", gap: 8 }}>
        <label style={lbl}>先行登録 目標<input value={obj.goalReg} onChange={numF(obj, set, "goalReg")} inputMode="numeric" style={inp} /></label>
        <label style={lbl}>登録 実績<input value={obj.reg} onChange={numF(obj, set, "reg")} inputMode="numeric" style={inp} /></label>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <label style={lbl}>本申込 目標<input value={obj.goalCv} onChange={numF(obj, set, "goalCv")} inputMode="numeric" style={inp} /></label>
        <label style={lbl}>本申込 実績<input value={obj.cv} onChange={numF(obj, set, "cv")} inputMode="numeric" style={inp} /></label>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <label style={lbl}>客単価（円）<input value={obj.price} onChange={numF(obj, set, "price")} inputMode="numeric" style={inp} /></label>
        <label style={lbl}>売上目標（円）<input value={obj.goalRev} onChange={numF(obj, set, "goalRev")} inputMode="numeric" style={inp} /></label>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <label style={lbl}>先行登録 締切<input type="date" value={obj.deadlineReg} onChange={numF(obj, set, "deadlineReg")} style={inp} /></label>
        <label style={lbl}>本申込 締切<input type="date" value={obj.deadlineCv} onChange={numF(obj, set, "deadlineCv")} style={inp} /></label>
      </div>
    </>
  );

  return (
    <Panel
      title="新講座の販売 進捗（先行登録→申込→売上）"
      accent={C.accent}
      help="「ローンチ」とは新しい講座・商品の期間限定の募集や販売のこと。それ『先行登録 → 本申込 → 売上』の進み具合を1枚で見ます。各段に目標と実績・達成率、締切まで何日かを信号(🟢=余裕 🟠=もうすぐ 🔴=締切すぎ)で表示。売上は『本申込の人数 × 客単価』で自動計算します。数字は✎からいつでも更新できます。"
      right={<button onClick={() => { setMode(mode === "new" ? null : "new"); setF(blankNew); }} style={chipBtn}>＋ローンチ</button>}
    >
      {mode === "new" && (
        <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: C.sub, marginBottom: 8, lineHeight: 1.6 }}>まず「名前」と「締切日」だけ入れればOK。人数や金額の数字は、あとから✎でいつでも更新できます。</div>
          {formFields(f, setF)}
          <button
            style={{ ...chipBtn, background: C.accent, color: "#0B0D11", borderColor: C.accent }}
            onClick={() => { if (!f.name.trim()) return; onAdd(toNums(f)); setF(blankNew); setMode(null); }}
          >追加</button>
        </div>
      )}
      {list.length === 0 && <Empty>まだ登録がありません。新しい講座・商品の販売（ローンチ）を始めるとき、右上の「＋ローンチ」から目標人数・客単価・売上目標を入れると、登録→申込→売上の進み具合がグラフで見えます。</Empty>}
      {list.map((L) =>
        editId === L.id ? (
          <div key={L.id} style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, marginBottom: 12 }}>
            {formFields(e, setE)}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={saveEdit} style={{ ...chipBtn, background: C.accent, color: "#0B0D11", borderColor: C.accent }}>保存</button>
              <button onClick={() => setEditId(null)} style={chipBtn}>取消</button>
            </div>
          </div>
        ) : (
          <LaunchFunnel key={L.id} L={L} onEdit={startEdit} onRemove={onRemove} />
        )
      )}
    </Panel>
  );
}

function MoneyList({ items, onToggle, onAdd, onEdit, onRemove }) {
  const list = items || [];
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [kind, setKind] = useState("請求");
  const [editId, setEditId] = useState(null);
  const [e, setE] = useState({ title: "", amount: "", kind: "請求" });
  const outstanding = list.filter((x) => !x.done).reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const startEdit = (it) => { setEditId(it.id); setE({ title: it.title, amount: it.amount || "", kind: it.kind || "請求" }); };
  const saveEdit = () => { if (e.title.trim()) onEdit(editId, { title: e.title.trim(), amount: Number(e.amount) || 0, kind: e.kind }); setEditId(null); };
  const kindColor = (k) => (k === "入金" ? C.green : k === "支払" ? C.red : C.accent);
  const sum = (arr) => arr.reduce((s, x) => s + (Number(x.amount) || 0), 0);

  const renderRow = (it) => (
    <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <Check done={it.done} onClick={() => onToggle(it.id)} />
      {editId === it.id ? (
        <>
          <input value={e.title} onChange={(ev) => setE({ ...e, title: ev.target.value })} placeholder="項目" style={{ ...inp, marginBottom: 0, flex: 1, minWidth: 80 }} />
          <input value={e.amount} onChange={(ev) => setE({ ...e, amount: ev.target.value })} placeholder="金額" inputMode="numeric" style={{ ...inp, marginBottom: 0, width: 84 }} />
          <select value={e.kind} onChange={(ev) => setE({ ...e, kind: ev.target.value })} style={{ ...inp, marginBottom: 0, width: 70 }}>
            {MONEY_KINDS.map((k) => <option key={k}>{k}</option>)}
          </select>
          <button onClick={saveEdit} style={chipBtn}>保存</button>
          <button onClick={() => setEditId(null)} style={iconBtn} title="取消">✕</button>
        </>
      ) : (
        <>
          <span style={{ flex: 1, minWidth: 0, fontSize: 14, textDecoration: it.done ? "line-through" : "none", color: it.done ? C.faint : C.text }}>{it.title}</span>
          {it.amount > 0 && <span style={{ fontSize: 13, color: it.done ? C.faint : C.text, fontVariantNumeric: "tabular-nums" }}>{yen(it.amount)}</span>}
          {it.kind && <span style={{ fontSize: 11, color: kindColor(it.kind), fontWeight: 700 }}>{it.kind}</span>}
          <button onClick={() => startEdit(it)} style={iconBtn} title="編集">✎</button>
          <button onClick={() => onRemove(it.id)} style={iconBtn} title="削除">✕</button>
        </>
      )}
    </div>
  );

  const tabs = [
    { key: "all", label: "すべて", filter: () => true, note: (a) => `未処理 ${yen(sum(a.filter((x) => !x.done)))}` },
    { key: "請求", label: "請求(未回収)", filter: (x) => x.kind === "請求", note: (a) => `未回収 ${yen(sum(a.filter((x) => !x.done)))}` },
    { key: "入金", label: "売上(入金)", filter: (x) => x.kind === "入金", note: (a) => `合計 ${yen(sum(a))}` },
    { key: "支払", label: "経費(支払)", filter: (x) => x.kind === "支払", note: (a) => `合計 ${yen(sum(a))}` },
  ];
  const slides = tabs.map((t) => {
    const arr = list.filter(t.filter);
    return {
      key: t.key,
      label: t.label,
      content: (
        <div>
          <div style={{ fontSize: 12, color: C.sub, marginBottom: 8 }}>{t.note(arr)}{arr.length ? ` ・ ${arr.length}件` : ""}</div>
          {arr.length === 0 ? <Empty>項目はありません。</Empty> : <div style={{ display: "grid", gap: 8 }}>{arr.map(renderRow)}</div>}
        </div>
      ),
    };
  });

  return (
    <Panel
      title="売上・経費"
      accent={C.accent}
      help="横スワイプで「すべて / 請求(未回収) / 売上(入金) / 経費(支払)」を切替。各タブに合計が出ます。下のフォームから追加できます。"
      right={<span style={{ fontSize: 12, color: outstanding > 0 ? C.accent : C.sub }}>未処理 {yen(outstanding)}</span>}
    >
      <SwipeView slides={slides} accent={C.accent} hint="← 横スワイプで すべて / 請求 / 売上 / 経費 →" />
      <form
        onSubmit={(ev) => { ev.preventDefault(); if (!title.trim()) return; onAdd({ title: title.trim(), amount: Number(amount) || 0, kind }); setTitle(""); setAmount(""); }}
        style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}
      >
        <input value={title} onChange={(ev) => setTitle(ev.target.value)} placeholder="請求・入金項目" style={{ ...inp, marginBottom: 0, flex: "1 1 120px" }} />
        <input value={amount} onChange={(ev) => setAmount(ev.target.value)} placeholder="例: 30000" inputMode="numeric" style={{ ...inp, marginBottom: 0, width: 84 }} />
        <select value={kind} onChange={(ev) => setKind(ev.target.value)} style={{ ...inp, marginBottom: 0, width: 70 }}>
          {MONEY_KINDS.map((k) => <option key={k}>{k}</option>)}
        </select>
        <button type="submit" style={chipBtn}>追加</button>
      </form>
      <div style={{ fontSize: 12, color: C.sub, marginTop: 6 }}>請求＝出した請求書 ／ 入金＝受け取り ／ 支払＝経費</div>
    </Panel>
  );
}

function Empty({ children }) {
  return <div style={{ fontSize: 13, color: C.sub, padding: "8px 2px", lineHeight: 1.6 }}>{children}</div>;
}

/* 今日の要対応（遅れ・締切間近の集約）。任意でブラウザ通知をオンにできる。 */
function AlertSummary({ alerts, notify, notifySupported, onEnableNotify }) {
  const { late, soon } = alerts;
  const none = late.length === 0 && soon.length === 0;
  const accent = late.length ? C.red : soon.length ? C.orange : C.green;
  const Row = ({ dot, color, label, right }) => (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
      <span style={{ flex: "0 0 auto" }}>{dot}</span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 14, lineHeight: 1.35 }}>{label}</span>
      <span style={{ flex: "0 0 auto", fontSize: 12, color, fontWeight: 600 }}>{right}</span>
    </div>
  );
  return (
    <Panel
      title="今日の要対応"
      accent={accent}
      help="締切が過ぎた『遅れ』と、3日以内に迫った『もうすぐ』を自動でまとめます。取りこぼし防止用です。"
      right={notifySupported && !notify ? <button onClick={onEnableNotify} style={chipBtn}>通知オン</button> : (notify ? <span style={{ fontSize: 11, color: C.green }}>通知オン</span> : null)}
    >
      {none ? (
        <div style={{ fontSize: 14, color: C.green }}>✅ 直近の遅れ・締切間近はありません。</div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {late.slice(0, 5).map((e, i) => (
            <Row key={"l" + i} dot="🔴" color={C.red} label={e.label} right={`${-e.diff}日遅れ`} />
          ))}
          {late.length > 5 && <div style={{ fontSize: 12, color: C.sub }}>ほか遅れ {late.length - 5}件</div>}
          {soon.slice(0, 5).map((e, i) => (
            <Row key={"s" + i} dot="🟠" color={C.orange} label={e.label} right={e.diff === 0 ? "今日" : `あと${e.diff}日`} />
          ))}
          {soon.length > 5 && <div style={{ fontSize: 12, color: C.sub }}>ほか間近 {soon.length - 5}件</div>}
        </div>
      )}
    </Panel>
  );
}

/* カレンダー連携の状態表示＋連携ボタン（時間メーター/今日の予定の上に出す） */
function CalStatusNote({ source, status, error, count, onConnect, connecting, onRefresh, refreshing }) {
  if (source === "calendar") {
    return (
      <div style={{ fontSize: 12, color: C.green, fontWeight: 700, background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 8, padding: "7px 10px", marginBottom: 12, display: "flex", gap: 6, alignItems: "center" }}>
        <span>✅</span>
        <span style={{ flex: 1 }}>Googleカレンダー連携中（今週 {count}件・自動で最新化）</span>
        {onRefresh && (
          <button onClick={onRefresh} disabled={refreshing} title="今すぐ最新の予定に更新" style={{ ...chipBtn, fontSize: 11, padding: "3px 8px", color: refreshing ? C.faint : C.green, borderColor: C.line }}>
            {refreshing ? "更新中…" : "🔄 更新"}
          </button>
        )}
      </div>
    );
  }
  const isErr = status === "error";
  return (
    <div style={{ fontSize: 12, color: C.sub, background: C.panel2, border: `1px solid ${isErr ? C.red : C.line}`, borderRadius: 8, padding: "8px 10px", marginBottom: 12 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "flex-start", marginBottom: 8 }}>
        <span>{isErr ? "⚠️" : "⚙️"}</span>
        <span style={{ color: isErr ? C.red : C.sub, wordBreak: "break-word" }}>
          {isErr
            ? `カレンダー取得に失敗：${(error && error.message) || error}`
            : "サンプル表示（準備中）— Googleカレンダーと一度連携すれば、以後は自動で維持され、毎回ログインし直す必要はありません。"}
        </span>
      </div>
      <button
        onClick={onConnect}
        disabled={connecting}
        style={{ ...chipBtn, background: connecting ? "transparent" : C.text, color: connecting ? C.sub : "#0B0D11", borderColor: connecting ? C.line : C.text, fontWeight: 700 }}
      >
        {connecting ? "連携中…" : isErr ? "再連携する" : "Googleカレンダーを連携"}
      </button>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   ログインゲート
   ────────────────────────────────────────────────────────────── */
function LoginGate({ onLogin, error }) {
  const FEATURES = [
    { icon: "⏳", title: "締切を、勝手に逆算", desc: "本番の申込締切を1つ入れるだけで、予告・先行案内・リマインド・締切まで自動で並びます。" },
    { icon: "📣", title: "告知から締切まで、抜け漏れゼロ", desc: "先行案内→申込→売上の流れを見える化。遅れていると朝に教えてくれます。" },
    { icon: "✅", title: "今日やる事だけ、1画面に", desc: "遅れ・締切間近を毎朝まとめて表示。送り忘れ・公開遅れをなくします。" },
  ];
  return (
    <div style={{ minHeight: "100vh", display: "flex", justifyContent: "center", background: C.bg, color: C.text, overflowY: "auto" }}>
      <div style={{ width: "100%", maxWidth: 420, padding: "40px 24px 48px", boxSizing: "border-box" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 12, letterSpacing: 4, color: C.accent }}>ひとり社長のための</div>
          <h1 style={{ fontSize: 30, margin: "6px 0 12px" }}>ひとり秘書</h1>
          <p style={{ color: C.text, fontSize: 16, fontWeight: 700, lineHeight: 1.7, margin: "0 0 6px" }}>
            講座の締切も、告知の段取りも。<br />ぜんぶ逆算して「抜け漏れ」を防ぐ秘書。
          </p>
          <p style={{ color: C.sub, fontSize: 13, lineHeight: 1.7, margin: "0 0 24px" }}>
            講座・コーチング・サロンを<strong style={{ color: C.text }}>ひとりで回す人</strong>のための、<br />段取り＆集客スケジュール管理ツールです。
          </p>
        </div>

        <div style={{ display: "grid", gap: 10, marginBottom: 24 }}>
          {FEATURES.map((f) => (
            <div key={f.title} style={{ display: "flex", gap: 12, alignItems: "flex-start", background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: 14 }}>
              <span style={{ fontSize: 22, flex: "0 0 auto", lineHeight: 1.2 }}>{f.icon}</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 3 }}>{f.title}</div>
                <div style={{ fontSize: 13, color: C.sub, lineHeight: 1.6 }}>{f.desc}</div>
              </div>
            </div>
          ))}
        </div>

        <div style={{ textAlign: "center", fontSize: 13, fontWeight: 700, color: C.accent, marginBottom: 8 }}>
          ✓ 今は無料・クレジットカード登録なし
        </div>
        <button
          onClick={onLogin}
          style={{ width: "100%", padding: "14px 16px", borderRadius: 12, border: "none", background: C.accent, color: "#0B0D11", fontWeight: 700, cursor: "pointer", fontSize: 16 }}
        >
          Googleではじめる
        </button>
        <p style={{ color: C.faint, fontSize: 12, lineHeight: 1.7, textAlign: "center", margin: "12px 0 0" }}>
          お試し中の機能です（β版）。気に入らなければいつでもやめられます。<br />
          ログインすると、あなた専用のデータ領域が作られます。<br />他の人のデータとは完全に分かれています。
        </p>

        {error && (
          <div style={{ marginTop: 18, textAlign: "left", background: "#2A1715", border: `1px solid ${C.red}`, borderRadius: 10, padding: 12 }}>
            <div style={{ color: C.red, fontSize: 13, fontWeight: 700, marginBottom: 4 }}>ログインできませんでした</div>
            <div style={{ color: C.sub, fontSize: 12, wordBreak: "break-word" }}>{error.code || ""} {error.message}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/* 事前登録（waitlist）画面 — 許可リスト外でログインした人を見込み客として記録し、丁寧に案内する */
function WaitlistScreen({ user, onSignOut }) {
  const [status, setStatus] = useState("saving"); // saving | saved | failed
  useEffect(() => {
    if (!user || !user.uid || !db) { setStatus("failed"); return; }
    const ref = doc(db, "waitlist", user.uid);
    setDoc(ref, { email: user.email || "", name: user.displayName || "", ts: Date.now() }, { merge: true })
      .then(() => setStatus("saved"))
      .catch((e) => { try { console.error("waitlist write failed", e); } catch { /* ignore */ } setStatus("failed"); });
    track("waitlist_joined"); // 需要シグナル（LPに惹かれて入った人の数）
  }, [user]);
  return (
    <div style={{ minHeight: "100vh", display: "flex", justifyContent: "center", background: C.bg, color: C.text, overflowY: "auto" }}>
      <div style={{ width: "100%", maxWidth: 420, padding: "48px 24px", boxSizing: "border-box", textAlign: "center" }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>{status === "failed" ? "🙏" : "✉️"}</div>
        <h1 style={{ fontSize: 24, margin: "0 0 12px" }}>
          {status === "failed" ? "ご登録ありがとうございます" : "事前登録を受け付けました"}
        </h1>
        <p style={{ color: C.sub, fontSize: 14, lineHeight: 1.8, margin: "0 0 20px" }}>
          いまは少人数で動作を確かめている<strong style={{ color: C.text }}>招待制テスト中</strong>です。<br />
          準備ができ次第、順番にご案内します。
        </p>
        {user && user.email && (
          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: "12px 14px", marginBottom: 20 }}>
            <div style={{ fontSize: 11, color: C.faint, marginBottom: 4 }}>ご案内の送り先</div>
            <div style={{ fontSize: 14, fontWeight: 700, wordBreak: "break-all" }}>{user.email}</div>
          </div>
        )}
        {status === "failed" && (
          <p style={{ color: C.sub, fontSize: 12, lineHeight: 1.7, margin: "0 0 20px" }}>
            ※ 登録の保存に問題が起きた可能性があります。お手数ですが、しばらくして再度お試しください。
          </p>
        )}
        <button
          onClick={onSignOut}
          style={{ width: "100%", padding: "12px 16px", borderRadius: 12, border: `1px solid ${C.line}`, background: "transparent", color: C.text, fontWeight: 700, cursor: "pointer", fontSize: 14 }}
        >
          別のアカウントでログインする
        </button>
        <p style={{ color: C.faint, fontSize: 11, lineHeight: 1.7, margin: "16px 0 0" }}>
          すでに招待済みの場合は、招待を受けたGoogleアカウントでログインし直してください。
        </p>
      </div>
    </div>
  );
}

/* Firestore等のデータ取得エラー画面 */
function ErrorScreen({ error, onSignOut }) {
  // 技術的な詳細はコンソールに残す
  if (error) { try { console.error("[VIELE] データ接続エラー:", error); } catch { /* ignore */ } }
  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ fontSize: 13, letterSpacing: 2, color: C.accent }}>ひとり秘書</div>
      <h2 style={{ color: C.red, fontSize: 16, marginTop: 8 }}>データの読み込みに失敗しました</h2>
      <p style={{ color: C.sub, fontSize: 13 }}>
        通信環境を確認して、しばらくしてからもう一度お試しください。
      </p>
      <button onClick={onSignOut} style={{ ...chipBtn, marginTop: 8 }}>ログアウト</button>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   本体
   ────────────────────────────────────────────────────────────── */
export default function App() {
  const [user, setUser] = useState(firebaseEnabled ? undefined : null); // undefined=判定中 / null=未ログイン
  const [authError, setAuthError] = useState(null);
  // 初期値は「大」(1.15)。ITが苦手な層でも初見で読めるように。標準を選べば localStorage に保存され維持される。
  const [fontScale, setFontScale] = useState(() => Number(localStorage.getItem("viele-fontscale")) || 1.15);
  const cycleFont = () => {
    const next = fontScale >= 1.3 ? 1 : fontScale === 1 ? 1.15 : 1.3;
    setFontScale(next);
    try { localStorage.setItem("viele-fontscale", String(next)); } catch { /* ignore */ }
  };
  const fontLabel = fontScale >= 1.3 ? "特大" : fontScale > 1 ? "大" : "標準";
  const seed = useMemo(() => makeSeed(), []);

  // ── Googleカレンダー連携（Firebaseポップアップ＋localStorage、約1時間有効）──
  const [calToken, setCalToken] = useState(() => localStorage.getItem("viele-cal-token") || null);
  const [calList, setCalList] = useState([]);
  const [calEvents, setCalEvents] = useState([]);
  const [calStatus, setCalStatus] = useState("idle"); // idle|loading|ok|error
  const [calError, setCalError] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [calNonce, setCalNonce] = useState(0); // ++で予定を再取得（手動更新・復帰時・定期）
  const lastCalFetchRef = useRef(0);
  const refreshCalendar = () => setCalNonce((n) => n + 1);
  const [calWriteBusy, setCalWriteBusy] = useState(false); // 予定の追加・編集・削除中
  const [calWriteMsg, setCalWriteMsg] = useState(null);
  const [tab, setTab] = useState("home"); // トップのタブ（キー: home/work/money/tasks/news/fortune）
  const tabTouch = useRef(null);
  // どのタブが見られているか（匿名）。次に磨く場所をデータで決めるための主要指標。
  // ※フックは早期return（読み込み中/未ログイン/waitlist）より前に置くこと（順序が変わるとReactがクラッシュする）
  useEffect(() => { track("tab_viewed", { tab }); }, [tab]);

  // トークンが取れたら今週〜約2ヶ月分を取得
  useEffect(() => {
    if (!calToken) return;
    let cancelled = false;
    setCalStatus("loading");
    setCalError(null);
    (async () => {
      try {
        const list = await fetchCalendarList(calToken);
        if (cancelled) return;
        setCalList(list);
        const now = new Date();
        const timeMin = startOfWeekMonday(now).toISOString();
        const timeMax = addDays(now, 62).toISOString();
        const all = (await Promise.all(list.map((c) => fetchEvents(calToken, c.id, timeMin, timeMax).catch(() => [])))).flat();
        if (cancelled) return;
        setCalEvents(all);
        setCalStatus("ok");
      } catch (err) {
        if (cancelled) return;
        if (err.status === 401) { localStorage.removeItem("viele-cal-token"); setCalToken(null); }
        setCalError(err);
        setCalStatus("error");
      }
    })();
    return () => { cancelled = true; };
  }, [calToken]);

  // 「連携」：サーバー経由のOAuth（リフレッシュトークン取得）。一度で維持され続ける。
  const connectCalendar = () => {
    setCalError(null);
    const uid = (user && user.uid) || "x";
    window.location.href = `/api/gcal-start?state=${encodeURIComponent(uid)}`;
  };

  // カレンダー連携を解除（refresh/legacyトークンを失効＋破棄）
  const disconnectCalendar = () => {
    revokeToken(calToken);
    revokeToken(data && data.gcalRefresh);
    localStorage.removeItem("viele-cal-token");
    update({ gcalRefresh: null });
    setCalToken(null); setCalEvents([]); setCalList([]); setCalStatus("idle"); setCalError(null);
  };

  // アプリ → Googleカレンダーへ 作成/更新/削除（書き込み）。成功後に再取得して反映。
  const calWrite = async (action, payload) => {
    const refresh = data && data.gcalRefresh;
    if (!refresh) { setCalWriteMsg("連携が必要です"); return false; }
    setCalWriteBusy(true); setCalWriteMsg(null);
    try {
      const r = await authedFetch("/api/gcal-write", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh, action, ...payload }) });
      const text = await r.text();
      let j; try { j = JSON.parse(text); } catch { console.error("[VIELE] gcal-write parse error", r.status, text.slice(0, 200)); throw new Error("サーバーとの通信に失敗しました。少し時間をおいて『更新』を押してください。"); }
      if (j.error) {
        if (j.needReconnect) setCalWriteMsg("カレンダーへの書き込み権限が必要です。一度「連携を解除」してから再度「連携」してください。");
        console.error("[VIELE] gcal-write error", j.error);
        throw new Error("カレンダーの操作に失敗しました。しばらくしてから再度お試しください。");
      }
      lastCalFetchRef.current = 0; // 直後の再取得を強制
      refreshCalendar();
      setCalWriteMsg(action === "delete" ? "削除しました" : action === "update" ? "更新しました" : "追加しました");
      return true;
    } catch (e) {
      setCalWriteMsg((prev) => prev || ("失敗：" + String((e && e.message) || e)));
      return false;
    } finally {
      setCalWriteBusy(false);
    }
  };
  const createCalEvent = (calendarId, event) => calWrite("create", { calendarId, event });
  const updateCalEvent = (calendarId, eventId, event) => calWrite("update", { calendarId, eventId, event });
  const deleteCalEvent = (calendarId, eventId) =>
    new Promise((resolve) => { if (window.confirm("この予定をGoogleカレンダーから削除しますか？")) resolve(calWrite("delete", { calendarId, eventId })); else resolve(false); });

  // ログアウト（共有端末対策でカレンダートークンも破棄）
  const logout = () => {
    resetAnalytics();
    revokeToken(calToken);
    localStorage.removeItem("viele-cal-token");
    signOut(auth);
  };

  // ── 今日のまとめ（ニュース）状態 ──
  const [digestLoading, setDigestLoading] = useState(false);
  const [digestError, setDigestError] = useState(null);
  const digestRef = useRef(false);
  const [fortuneLoading, setFortuneLoading] = useState(false);
  const [fortuneError, setFortuneError] = useState(null);
  const fortuneRef = useRef(false);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState(null);

  // ── 通知（任意）：開いた時に遅れがあればブラウザ通知 ──
  const notifySupported = typeof Notification !== "undefined";
  const [notify, setNotify] = useState(() => localStorage.getItem("viele-notify") === "1");
  const notifiedRef = useRef(false);
  const cloud = useCloud(firebaseEnabled ? user?.uid || null : null, seed);
  const local = useLocal(STORE_KEY, seed);
  const { data, loading, error, update } = firebaseEnabled ? cloud : local;

  // 通知ON：許可取得 → プッシュ購読 → 購読をFirestoreに保存（閉じていてもサーバーから届く）
  // 注意1(iOS): ホーム画面に追加したPWA内でのみプッシュ受信が可能。
  // 注意2: requestPermission/subscribe はボタンタップの直後に呼ぶ必要がある（このonClick内でOK）。
  const enableNotify = async () => {
    if (!notifySupported) { alert("この端末/ブラウザは通知に対応していません。"); return; }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") { alert("通知が許可されませんでした。端末の設定から許可できます。"); return; }
    setNotify(true); localStorage.setItem("viele-notify", "1");
    // プッシュ購読（SW対応時のみ。未対応でも「開いた時の通知」は有効なので致命的にしない）
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    try {
      const registration = await navigator.serviceWorker.ready;
      const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
      if (!vapidPublicKey) { console.warn("VITE_VAPID_PUBLIC_KEY 未設定のためプッシュ購読をスキップ"); return; }
      const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey);
      const existing = await registration.pushManager.getSubscription();
      if (existing) await existing.unsubscribe(); // 鍵変更に追従するため再購読
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
      if (firebaseEnabled && update) update({ pushSub: subscription.toJSON() });
    } catch (err) {
      console.error("プッシュ購読エラー:", err); // iOS(ホーム画面未追加)等。許可だけ通った状態で続行
    }
  };

  // ── Googleカレンダー連携（refresh token方式・data宣言後に置く）──
  // OAuth戻り値(refresh token)を本人のFirestoreへ保存（初回のみ・ループ防止でガードを先に立てる）
  const gcalSavedRef = useRef(false);
  useEffect(() => {
    if (!data || gcalSavedRef.current || !PENDING_GCAL_REFRESH) return;
    gcalSavedRef.current = true;
    if (data.gcalRefresh !== PENDING_GCAL_REFRESH) update({ gcalRefresh: PENDING_GCAL_REFRESH });
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  // refresh token があればサーバー経由で予定取得（連携を維持＝再連携不要・3ヶ月先まで）
  // calNonce が増えると再取得（手動更新ボタン・アプリ復帰時・定期ポーリング）
  useEffect(() => {
    const refresh = data && data.gcalRefresh;
    if (!refresh) return;
    let cancelled = false;
    setCalStatus("loading"); setCalError(null);
    (async () => {
      try {
        const r = await authedFetch("/api/gcal-events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh }) });
        const text = await r.text();
        let j;
        try { j = JSON.parse(text); }
        catch {
          console.error("[VIELE] gcal-events parse error", r.status, text.slice(0, 200));
          const hint = (r.status === 401 || r.status === 403 || /authenticat|sign in|log ?in|vercel/i.test(text))
            ? "（サイトのアクセス保護がAPIを塞いでいる可能性。Vercelの Deployment Protection を確認）"
            : (r.status >= 500 || r.status === 504)
              ? "（サーバー側のタイムアウト／一時エラーの可能性。少し待って再度）"
              : "";
          throw new Error(`カレンダー取得に失敗（${r.status}）${hint}`);
        }
        if (cancelled) return;
        if (j.error) {
          // 連携が切れている場合は保存済みトークンを破棄して再連携を促す
          if (j.needReconnect) update({ gcalRefresh: null });
          console.error("[VIELE] gcal-events error", j.error);
          throw new Error("カレンダーの取得に失敗しました。再連携が必要な場合は「Googleカレンダーを連携」を押してください。");
        }
        setCalList(j.calendars || []);
        setCalEvents(j.events || []);
        setCalStatus("ok");
        lastCalFetchRef.current = Date.now();
      } catch (e) {
        if (cancelled) return;
        setCalError(e); setCalStatus("error");
      }
    })();
    return () => { cancelled = true; };
  }, [data && data.gcalRefresh, calNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // アプリに戻ったとき・定期的に自動で再取得（Googleカレンダー側の変更をすぐ反映）
  useEffect(() => {
    if (!(data && data.gcalRefresh)) return;
    const maybeRefresh = () => { if (Date.now() - lastCalFetchRef.current > 30000) refreshCalendar(); }; // 30秒以上経過時のみ
    const onVisible = () => { if (document.visibilityState === "visible") maybeRefresh(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", maybeRefresh);
    const id = setInterval(maybeRefresh, 5 * 60 * 1000); // 5分ごと
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", maybeRefresh);
      clearInterval(id);
    };
  }, [data && data.gcalRefresh]); // eslint-disable-line react-hooks/exhaustive-deps

  // 予定の自動検知：カレンダー予定のタイトルが逆算ルール(AUTO_RULES)にマッチすれば、逆算チェーンを自動生成（3ヶ月先まで）
  // ※ data を依存に入れると update→再実行の無限ループになるため、calEvents/calStatus のみを依存にし、
  //    処理済みIDは ref に蓄積して二重生成・ループを防ぐ。
  const tripSeenRef = useRef(new Set());
  const tripDataRef = useRef(null);
  tripDataRef.current = data; // 最新の data を ref で参照（依存配列に入れない）
  useEffect(() => {
    const d = tripDataRef.current;
    if (!d || calStatus !== "ok" || !calEvents.length) return;
    const now0 = new Date(); now0.setHours(0, 0, 0, 0);
    const horizon = new Date(now0.getTime() + 100 * 86400000); // 約3ヶ月先
    const existing = new Set((d.trips || []).map((t) => t.srcId).filter(Boolean));
    const ignore = d.tripIgnore || []; // 削除した自動出張は再生成しない
    const seen = tripSeenRef.current;
    const newTrips = calEvents
      .filter((ev) => ev.id && ev.title && matchAutoTemplate(ev.title))
      .filter((ev) => { const s = new Date(ev.startISO); return s >= now0 && s <= horizon; })
      .filter((ev) => !existing.has(ev.id) && !ignore.includes(ev.id) && !seen.has(ev.id))
      .map((ev) => {
        seen.add(ev.id);
        const tpl = pickTripTemplate(ev.title);
        return { id: "ts" + ev.id, srcId: ev.id, auto: true, title: ev.title, template: tpl, date: iso(new Date(ev.startISO)), items: templateItems(tpl) };
      });
    if (newTrips.length) update({ trips: [...(d.trips || []), ...newTrips] });
  }, [calEvents, calStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // 開いた時に遅れがあればブラウザ通知（dataを使うのでdata宣言後に置く）
  useEffect(() => {
    if (notifiedRef.current || !notify || !data) return;
    if (!notifySupported || Notification.permission !== "granted") return;
    const { late, soon } = computeAlerts(data);
    if (late.length + soon.length > 0) {
      try {
        new Notification("ひとり秘書｜今日の確認です", {
          body: `遅れ ${late.length}件・もうすぐ ${soon.length}件`,
          icon: "/icon-512.png",
        });
      } catch { /* iOS等はnew Notification不可。無視 */ }
    }
    notifiedRef.current = true;
  }, [notify, data, notifySupported]);

  // ── 今日のまとめ（ニュース）取得 ──
  const newsCats = data ? (data.newsCats || DEFAULT_NEWS_CATS) : DEFAULT_NEWS_CATS;
  const toggleNewsCat = (key) => {
    const cur = data.newsCats || DEFAULT_NEWS_CATS;
    const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
    update({ newsCats: next });
  };
  const refreshDigest = async () => {
    if (!data) return;
    setDigestLoading(true);
    setDigestError(null);
    try {
      const catUrls = NEWS_CATEGORIES.filter((c) => newsCats.includes(c.key)).map((c) => c.url);
      const customUrls = (data.feeds || []).map((f) => f.url);
      const urls = [...catUrls, ...customUrls];
      const fp = urls.map((u) => encodeURIComponent(u)).join(",");
      const r = await authedFetch(`/api/digest${fp ? `?feeds=${fp}` : ""}`);
      let j; try { j = await r.json(); } catch { console.error("[VIELE] digest parse error", r.status); throw new Error("サーバーとの通信に失敗しました。少し時間をおいて『更新』を押してください。"); }
      if (j.error) { console.error("[VIELE] digest error", j.error); throw new Error("サーバーとの通信に失敗しました。少し時間をおいて『更新』を押してください。"); }
      update({ digest: { date: iso(new Date()), briefing: j.briefing || "", items: (j.items || []).slice(0, 40), aiEnabled: !!j.aiEnabled } });
    } catch (e) {
      setDigestError(e);
    }
    setDigestLoading(false);
  };
  // 1日1回、未取得なら自動取得
  useEffect(() => {
    if (!data || digestRef.current) return;
    if (!data.digest || data.digest.date !== iso(new Date())) {
      digestRef.current = true;
      refreshDigest();
    }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 運気 ──
  const refreshFortune = async (birthOverride) => {
    if (!data) return;
    const birth = birthOverride || data.birth;
    if (!birth || !birth.date) {
      setFortuneError(new Error("先に出生情報を入力してください"));
      return;
    }
    setFortuneLoading(true);
    setFortuneError(null);
    try {
      const chartText = computeChart(birth).text; // 命式はブラウザ側で計算
      const energy = dayEnergy(birth, iso(new Date())); // その日の気（決定論的にスコア＆スタンス）
      const r = await authedFetch("/api/fortune", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chart: chartText, situation: buildSituation(data), today: iso(new Date()), energy }),
      });
      const text = await r.text();
      let j;
      try { j = JSON.parse(text); }
      catch { console.error("[VIELE] fortune parse error", r.status, text.slice(0, 200)); throw new Error("サーバーとの通信に失敗しました。少し時間をおいて『更新』を押してください。"); }
      if (j && j.quotaExceeded) { throw new Error(j.error || "本日のAI利用上限に達しました。"); }
      if (!r.ok || j.error) { console.error("[VIELE] fortune error", j && j.error, r.status); throw new Error("サーバーとの通信に失敗しました。少し時間をおいて『更新』を押してください。"); }
      track("ai_used", { feature: "fortune" });
      update({ fortune: { date: iso(new Date()), aiEnabled: !!j.aiEnabled, ...(j.fortune || {}) } });
    } catch (e) {
      setFortuneError(e);
    }
    setFortuneLoading(false);
  };

  // 予定スクショの取り込み（TimeTree等→AI読取→家族レーン）
  const importSchedule = async (file) => {
    if (!file || !data) return;
    setImporting(true);
    setImportMsg(null);
    try {
      const dataUrl = await downscaleImage(file, 1280, 0.7);
      const r = await authedFetch("/api/import-schedule", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: dataUrl, mime: "image/jpeg", today: iso(new Date()) }) });
      const text = await r.text();
      let j; try { j = JSON.parse(text); } catch { console.error("[VIELE] import-schedule parse error", r.status, text.slice(0, 200)); throw new Error("サーバーとの通信に失敗しました。しばらくしてから再度お試しください。"); }
      if (j && j.quotaExceeded) { throw new Error(j.error || "本日のAI利用上限に達しました。"); }
      if (!r.ok || j.error) { console.error("[VIELE] import-schedule error", j && j.error, r.status); throw new Error("サーバーとの通信に失敗しました。しばらくしてから再度お試しください。"); }
      if (j.aiEnabled === false) throw new Error("AI機能は現在オフです");
      const ev = (j.events || []).map((e, i) => ({ id: "mv" + Date.now() + "_" + i, date: e.date, time: e.time || "終日", title: e.title }));
      const existing = data.manualEvents || [];
      const keyOf = (e) => `${e.date}|${e.time}|${e.title}`;
      const seen = new Set(existing.map(keyOf));
      const merged = [...existing, ...ev.filter((e) => !seen.has(keyOf(e)))];
      update({ manualEvents: merged });
      setImportMsg(ev.length ? `${ev.length}件読み取り（新規${merged.length - existing.length}件を追加）` : "予定を読み取れませんでした。別のスクショで再試行を。");
    } catch (e) {
      setImportMsg("失敗：" + String((e && e.message) || e));
    }
    setImporting(false);
  };
  const clearManual = () => { if (window.confirm("取り込んだ予定をすべて消去しますか？")) update({ manualEvents: [] }); };

  useEffect(() => {
    if (!data || fortuneRef.current) return;
    if (!(data.birth && data.birth.date)) return; // birth 未設定時は自動 fetch しない
    if (!data.fortune || data.fortune.date !== iso(new Date())) {
      fortuneRef.current = true;
      refreshFortune();
    }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!firebaseEnabled) return; // ローカルモードは認証なし
    const unsub = onAuthStateChanged(auth, (u) => setUser(u || null));
    // リダイレクト方式ログインの結果・エラーを拾う
    getRedirectResult(auth).catch((e) => setAuthError(e));
    return unsub;
  }, []);

  // 製品計測（PostHog）の初期化。キー未設定なら何もしない（無料・無送信）
  useEffect(() => { initAnalytics(); track("app_opened"); }, []);
  // ログインしたら匿名uidで識別（PIIは送らない）。ファネル: app_opened → signed_in
  useEffect(() => {
    if (user && user.uid) { identifyUser(user.uid); track("signed_in"); }
  }, [user]);

  // スマホSafari等ではポップアップがブロックされやすいので、失敗時はリダイレクト方式で再試行
  const login = async () => {
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (e) {
      const popupIssue =
        e.code === "auth/popup-blocked" ||
        e.code === "auth/popup-closed-by-user" ||
        e.code === "auth/cancelled-popup-request" ||
        e.code === "auth/operation-not-supported-in-this-environment";
      if (popupIssue) {
        try {
          await signInWithRedirect(auth, googleProvider);
        } catch (e2) {
          setAuthError(e2);
        }
      } else {
        setAuthError(e);
      }
    }
  };

  if (firebaseEnabled && user === undefined) return <Splash text="読み込み中…" />;
  if (firebaseEnabled && user === null) return <LoginGate onLogin={login} error={authError} />;
  // 許可リスト外でログインした人は“行き止まり”にせず、事前登録（waitlist）へ案内する
  if (error && error.code === "permission-denied") return <WaitlistScreen user={user} onSignOut={logout} />;
  if (error) return <ErrorScreen error={error} onSignOut={logout} />;
  if (loading || !data) return <Splash text="読み込み中…" />;

  // ── trips 操作 ──
  const toggleTripItem = (tripId, idx) => {
    const trips = data.trips.map((t) =>
      t.id !== tripId ? t : { ...t, items: t.items.map((it, i) => (i === idx ? { ...it, done: !it.done } : it)) }
    );
    update({ trips });
  };
  const addTrip = ({ title, template, date }) => {
    const trip = { id: "t" + Date.now(), title, template, date, items: templateItems(template) };
    update({ trips: [...data.trips, trip] });
    track("chain_created", { kind: "trip", template: template || "" }); // 売りコア（段取り逆算）の利用
  };
  // 削除は誤操作防止のため確認を挟む
  const confirmDelete = (fn, label) => {
    const name = label ? `『${label}』` : "この項目";
    if (window.confirm(`${name}を削除しますか？この操作は取り消せません。`)) fn();
  };
  const removeTrip = (id) => {
    const t = data.trips.find((x) => x.id === id);
    confirmDelete(() => {
      const patch = { trips: data.trips.filter((x) => x.id !== id) };
      // 自動検知の出張を消したら、同じ予定からは再生成しない
      if (t && t.auto && t.srcId) patch.tripIgnore = [...(data.tripIgnore || []), t.srcId];
      update(patch);
    }, t && t.title);
  };
  const editTrip = (id, patch) => update({ trips: data.trips.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
  const mapTripItems = (tripId, fn) =>
    update({ trips: data.trips.map((t) => (t.id === tripId ? { ...t, items: fn(t.items) } : t)) });
  const addTripItem = (tripId, item) => mapTripItems(tripId, (items) => [...items, { ...item, done: false }]);
  const editTripItem = (tripId, idx, patch) =>
    mapTripItems(tripId, (items) => items.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  const removeTripItem = (tripId, idx) => {
    const t = data.trips.find((x) => x.id === tripId);
    const item = t && t.items && t.items[idx];
    confirmDelete(() => mapTripItems(tripId, (items) => items.filter((_, i) => i !== idx)), item && item.label);
  };

  // ── 締切（二段ローンチ）操作 ──
  const addDeadline = (d) => { update({ deadlines: [...(data.deadlines || []), { id: "d" + Date.now(), ...d }] }); track("deadline_created"); }; // 売りコア（締切逆算）の利用
  const addDeadlinesBulk = (arr) =>
    update({ deadlines: [...(data.deadlines || []), ...arr.map((d, i) => ({ id: "d" + Date.now() + "_" + i, ...d }))] });
  const editDeadline = (id, patch) => update({ deadlines: data.deadlines.map((x) => (x.id === id ? { ...x, ...patch } : x)) });
  const removeDeadline = (id) => {
    const d = (data.deadlines || []).find((x) => x.id === id);
    confirmDelete(() => update({ deadlines: data.deadlines.filter((x) => x.id !== id) }), d && d.title);
  };

  // ── 汎用リスト操作（content / money / tasks / feeds）──
  // 既存ユーザーで未定義のキーでも落ちないよう (data[key] || []) で防御
  const makeListOps = (key) => ({
    toggle: (id) => update({ [key]: (data[key] || []).map((x) => (x.id === id ? { ...x, done: !x.done } : x)) }),
    add: (item) => {
      const base = typeof item === "string" ? { title: item } : item;
      update({ [key]: [...(data[key] || []), { id: key[0] + Date.now(), done: false, ...base }] });
    },
    edit: (id, patch) => update({ [key]: (data[key] || []).map((x) => (x.id === id ? { ...x, ...patch } : x)) }),
    remove: (id) => {
      const item = (data[key] || []).find((x) => x.id === id);
      confirmDelete(() => update({ [key]: (data[key] || []).filter((x) => x.id !== id) }), item && item.title);
    },
  });
  const content = makeListOps("content");
  const launches = makeListOps("launches");
  const money = makeListOps("money");
  const tasks = makeListOps("tasks");
  const feedsOps = makeListOps("feeds");

  const today = new Date();
  const dateLabel = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日(${WD[today.getDay()]})`;

  // ── カレンダー由来データの組み立て（複数カレンダー対応）──
  const usingCal = calStatus === "ok" && (!!calToken || !!(data && data.gcalRefresh));
  const catMap = data.catMap || {};       // 予定名→役割 の手動上書き（同名は次回も適用）
  const calConfig = data.calConfig || {}; // カレンダーID→ロール(work/family/off)
  const axisOfCat = (cat) => (cat === "制作" || cat === "集客" ? "仕組み" : "労働");
  const setEventCat = (title, cat) => update({ catMap: { ...catMap, [title]: cat } });
  const setCalRole = (calId, role) => update({ calConfig: { ...calConfig, [calId]: role } });
  const roleForCal = (calId) => {
    if (calConfig[calId]) return calConfig[calId];
    const c = calList.find((x) => x.id === calId);
    return c && c.primary ? "work" : "off"; // 既定: primary=仕事、その他=取り込まない
  };
  const buildEntry = (ev) => {
    const role = roleForCal(ev.calendarId);
    const start = new Date(ev.startISO);
    const end = ev.endISO ? new Date(ev.endISO) : null;
    const hours = ev.allDay ? 0 : end ? Math.max(0.25, (end - start) / 3600000) : 1;
    let cat, axis;
    if (role === "family") { cat = "家族"; axis = "家族"; }
    else {
      const ov = catMap[ev.title];
      if (ov) { cat = ov; axis = axisOfCat(ov); }
      else { const c = classifyEvent(ev.title); cat = c.cat; axis = c.axis; }
    }
    return { ...ev, role, start, wd: start.getDay(), time: ev.allDay ? "終日" : `${pad2(start.getHours())}:${pad2(start.getMinutes())}`, hours, cat, axis };
  };
  const includedEntries = calEvents.filter((ev) => roleForCal(ev.calendarId) !== "off").map(buildEntry);

  // 取り込んだ予定(TimeTree等のスクショ由来) → 家族レーンとして合流
  const manualEntries = (data.manualEvents || []).map((ev) => {
    const allDay = ev.time === "終日" || !/^\d/.test(ev.time || "");
    const start = new Date(`${ev.date}T${allDay ? "00:00" : ev.time}:00`);
    return { id: ev.id, title: ev.title, allDay, startISO: start.toISOString(), start, wd: start.getDay(), time: allDay ? "終日" : ev.time, hours: 0, cat: "家族", axis: "家族", role: "family", manual: true };
  });

  // 今週の時間メーター：仕事カレンダーの時間指定予定のみ（家族・取り込みは除外）
  const weekStart = startOfWeekMonday(today);
  const weekEnd = addDays(weekStart, 7);
  const weekWork = includedEntries.filter((e) => e.role === "work" && !e.allDay && e.start >= weekStart && e.start < weekEnd);
  const scheduleEntries = usingCal ? weekWork : LOG;
  const scheduleSource = usingCal ? "calendar" : "sample";

  // 今日の予定：仕事＋家族＋取り込み（本日分）／横スワイプで先の日も
  const todayStart = startOfDay(today);
  const todayEnd = addDays(todayStart, 1);
  const pool = [...(usingCal ? includedEntries : []), ...manualEntries];
  const usePool = pool.length > 0;
  const DAYS_AHEAD = 7;
  const dayBuckets = [];
  for (let d = 0; d < DAYS_AHEAD; d++) {
    const ds = addDays(todayStart, d);
    const de = addDays(ds, 1);
    const items = usePool
      ? pool.filter((e) => e.start >= ds && e.start < de).sort((a, b) => a.time.localeCompare(b.time))
      : LOG.filter((e) => e.wd === ds.getDay()).slice().sort((a, b) => a.time.localeCompare(b.time));
    const label = d === 0 ? "今日" : d === 1 ? "明日" : d === 2 ? "明後日" : `${ds.getMonth() + 1}/${ds.getDate()}`;
    dayBuckets.push({ key: d, date: ds, label, items });
  }

  // 今後の予定（先2ヶ月）：家族・取り込みは全件、仕事は重要イベントのみ
  const upcoming = pool
    .filter((e) => e.start >= todayEnd && e.start < addDays(today, 62) && (e.role === "family" || isNotable(e)))
    .sort((a, b) => a.start - b.start);

  const calProps = {
    source: scheduleSource,
    status: calStatus,
    error: calError,
    onConnect: connectCalendar,
    connecting,
    count: weekWork.length,
    onRefresh: refreshCalendar,
    refreshing: calStatus === "loading",
  };

  // 書き込み可能なカレンダーID（予定一覧での✎編集・✕削除の可否判定に使う）
  const writableCalIds = new Set((calList || []).filter((c) => c.accessRole === "owner" || c.accessRole === "writer").map((c) => c.id));

  const alerts = computeAlerts(data);
  // 売上タブのローンチ締切を、仕事タブの締切ボードに読み取り専用で並べるためのリンク項目
  const launchLinked = (data.launches || []).flatMap((L) =>
    launchDeadlines(L).map((d) => ({ id: `lk:${L.id}:${d.stage}`, title: L.name, stage: `${d.stage}締切`, date: d.date, linked: true }))
  );
  const moneyOutstanding = (data.money || []).filter((x) => !x.done).reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const briefFirst = (data.digest && data.digest.briefing ? data.digest.briefing.split("\n").filter((l) => l.trim())[0] : "");

  // トップのタブ（キー方式。ニュース/運気は設定で非表示にできる＝販売時はコアに集中できる）
  const hiddenTabs = (data && data.hiddenTabs) || {};
  const ALL_TABS = [
    { key: "home", label: "ホーム" },
    { key: "work", label: "仕事" },
    { key: "money", label: "売上" },
    { key: "tasks", label: "タスク" },
    { key: "news", label: "ニュース" },
    { key: "fortune", label: "運気" },
  ];
  const TABS = ALL_TABS.filter((t) => !hiddenTabs[t.key]);
  const activeTab = TABS.some((t) => t.key === tab) ? tab : "home"; // 非表示タブ選択中はホームへ寄せる
  const onTouchStart = (ev) => {
    if (ev.target.closest && ev.target.closest("[data-hscroll]")) { tabTouch.current = null; return; } // 内側の横スクロール上は無視
    const t = ev.touches[0];
    tabTouch.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (ev) => {
    if (!tabTouch.current) return;
    const t = ev.changedTouches[0];
    const dx = t.clientX - tabTouch.current.x;
    const dy = t.clientY - tabTouch.current.y;
    tabTouch.current = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      const idx = TABS.findIndex((t) => t.key === activeTab);
      const ni = Math.max(0, Math.min(TABS.length - 1, idx + (dx < 0 ? 1 : -1)));
      setTab(TABS[ni].key);
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "system-ui, -apple-system, 'Hiragino Sans', sans-serif", overflowX: "hidden" }}>
      {/* ヘッダー＋タブバー */}
      <header style={{ position: "sticky", top: 0, zIndex: 10, background: "rgba(15,17,21,0.9)", backdropFilter: "blur(8px)", borderBottom: `1px solid ${C.line}`, padding: "10px 14px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <strong style={{ fontSize: 16, letterSpacing: 1 }}>ひとり秘書</strong>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: C.sub }}>{dateLabel}</span>
          <button onClick={cycleFont} title="文字サイズを変える" style={{ ...iconBtn, fontSize: 12, padding: "4px 8px", width: "auto", border: `1px solid ${C.line}`, borderRadius: 8 }}>文字{fontLabel}</button>
          {firebaseEnabled && <button onClick={logout} style={{ ...iconBtn, fontSize: 12, padding: "4px 8px", width: "auto" }}>ログアウト</button>}
        </div>
        <div style={{ display: "flex", gap: 6, overflowX: "auto", scrollbarWidth: "none" }}>
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{ flex: "0 0 auto", padding: "6px 14px", borderRadius: 999, border: `1px solid ${activeTab === t.key ? C.accent : C.line}`, background: activeTab === t.key ? C.accent : "transparent", color: activeTab === t.key ? "#0B0D11" : C.text, fontSize: 13, fontWeight: activeTab === t.key ? 700 : 400, cursor: "pointer" }}
            >{t.label}</button>
          ))}
        </div>
      </header>

      <main onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} style={{ width: `${100 / fontScale}%`, maxWidth: `${760 / fontScale}px`, margin: "0 auto", padding: 18, boxSizing: "border-box", position: "relative", zoom: fontScale }}>
        {!firebaseEnabled && (
          <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 12, padding: "10px 14px", marginBottom: 16, fontSize: 12, color: C.sub, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: C.accent }}>●</span>
            ローカルモード — この端末に保存中。複数端末で同期するには <code style={{ color: C.text }}>.env</code> にFirebaseの値を設定してください（README参照）。
          </div>
        )}

        {activeTab === "home" && (() => {
          const pendingTasks = (data.tasks || []).filter((x) => !x.done).length;
          const remaining = alerts.late.length + alerts.soon.length + pendingTasks;
          return (
            <>
              {/* サンプルデータ識別バナー */}
              {data.sampleNotice && (
                <div style={{ background: C.panel, border: `2px solid ${C.accent}`, borderRadius: 12, padding: "14px 16px", marginBottom: 16 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.accent, marginBottom: 8 }}>
                    いま表示されているデータはサンプルです（「（例）」と付いた項目）。
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      style={{ height: 44, padding: "0 16px", borderRadius: 8, border: `1px solid ${C.red}`, background: "transparent", color: C.red, fontWeight: 700, fontSize: 14, cursor: "pointer" }}
                      onClick={() => {
                        if (window.confirm("サンプルデータをすべて削除しますか？この操作は取り消せません。")) {
                          update({ trips: [], deadlines: [], launches: [], content: [], money: [], tasks: [], manualEvents: [], birth: null, sampleNotice: false });
                          track("sample_cleared"); // アクティベーション（自分のデータで使い始めた合図）
                        }
                      }}
                    >サンプルを全部消す</button>
                    <button
                      style={{ height: 44, padding: "0 16px", borderRadius: 8, border: `1px solid ${C.line}`, background: "transparent", color: C.text, fontWeight: 700, fontSize: 14, cursor: "pointer" }}
                      onClick={() => update({ sampleNotice: false })}
                    >これは自分のデータ</button>
                  </div>
                </div>
              )}
              {/* はじめの3ステップ（セットアップが終わるまで案内。「どこから始めるか」の地図） */}
              {(data.sampleNotice || !data.birth) && !data.onboardDismissed && (() => {
                const steps = [
                  { n: 1, label: "自分のデータにする", hint: "上の「サンプルを全部消す」or「これは自分のデータ」を押す", done: !data.sampleNotice },
                  { n: 2, label: "生年月日を登録する", hint: "「今日の一手」と経営カレンダーが動き出します", done: !!data.birth, action: () => setTab("fortune"), btn: "運気タブへ" },
                  { n: 3, label: "Googleカレンダーを連携（任意）", hint: "予定が自動で取り込まれ、逆算の手配も自動生成", done: usingCal, action: connectCalendar, btn: "連携する" },
                ];
                return (
                  <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: "14px 16px", marginBottom: 16 }}>
                    <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
                      <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>はじめの3ステップ</div>
                      <span style={{ flex: 1 }} />
                      <button onClick={() => update({ onboardDismissed: true })} style={{ ...iconBtn, fontSize: 12, width: "auto", padding: "4px 8px", color: C.sub, border: `1px solid ${C.line}`, borderRadius: 8 }}>閉じる</button>
                    </div>
                    {steps.map((s) => (
                      <div key={s.n} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderTop: s.n === 1 ? "none" : `1px solid ${C.line}` }}>
                        <span style={{ width: 26, height: 26, flex: "0 0 auto", borderRadius: "50%", display: "grid", placeItems: "center", fontSize: 13, fontWeight: 700, background: s.done ? C.green : C.panel2, color: s.done ? "#0B0D11" : C.sub, border: `1px solid ${s.done ? C.green : C.line}` }}>{s.done ? "✓" : s.n}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 14, fontWeight: 600, color: s.done ? C.sub : C.text, textDecoration: s.done ? "line-through" : "none" }}>{s.label}</div>
                          <div style={{ fontSize: 12, color: C.faint, lineHeight: 1.4 }}>{s.hint}</div>
                        </div>
                        {!s.done && s.action && (
                          <button onClick={s.action} style={{ flex: "0 0 auto", height: 40, padding: "0 14px", borderRadius: 8, border: `1px solid ${C.accent}`, background: C.accent, color: "#0B0D11", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>{s.btn}</button>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })()}
              <BriefingCard fortune={data.fortune} birth={data.birth} today={dayBuckets[0].items} late={alerts.late.length} soon={alerts.soon.length} outstanding={moneyOutstanding} brief={briefFirst} onTab={setTab} remaining={remaining} pendingTasks={pendingTasks} hideFortune={!!hiddenTabs.fortune} hideNews={!!hiddenTabs.news} />
              <AlertSummary alerts={alerts} notify={notify} notifySupported={notifySupported} onEnableNotify={enableNotify} />
              {usingCal && <AddEventBar calList={calList} onCreate={createCalEvent} busy={calWriteBusy} msg={calWriteMsg} onReconnect={connectCalendar} />}
              <Schedule days={dayBuckets} {...calProps} onSetCat={setEventCat} writableIds={writableCalIds} onEditEvent={updateCalEvent} onDeleteEvent={deleteCalEvent} editBusy={calWriteBusy} />
              <TimeMeter entries={scheduleEntries} {...calProps} />
              {(usingCal || manualEntries.length > 0) && <Upcoming events={upcoming} writableIds={writableCalIds} onEditEvent={updateCalEvent} onDeleteEvent={deleteCalEvent} editBusy={calWriteBusy} />}
              <Acc title="設定・取り込み" defaultOpen={false}>
                {usingCal && calList.length > 0 && <CalendarSettings calList={calList} roleForCal={roleForCal} onSetRole={setCalRole} onDisconnect={disconnectCalendar} />}
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.line}` }}>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>表示するタブ</div>
                  <div style={{ fontSize: 12, color: C.sub, marginBottom: 8 }}>使わないタブは隠せます（データは消えません。あとでいつでも戻せます）。</div>
                  {[{ key: "news", label: "ニュース" }, { key: "fortune", label: "運気" }].map((t) => (
                    <label key={t.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={!hiddenTabs[t.key]}
                        onChange={(ev) => update({ hiddenTabs: { ...hiddenTabs, [t.key]: !ev.target.checked } })}
                        style={{ width: 18, height: 18, flex: "0 0 auto" }}
                      />
                      <span style={{ fontSize: 14 }}>「{t.label}」タブを表示する</span>
                    </label>
                  ))}
                </div>
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.line}` }}>
                  <button
                    style={{ ...chipBtn, display: "inline-flex", alignItems: "center", minHeight: 40, padding: "9px 14px", fontSize: 13 }}
                    onClick={() => {
                      try {
                        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        const d = iso(new Date());
                        a.href = url;
                        a.download = `viele-backup-${d}.json`;
                        a.click();
                        URL.revokeObjectURL(url);
                      } catch (e) {
                        alert("エクスポートに失敗しました: " + String(e && e.message || e));
                      }
                    }}
                  >データをJSONで書き出す</button>
                  <div style={{ fontSize: 12, color: C.sub, marginTop: 6 }}>全データを viele-backup-YYYY-MM-DD.json としてダウンロードします。</div>
                </div>
              </Acc>
            </>
          );
        })()}

        {activeTab === "work" && (
          <>
            <TripChain
              trips={data.trips}
              birth={data.birth}
              onToggle={toggleTripItem}
              onAdd={addTrip}
              onRemove={removeTrip}
              onEditTrip={editTrip}
              onAddItem={addTripItem}
              onEditItem={editTripItem}
              onRemoveItem={removeTripItem}
            />
            <DeadlineBoard deadlines={data.deadlines} linked={launchLinked} birth={data.birth} onAdd={addDeadline} onAddBulk={addDeadlinesBulk} onEdit={editDeadline} onRemove={removeDeadline} />
            <CheckList
              title="コンテンツ制作サイクル"
              accent={C.blue}
              items={data.content}
              onToggle={content.toggle}
              onAdd={content.add}
              onEdit={content.edit}
              onRemove={content.remove}
              placeholder="制作物を追加…"
              renderMeta={(it) => it.phase && <span style={{ fontSize: 11, color: C.blue, fontWeight: 700 }}>{it.phase}</span>}
            />
          </>
        )}

        {activeTab === "money" && (
          <>
            <LaunchKpi
              launches={data.launches}
              onAdd={launches.add}
              onEdit={launches.edit}
              onRemove={launches.remove}
            />
            <MoneyList
              items={data.money}
              onToggle={money.toggle}
              onAdd={money.add}
              onEdit={money.edit}
              onRemove={money.remove}
            />
          </>
        )}

        {activeTab === "tasks" && (
          <CheckList
            title="追加タスク"
            accent={C.purple}
            items={data.tasks}
            onToggle={tasks.toggle}
            onAdd={tasks.add}
            onEdit={tasks.edit}
            onRemove={tasks.remove}
            placeholder="タスクを追加…"
          />
        )}

        {activeTab === "news" && (
          <DigestPanel
            digest={data.digest}
            loading={digestLoading}
            error={digestError}
            onRefresh={refreshDigest}
            feeds={data.feeds}
            onAddFeed={(f) => feedsOps.add(f)}
            onRemoveFeed={(id) => feedsOps.remove(id)}
            selectedCats={newsCats}
            onToggleCat={toggleNewsCat}
          />
        )}

        {activeTab === "fortune" && (
          <BizCalendar birth={data.birth} trips={data.trips} deadlines={data.deadlines} launches={data.launches} onPlan={(d) => addDeadline({ title: "発信・告知", stage: "告知", date: d })} />
        )}

        {activeTab === "fortune" && (
          <FortunePanel
            fortune={data.fortune}
            loading={fortuneLoading}
            error={fortuneError}
            aiOff={!!(data.fortune && data.fortune.aiEnabled === false)}
            onRefresh={() => refreshFortune()}
            birth={data.birth}
            onSaveBirth={(b) => { update({ birth: b }); refreshFortune(b); }}
          />
        )}

        <footer style={{ textAlign: "center", color: C.faint, fontSize: 11, padding: "12px 0 32px" }}>
          ← 横スワイプ / 上のタブで切替 ・ {firebaseEnabled ? "全端末で同期" : "ローカル保存"}
        </footer>
      </main>
    </div>
  );
}

function Splash({ text }) {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: C.bg, color: C.sub }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 13, letterSpacing: 2, color: C.accent }}>ひとり秘書</div>
        <div style={{ marginTop: 8, fontSize: 14 }}>{text}</div>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   共通スタイル片
   ────────────────────────────────────────────────────────────── */
const inp = {
  width: "100%",
  boxSizing: "border-box",
  background: C.panel,
  border: `1px solid ${C.line}`,
  borderRadius: 8,
  color: C.text,
  padding: "8px 10px",
  fontSize: 13,
  marginBottom: 8,
  outline: "none",
};
const lbl = {
  flex: 1,
  minWidth: 0,
  fontSize: 13,
  color: C.sub,
  display: "flex",
  flexDirection: "column",
  gap: 3,
};
const chipBtn = {
  background: "transparent",
  border: `1px solid ${C.line}`,
  color: C.text,
  borderRadius: 8,
  padding: "9px 14px",
  fontSize: 13,
  cursor: "pointer",
  whiteSpace: "nowrap",
  minHeight: 40,
  display: "inline-flex",
  alignItems: "center",
};
const iconBtn = {
  background: "transparent",
  border: "none",
  color: C.sub,
  cursor: "pointer",
  fontSize: 15,
  width: 40,
  height: 40,
  flex: "0 0 auto",
  display: "grid",
  placeItems: "center",
};

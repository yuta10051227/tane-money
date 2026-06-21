import { useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, GoogleAuthProvider } from "firebase/auth";
import { doc, setDoc } from "firebase/firestore";
import { auth, googleProvider, firebaseEnabled, db } from "./firebase";
import { useCloud } from "./useCloud";
import { useLocal } from "./useLocal";
import { CALENDAR_SCOPE, fetchCalendarList, fetchEvents, classifyEvent, isNotable, startOfWeekMonday, pad2 } from "./calendar";
import { revokeToken } from "./gauth";
import { computeChart, dayEnergy, stancesFor, sanmei, sanmeiDetail, tenchusatsu, daiun, aishou, familyFortune, sanmeiUn, koyomi, koyomiMonth, bestDays, shugojin } from "./natal";
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
// テーマ：暗背景はビビッドなアクセント、明背景は白地で読みやすいよう濃いめのアクセントに最適化。
// アクセントも含めテーマ単位で切替（CAT/STANCE_UIは下でdynにして読み込み時固定を回避）。
const THEMES = {
  // invBg/invText: 反転(白抜き)ボタン用。背景に文字色を流用すると light で潰れるため専用トークン化。
  dark: { bg: "#0F1115", panel: "#171A21", panel2: "#1E222B", line: "#2A2F3A", text: "#E8EAED", sub: "#C5CBD3", faint: "#AAB2BD", invBg: "#E8EAED", invText: "#0B0D11", accent: "#C9A227", green: "#3FB984", orange: "#E8A13E", red: "#E2554B", blue: "#5B8DEF", purple: "#9A7BE0" },
  light: { bg: "#F4F5F7", panel: "#FFFFFF", panel2: "#EDF0F4", line: "#D2D8E0", text: "#1B1E24", sub: "#444B55", faint: "#66707C", invBg: "#222733", invText: "#FFFFFF", accent: "#9A7B12", green: "#1B8A5A", orange: "#B56A14", red: "#C23B32", blue: "#2F62C8", purple: "#6A4FB8" },
};
let THEME_NAME = "dark"; // 本画面の描画開始時に data.theme で更新（CSR単一画面なので安全）
// テーマに追従する動的スタイル：プロパティ参照のたびに現在テーマの値を返すProxy。
// style={obj} / {...obj} のどちらでも描画時に最新色へ解決される。
const dyn = (fn) => new Proxy({}, {
  get: (_, k) => fn()[k],
  has: (_, k) => k in fn(),
  ownKeys: () => Reflect.ownKeys(fn()),
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
});
const C = dyn(() => THEMES[THEME_NAME]);

// 役割カテゴリ（施術/制作/集客/経営）の色。テーマ追従のためdyn（CAT[cat]/Object.keys(CAT)が現在テーマ色を返す）。
const CAT = dyn(() => { const t = THEMES[THEME_NAME]; return { 施術: t.green, 制作: t.blue, 集客: t.purple, 経営: t.accent }; });
const FAMILY_COLOR = "#C77B9C"; // 家族・プライベートの色（仕事と区別）
const catColor = (cat) => CAT[cat] || (cat === "家族" ? FAMILY_COLOR : C.faint);

// 区分の「表示名」だけを業種に合わせて差し替える仕組み（内部キーは施術/制作/集客/経営のまま）。
// CAT_LABELS は本画面の描画開始時に data.catLabels で更新する（CSR単一画面なので安全）。
let CAT_LABELS = {};
const labelOf = (cat) => (CAT_LABELS && CAT_LABELS[cat]) || cat;
// 業種プリセット：4枠の表示名（色と労働/仕組み軸は不変）。空={}は施術家・サロン(既定)。
const CAT_PRESETS = [
  { id: "salon", name: "施術家・サロン", labels: {} },
  { id: "coach", name: "コーチ・コンサル", labels: { 施術: "セッション", 制作: "コンテンツ", 集客: "集客", 経営: "経営" } },
  { id: "school", name: "講師・スクール", labels: { 施術: "講座・レッスン", 制作: "教材制作", 集客: "集客", 経営: "運営" } },
  { id: "creator", name: "クリエイター・制作業", labels: { 施術: "受託・納品", 制作: "自主制作", 集客: "集客", 経営: "経営" } },
  { id: "shop", name: "物販・ショップ", labels: { 施術: "接客・対応", 制作: "商品準備", 集客: "集客", 経営: "経営" } },
  { id: "president", name: "会社経営・社長", labels: { 施術: "営業・商談", 制作: "事業・商品", 集客: "集客・広報", 経営: "組織・財務" } },
  { id: "uranai", name: "占い師・鑑定士", labels: { 施術: "鑑定・セッション", 制作: "コンテンツ", 集客: "集客", 経営: "運営" } },
  { id: "other", name: "その他", labels: {} },
];

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
  // 不正な日付でも落ちないようフォールバック。ローカル年月日で返す（UTC変換でJST深夜にズレるのを防ぐ）
  const safe = isNaN(x.getTime()) ? startOfDay(new Date()) : x;
  return `${safe.getFullYear()}-${pad2(safe.getMonth() + 1)}-${pad2(safe.getDate())}`;
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
  "オンライン講座・説明会": [
    { label: "告知文・申込ページを準備", daysBefore: 21 },
    { label: "募集ページ公開・SNS告知", daysBefore: 18 },
    { label: "参加者へリマインド①", daysBefore: 7 },
    { label: "Zoom/配信URLを参加者へ送付", daysBefore: 3 },
    { label: "スライド・資料の最終確認", daysBefore: 2 },
    { label: "参加者へ前日リマインド", daysBefore: 1 },
  ],
  "サロン・施術イベント": [
    { label: "予約枠を開放・告知", daysBefore: 14 },
    { label: "SNS/LINEで集客告知", daysBefore: 10 },
    { label: "材料・備品の在庫確認・発注", daysBefore: 7 },
    { label: "参加者リスト・当日の流れを確認", daysBefore: 3 },
    { label: "施術スペース・機材の準備", daysBefore: 1 },
  ],
  "出張施術": [
    { label: "訪問先との日程・場所を確定", daysBefore: 14 },
    { label: "材料・備品・道具のリストアップ", daysBefore: 7 },
    { label: "交通・駐車場の確認", daysBefore: 3 },
    { label: "持ち物パッキング・前日確認", daysBefore: 1 },
  ],
  "ハンドメイド出店": [
    { label: "材料の発注", daysBefore: 30 },
    { label: "制作開始", daysBefore: 21 },
    { label: "作品の検品・価格付け", daysBefore: 10 },
    { label: "梱包・ラッピング準備", daysBefore: 5 },
    { label: "Instagram/SNS告知", daysBefore: 3 },
    { label: "搬入物・当日設営の準備確認", daysBefore: 1 },
  ],
  "ハンドメイド新作リリース": [
    { label: "材料の発注", daysBefore: 30 },
    { label: "試作・制作", daysBefore: 21 },
    { label: "撮影・写真の準備", daysBefore: 10 },
    { label: "商品説明文・価格の設定", daysBefore: 5 },
    { label: "Instagram/SNS告知投稿", daysBefore: 3 },
    { label: "販売ページの最終確認", daysBefore: 1 },
  ],
  "撮影・収録": [
    { label: "香盤・台本・構成を確定", daysBefore: 14 },
    { label: "機材・小道具のリストアップ", daysBefore: 7 },
    { label: "ロケハン・撮影場所の確認", daysBefore: 5 },
    { label: "衣装・メイクの準備", daysBefore: 3 },
    { label: "機材充電・SDカード確認", daysBefore: 1 },
  ],
  // ── 会社経営・社長向けテンプレ ──
  "役員会・経営会議": [
    { label: "議題・アジェンダの確定", daysBefore: 7 },
    { label: "資料・数値データの準備", daysBefore: 5 },
    { label: "各役員・参加者へ事前送付", daysBefore: 3 },
    { label: "会場・Zoom URLを確認・共有", daysBefore: 2 },
    { label: "議事録担当・進行手順を確認", daysBefore: 1 },
  ],
  "決算・資金繰り確認": [
    { label: "試算表・残高確認（税理士と共有）", daysBefore: 14 },
    { label: "入出金予定の洗い出し", daysBefore: 10 },
    { label: "借入・融資ラインの確認", daysBefore: 7 },
    { label: "次月の資金繰り計画を作成", daysBefore: 3 },
    { label: "経営幹部への共有・説明", daysBefore: 1 },
  ],
  "採用面接": [
    { label: "求人票・採用条件の最終確認", daysBefore: 10 },
    { label: "候補者の書類・職歴を確認", daysBefore: 5 },
    { label: "面接官・会場・日程を確定・連絡", daysBefore: 3 },
    { label: "評価シートを準備", daysBefore: 2 },
    { label: "当日の進行・質問リストを確認", daysBefore: 1 },
  ],
  "会食・接待": [
    { label: "相手の好み・アレルギーを確認", daysBefore: 7 },
    { label: "店の予約・個室確認", daysBefore: 5 },
    { label: "手土産・用意物を手配", daysBefore: 3 },
    { label: "当日の議題・話す内容を整理", daysBefore: 2 },
    { label: "ドレスコード・交通を確認", daysBefore: 1 },
  ],
  "視察・出張（社長）": [
    { label: "視察先アポ・アジェンダ確認", daysBefore: 14 },
    { label: "交通・宿泊を手配", daysBefore: 10 },
    { label: "必要な資料・名刺・手土産を準備", daysBefore: 5 },
    { label: "秘書・担当者への引き継ぎ確認", daysBefore: 3 },
    { label: "スケジュール・連絡先を最終確認", daysBefore: 1 },
  ],
  "周年・表彰式典": [
    { label: "式次第・プログラムを確定", daysBefore: 30 },
    { label: "招待状・案内を発送", daysBefore: 21 },
    { label: "表彰状・記念品を手配", daysBefore: 14 },
    { label: "会場・ケータリングを確認", daysBefore: 7 },
    { label: "スタッフ役割分担・リハーサル", daysBefore: 2 },
    { label: "当日の進行表を最終確認", daysBefore: 1 },
  ],
};

/* 二段ローンチ等の「逆算テンプレ」。基準日(offset 0)からの相対日数で締切群を自動生成 */
const LAUNCH_TEMPLATES = {
  二段ローンチ標準: {
    anchorLabel: "本申込 開始日",
    steps: [
      { title: "予告・教育コンテンツ開始", stage: "予告", offset: -28 },
      { title: "LINE先行登録 開始", stage: "先行登録", offset: -21 },
      { title: "先行登録 中間リマインド", stage: "先行登録", offset: -10 },
      { title: "先行登録 締切", stage: "先行登録", offset: -1 },
      { title: "本申込 開始", stage: "本申込", offset: 0 },
      { title: "締切リマインド送信", stage: "本申込", offset: 4 },
      { title: "本申込 締切", stage: "本申込", offset: 7 },
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

// 型の表示名（内部キーは英語混じりの用語を避けて初心者にも分かる日本語に）
const LAUNCH_TEMPLATE_LABELS = {
  二段ローンチ標準: "先行登録あり（2段階）",
  セミナー集客: "セミナー集客",
  単発ローンチ: "先行登録なし（直販）",
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
  // 会社経営・社長向けルール（AUTO_RULES に追加）
  { kw: /役員会|経営会議|取締役会|株主総会/, tpl: "役員会・経営会議" },
  { kw: /決算|資金繰り|月次|試算表/, tpl: "決算・資金繰り確認" },
  { kw: /採用面接|面接|選考/, tpl: "採用面接" },
  { kw: /会食|接待|接客|懇親会/, tpl: "会食・接待" },
  { kw: /周年|表彰|式典/, tpl: "周年・表彰式典" },
  { kw: /視察|出張.*社長|社長.*出張/, tpl: "視察・出張（社長）" },
  { kw: /撮影|収録|ロケ|撮り/, tpl: "撮影・収録" },
  { kw: /出店|マルシェ|クラフト|ハンドメイド|ハンドメード|手作り/, tpl: "ハンドメイド出店" },
  { kw: /新作リリース|新作公開|作品リリース/, tpl: "ハンドメイド新作リリース" },
  { kw: /出張施術|訪問施術|出張セッション|訪問セッション/, tpl: "出張施術" },
  { kw: /施術|サロン|トリートメント/, tpl: "サロン・施術イベント" },
  { kw: /オンライン講座|説明会|オンラインセミナー|体験会|講座|レッスン/, tpl: "オンライン講座・説明会" },
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
   年中行事データ＋日付算出
   ────────────────────────────────────────────────────────────── */

// 指定年の「第N曜日」の日付(Date)を返す
// month: 1-12, weekday: 0=日..6=土, nth: 第nth
function nthWeekday(year, month, weekday, nth) {
  const first = new Date(year, month - 1, 1);
  const diff = (weekday - first.getDay() + 7) % 7;
  const day = 1 + diff + (nth - 1) * 7;
  return new Date(year, month - 1, day);
}

// 今日以降の「次回該当日」を返す（過ぎていれば翌年）
function nextAnnualDate(computeFn) {
  const today = startOfDay(new Date());
  const y = today.getFullYear();
  let d = computeFn(y);
  if (startOfDay(d) < today) d = computeFn(y + 1);
  return iso(d);
}

// 固定月日の次回日付
function fixedDate(month, day) {
  return nextAnnualDate((y) => new Date(y, month - 1, day));
}
// 第N曜日の次回日付
function nthWeekdayDate(month, weekday, nth) {
  return nextAnnualDate((y) => nthWeekday(y, month, weekday, nth));
}

// プリセット年中行事一覧
// id: 一意キー, name: 表示名, emoji, getDate: ()=>ISO, template: 逆算チェーン型
const ANNUAL_EVENTS = [
  { id: "mothers_day",   name: "母の日",   emoji: "🌸", getDate: () => nthWeekdayDate(5, 0, 2),  template: "誕生日・記念日" },
  { id: "fathers_day",   name: "父の日",   emoji: "👔", getDate: () => nthWeekdayDate(6, 0, 3),  template: "誕生日・記念日" },
  { id: "keiro_day",     name: "敬老の日", emoji: "🎎", getDate: () => nthWeekdayDate(9, 1, 3),  template: "誕生日・記念日" },
  { id: "valentine",     name: "バレンタイン", emoji: "🍫", getDate: () => fixedDate(2, 14), template: "誕生日・記念日" },
  { id: "white_day",     name: "ホワイトデー", emoji: "🍬", getDate: () => fixedDate(3, 14), template: "誕生日・記念日" },
  { id: "ochugen",       name: "お中元",   emoji: "🎁", getDate: () => fixedDate(7, 1),  template: "誕生日・記念日" },
  { id: "oseibo",        name: "お歳暮",   emoji: "🎁", getDate: () => fixedDate(12, 1), template: "誕生日・記念日" },
  { id: "christmas",     name: "クリスマス", emoji: "🎄", getDate: () => fixedDate(12, 25), template: "誕生日・記念日" },
  { id: "omisoka",       name: "大晦日",   emoji: "🎍", getDate: () => fixedDate(12, 31), template: "誕生日・記念日" },
];

// デフォルトでONにする行事ID
const ANNUAL_DEFAULT_ON = new Set(["mothers_day", "fathers_day", "keiro_day", "valentine", "christmas"]);

// 有効な行事を「あと何日」付きで返す（45日以内のみ。disabledを除外）
function getUpcomingAnnualEvents(settings) {
  const s = settings || {};
  return ANNUAL_EVENTS
    .filter((ev) => {
      // settingsに明示されていなければデフォルト値を使う
      const on = ev.id in s ? s[ev.id] : ANNUAL_DEFAULT_ON.has(ev.id);
      return on;
    })
    .map((ev) => ({ ...ev, dateISO: ev.getDate(), days: daysUntil(ev.getDate()) }))
    .filter((ev) => ev.days >= 0 && ev.days <= 45)
    .sort((a, b) => a.days - b.days);
}

// ユーザー登録の記念日を「あと何日」付きで返す（45日以内のみ）
// anniversaries: [{ id, name, month, day, emoji }]
function getUpcomingUserAnniversaries(anniversaries) {
  return (anniversaries || [])
    .map((a) => {
      const dateISO = fixedDate(a.month, a.day);
      const days = daysUntil(dateISO);
      return { ...a, dateISO, days };
    })
    .filter((a) => a.days >= 0 && a.days <= 45)
    .sort((a, b) => a.days - b.days);
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
    members: [],
    hiddenTabs: { news: true }, // ニュースタブは既定で非表示（ホームの1行ブリーフィングから開ける）
    fortune: null,
    manualEvents: [], // スクショ取り込み(TimeTree等)の予定
    sampleNotice: true, // サンプルデータ識別フラグ
    profile: null,      // オンボーディングで収集するプロフィール（未設定=null）
    anniversaries: [],  // ユーザー登録の記念日 [{ id, name, month, day, emoji? }]
    annivSettings: {},  // 年中行事のオン/オフ { [eventId]: true|false }
    momVoice: true,     // お母さんの声かけ（褒める・心配・休息ケア）オン/オフ。未設定はオン扱い。
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

/* 用語の「?」ヘルプ（タップで説明を中央オーバーレイ表示。画面端でも見切れない） */
function Help({ text }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ display: "inline-flex" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="説明"
        style={{ width: 30, height: 30, borderRadius: "50%", border: `1px solid ${C.sub}`, background: C.panel2, color: C.text, fontSize: 17, fontWeight: 700, cursor: "pointer", lineHeight: 1, display: "grid", placeItems: "center", flex: "0 0 auto" }}
      >?</button>
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(0,0,0,0.4)", display: "grid", placeItems: "center", padding: 24 }}
        >
          <div
            onClick={(ev) => ev.stopPropagation()}
            style={{ width: 360, maxWidth: "86vw", maxHeight: "70vh", overflowY: "auto", background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: "18px 18px 14px", fontSize: 15, color: C.text, lineHeight: 1.75, boxShadow: "0 12px 40px rgba(0,0,0,0.4)" }}
          >
            <div style={{ whiteSpace: "pre-wrap" }}>{text}</div>
            <button onClick={() => setOpen(false)} style={{ ...chipBtn, marginTop: 14, width: "100%", justifyContent: "center", background: C.invBg, color: C.invText, borderColor: C.invBg, fontWeight: 700 }}>閉じる</button>
          </div>
        </div>
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
   年中行事・記念日パネル
   設定（オン/オフ）＋大切な人の記念日管理＋近日通知＋逆算導線
   ────────────────────────────────────────────────────────────── */
function AnniversaryPanel({ annivSettings, anniversaries, onUpdateSettings, onUpdateAnniversaries, onAddTrip }) {
  const [showSettings, setShowSettings] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [form, setForm] = useState({ name: "", month: "", day: "", emoji: "" });

  const settings = annivSettings || {};
  const annivs = anniversaries || [];

  const toggleEvent = (id) => {
    const cur = id in settings ? settings[id] : ANNUAL_DEFAULT_ON.has(id);
    onUpdateSettings({ ...settings, [id]: !cur });
  };
  const isOn = (id) => (id in settings ? settings[id] : ANNUAL_DEFAULT_ON.has(id));

  const addAnniversary = () => {
    const m = Number(form.month), d = Number(form.day);
    if (!form.name.trim() || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return;
    const next = [...annivs, { id: "av" + Date.now(), name: form.name.trim(), month: m, day: d, emoji: form.emoji.trim() || "🎂" }];
    onUpdateAnniversaries(next);
    setForm({ name: "", month: "", day: "", emoji: "" });
    setShowAddForm(false);
  };
  const removeAnniversary = (id) => {
    const item = annivs.find((a) => a.id === id);
    if (window.confirm(`「${item ? item.name : "この記念日"}」を削除しますか？`)) {
      onUpdateAnniversaries(annivs.filter((a) => a.id !== id));
    }
  };

  // 近日の年中行事（45日以内）
  const upcomingAnnual = getUpcomingAnnualEvents(settings);
  // 近日のユーザー登録記念日（45日以内）
  const upcomingUser = getUpcomingUserAnniversaries(annivs);

  const makeChain = (name, dateISO, template) => {
    onAddTrip({ title: name + "の準備", template, date: dateISO });
  };

  return (
    <Panel
      title="年中行事・記念日"
      accent={FAMILY_COLOR}
      help="母の日・父の日・バレンタインなど大切な人への行事を45日前から教えてくれます。「準備の段取りをつくる」を押すと逆算チェーンを自動生成します。大切な人の誕生日や記念日も登録できます。"
      right={
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => setShowAddForm((v) => !v)} style={chipBtn}>＋記念日を追加</button>
          <button onClick={() => setShowSettings((v) => !v)} style={{ ...iconBtn, fontSize: 15, color: showSettings ? FAMILY_COLOR : C.sub }} title="どの行事を気にするか設定">⚙</button>
        </div>
      }
    >
      {/* 記念日追加フォーム */}
      {showAddForm && (
        <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: C.sub, marginBottom: 8 }}>大切な人の誕生日や記念日を登録します（毎年通知）。</div>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="名前（例：お母さんの誕生日）" style={inp} />
          <div style={{ display: "flex", gap: 8 }}>
            <input value={form.month} onChange={(e) => setForm({ ...form, month: e.target.value })} placeholder="月" inputMode="numeric" style={{ ...inp, width: 72, flex: "0 0 auto" }} />
            <span style={{ fontSize: 14, color: C.sub, lineHeight: "38px" }}>月</span>
            <input value={form.day} onChange={(e) => setForm({ ...form, day: e.target.value })} placeholder="日" inputMode="numeric" style={{ ...inp, width: 72, flex: "0 0 auto" }} />
            <span style={{ fontSize: 14, color: C.sub, lineHeight: "38px" }}>日</span>
            <input value={form.emoji} onChange={(e) => setForm({ ...form, emoji: e.target.value })} placeholder="絵文字（任意）" style={{ ...inp, width: 90, flex: "0 0 auto" }} />
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
            <button onClick={addAnniversary} style={{ ...chipBtn, background: FAMILY_COLOR, color: "#fff", borderColor: FAMILY_COLOR }}>追加</button>
            <button onClick={() => setShowAddForm(false)} style={chipBtn}>閉じる</button>
          </div>
        </div>
      )}

      {/* 年中行事のオン/オフ設定 */}
      {showSettings && (
        <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 12, padding: "10px 12px", marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 8 }}>気にする年中行事を選ぶ</div>
          <div style={{ display: "grid", gap: 4 }}>
            {ANNUAL_EVENTS.map((ev) => (
              <label key={ev.id} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", padding: "4px 0" }}>
                <input
                  type="checkbox"
                  checked={isOn(ev.id)}
                  onChange={() => toggleEvent(ev.id)}
                  style={{ width: 17, height: 17, flex: "0 0 auto", accentColor: FAMILY_COLOR }}
                />
                <span style={{ fontSize: 14 }}>{ev.emoji} {ev.name}</span>
              </label>
            ))}
          </div>
          <button onClick={() => setShowSettings(false)} style={{ ...chipBtn, marginTop: 8, fontSize: 12 }}>閉じる</button>
        </div>
      )}

      {/* 近日の年中行事 */}
      {upcomingAnnual.length === 0 && upcomingUser.length === 0 && annivs.length === 0 && (
        <div style={{ fontSize: 13, color: C.faint, padding: "8px 0" }}>
          45日以内に近づく行事はありません。右上の設定で気にする行事を増やせます。
        </div>
      )}
      <div style={{ display: "grid", gap: 10 }}>
        {[...upcomingAnnual, ...upcomingUser].map((ev) => {
          const isUrgent = ev.days <= 14;
          const dotColor = ev.days <= 7 ? C.red : ev.days <= 14 ? C.orange : FAMILY_COLOR;
          return (
            <div key={ev.id} style={{ background: C.panel2, borderRadius: 12, padding: "10px 14px", borderLeft: `3px solid ${dotColor}` }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <span style={{ fontSize: 20, flex: "0 0 auto", marginTop: 1 }}>{ev.emoji || "🎂"}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{ev.name}</div>
                  <div style={{ fontSize: 12, color: dotColor, fontWeight: 700, marginTop: 2 }}>
                    {ev.days === 0 ? "今日！" : `あと ${ev.days} 日`}
                    <span style={{ color: C.sub, fontWeight: 400, marginLeft: 6 }}>（{fmt(ev.dateISO)}）</span>
                  </div>
                  {isUrgent && ev.days > 0 && (
                    <div style={{ fontSize: 12, color: C.sub, marginTop: 3, lineHeight: 1.4 }}>
                      そろそろ準備を始めると安心です。
                    </div>
                  )}
                </div>
                {ev.days > 0 && (
                  <button
                    onClick={() => makeChain(ev.name, ev.dateISO, ev.template || "誕生日・記念日")}
                    style={{ ...chipBtn, fontSize: 12, padding: "6px 10px", minHeight: 34, background: FAMILY_COLOR + "18", borderColor: FAMILY_COLOR, color: FAMILY_COLOR, flex: "0 0 auto" }}
                    title="準備の逆算チェーンを仕事タブに作成"
                  >段取りをつくる</button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* 登録済み記念日一覧（近日以外のものも表示） */}
      {annivs.length > 0 && (
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${C.line}` }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.sub, marginBottom: 8 }}>登録した記念日</div>
          <div style={{ display: "grid", gap: 6 }}>
            {annivs.map((a) => {
              const dateISO = fixedDate(a.month, a.day);
              const days = daysUntil(dateISO);
              return (
                <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderTop: `1px solid ${C.line}` }}>
                  <span style={{ fontSize: 16, flex: "0 0 auto" }}>{a.emoji || "🎂"}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 14 }}>{a.name}</span>
                    <span style={{ fontSize: 12, color: C.sub, marginLeft: 8 }}>{a.month}/{a.day}</span>
                    <span style={{ fontSize: 12, color: days <= 14 ? C.orange : C.faint, marginLeft: 8 }}>
                      {days === 0 ? "今日！" : days > 0 ? `あと${days}日` : "今年は終了"}
                    </span>
                  </div>
                  <button onClick={() => removeAnniversary(a.id)} style={iconBtn} title="削除">✕</button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Panel>
  );
}

/* ──────────────────────────────────────────────────────────────
   逆算チェーン（出張・遠征）
   ────────────────────────────────────────────────────────────── */
// 私的・お祝い系の型（仕事の「営業・追い込み」文言ではなく、温かい文言を出す）
const CELEBRATION_TEMPLATES = new Set(["誕生日・記念日", "入学式・式典", "旅行", "日帰り"]);

// 本番日のコンディション(占術)から、逆算チェーン全体への一言ガイドを作る（決定論・AI不使用）
// template に応じて、仕事系は「営業・追い込み」、私的・お祝い系は楽しむ前提の文言に出し分ける。
function tripStanceHint(rel, dleft, template) {
  if (!rel) return null;
  const s = rel.stance;
  if (CELEBRATION_TEMPLATES.has(template)) {
    if (s === "攻め") return { color: C.green, text: "当日は運気も後押し。主役らしく、思いきり楽しめる日。" };
    if (s === "守り") return { color: C.blue, text: "当日はゆったりが吉。準備は早めに済ませ、当日は楽しむことに集中して。" };
    if (s === "労い") return { color: C.blue, text: "人に恵まれ、支えられる日。みんなで囲むのにぴったり。" };
    return { color: C.accent, text: "穏やかに過ごせる日。段取り通り、落ち着いて楽しめます。" };
  }
  if (s === "攻め") return { color: C.green, text: dleft < 0 ? "本番は攻めの日。仕上げ・追い込みが伸びる流れ。" : "本番は攻めの日。当日に営業・追い込みを置くと伸びやすい。" };
  if (s === "守り") return { color: C.red, text: "本番は守りの日。準備は前倒しで、当日は欲張らず守りの段取りに。" };
  if (s === "労い") return { color: C.blue, text: "本番は労いの日。人や場に支えられる。受け取る姿勢で臨もう。" };
  return { color: C.accent, text: "本番は整える日。淡々と予定通りに進めるのが吉。" };
}

function TripChain({ trips, birth, onToggle, onAdd, onRemove, onEditTrip, onAddItem, onEditItem, onRemoveItem, usage }) {
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
    <Panel title="予定の準備リスト（逆算）" accent={C.green} help="本番日から逆算して、各準備の締切と信号（🟢=済 🟠=もうすぐ 🔴=遅れ）を自動表示します。出張・旅行・打ち合わせ・入学式・誕生日など、前もって準備が要る予定に対応。Googleカレンダーに『出張・旅行・式典・誕生日』などを含む予定があれば、3ヶ月先まで自動で逆算チェーン（🤖自動）を作ります。「型から追加」で手動追加も可能。" right={<AddTrip onAdd={onAdd} usage={usage} />}>
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
                <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <strong style={{ fontSize: 14 }}>{trip.title}</strong>
                    {trip.auto && <span title="カレンダーの「出張」予定から自動作成" style={{ fontSize: 12, fontWeight: 700, color: C.green, background: C.greenSoft || C.panel2, border: `1px solid ${C.green}`, borderRadius: 8, padding: "1px 6px" }}>🤖自動</span>}
                    <span style={{ fontSize: 12, color: C.sub, border: `1px solid ${C.line}`, borderRadius: 8, padding: "1px 6px" }}>{trip.template}</span>
                  </div>
                  <div style={{ display: "flex", gap: 2, flex: "0 0 auto" }}>
                    <button onClick={() => startTrip(trip)} style={iconBtn} title="編集">✏️</button>
                    <button onClick={() => onRemove(trip.id)} style={iconBtn} title="削除">✕</button>
                  </div>
                </div>
              )}
              <div style={{ fontSize: 12, color: dleft < 0 ? C.red : C.accent, margin: "4px 0 8px" }}>
                {dleft < 0 ? `本番から${-dleft}日経過` : `本番まであと ${dleft}日`} ・ 本番 {fmt(trip.date)} ・ 手配 {doneCount}/{trip.items.length}
              </div>
              {(() => {
                const hint = tripStanceHint(stances[trip.date], dleft, trip.template);
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
                        <span style={{ fontSize: 12, color: C.sub }}>日前</span>
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
                          <button onClick={() => startItem(trip.id, idx, item)} style={iconBtn} title="編集">✏️</button>
                          <button onClick={() => onRemoveItem(trip.id, idx)} style={iconBtn} title="削除">✕</button>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 2 }}>
                          {!item.done && <span style={{ fontSize: 12, color: C.sub }}>締切 {fmt(sig.deadlineISO)}</span>}
                          <span style={{ fontSize: 12, color: sig.color, fontWeight: 600 }}>{sig.dot} {sig.label}</span>
                        </div>
                        {!item.done && stances[sig.deadlineISO] && stances[sig.deadlineISO].stance === "守り" && (
                          <div style={{ fontSize: 12, color: CELEBRATION_TEMPLATES.has(trip.template) ? C.sub : C.red, marginTop: 2 }}>
                            🧭 {CELEBRATION_TEMPLATES.has(trip.template) ? "早めに準備しておくと当日ゆとりが持てます" : "締切が守りの日。1日前倒すと楽です"}
                          </div>
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
                  <span style={{ fontSize: 12, color: C.sub }}>日前</span>
                  <button onClick={() => { if (!ni.label.trim()) return; onAddItem(trip.id, { label: ni.label.trim(), daysBefore: Number(ni.daysBefore) || 0 }); setNi({ label: "", daysBefore: 7 }); setAddItemFor(null); }} style={chipBtn}>追加</button>
                  <button onClick={() => setAddItemFor(null)} style={iconBtn} title="閉じる">✕</button>
                </div>
              ) : (
                <button onClick={() => setAddItemFor(trip.id)} style={{ ...chipBtn, marginTop: 8, fontSize: 12 }}>＋手配項目を追加</button>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function AddTrip({ onAdd, usage }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [template, setTemplate] = useState("遠方登壇");
  const [date, setDate] = useState(iso(addDays(new Date(), 14)));
  // usage=split のとき私的・お祝い系テンプレ(CELEBRATION_TEMPLATES)を除外して仕事テンプレのみ表示
  const templateKeys = usage === "split"
    ? Object.keys(TEMPLATES).filter((t) => !CELEBRATION_TEMPLATES.has(t))
    : Object.keys(TEMPLATES);
  if (!open) return <button onClick={() => setOpen(true)} style={chipBtn}>＋型から追加</button>;
  return (
    <div style={{ position: "absolute", right: 18, marginTop: 36, zIndex: 5, background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, width: 240 }}>
      <input placeholder="タイトル（例：大阪登壇／会食）" value={title} onChange={(e) => setTitle(e.target.value)} style={inp} />
      <select value={template} onChange={(e) => setTemplate(e.target.value)} style={inp}>
        {templateKeys.map((t) => <option key={t}>{t}</option>)}
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
            <span style={{ fontSize: 12, color: C.accent, fontWeight: 700 }}>{labels[k] || k}</span>
            <span style={{ flex: 1 }} />
            <button onClick={() => copy(drafts[k])} style={{ ...chipBtn, fontSize: 12, padding: "3px 10px" }}>{copied === drafts[k].slice(0, 10) ? "コピー済✓" : "コピー"}</button>
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

function DeadlineBoard({ deadlines, linked, launches, birth, onAdd, onAddBulk, onEdit, onRemove }) {
  // 手動の締切＋売上タブのローンチ締切(linked)を時系列に統合表示
  const sorted = [...(deadlines || []), ...(linked || [])].sort((a, b) => new Date(a.date) - new Date(b.date));
  // ローンチKPIを告知文の材料に注入：linked締切(id=lk:ローンチID:段階)から該当ローンチを引く
  const launchById = {};
  for (const L of launches || []) launchById[L.id] = L;
  const draftContext = (d) => {
    const base = `${d.stage ? d.stage + "：" : ""}「${d.title}」（${fmt(d.date)}）の告知`;
    const lid = String(d.id).startsWith("lk:") ? String(d.id).split(":")[1] : null;
    const L = lid ? launchById[lid] : null;
    if (!L) return base;
    const parts = [];
    if (L.name) parts.push(`商品名：${L.name}`);
    if (Number(L.price)) parts.push(`客単価：¥${Number(L.price).toLocaleString("ja-JP")}`);
    if (Number(L.goalReg)) parts.push(`先行登録 目標${L.goalReg}人（現在${Number(L.reg) || 0}人）`);
    if (Number(L.goalCv)) parts.push(`本申込 目標${L.goalCv}人（現在${Number(L.cv) || 0}人）`);
    const diff = Math.ceil((new Date(d.date) - new Date()) / 86400000);
    if (Number.isFinite(diff)) parts.push(`この締切まであと${diff}日`);
    return parts.length ? `${base}。次の情報を踏まえ、行動を促す具体的な告知にしてください：${parts.join(" / ")}` : base;
  };
  // 各締切日の「気」をまとめて計算（命式計算は1回だけ・出生情報がある時のみ）
  const stances = useMemo(
    () => (birth && birth.date ? stancesFor(birth, sorted.map((d) => d.date)) : {}),
    [birth && birth.date, birth && birth.time, sorted.map((d) => d.date).join(",")]
  );
  const [mode, setMode] = useState(null); // null | "single" | "template"
  const [q, setQ] = useState("");          // 締切の絞り込みキーワード
  const [near, setNear] = useState(false); // 間近(14日以内)・遅れのみ表示
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
            {Object.keys(LAUNCH_TEMPLATES).map((t) => <option key={t} value={t}>{LAUNCH_TEMPLATE_LABELS[t] || t}</option>)}
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
      {sorted.length >= 4 && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
          <input value={q} onChange={(ev) => setQ(ev.target.value)} placeholder="🔍 締切を検索（名前・段階）" style={{ ...inp, marginBottom: 0, flex: "1 1 160px" }} />
          <button onClick={() => setNear((v) => !v)} title="14日以内・遅れだけ表示" style={{ ...chipBtn, background: near ? C.accent : "transparent", color: near ? C.invText : C.sub, borderColor: near ? C.accent : C.line }}>{near ? "✓ 間近のみ" : "間近のみ"}</button>
        </div>
      )}
      {(() => {
        const qq = q.trim().toLowerCase();
        const view = sorted.filter((d) => {
          if (qq && !(`${d.title} ${d.stage || ""}`.toLowerCase().includes(qq))) return false;
          if (near) { const diff = Math.ceil((new Date(d.date) - new Date()) / 86400000); if (diff > 14) return false; }
          return true;
        });
        return (<>
      {sorted.length === 0 ? <Empty>締切は登録されていません。右上から追加できます。</Empty>
        : view.length === 0 ? <Empty>条件に合う締切はありません。</Empty> : null}
      <div style={{ display: "grid", gap: 10 }}>
        {view.map((d, i) => {
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
              <div style={{ display: "flex", alignItems: "flex-start", gap: 10, background: C.panel2, borderRadius: 12, padding: "12px 14px", borderLeft: d.linked ? `3px solid ${C.accent}` : undefined }}>
                <span style={{ width: 28, height: 28, borderRadius: "50%", background: C.panel, border: `1px solid ${C.line}`, display: "grid", placeItems: "center", fontSize: 13, color: C.sub, flex: "0 0 auto", marginTop: 1 }}>
                  {i + 1}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, lineHeight: 1.35 }}>{d.linked ? "📣 " : ""}{d.title}</div>
                  <div style={{ fontSize: 12, color: C.sub, marginTop: 2 }}><span style={{ color: sig.color, fontWeight: 600 }}>{sig.dot} {sig.label}</span> ・ {d.stage} ・ {fmt(d.date)}{d.linked ? " ・ 売上タブのローンチ" : ""}</div>
                  {(() => { const h = deadlineStanceHint(stances[d.date]); return h ? <div style={{ fontSize: 12, color: h.color, marginTop: 2 }}>🧭 {h.text}</div> : null; })()}
                </div>
                <div style={{ display: "flex", gap: 2, flex: "0 0 auto" }}>
                  <button onClick={() => setDraftId(draftId === d.id ? null : d.id)} style={iconBtn} title="告知文を作る">✍️</button>
                  {!d.linked && <button onClick={() => startEdit(d)} style={iconBtn} title="編集">✏️</button>}
                  {!d.linked && <button onClick={() => onRemove(d.id)} style={iconBtn} title="削除">✕</button>}
                </div>
              </div>
              {draftId === d.id && <DraftPanel context={draftContext(d)} />}
            </div>
          );
        })}
      </div>
        </>);
      })()}
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
    <Panel title="今週の時間配分メーター" accent={C.accent} help="今週の時間を役割（施術/制作/集客/経営）別に表示します。さらに『労働＝自分が動く時間』と『仕組み＝後から自動で売れる資産になる時間』の2軸で、仕組みづくりに時間を回せているかを％で見ます。役割は自動判定ですが、各予定の区分ボタンで修正でき（同名は記憶）、カレンダー単位の既定区分も『設定・取り込み』で決められます。『労働/仕組み』も各予定の隣のボタンで切り替えられます（例：受託の制作は労働、自主コンテンツは仕組み）。" right={<span style={{ fontSize: 13, color: C.sub }}>計 {r1(total)}h</span>}>
      <CalStatusNote source={source} status={status} error={error} count={count} onConnect={onConnect} connecting={connecting} onRefresh={onRefresh} refreshing={refreshing} />
      {total === 0 ? (
        <Empty>{source === "calendar" ? "今週の時間指定の予定が見つかりませんでした。" : "データがありません。"}</Empty>
      ) : (
        <>
          <div style={{ display: "grid", gap: 12 }}>
            {cats.filter((c) => byCat[c] > 0).map((cat) => (
              <div key={cat}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                  <span style={{ color: CAT[cat] || C.faint }}>● {labelOf(cat)}</span>
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
const CAT_CYCLE = ["施術", "制作", "集客", "経営", "その他", "自動"];
const AXIS_CYCLE = ["労働", "仕組み", "自動"]; // 労働⟷仕組みの手動切替（"自動"で解除）

// 予定1件の行（今日の予定／日別ビュー共通）
function ScheduleRow({ e, source, onSetCat, onSetAxis, writableIds, onEditEvent, onDeleteEvent, busy }) {
  const isFamily = e.role === "family";
  const canCat = source === "calendar" && !!onSetCat && !isFamily;
  const canAxis = source === "calendar" && !!onSetAxis && !isFamily;
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
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, lineHeight: 1.35, color: isFamily ? C.sub : C.text }}>{e.title}</div>
        <div style={{ marginTop: 4, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {canCat ? (
            <button
              onClick={() => onSetCat(e.title, CAT_CYCLE[(CAT_CYCLE.indexOf(e.cat) + 1) % CAT_CYCLE.length])}
              title={e.catSource === "manual" ? "記憶済み（タップで変更・一周すると自動に戻ります）" : e.catSource === "cal" ? "カレンダーの既定区分（タップでこの予定だけ変更）" : "自動判定（タップで記憶できます）"}
              style={{ fontSize: 12, fontWeight: e.catSource === "manual" ? 700 : 400, color: e.catSource === "manual" ? "#0B0D11" : catColor(e.cat), background: e.catSource === "manual" ? catColor(e.cat) : "transparent", border: `1px solid ${e.catSource === "manual" ? catColor(e.cat) : C.line}`, borderRadius: 6, padding: "2px 8px", cursor: "pointer" }}
            >{labelOf(e.cat)}{e.catSource === "manual" ? " ✓" : " ⇄"}</button>
          ) : (
            <span style={{ fontSize: 12, color: catColor(e.cat) }}>{labelOf(e.cat)}</span>
          )}
          {canAxis && (() => {
            const axColor = e.axis === "仕組み" ? C.green : C.orange;
            const manual = e.axisSource === "manual";
            return (
              <button
                onClick={() => onSetAxis(e.title, AXIS_CYCLE[(AXIS_CYCLE.indexOf(e.axis) + 1) % AXIS_CYCLE.length])}
                title={manual ? "記憶済み（タップで変更・一周すると自動に戻ります）" : "自動判定（タップで「労働/仕組み」を記憶できます）"}
                style={{ fontSize: 12, fontWeight: manual ? 700 : 400, color: manual ? "#0B0D11" : axColor, background: manual ? axColor : "transparent", border: `1px solid ${manual ? axColor : C.line}`, borderRadius: 6, padding: "2px 8px", cursor: "pointer" }}
              >{e.axis === "仕組み" ? "仕組み" : "労働"}{manual ? " ✓" : " ⇄"}</button>
            );
          })()}
        </div>
      </div>
      {editable && (
        <div style={{ display: "flex", gap: 2, flex: "0 0 auto" }}>
          <button onClick={startEdit} style={iconBtn} title="時間・内容を編集">✏️</button>
          <button onClick={() => onDeleteEvent(e.calendarId, e.id)} style={iconBtn} title="Googleカレンダーから削除">✕</button>
        </div>
      )}
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
        <button onClick={onReconnect} style={{ ...chipBtn, marginTop: 8, background: C.invBg, color: C.invText, borderColor: C.invBg, fontWeight: 700 }}>
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
      {hint && <div aria-hidden="true" style={{ fontSize: 12, color: C.sub, marginTop: 8, textAlign: "center" }}>{hint}</div>}
    </>
  );
}

function Schedule({ days, source, status, error, count, onConnect, connecting, onSetCat, onSetAxis, onRefresh, refreshing, writableIds, onEditEvent, onDeleteEvent, editBusy }) {
  const list = days || [];
  const slides = list.map((day) => ({
    key: day.key,
    label: `${day.label}（${day.date.getMonth() + 1}/${day.date.getDate()} ${WD[day.date.getDay()]}）`,
    content: day.items.length === 0
      ? <Empty>予定はありません。</Empty>
      : <div style={{ display: "grid", gap: 10 }}>{day.items.map((e, i) => <ScheduleRow key={e.id || i} e={e} source={source} onSetCat={onSetCat} onSetAxis={onSetAxis} writableIds={writableIds} onEditEvent={onEditEvent} onDeleteEvent={onDeleteEvent} busy={editBusy} />)}</div>,
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
    <Panel title="今後の予定（先2ヶ月）" accent={FAMILY_COLOR} help="出張・登壇・ライブ・イベント等の重要予定と、家族・プライベートの予定（別色）を先まで表示します。✏️で時間変更・✕で削除（Googleカレンダーに反映）。">
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
          <button onClick={startEdit} style={iconBtn} title="時間・内容を編集">✏️</button>
          <button onClick={() => onDeleteEvent(e.calendarId, e.id)} style={iconBtn} title="Googleカレンダーから削除">✕</button>
        </>
      ) : (
        <span style={{ fontSize: 12, color: catColor(e.cat), fontWeight: 700, flex: "0 0 auto" }}>{e.role === "family" ? "家族" : labelOf(e.cat)}</span>
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
      <div style={{ fontSize: 12, color: C.sub, marginBottom: 12 }}>カテゴリを選んで「更新」で反映されます（取りすぎると見づらいので3〜5個が目安）。</div>

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
                    <div style={{ fontSize: 12, color: C.sub }}>{it.source}{it.date ? ` ・ ${fmtNews(it.date)}` : ""}</div>
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
        <button onClick={() => setOpen((o) => !o)} style={{ ...chipBtn, fontSize: 12 }}>{open ? "情報源を閉じる" : "情報源を編集"}</button>
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
            <div style={{ fontSize: 12, color: C.sub }}>RSS＝ニュースの自動受信先のこと。例：ブログ等のRSS、Googleニュース検索のRSS。記事は見出し＋出典リンクのみ表示します。</div>
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

/* ──────────────────────────────────────────────────────────────
   初回ヒアリング ウィザード（OnboardingWizard）
   profile未設定かつsampleNotice状態のとき表示。「あとで」で全スキップ可。
   保存先: data.profile = { occupation, scale, usage, uranaiLevel, done:true }
   ────────────────────────────────────────────────────────────── */
const ONBOARD_OCCUPATIONS = [
  { id: "salon",     label: "施術家・サロン",    emoji: "💆" },
  { id: "coach",     label: "コーチ・コンサル",  emoji: "🎯" },
  { id: "school",    label: "講師・スクール",    emoji: "📚" },
  { id: "creator",   label: "クリエイター",      emoji: "🎨" },
  { id: "shop",      label: "物販・ショップ",    emoji: "🛒" },
  { id: "uranai",    label: "占い師・鑑定士",    emoji: "🔮" },
  { id: "president", label: "会社経営・社長",    emoji: "🏢" },
  { id: "other",     label: "その他",            emoji: "✨" },
];
const ONBOARD_SCALES = [
  { id: "solo",    label: "ひとりで回している",    emoji: "🙋" },
  { id: "team",    label: "小チーム（スタッフ数人）", emoji: "👥" },
  { id: "company", label: "組織・会社として動いている", emoji: "🏢" },
];
const ONBOARD_USAGES = [
  { id: "work",         label: "仕事だけ管理したい",      emoji: "💼" },
  { id: "work_private", label: "仕事もプライベートも",    emoji: "🌐" },
  { id: "split",        label: "仕事とプライベートを分けたい", emoji: "↔️" },
];
const ONBOARD_URANAI = [
  { id: "high", label: "占いが大好き・ガッツリ使いたい", emoji: "⭐" },
  { id: "mid",  label: "ほどほどに参考にしたい",         emoji: "🌙" },
  { id: "low",  label: "データ・論理派・占いは控えめで",  emoji: "📊" },
];

function OnboardingWizard({ onSave, onSkip }) {
  const [step, setStep] = useState(0); // 0=生年月日, 1=職種, 2=規模, 3=用途, 4=運気濃さ
  const [birth, setBirth] = useState("");
  const [occupation, setOccupation] = useState(null);
  const [scale, setScale] = useState(null);
  const [usage, setUsage] = useState(null);
  const [uranaiLevel, setUranaiLevel] = useState(null);

  const finish = (uranai) => {
    const profile = {
      occupation: occupation || "other",
      scale: scale || "solo",
      usage: usage || "work",
      uranaiLevel: uranai || uranaiLevel || "mid",
      done: true,
    };
    const catPreset = CAT_PRESETS.find((p) => p.id === (occupation || "other"));
    onSave({ profile, birth: birth || null, catLabels: catPreset ? catPreset.labels : {} });
  };

  const BigBtn = ({ emoji, label, active, onClick }) => (
    <button
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 10,
        width: "100%", padding: "13px 14px", marginBottom: 8, borderRadius: 12,
        border: `2px solid ${active ? C.accent : C.line}`,
        background: active ? C.accent + "22" : C.panel2,
        color: C.text, fontSize: 15, fontWeight: active ? 700 : 400,
        cursor: "pointer", textAlign: "left", font: "inherit",
      }}
    >
      <span style={{ fontSize: 22, flex: "0 0 auto" }}>{emoji}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {active && <span style={{ color: C.accent, fontSize: 18 }}>✓</span>}
    </button>
  );

  const StepIndicator = () => (
    <div style={{ display: "flex", gap: 6, justifyContent: "center", marginBottom: 18 }}>
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} style={{ width: i === step ? 24 : 8, height: 8, borderRadius: 4, background: i === step ? C.accent : i < step ? C.green : C.line, transition: "width 0.2s" }} />
      ))}
    </div>
  );

  return (
    <div style={{ background: C.panel, border: `2px solid ${C.accent}`, borderRadius: 16, padding: "20px 18px", marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, color: C.accent, fontWeight: 700, letterSpacing: 0.5 }}>
            {occupation === "president" ? "社長の段取り秘書 セットアップ" : "ひとり秘書 セットアップ"}
          </div>
          <div style={{ fontSize: 17, fontWeight: 700, marginTop: 2 }}>
            {step === 0 && "生年月日を教えてください"}
            {step === 1 && "あなたのお仕事は？"}
            {step === 2 && (occupation === "president" ? "組織の規模は？" : "チームの規模は？")}
            {step === 3 && (occupation === "president" ? "何を管理・段取りしたいですか？" : "何を管理したいですか？")}
            {step === 4 && "運気の濃さを選んでください"}
          </div>
        </div>
        <button onClick={onSkip} style={{ ...iconBtn, fontSize: 12, width: "auto", padding: "4px 10px", border: `1px solid ${C.line}`, borderRadius: 8, color: C.sub }}>あとで</button>
      </div>
      <StepIndicator />

      {step === 0 && (
        <>
          <div style={{ fontSize: 13, color: C.sub, marginBottom: 10, lineHeight: 1.6 }}>
            入れると「今日のコンディション」と経営カレンダーが使えます。任意でOK。
          </div>
          <input type="date" value={birth} onChange={(e) => setBirth(e.target.value)} style={{ ...inp, marginBottom: 12 }} />
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => setStep(1)}
              style={{ flex: 1, height: 44, borderRadius: 10, border: "none", background: C.accent, color: "#0B0D11", fontWeight: 700, fontSize: 15, cursor: "pointer" }}
            >
              {birth ? "次へ" : "スキップして次へ"}
            </button>
          </div>
        </>
      )}

      {step === 1 && (
        <>
          {ONBOARD_OCCUPATIONS.map((o) => (
            <BigBtn key={o.id} emoji={o.emoji} label={o.label} active={occupation === o.id}
              onClick={() => { setOccupation(o.id); setTimeout(() => setStep(2), 150); }} />
          ))}
        </>
      )}

      {step === 2 && (
        <>
          {ONBOARD_SCALES.map((s) => (
            <BigBtn key={s.id} emoji={s.emoji} label={s.label} active={scale === s.id}
              onClick={() => { setScale(s.id); setTimeout(() => setStep(3), 150); }} />
          ))}
        </>
      )}

      {step === 3 && (
        <>
          {ONBOARD_USAGES.map((u) => (
            <BigBtn key={u.id} emoji={u.emoji} label={u.label} active={usage === u.id}
              onClick={() => { setUsage(u.id); setTimeout(() => setStep(4), 150); }} />
          ))}
        </>
      )}

      {step === 4 && (
        <>
          {ONBOARD_URANAI.map((u) => (
            <BigBtn key={u.id} emoji={u.emoji} label={u.label} active={uranaiLevel === u.id}
              onClick={() => { setUranaiLevel(u.id); setTimeout(() => finish(u.id), 200); }} />
          ))}
          <button
            onClick={() => finish("mid")}
            style={{ width: "100%", padding: "10px 0", borderRadius: 10, border: `1px solid ${C.line}`, background: "transparent", color: C.sub, fontSize: 14, cursor: "pointer", marginTop: 4 }}
          >スキップして完了</button>
        </>
      )}
    </div>
  );
}

/* 業種プロンプト（catLabels 未設定の初回のみ表示。1タップで区分名を切替） */
function IndustryPrompt({ onSelect, onDismiss }) {
  return (
    <div style={{ background: C.panel, border: `2px solid ${C.blue}`, borderRadius: 14, padding: "14px 16px", marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 20, flex: "0 0 auto" }}>💼</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.blue }}>あなたの業種は？</div>
          <div style={{ fontSize: 12, color: C.sub, lineHeight: 1.5, marginTop: 2 }}>選ぶと「施術/制作/集客/経営」の区分名がぴったりの言葉に変わります（後で変更できます）。</div>
        </div>
        <button onClick={onDismiss} style={iconBtn} title="閉じる">✕</button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {CAT_PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => onSelect(p)}
            style={{ ...chipBtn, background: C.blue, color: "#fff", borderColor: C.blue, fontWeight: 700 }}
          >{p.name}</button>
        ))}
      </div>
    </div>
  );
}

/* 生年月日クイック入力バナー（出生情報未登録時のみ表示。日付だけ入れると即・今日の運気が出る導線） */
function BirthQuickInput({ onSave, onDismiss, occupation }) {
  const [date, setDate] = useState("");
  const [done, setDone] = useState(false);
  const [saved, setSaved] = useState(false);
  const todayKoyomiQ = (() => {
    try { return typeof koyomi === 'function' ? koyomi(iso(new Date())) : null; }
    catch { return null; }
  })();
  const save = () => {
    if (!date) return;
    const p = [35.69, 139.69]; // 東京デフォルト
    onSave({ date, time: "12:00", place: "東京", lat: p[0], lon: p[1], utcOffset: 9, gender: "" });
    setSaved(true);
    // 保存後に SanmeiFlow（今日の動き）へ自動スクロール（タブ切り替えのレンダリング待ち）
    setTimeout(() => {
      try {
        const el = document.getElementById("sanmei-flow");
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch { /* スクロール失敗は無視 */ }
    }, 800);
    setDone(true);
  };
  if (done) return null;
  return (
    <div style={{ background: C.panel, border: `2px solid ${C.purple}`, borderRadius: 14, padding: "14px 16px", marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 20, flex: "0 0 auto" }}>🔮</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.purple }}>
            {occupation === "president" ? "生年月日を入れると「意思決定の日のコンディション」が出ます" : "生年月日を入れると「今日の動き」が出ます"}
          </div>
          <div style={{ fontSize: 12, color: C.sub, lineHeight: 1.5, marginTop: 2 }}>
            {occupation === "president" ? "日付だけでOK。攻め・守り・労いの日を経営カレンダーで確認できます。" : "日付だけでOK。入れた瞬間に今日のコンディションが反映されます。"}
          </div>
        </div>
        {onDismiss && (
          <button onClick={onDismiss} style={iconBtn} title="閉じる">✕</button>
        )}
      </div>
      {todayKoyomiQ && todayKoyomiQ.labels && todayKoyomiQ.labels.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
          {todayKoyomiQ.labels.map((l) => (
            <span key={l.key} style={{ fontSize: 12, fontWeight: 700, color: "#0B0D11", background: C.accent, borderRadius: 999, padding: "2px 10px" }}>
              {l.emoji}今日は{l.name}
            </span>
          ))}
          <span style={{ fontSize: 12, color: C.sub }}>生年月日を入れてあなたの運気と合わせて確認を</span>
        </div>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ ...inp, marginBottom: 0, flex: "1 1 160px" }} />
        <button onClick={save} disabled={!date} style={{ ...chipBtn, background: date ? C.purple : "transparent", color: date ? "#fff" : C.sub, borderColor: date ? C.purple : C.line, fontWeight: 700, flex: "0 0 auto" }}>
          {occupation === "president" ? "経営カレンダーを見る" : "今日の運気を見る"}
        </button>
      </div>
      {saved && (
        <div style={{ fontSize: 13, color: C.purple, fontWeight: 700, marginTop: 8 }}>
          下に「今日の動き」が出ました
        </div>
      )}
      <div style={{ fontSize: 12, color: C.faint, marginTop: 6 }}>保存すると、このページの下に「今日の動き（算命学）」が表示されます。出生地・時刻は「運気タブ &gt; 出生情報の編集」で後から詳しく入れられます。</div>
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
  const [gender, setGender] = useState(b.gender || "");
  const save = () => {
    const p = PREFS.find((x) => x[0] === pref) || PREFS.find((x) => x[0] === "東京");
    if (!date) { alert("生年月日を入れてください"); return; }
    onSave({ name: name.trim(), date, time: time || "12:00", place: pref, lat: p[1], lon: p[2], utcOffset: 9, gender });
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
      <label style={{ fontSize: 12, color: C.sub, display: "block", marginBottom: 2 }}>性別（大運＝運勢の流れの算出に使用）</label>
      <select value={gender} onChange={(e) => setGender(e.target.value)} style={inp}>
        <option value="">未設定</option>
        <option value="male">男性</option>
        <option value="female">女性</option>
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
        <button onClick={() => ref.current && ref.current.click()} disabled={importing} style={{ ...chipBtn, background: importing ? "transparent" : C.invBg, color: importing ? C.sub : C.invText, borderColor: importing ? C.line : C.invBg, fontWeight: 700 }}>
          {importing ? "読み取り中…" : "📷 スクショから取り込む"}
        </button>
        {count > 0 && <button onClick={onClear} style={chipBtn}>取り込み{count}件を消去</button>}
      </div>
      {msg && <div style={{ fontSize: 12, color: C.sub, marginTop: 8, wordBreak: "break-word" }}>{msg}</div>}
      <div style={{ fontSize: 12, color: C.sub, marginTop: 8 }}>※「週」や「リスト」表示のスクショが精度◎。複数回取り込めます。</div>
    </Panel>
  );
}

// プロフィール(occupation)ごとの「攻め/守り/整える/労い」の一手コピー
const PROFILE_ADVICE = {
  president: {
    攻め: (outstanding, next, tip) => outstanding > 0
      ? `攻めどき。未回収¥${outstanding.toLocaleString("ja-JP")}を動かして、キャッシュを手元に。${tip}`
      : next ? `攻めどき。「${next.time} ${next.title}」で意思決定・商談を前に進めましょう。${tip}`
      : `攻めどき。今日は契約・投資・採用など大事な決断を前に進める日です。${tip}`,
    守り: (late, soon) => late + soon > 0
      ? `守りの日。まず${late ? `遅れ${late}件` : ""}${late && soon ? "・" : ""}${soon ? `もうすぐ${soon}件` : ""}の抜け漏れを確認。組織の足場を固めましょう。`
      : "守りの日。新規の大きな判断より、既存の数字・契約・チームの点検を。",
    労い: () => "労いの日。幹部・メンバーへの感謝と承認を。今日のキーマンは人です。",
    整える: () => "整える日。会議・資料・数字の整理を淡々と。今日は仕込みの日です。",
  },
};

/* ──────────────────────────────────────────────────────────────
   お母さんレイヤー：褒める・心配・休息ケアのメッセージを既存データから決定論で算出
   ────────────────────────────────────────────────────────────── */

/**
 * computeMomMessages(data, alerts, todayEvents, energy)
 * 既存のデータだけを見て「声かけメッセージ」を返す（AI/サーバー不要）。
 *
 * 返り値: { praise: string|null, worries: Array<{text:string, tab:string|null}>, restCare: string|null, restCareTab: string|null, guide: string|null }
 *   praise       … 褒め・労いの一言（1件）。空状態では出さない
 *   worries      … 能動的な確認つっこみ（最大2件）。遷移先タブ(tab)付き
 *   restCare     … 休息ケアの一言（1件）
 *   restCareTab  … restCareのタップ遷移先タブ（null=遷移なし）
 *   guide        … 空状態のガイド一言（praise と排他。空のときだけ出る）
 */
function computeMomMessages(data, alerts, todayEvents, energy) {
  if (!data) return { praise: null, worries: [], restCare: null, restCareTab: null, guide: null };

  const late = (alerts && alerts.late) || [];
  const soon = (alerts && alerts.soon) || [];
  const totalAlerts = late.length + soon.length;
  const h = new Date().getHours();
  // 時間帯3区分: 朝(〜10:59) / 昼(11〜15:59) / 夕夜(16〜)
  const isMorning = h < 11;
  const isNoon = h >= 11 && h < 16;
  const isEvening = h >= 16;
  const isNight = h >= 22 || h < 5;

  // ── 空状態判定：データが実質ゼロかどうか ──
  // sampleNotice=true またはすべてのデータ配列が空のとき「空状態」と見なす。
  // 空状態では「やり切った」系の褒めは出さない（実績が無いのに褒めるのは的外れ）。
  const isEmpty = data.sampleNotice || (
    (data.trips || []).length === 0 &&
    (data.deadlines || []).length === 0 &&
    (data.tasks || []).length === 0 &&
    (data.launches || []).length === 0 &&
    (data.money || []).length === 0
  );

  // ── 1. 褒め・労い ──
  let praise = null;
  let guide = null;

  if (isEmpty) {
    // 空状態 → 初回ガイド一言のみ、褒めなし
    guide = "まずは逆算か締め切りをひとつ入れてみてね。";
  } else {
    // 今日の要対応が 0 件 → いちばん温かく（時間帯3区分）
    const pendingTasks = (data.tasks || []).filter((x) => !x.done).length;
    if (totalAlerts === 0 && pendingTasks === 0) {
      if (isNight) {
        praise = "今日もお疲れ様。夜はゆっくり休んでね。";
      } else if (isEvening) {
        praise = "今日の仕事、全部やり切ってる。えらい。今夜はゆっくりしてね。";
      } else if (isNoon) {
        praise = "ここまで全部終わってる、えらい！午後もいいペースで行こ。";
      } else {
        // 朝
        praise = "今日の準備、バッチリだね。いいスタートだよ。";
      }
    }

    // 逆算チェーン(trip)が全完了している → 「準備ぜんぶ完了」
    if (!praise) {
      const completedTrips = (data.trips || []).filter((t) => {
        const items = t.items || [];
        return items.length > 0 && items.every((it) => it.done);
      });
      if (completedTrips.length > 0) {
        const t = completedTrips[0];
        praise = `「${t.title}」の準備、ぜんぶ完了！えらい。`;
      }
    }

    // ローンチKPIが目標到達（reg>=goalReg または cv>=goalCv）
    if (!praise) {
      for (const L of (data.launches || [])) {
        const reg = Number(L.reg) || 0, goalReg = Number(L.goalReg) || 0;
        const cv = Number(L.cv) || 0, goalCv = Number(L.goalCv) || 0;
        if ((goalReg > 0 && reg >= goalReg) || (goalCv > 0 && cv >= goalCv)) {
          praise = `「${L.name}」、目標達成おめでとう！よく走り切ったね。`;
          break;
        }
      }
    }

    // 夕夜でまだ褒めていない場合 → 時間帯に合った一般的な労い
    if (!praise && isEvening) {
      praise = isNight ? "今日もおつかれさま。もう休んでいいよ。" : "今日もおつかれさま。無理しすぎてない？";
    }

    // 朝・昼の一般労い（対応件数があっても前向きな一言）
    if (!praise && isMorning) {
      praise = "おはよう。今日も一緒に乗り越えようね。";
    }
    if (!praise && isNoon) {
      praise = "お昼だよ。少し休んで、午後も頑張ろ。";
    }
  }

  // ── 2. 確認つっこみ（能動的な心配）── worries は { text, tab } オブジェクトの配列
  const worries = [];

  // 逆算項目に「遅れ・間近」で未着手が続くもの（最大 2 件）→ 仕事タブへ
  for (const t of (data.trips || [])) {
    if (worries.length >= 2) break;
    const pendingLate = (t.items || []).filter((it) => {
      if (it.done) return false;
      const dl = iso(addDays(new Date(t.date), -(it.daysBefore || 0)));
      const diff = daysUntil(dl);
      return diff < 0 || diff <= 3;
    });
    if (pendingLate.length > 0) {
      const item = pendingLate[0];
      worries.push({ text: `「${t.title}」の${item.label}、まだみたいだけど大丈夫？そろそろ動こ。`, tab: "work" });
    }
  }

  // 未処理請求が残っている → 売上タブへ
  if (worries.length < 2) {
    const outstanding = (data.money || [])
      .filter((x) => !x.done && x.kind === "入金")
      .reduce((s, x) => s + (Number(x.amount) || 0), 0);
    if (outstanding > 0) {
      worries.push({ text: `入金の確認、した？ ¥${outstanding.toLocaleString("ja-JP")}がまだだよ。`, tab: "money" });
    }
  }

  // ── 3. 休息ケア ──
  let restCare = null;
  let restCareTab = null;

  // 今日の予定件数が多い（5件以上）
  const todayCount = (todayEvents || []).length;
  if (todayCount >= 5) {
    restCare = `今日は予定が${todayCount}件も詰まってるね。無理しないで、ひとつ減らせない？`;
    restCareTab = null; // カレンダーはホーム内なので遷移なし
  }

  // 運気が「労い」または「守り」の日 → 運気タブへ
  if (!restCare && energy && (energy.today && (energy.today.stance === "労い" || energy.today.stance === "守り"))) {
    if (energy.today.stance === "労い") {
      restCare = "今日は充電の日。頑張りすぎないでね。";
    } else {
      restCare = "今日は守りの日。新しいことより、足場を固める日にしてね。";
    }
    restCareTab = "fortune";
  }

  return { praise, worries, restCare, restCareTab, guide };
}

/* お母さんの声かけカード */
function MomVoiceCard({ praise, worries, restCare, restCareTab, guide, onTab }) {
  const hasAny = praise || guide || worries.length > 0 || restCare;
  if (!hasAny) return null;

  const MOM_COLOR = "#C77B9C"; // FAMILYカラーと同系統の温かみのある色

  // 遷移先ラベルマップ
  const TAB_LABELS = { work: "仕事を見る", money: "売上を見る", fortune: "運気を見る" };

  return (
    <div style={{
      background: MOM_COLOR + "0F",
      border: `1px solid ${MOM_COLOR}44`,
      borderRadius: 14,
      padding: "14px 16px",
      marginBottom: 14,
    }}>
      <div style={{ fontSize: 12, color: MOM_COLOR, fontWeight: 700, letterSpacing: 0.5, marginBottom: 10 }}>
        お母さんからひとこと
      </div>
      {/* 褒め・労い（タップなし） */}
      {praise && (
        <div style={{ fontSize: 16, color: THEMES[THEME_NAME].text, lineHeight: 1.7, marginBottom: worries.length > 0 || restCare ? 10 : 0 }}>
          {praise}
        </div>
      )}
      {/* 空状態ガイド（タップなし） */}
      {guide && (
        <div style={{ fontSize: 16, color: THEMES[THEME_NAME].sub, lineHeight: 1.7, marginBottom: worries.length > 0 || restCare ? 10 : 0 }}>
          {guide}
        </div>
      )}
      {/* 確認つっこみ（遷移先があればタップ可能） */}
      {worries.length > 0 && (
        <div style={{ marginBottom: restCare ? 10 : 0 }}>
          {worries.map((w, i) => {
            const hasLink = w.tab && onTab;
            return (
              <div
                key={i}
                onClick={hasLink ? () => onTab(w.tab) : undefined}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 6,
                  lineHeight: 1.6,
                  marginBottom: i < worries.length - 1 ? 6 : 0,
                  cursor: hasLink ? "pointer" : "default",
                  borderRadius: 8,
                  padding: "4px 0",
                }}
              >
                <span style={{ flex: "0 0 auto", fontSize: 15, marginTop: 2, color: MOM_COLOR }}>...</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 16, color: THEMES[THEME_NAME].sub }}>{w.text}</div>
                  {hasLink && (
                    <div style={{ fontSize: 12, color: MOM_COLOR, marginTop: 2, fontWeight: 600 }}>
                      → {TAB_LABELS[w.tab] || w.tab}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {/* 休息ケア（運気系はタップ可能） */}
      {restCare && (
        <div
          onClick={restCareTab && onTab ? () => onTab(restCareTab) : undefined}
          style={{
            fontSize: 16,
            color: MOM_COLOR,
            lineHeight: 1.6,
            fontStyle: "italic",
            cursor: restCareTab && onTab ? "pointer" : "default",
            borderRadius: 8,
            padding: "4px 0",
          }}
        >
          {restCare}
          {restCareTab && onTab && (
            <div style={{ fontSize: 12, fontStyle: "normal", fontWeight: 600, marginTop: 2 }}>
              → {TAB_LABELS[restCareTab] || restCareTab}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// 今朝のまとめ（運気・予定・要対応・売上・ニュースを1枚に束ねる）
function BriefingCard({ fortune, birth, today, late, soon, outstanding, brief, onTab, remaining, pendingTasks, hideFortune, hideNews, profile, annivSettings, anniversaries }) {
  const [more, setMore] = useState(false); // 副次情報（運気/売上/ニュース）の折りたたみ
  // 占術コンディションは決定論(dayEnergy)で常に算出 → AIが無くても「今日のスタンス」が出る。
  // AIの鑑定文(fortune.today)は付加情報として併用する。
  const energy = useMemo(() => {
    try { return birth && birth.date ? dayEnergy(birth, iso(new Date())) : null; }
    catch { return null; }
  }, [birth && birth.date, birth && birth.time]);
  // 今日の開運日（koyomiが未定義でも落ちない）
  const todayKoyomiHome = useMemo(() => {
    try { return typeof koyomi === 'function' ? koyomi(iso(new Date())) : null; }
    catch { return null; }
  }, []);
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
    const occ = profile && profile.occupation;
    const pAdv = occ && PROFILE_ADVICE[occ];
    if (s === "攻め") {
      const tip = sm && sm.attack ? ` ${sm.emoji}${sm.attack}` : "";
      if (pAdv && pAdv.攻め) return pAdv.攻め(outstanding, next, tip);
      if (outstanding > 0) return `攻めどき。未処理の¥${outstanding.toLocaleString("ja-JP")}を回収して、売上を取りにいきましょう。${tip}`;
      if (next) return `攻めどき。まず「${next.time} ${next.title}」に集中を。${tip}`;
      return `攻めどき。発信・営業を今日の前半に寄せましょう。${tip}`;
    }
    if (s === "守り") {
      if (pAdv && pAdv.守り) return pAdv.守り(late, soon);
      if (late + soon > 0) return `守りの日。まず${late ? `遅れ${late}件` : ""}${late && soon ? "・" : ""}${soon ? `もうすぐ${soon}件` : ""}の抜け漏れを片付けて、足場を固めましょう。`;
      return "守りの日。新規を広げるより、既存の見直しと準備の整理を。";
    }
    if (s === "労い") {
      if (pAdv && pAdv.労い) return pAdv.労い();
      return "労いの日。詰め込みすぎず、休む時間も今日の予定に入れましょう。";
    }
    if (pAdv && pAdv.整える) return pAdv.整える();
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
      <div style={{ fontSize: 13, color: C.accent, fontWeight: 700 }}>
        {(profile && profile.occupation === "president")
          ? `☀️ ${greet}・今日の段取りと意思決定まとめ`
          : `☀️ ${greet}・今朝のまとめ`}
      </div>
      {/* 今日の残り件数 KPI */}
      <button onClick={() => onTab("work")} style={{ width: "100%", textAlign: "left", background: "transparent", border: "none", cursor: "pointer", color: C.text, font: "inherit", padding: "10px 0 4px" }}>
        {rem === 0 ? (
          <div style={{ fontSize: 15, fontWeight: 700, color: C.green }}>今日の要対応はありません ✨</div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ fontSize: 13, color: C.sub }}>要対応</span>
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
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
          <span style={{ flex: "0 0 auto", fontSize: 12, fontWeight: 700, color: "#0B0D11", background: mode.color, borderRadius: 999, padding: "2px 10px" }}>今日は{mode.label}</span>
          {todayKoyomiHome && todayKoyomiHome.labels && todayKoyomiHome.labels.length > 0 && todayKoyomiHome.labels.map((l) => (
            <span key={l.key} style={{ flex: "0 0 auto", fontSize: 12, fontWeight: 700, color: "#0B0D11", background: todayKoyomiHome.best ? C.green : C.accent, borderRadius: 999, padding: "2px 10px" }}>
              {l.emoji}今日は{l.name}
            </span>
          ))}
          {mode.tip && <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: C.sub, lineHeight: 1.4 }}>{mode.tip}</span>}
        </div>
      )}
      {/* 出生情報未登録時：開運日だけは出す（birth不要） */}
      {!birth && todayKoyomiHome && todayKoyomiHome.labels && todayKoyomiHome.labels.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
          {todayKoyomiHome.labels.map((l) => (
            <span key={l.key} style={{ fontSize: 12, fontWeight: 700, color: "#0B0D11", background: C.accent, borderRadius: 999, padding: "2px 10px" }}>
              {l.emoji}今日は{l.name}
            </span>
          ))}
        </div>
      )}
      {advice && (
        <button onClick={() => onTab("fortune")} style={{ display: "flex", gap: 8, alignItems: "flex-start", width: "100%", textAlign: "left", background: C.panel2, border: "none", borderRadius: 10, padding: "9px 11px", margin: "2px 0 8px", cursor: "pointer", color: C.text, font: "inherit" }}>
          <span style={{ flex: "0 0 auto", fontSize: 15 }}>🧭</span>
          <span style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.5 }}><b style={{ color: mode.color }}>今日の一手</b>　{advice}</span>
        </button>
      )}
      {/* 近日の年中行事・記念日（45日以内）：控えめに1〜2件だけ表示 */}
      {(() => {
        const allUpcoming = [
          ...getUpcomingAnnualEvents(annivSettings),
          ...getUpcomingUserAnniversaries(anniversaries),
        ].sort((a, b) => a.days - b.days).slice(0, 2);
        if (!allUpcoming.length) return null;
        return (
          <div style={{ background: FAMILY_COLOR + "14", border: `1px solid ${FAMILY_COLOR}44`, borderRadius: 10, padding: "8px 11px", margin: "4px 0 6px" }}>
            {allUpcoming.map((ev) => (
              <div key={ev.id} style={{ display: "flex", alignItems: "center", gap: 7, padding: "2px 0", fontSize: 13, color: C.text }}>
                <span style={{ flex: "0 0 auto" }}>{ev.emoji || "🎂"}</span>
                <span style={{ flex: 1, minWidth: 0, lineHeight: 1.4 }}>
                  <b style={{ color: FAMILY_COLOR }}>{ev.name}</b>
                  <span style={{ color: C.sub, marginLeft: 6 }}>
                    {ev.days === 0 ? "今日！" : `あと${ev.days}日`}（{fmt(ev.dateISO)}）
                  </span>
                </span>
              </div>
            ))}
            <div style={{ fontSize: 11, color: C.faint, marginTop: 4 }}>ホームの「年中行事・記念日」パネルで準備の段取りを確認できます。</div>
          </div>
        );
      })()}
      {/* 主要：今日の予定は常に表示（要対応の内訳は直下の「今日の要対応」パネルに集約して重複を回避） */}
      <Row icon="📅" label={(today || []).length ? `今日の予定 ${today.length}件${next ? `／次 ${next.time} ${next.title}` : ""}` : "今日の予定はありません"} onClick={() => onTab("home")} />
      {/* 副次：運気・攻めの日・未処理・ニュースは折りたたみ（情報過多の防止） */}
      {more && (
        <>
          {!hideFortune && weekAttack.length > 0 && (
            <Row icon="🟢" color={C.green} label={`今週の攻めの日 ${weekAttack.map((d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`).join("・")}（発信・営業を寄せて）`} onClick={() => onTab("fortune")} />
          )}
          {!hideFortune && <Row icon="🔮" label={`運気 ${sc ? "★".repeat(sc) : "—"}`} onClick={() => onTab("fortune")} />}
          {outstanding > 0 && <Row icon="💰" label={`未処理 ¥${outstanding.toLocaleString("ja-JP")}`} onClick={() => onTab("money")} />}
          {brief && <Row icon="📰" label={brief.replace(/^[・\-*\s]+/, "")} onClick={() => onTab("news")} />}
        </>
      )}
      {(!hideFortune || outstanding > 0 || brief) && (
        <button onClick={() => setMore((m) => !m)} style={{ width: "100%", textAlign: "center", background: "transparent", border: "none", borderTop: `1px solid ${C.line}`, padding: "9px 0 2px", cursor: "pointer", color: C.sub, font: "inherit", fontSize: 13 }}>
          {more ? "閉じる ▲" : "他の情報も見る ▼"}
        </button>
      )}
    </section>
  );
}

/* 経営カレンダー：その月の各日の「気」を決定論(占術)で色分けし、
   仕事タブの予定（本番日・締切・ローンチ締切）を重ねて「攻めの日に寄っているか」を可視化。
   → 発信・ローンチを攻めの日に寄せ、守りの日に重なった締切は前後へずらす提案を出す。 */
const STANCE_UI = dyn(() => { const t = THEMES[THEME_NAME]; return {
  攻め: { color: t.green, mark: "攻", tip: "発信・営業・ローンチ向き" },
  労い: { color: t.blue, mark: "労", tip: "人に支えられる・受け取る日" },
  整える: { color: t.accent, mark: "整", tip: "淡々と整える日" },
  守り: { color: t.red, mark: "守", tip: "守りを固める・背伸びしない" },
}; });
function BizCalendar({ birth, trips, deadlines, launches, events, onPlan, profile }) {
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
  // 開運日（一粒万倍日・天赦日・己巳の日・巳の日・寅の日）をkoyomiMonthで取得
  const koyomiData = useMemo(() => {
    try { return typeof koyomiMonth === 'function' ? koyomiMonth(yy, mm + 1) : {}; }
    catch { return {}; }
  }, [yy, mm]);
  const marks = useMemo(() => {
    const m = {};
    const add = (d, label) => { if (!d) return; const k = String(d).slice(0, 10); (m[k] = m[k] || []).push(label); };
    for (const t of trips || []) add(t.date, t.title);
    for (const d of deadlines || []) add(d.date, d.title);
    for (const L of launches || []) { add(L.deadlineReg, `${L.name} 先行締切`); add(L.deadlineCv, `${L.name} 本申込締切`); }
    for (const e of events || []) add(e.date, e.title); // 同期(Googleカレンダー)・取り込み予定
    return m;
  }, [trips, deadlines, launches, events]);

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
          <div key={w} style={{ textAlign: "center", fontSize: 12, color: i === 0 ? C.red : i === 6 ? C.blue : C.sub }}>{w}</div>
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
          const koyomiLabels = koyomiData[k] || [];
          const hasKoyomi = koyomiLabels.length > 0;
          // 攻め×開運日＝ダブルで良い日
          const isDouble = ui && st.stance === "攻め" && hasKoyomi;
          const koyomiTip = koyomiLabels.map((l) => l.emoji + l.name).join("・");
          return (
            <button key={k} onClick={() => setSel(isSel ? null : k)}
              title={`${mm + 1}/${d}${ui ? ` ・ ${st.stance}（${ui.tip}）` : ""}${hasKoyomi ? ` ・ ${koyomiTip}` : ""}${hasMark ? ` ・ ${marks[k].join(" / ")}` : ""}`}
              style={{ position: "relative", aspectRatio: "1 / 1", borderRadius: 8, background: isDouble ? C.green + "44" : ui ? ui.color + (isSel ? "44" : "22") : C.panel2, border: isSel ? `2px solid ${C.purple}` : isDouble ? `2px solid ${C.green}` : isToday ? `2px solid ${C.accent}` : `1px solid ${C.line}`, display: "grid", placeItems: "center", cursor: "pointer", padding: 0, font: "inherit" }}>
              <span style={{ display: "flex", flexDirection: "column", alignItems: "center", lineHeight: 1.05 }}>
                <span style={{ fontSize: 12, fontWeight: isToday ? 700 : 500, color: ui ? ui.color : C.sub }}>{d}</span>
                {ui && <span style={{ fontSize: 12, fontWeight: 700, color: isDouble ? C.green : ui.color }}>{ui.mark}</span>}
                {hasKoyomi && <span style={{ fontSize: 10, lineHeight: 1 }}>{koyomiLabels[0].emoji}</span>}
              </span>
              {hasMark && <span style={{ position: "absolute", bottom: 3, left: "50%", transform: "translateX(-50%)", width: 5, height: 5, borderRadius: "50%", background: C.purple }} />}
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
            {(() => {
              const kl = koyomiData[sel] || [];
              if (!kl.length) return null;
              const isDoubleDay = st && st.stance === "攻め";
              return (
                <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {kl.map((l) => (
                    <span key={l.key} style={{ fontSize: 12, fontWeight: 700, color: "#0B0D11", background: isDoubleDay ? C.green : C.accent, borderRadius: 999, padding: "1px 9px" }}>
                      {l.emoji}{l.name}
                    </span>
                  ))}
                  {isDoubleDay && <span style={{ fontSize: 12, color: C.green, fontWeight: 700 }}>
                    {(profile && profile.occupation === "president")
                      ? "攻め×開運日 — 契約・投資・人事など大事な決断はこの日に"
                      : "攻め×開運日 ダブルで良い日！"}
                  </span>}
                </div>
              );
            })()}
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
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 10, fontSize: 12, color: C.sub }}>
        {Object.entries(STANCE_UI).map(([k, v]) => (
          <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 16, height: 16, borderRadius: 4, background: v.color + "33", border: `1px solid ${v.color}`, color: v.color, fontSize: 12, fontWeight: 700, display: "grid", placeItems: "center" }}>{v.mark}</span>{k}
          </span>
        ))}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><span style={{ width: 5, height: 5, borderRadius: "50%", background: C.purple }} />予定あり</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>✨開運日（タップで詳細）</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><span style={{ fontSize: 12, color: C.green }}>■</span>攻め×開運日</span>
      </div>
      {/* 今月の開運日一覧 */}
      {(() => {
        const koyomiDays = Object.entries(koyomiData).sort(([a], [b]) => a.localeCompare(b));
        if (!koyomiDays.length) return null;
        return (
          <div style={{ background: C.panel2, borderRadius: 10, padding: "10px 12px", marginTop: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.accent, marginBottom: 6 }}>✨ 今月の開運日</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {koyomiDays.map(([dateKey, labels]) => (
                <span key={dateKey} style={{ fontSize: 12, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: "2px 8px" }}>
                  {Number(dateKey.slice(5, 7))}/{Number(dateKey.slice(8, 10))} {labels.map((l) => l.emoji + l.name).join("・")}
                </span>
              ))}
            </div>
          </div>
        );
      })()}
      {/* 狙い目（攻めの日） */}
      {attackDays.length > 0 && (
        <div style={{ background: C.panel2, borderRadius: 10, padding: "10px 12px", marginTop: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.green, marginBottom: 4 }}>🟢 {isCurrent ? "この先の" : "今月の"}狙い目（攻めの日）</div>
          <div style={{ fontSize: 13, color: C.text, lineHeight: 1.6 }}>{attackDays.map((d) => `${mm + 1}/${d}`).join("・")}</div>
          <div style={{ fontSize: 12, color: C.sub, marginTop: 4 }}>
            {(profile && profile.occupation === "president")
              ? `契約・投資・採用・重要な意思決定はこの日に寄せると流れに乗れます。${sm && sm.attack ? `${sm.emoji}あなたは${sm.star}。${sm.attack}` : ""}`
              : `発信・営業・新講座の販売開始日をここに寄せると伸びやすい流れです。${sm && sm.attack ? `${sm.emoji}あなたは${sm.star}。${sm.attack}` : ""}`}
          </div>
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

/* ──────────────────────────────────────────────────────────────
   大事な決断の良い日取り（Top3）
   bestDays(birth, fromISO, {horizonDays, count}) を使い、攻めの日×開運日を上位3件表示。
   birth未設定または bestDays未定義のときは何も出さない（optional防御済み）。
   ────────────────────────────────────────────────────────────── */
function BestDaysPanel({ birth, occupation, onPlan }) {
  const [days, setDays] = useState(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (!birth || !birth.date) { setDays([]); return; }
    try {
      const result = typeof bestDays === "function"
        ? bestDays(birth, iso(new Date()), { horizonDays: 90, count: 3 })
        : [];
      setDays(result || []);
    } catch {
      setErr(true);
      setDays([]);
    }
  }, [birth && birth.date, birth && birth.time]);

  if (!birth || !birth.date) return null;
  if (err || !days) return null;
  if (days.length === 0) return null;

  const isPresident = occupation === "president";
  const heading = isPresident
    ? "大型契約・投資・人事の日取りはこの日に"
    : "ここぞの一手・大事な予定はこの日に";

  return (
    <Panel
      title={heading}
      accent={C.green}
      help="あなたの命式の「攻めの日」と暦の「開運日（一粒万倍日・天赦日など）」を掛け合わせ、これから先の良い決断日をTop3で表示します。攻め×開運日が最優先です。"
    >
      <div style={{ display: "grid", gap: 10 }}>
        {days.map((d, i) => {
          const stanceColor = d.stance === "攻め" ? C.green : d.stance === "守り" ? C.red : d.stance === "労い" ? C.blue : C.accent;
          const isDouble = d.stance === "攻め" && d.koyomi && d.koyomi.length > 0;
          return (
            <div key={d.date} style={{ background: isDouble ? C.green + "14" : C.panel2, border: `1px solid ${isDouble ? C.green : C.line}`, borderRadius: 12, padding: "12px 14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                <span style={{ width: 24, height: 24, borderRadius: "50%", background: C.panel, border: `1px solid ${C.line}`, display: "grid", placeItems: "center", fontSize: 12, fontWeight: 700, color: C.accent, flex: "0 0 auto" }}>{i + 1}</span>
                <span style={{ fontSize: 15, fontWeight: 700 }}>
                  {Number(d.date.slice(5, 7))}/{Number(d.date.slice(8, 10))}({d.weekday})
                </span>
                {d.stance && (
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#0B0D11", background: stanceColor, borderRadius: 999, padding: "1px 9px" }}>{d.stance}</span>
                )}
                {d.koyomi && d.koyomi.map((k) => (
                  <span key={k.name} style={{ fontSize: 12, fontWeight: 700, color: "#0B0D11", background: C.accent, borderRadius: 999, padding: "1px 9px" }}>{k.emoji}{k.name}</span>
                ))}
                <span style={{ flex: 1 }} />
                {d.dayStar && <span style={{ fontSize: 12, color: C.sub }}>{d.dayStar}</span>}
              </div>
              <div style={{ fontSize: 13, color: C.text, lineHeight: 1.5 }}>{d.reason}</div>
              <div style={{ fontSize: 12, color: C.sub, lineHeight: 1.6, marginTop: 3, marginBottom: onPlan ? 8 : 0 }}>
                {(() => {
                  const isTensha = d.koyomi && d.koyomi.some((k) => k.name === "天赦日");
                  const isAttack = d.stance === "攻め";
                  const isKoyomi = d.koyomi && d.koyomi.length > 0;
                  if (isTensha && isAttack) return "→ 何を始めても良い最強日。大事な申し込み・契約・発表・決断に最適です。";
                  if (isTensha) return "→ 何をしても良いとされる最強の開運日。大事なことは迷わずこの日に。";
                  if (isAttack && isKoyomi) return "→ あなたの「攻め」と暦の開運が重なる日。大事な連絡・申し込み・契約・発信に好機です。";
                  if (isAttack) return "→ あなたの命式が「攻め」に向く日。新しいことを動かす・重要な判断をするのに向いています。";
                  return "→ 暦の開運日。商談・ご縁をつなぐ連絡・新しい取り組みのスタートに良い日です。";
                })()}
              </div>
              {onPlan && (
                <button
                  onClick={() => onPlan(d.date)}
                  style={{ ...chipBtn, fontSize: 12, padding: "5px 12px", background: isDouble ? C.green : "transparent", color: isDouble ? "#0B0D11" : C.text, borderColor: isDouble ? C.green : C.line }}
                >
                  + この日に予定を入れる
                </button>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

/* 算命学・人体星図（陽占）：五主星を十字に配置＋十二大従星のエネルギー＋日干タイプ＋陰占の干支 */
const POS_SHORT = { center: "中央・本質", north: "頭・目上", south: "腹・社会", east: "右手・身近", west: "左手・友人" };
function SanmeiChart({ detail }) {
  const [sel, setSel] = useState("center");
  if (!detail) return null;
  const by = {};
  (detail.stars || []).forEach((s) => { by[s.pos] = s; });
  const sd = by[sel];
  const cell = (pos) => {
    const s = by[pos];
    if (!s) return <span />;
    const active = sel === pos;
    return (
      <button
        onClick={() => setSel(pos)}
        style={{ border: `1px solid ${active ? C.purple : C.line}`, background: active ? C.purple + "1F" : C.panel2, borderRadius: 10, padding: "8px 4px", textAlign: "center", cursor: "pointer", color: C.text, font: "inherit", display: "grid", gap: 1, placeItems: "center" }}
      >
        <span style={{ fontSize: 18 }}>{s.emoji}</span>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{s.star}</span>
        <span style={{ fontSize: 11, color: C.faint }}>{POS_SHORT[pos]}</span>
      </button>
    );
  };
  const eColor = (e) => (e >= 9 ? C.green : e >= 5 ? C.accent : C.blue);
  return (
    <div>
      {/* 十字（人体星図） */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 12 }}>
        <span />{cell("north")}<span />
        {cell("west")}{cell("center")}{cell("east")}
        <span />{cell("south")}<span />
      </div>
      {/* 選択中の星の詳細 */}
      {sd && (
        <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 10, padding: "11px 13px", marginBottom: 14 }}>
          <div style={{ fontSize: 13, color: C.purple, fontWeight: 700, marginBottom: 2 }}>
            {sd.posLabel}（{sd.source}）
            {sd.pos === "center" && <span style={{ fontSize: 13, color: C.faint, fontWeight: 400, marginLeft: 6 }}>あなたの素の自分</span>}
            {sd.pos === "north" && <span style={{ fontSize: 13, color: C.faint, fontWeight: 400, marginLeft: 6 }}>上司・年長者から見た印象</span>}
            {sd.pos === "south" && <span style={{ fontSize: 13, color: C.faint, fontWeight: 400, marginLeft: 6 }}>仕事・目下から見た顔</span>}
            {sd.pos === "east" && <span style={{ fontSize: 13, color: C.faint, fontWeight: 400, marginLeft: 6 }}>家族・パートナーから見た姿</span>}
            {sd.pos === "west" && <span style={{ fontSize: 13, color: C.faint, fontWeight: 400, marginLeft: 6 }}>仲間内での魅力</span>}
          </div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{sd.emoji} {sd.star}・{sd.title}</div>
          <div style={{ fontSize: 13, color: C.faint, marginTop: 2 }}>{sd.posMeaning}</div>
          <div style={{ fontSize: 13, color: C.text, lineHeight: 1.6, marginTop: 6 }}>{sd.desc}</div>
          <div style={{ fontSize: 13, color: C.sub, lineHeight: 1.6, marginTop: 4 }}>💡 {sd.biz}</div>
        </div>
      )}
      {/* 十二大従星（人生の勢い） */}
      <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 2 }}>人生のエネルギー（十二大従星）</div>
      <div style={{ fontSize: 13, color: C.faint, marginBottom: 6 }}>人生の勢いを12段階で表す星</div>
      <div style={{ display: "grid", gap: 8, marginBottom: 14 }}>
        {(detail.energies || []).map((e) => (
          <div key={e.phase}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 3 }}>
              <span style={{ color: C.sub }}>{e.phase}期 ・ <b style={{ color: C.text }}>{e.name}</b></span>
              <span style={{ color: eColor(e.energy), fontWeight: 700 }}>エネルギー {e.energy}/12</span>
            </div>
            <div style={{ height: 8, background: C.panel2, borderRadius: 5, overflow: "hidden", border: `1px solid ${C.line}` }}>
              <div style={{ width: `${(e.energy / 12) * 100}%`, height: "100%", background: eColor(e.energy) }} />
            </div>
            <div style={{ fontSize: 13, color: C.faint, marginTop: 2 }}>{e.meaning}</div>
          </div>
        ))}
      </div>
      {/* 日干タイプ＋陰占の干支 */}
      {detail.dayType && (
        <div style={{ fontSize: 13, color: C.text, lineHeight: 1.6, marginBottom: 8 }}>
          <b style={{ color: C.purple }}>日干タイプ：{detail.dayType.label}</b>　{detail.dayType.desc}
        </div>
      )}
      {detail.pillars && (
        <div style={{ display: "flex", gap: 8, fontSize: 12, color: C.sub }}>
          {[["年柱", detail.pillars.year], ["月柱", detail.pillars.month], ["日柱", detail.pillars.day]].map(([k, v]) => (
            <span key={k} style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 8, padding: "3px 10px" }}>{k} <b style={{ color: C.text }}>{v}</b></span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   A. 天中殺・大運 表示（FortunePanel内・人体星図Accの直下）
   ────────────────────────────────────────────────────────────── */
function TenchusatsuDaiunAcc({ birth }) {
  const tc = useMemo(() => { try { return tenchusatsu(birth); } catch { return null; } }, [birth && birth.date, birth && birth.time]);
  const du = useMemo(() => { try { return daiun(birth); } catch { return null; } }, [birth && birth.date, birth && birth.time, birth && birth.gender]);
  if (!tc && !du) return null;
  // cur が null または preStart:true（立運前）のケースを防御的に扱う
  const cur = du && du.current && !du.current.preStart ? du.current : null;
  const preStart = du && du.current && du.current.preStart ? du.current : null;
  return (
    <Acc title="運勢の流れ（天中殺・大運）" color={C.blue} defaultOpen={false}>
      {tc && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.blue, marginBottom: 2 }}>
            {tc.name}
            <span style={{ fontSize: 13, color: C.faint, fontWeight: 400, marginLeft: 8 }}>天中殺 = 運気が休む・充電の時期</span>
          </div>
          <div style={{ fontSize: 13, color: C.sub, lineHeight: 1.7, marginBottom: 6 }}>{tc.desc}</div>
          {tc.years && tc.years.length > 0 && (
            <div style={{ fontSize: 13, color: C.text }}>
              次の天中殺の年: <strong>{tc.years.join("・")}</strong>
            </div>
          )}
        </div>
      )}
      {du && (
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.blue, marginBottom: 2 }}>
            大運（10年の流れ）
            <span style={{ fontSize: 13, color: C.faint, fontWeight: 400, marginLeft: 8 }}>10年ごとの運勢の流れ</span>
          </div>
          {du.assumed && (
            <div style={{ fontSize: 13, color: C.faint, marginBottom: 6 }}>性別未設定のため順行で仮表示</div>
          )}
          {cur && (
            <div style={{ background: C.panel, border: `1px solid ${C.blue}`, borderRadius: 10, padding: "10px 14px", marginBottom: 10, marginTop: 6 }}>
              <div style={{ fontSize: 13, color: C.blue, fontWeight: 700, marginBottom: 4 }}>現在の大運期</div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>{cur.ganzhi} ・ {cur.star}</div>
              <div style={{ fontSize: 13, color: C.sub, marginBottom: 4 }}>{cur.ageFrom}歳〜{cur.ageTo}歳</div>
              <div style={{ fontSize: 13, color: C.text, lineHeight: 1.6 }}>{cur.theme}</div>
            </div>
          )}
          {preStart && (
            <div style={{ background: C.panel2, border: `1px solid ${C.blue}`, borderRadius: 10, padding: "10px 14px", marginBottom: 10, marginTop: 6 }}>
              <div style={{ fontSize: 13, color: C.blue, marginBottom: 2 }}>まもなく {preStart.ageFrom}歳から大運が始まります</div>
              <div style={{ fontSize: 13, color: C.faint }}>{preStart.ganzhi} ・ {preStart.star}</div>
            </div>
          )}
          {!cur && !preStart && (
            <div style={{ fontSize: 13, color: C.faint, marginBottom: 10 }}>現在の大運期は算出中です</div>
          )}
          {du.roadmap && du.roadmap.length > 0 && (
            <>
              <div style={{ fontSize: 13, color: C.sub, marginBottom: 6 }}>ロードマップ（5期）</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {du.roadmap.map((p, i) => (
                  <div
                    key={i}
                    style={{
                      flex: "1 1 140px",
                      minWidth: 120,
                      background: p.current ? C.blue + "22" : C.panel2,
                      border: `1px solid ${p.current ? C.blue : C.line}`,
                      borderRadius: 8,
                      padding: "8px 10px",
                    }}
                  >
                    <div style={{ fontSize: 13, color: p.current ? C.blue : C.faint, fontWeight: p.current ? 700 : 400 }}>
                      {p.ageFrom}〜{p.ageTo}歳
                      {p.current && !p.preStart && <span style={{ marginLeft: 4, fontSize: 12, fontWeight: 700 }}>← 現在</span>}
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 700, margin: "2px 0" }}>{p.ganzhi} {p.star}</div>
                    {/* テキストを折り返して全文表示（truncateしない） */}
                    <div style={{ fontSize: 13, color: C.sub, lineHeight: 1.5, whiteSpace: "normal", wordBreak: "break-all" }}>{p.theme}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </Acc>
  );
}

/* ──────────────────────────────────────────────────────────────
   B-1. メンバー管理フォーム・一覧
   ────────────────────────────────────────────────────────────── */
const RELATIONS = ["配偶者", "子ども", "親", "パートナー", "メンバー", "取引先", "会食相手", "幹部・社員", "後継者", "ビジネスパートナー", "その他"];
// 仕事系の続柄（社長用）
const WORK_RELATIONS = new Set(["取引先", "会食相手", "幹部・社員", "後継者", "ビジネスパートナー", "メンバー"]);

function MemberBirthForm({ initial, onSave, onCancel }) {
  const def = initial || {};
  const b = def.birth || {};
  const [name, setName] = useState(def.name || "");
  const [relation, setRelation] = useState(def.relation || "配偶者");
  const [date, setDate] = useState(b.date || "");
  const [time, setTime] = useState(b.time || "");
  const [place, setPlace] = useState(b.place || "東京");
  const [gender, setGender] = useState(b.gender || "");
  const [err, setErr] = useState("");

  const save = () => {
    if (!name.trim()) { setErr("名前を入力してください"); return; }
    if (!date) { setErr("生年月日を入力してください"); return; }
    setErr("");
    const p = PREFS.find((x) => x[0] === place) || PREFS.find((x) => x[0] === "東京");
    onSave({
      id: def.id || ("m" + Date.now()),
      name: name.trim(),
      relation,
      birth: { date, time: time || "12:00", place, lat: p[1], lon: p[2], gender, utcOffset: 9 },
    });
  };

  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 14px", marginTop: 8 }}>
      {err && <div style={{ fontSize: 12, color: C.red, marginBottom: 6 }}>{err}</div>}
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="名前（必須）" style={inp} />
      <label style={{ fontSize: 12, color: C.sub, display: "block", marginBottom: 2 }}>続柄</label>
      <select value={relation} onChange={(e) => setRelation(e.target.value)} style={inp}>
        {RELATIONS.map((r) => <option key={r}>{r}</option>)}
      </select>
      <label style={{ fontSize: 12, color: C.sub, display: "block", marginBottom: 2 }}>生年月日（必須）</label>
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inp} />
      <label style={{ fontSize: 12, color: C.sub, display: "block", marginBottom: 2 }}>出生時刻（任意）</label>
      <input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={inp} />
      <label style={{ fontSize: 12, color: C.sub, display: "block", marginBottom: 2 }}>出生地</label>
      <select value={place} onChange={(e) => setPlace(e.target.value)} style={inp}>
        {PREFS.map((p) => <option key={p[0]}>{p[0]}</option>)}
      </select>
      <label style={{ fontSize: 12, color: C.sub, display: "block", marginBottom: 2 }}>性別</label>
      <select value={gender} onChange={(e) => setGender(e.target.value)} style={inp}>
        <option value="">未設定</option>
        <option value="male">男性</option>
        <option value="female">女性</option>
      </select>
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button onClick={save} style={{ ...chipBtn, background: C.green, color: "#0B0D11", borderColor: C.green, fontWeight: 700 }}>保存</button>
        <button onClick={onCancel} style={chipBtn}>取消</button>
      </div>
    </div>
  );
}

function MemberManager({ members, onSaveMembers }) {
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const dcTimer = useRef(null);

  const handleDelete = (id) => {
    if (deleteConfirm === id) {
      clearTimeout(dcTimer.current);
      setDeleteConfirm(null);
      onSaveMembers((members || []).filter((m) => m.id !== id));
    } else {
      setDeleteConfirm(id);
      clearTimeout(dcTimer.current);
      dcTimer.current = setTimeout(() => setDeleteConfirm(null), 6000);
    }
  };

  const handleSave = (item) => {
    const list = members || [];
    const idx = list.findIndex((m) => m.id === item.id);
    if (idx >= 0) {
      onSaveMembers(list.map((m) => (m.id === item.id ? item : m)));
    } else {
      onSaveMembers([...list, item]);
    }
    setAdding(false);
    setEditId(null);
  };

  return (
    <div>
      {(members || []).length === 0 && !adding && <Empty>メンバーがいません。下のボタンから追加してください。</Empty>}
      <div style={{ display: "grid", gap: 2 }}>
        {(members || []).map((m) => (
          <div key={m.id}>
            {editId === m.id ? (
              <MemberBirthForm initial={m} onSave={handleSave} onCancel={() => setEditId(null)} />
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 44, padding: "6px 0", borderBottom: `1px solid ${C.line}` }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{m.name}</span>
                  <span style={{ fontSize: 12, color: C.sub, marginLeft: 8 }}>{m.relation}</span>
                  {m.birth && m.birth.date && <span style={{ fontSize: 12, color: C.faint, marginLeft: 8 }}>{m.birth.date}</span>}
                </div>
                <button onClick={() => { setEditId(m.id); setAdding(false); }} style={iconBtn} title="編集">✏️</button>
                <button
                  onClick={() => handleDelete(m.id)}
                  style={{ ...iconBtn, color: deleteConfirm === m.id ? C.red : C.sub, fontWeight: deleteConfirm === m.id ? 700 : 400, fontSize: deleteConfirm === m.id ? 16 : 13 }}
                  title={deleteConfirm === m.id ? "もう一度押すと削除されます" : "削除"}
                >
                  {deleteConfirm === m.id ? "もう一度押すと削除" : "✕"}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      {adding ? (
        <MemberBirthForm onSave={handleSave} onCancel={() => setAdding(false)} />
      ) : (
        <button
          onClick={() => { setAdding(true); setEditId(null); }}
          style={{ ...chipBtn, marginTop: 10, borderStyle: "dashed", width: "100%", justifyContent: "center" }}
        >
          + メンバーを追加
        </button>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   B-2. 今日のチーム運気
   ────────────────────────────────────────────────────────────── */
function FamilyFortunePanel({ birth, members }) {
  const stars = (n) => "★★★★★".slice(0, Math.max(0, Math.min(5, Number(n) || 0))) + "☆☆☆☆☆".slice(0, 5 - Math.max(0, Math.min(5, Number(n) || 0)));
  const allMembers = useMemo(() => {
    const hasBirth = birth && birth.date;
    const me = hasBirth ? [{ name: birth.name || "あなた", birth }] : [];
    return [...me, ...(members || []).map((m) => ({ name: m.name, birth: m.birth }))];
  }, [birth && birth.date, birth && birth.time, JSON.stringify(members)]);

  // birthが無くメンバーもゼロのときだけEmptyを出す（本人だけでも運気を表示する）
  const hasBirthData = birth && birth.date;
  if (!hasBirthData && (members || []).length === 0) {
    return <Empty>出生情報またはメンバーを登録すると、今日のチーム運気が見られます</Empty>;
  }
  if (allMembers.length === 0) return null;

  let result = null;
  try { result = familyFortune(allMembers); } catch { return <Empty>運気の計算に失敗しました</Empty>; }
  if (!result) return null;
  const stars5 = stars(result.teamScore);

  return (
    <div>
      <div style={{ fontSize: 13, color: C.faint, marginBottom: 10 }}>今日のチームスコア: <strong style={{ fontSize: 15, color: C.text }}>{stars5}</strong></div>
      <div style={{ display: "grid", gap: 6, marginBottom: 12 }}>
        {result.members.map((mb, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: `1px solid ${C.line}` }}>
            <span style={{ fontSize: 14, color: C.accent, flex: "0 0 auto" }}>{stars(mb.score)}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{mb.name}</span>
              <span style={{ fontSize: 13, color: C.sub, marginLeft: 8 }}>{mb.stance}</span>
              {mb.focus && <div style={{ fontSize: 13, color: C.faint, marginTop: 2, lineHeight: 1.5 }}>{mb.focus}</div>}
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        {result.bestMover && (
          <span style={{ fontSize: 13, background: C.green + "22", border: `1px solid ${C.green}`, color: C.green, borderRadius: 8, padding: "3px 10px", fontWeight: 700 }}>
            {result.bestMover} が今日の中心
          </span>
        )}
        {result.supporter && result.supporter !== result.bestMover && (
          <span style={{ fontSize: 13, background: C.blue + "22", border: `1px solid ${C.blue}`, color: C.blue, borderRadius: 8, padding: "3px 10px", fontWeight: 700 }}>
            {result.supporter} が今日の支え
          </span>
        )}
      </div>
      {result.advice && (
        <div style={{ fontSize: 13, color: C.text, lineHeight: 1.7, background: C.panel2, borderRadius: 8, padding: "10px 12px" }}>
          チームへのひとこと：{result.advice}
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   B-2.5 その場でサッと相性（登録不要）
   生年月日だけ入れると即・aishou() で相性結果を表示。
   保存なし。「登録して残す」で既存のメンバー追加フォームに誘導（任意）。
   ────────────────────────────────────────────────────────────── */
function QuickAishouPanel({ birth, occupation, onAddMember }) {
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const [showRegister, setShowRegister] = useState(false);

  const isPresident = occupation === "president";
  const heading = isPresident ? "会食相手・商談相手とサッと相性" : "相手とサッと相性";

  const calc = () => {
    if (!date) return;
    setErr(null);
    setResult(null);
    try {
      const partnerBirth = { date, time: time || "12:00", place: "東京", lat: 35.69, lon: 139.69, utcOffset: 9 };
      const r = aishou(birth, partnerBirth);
      if (!r) { setErr("計算できませんでした"); return; }
      setResult(r);
    } catch (e) {
      setErr("計算に失敗しました: " + String((e && e.message) || e));
    }
  };

  const reset = () => { setDate(""); setTime(""); setResult(null); setErr(null); setShowRegister(false); };

  if (!birth || !birth.date) return null;

  const pct = result ? result.score : 0;
  const barColor = pct >= 75 ? C.green : pct >= 45 ? C.accent : C.blue;

  return (
    <Acc title={heading} defaultOpen={false} color={C.purple}>
      <div style={{ fontSize: 12, color: C.sub, marginBottom: 10, lineHeight: 1.6 }}>
        {isPresident
          ? "会食・商談前に相手の生年月日を入れると、関係の傾向と接し方のコツが即座に出ます。保存はしません。"
          : "相手の生年月日を入れると相性が即座に出ます。保存はしません。"}
      </div>
      {!result ? (
        <div>
          <label style={{ fontSize: 12, color: C.sub, display: "block", marginBottom: 2 }}>相手の生年月日（必須）</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inp} />
          <label style={{ fontSize: 12, color: C.sub, display: "block", marginBottom: 2 }}>出生時刻（任意・なければ空欄でOK）</label>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={inp} />
          <button
            onClick={calc}
            disabled={!date}
            style={{ ...chipBtn, background: date ? C.purple : "transparent", color: date ? "#fff" : C.sub, borderColor: date ? C.purple : C.line, fontWeight: 700 }}
          >
            相性を見る
          </button>
          {err && <div style={{ fontSize: 12, color: C.red, marginTop: 8 }}>{err}</div>}
        </div>
      ) : (
        <div>
          <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 14px", marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 14, fontWeight: 700 }}>{date}の方との相性</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 15, fontWeight: 700, color: barColor }}>{result.score}点</span>
            </div>
            <div style={{ height: 8, background: C.panel, borderRadius: 5, overflow: "hidden", marginBottom: 8 }}>
              <div style={{ width: `${pct}%`, height: "100%", background: barColor, borderRadius: 5 }} />
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 6 }}>{result.label}</div>
            {result.summary && (
              <div style={{ fontSize: 13, color: C.sub, lineHeight: 1.7, marginBottom: 8 }}>
                {String(result.summary || "").replace(/\s*根拠[:：].*$/s, "")}
              </div>
            )}
            {Array.isArray(result.reasons) && result.reasons.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                {result.reasons.map((r, i) => (
                  <span key={i} style={{ fontSize: 12, color: C.faint, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 999, padding: "2px 9px" }}>{r}</span>
                ))}
              </div>
            )}
            {result.howto && result.howto.length > 0 && (
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.accent, marginBottom: 4 }}>
                  {isPresident ? "組む・会う時のコツ" : "うまくいくコツ"}
                </div>
                <div style={{ display: "grid", gap: 4 }}>
                  {result.howto.slice(0, 3).map((h, i) => (
                    <div key={i} style={{ fontSize: 13, color: C.text, lineHeight: 1.6 }}>・{h}</div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={reset} style={chipBtn}>別の方を調べる</button>
            {onAddMember && (
              <button
                onClick={() => setShowRegister(true)}
                style={{ ...chipBtn, borderColor: C.green, color: C.green }}
              >
                登録して残す
              </button>
            )}
          </div>
          {showRegister && onAddMember && (
            <div style={{ marginTop: 10, background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 12px" }}>
              <div style={{ fontSize: 12, color: C.sub, marginBottom: 6 }}>「メンバーの管理」から追加すると次回も相性を確認できます。</div>
              <button
                onClick={() => { onAddMember({ date, time: time || "12:00" }); setShowRegister(false); }}
                style={{ ...chipBtn, background: C.green, color: "#0B0D11", borderColor: C.green, fontWeight: 700 }}
              >
                メンバー追加フォームへ
              </button>
            </div>
          )}
        </div>
      )}
    </Acc>
  );
}

/* ──────────────────────────────────────────────────────────────
   B-3. 相性チャート
   ────────────────────────────────────────────────────────────── */
function AishouPanel({ birth, members, occupation }) {
  const [expandedId, setExpandedId] = useState(null);
  if (!birth || !birth.date || (members || []).length === 0) {
    return (
      <Empty>
        {occupation === "president"
          ? "本人の出生情報と相手（取引先・会食相手・幹部）を登録すると、相性チャートが表示されます"
          : "本人の出生情報とメンバーを登録すると、相性チャートが表示されます"}
      </Empty>
    );
  }
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {(members || []).map((m) => {
        if (!m.birth || !m.birth.date) return null;
        let result = null;
        try { result = aishou(birth, m.birth); } catch { return null; }
        if (!result) return null;
        const pct = result.score;
        const barColor = pct >= 75 ? C.green : pct >= 45 ? C.accent : C.blue;
        const isExpanded = expandedId === m.id;
        const isChild = m.relation === "子ども";
        // 仕事系続柄かどうか（社長モードで追加された取引先・幹部等）
        const isWorkRelation = WORK_RELATIONS.has(m.relation);
        return (
          <div key={m.id} style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden" }}>
            <button
              onClick={() => setExpandedId(isExpanded ? null : m.id)}
              style={{ width: "100%", background: "transparent", border: "none", color: C.text, padding: "12px 14px", cursor: "pointer", textAlign: "left", font: "inherit" }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 700 }}>{m.name}</span>
                <span style={{ fontSize: 12, color: C.sub }}>{m.relation}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 13, fontWeight: 700, color: barColor }}>{result.score}点</span>
                <span style={{ fontSize: 12, color: C.sub }}>{isExpanded ? "▲" : "▼"}</span>
              </div>
              <div style={{ height: 8, background: C.panel, borderRadius: 5, overflow: "hidden", marginBottom: 6 }}>
                <div style={{ width: `${pct}%`, height: "100%", background: barColor, borderRadius: 5 }} />
              </div>
              <div style={{ fontSize: 13, color: C.text }}>{result.label}</div>
            </button>
            {isExpanded && (
              <div style={{ padding: "0 14px 14px", borderTop: `1px solid ${C.line}` }}>
                <div style={{ fontSize: 13, color: C.sub, lineHeight: 1.7, marginBottom: 10, marginTop: 10 }}>{String(result.summary || "").replace(/\s*根拠[:：].*$/s, "")}</div>
                {/* スコア根拠の断片（reasons配列）をタグ表示。点数の理由を掴めるように */}
                {Array.isArray(result?.reasons) && result.reasons.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                    {result.reasons.map((r, i) => (
                      <span key={i} style={{ fontSize: 13, color: C.faint, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 999, padding: "2px 9px" }}>{r}</span>
                    ))}
                  </div>
                )}
                {!isChild && (
                  <>
                    <div style={{ fontSize: 13, fontWeight: 700, color: C.purple, marginBottom: 4 }}>
                      {isWorkRelation ? "あなたから見た印象・関係" : "あなたから見て"}
                    </div>
                    <div style={{ fontSize: 13, color: C.text, lineHeight: 1.6, marginBottom: 10 }}>{result.aToB}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: C.blue, marginBottom: 4 }}>
                      {isWorkRelation ? "相手から見た印象・関係" : "相手から見て"}
                    </div>
                    <div style={{ fontSize: 13, color: C.text, lineHeight: 1.6, marginBottom: 10 }}>{result.bToA}</div>
                  </>
                )}
                <div style={{ fontSize: 13, fontWeight: 700, color: C.accent, marginBottom: 6 }}>
                  {isWorkRelation ? "組む・会う時のコツ" : "うまくいくコツ"}
                </div>
                <div style={{ display: "grid", gap: 4 }}>
                  {(result.howto || []).slice(0, 3).map((h, i) => (
                    <div key={i} style={{ fontSize: 13, color: C.text, lineHeight: 1.6 }}>・{h}</div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   運気カード画像生成（canvas → ダウンロード / Share API）
   ────────────────────────────────────────────────────────────── */
function generateFortuneImage({ dateLabel, star, stance, stanceColor, move, koyomiLabel }) {
  try {
    const W = 1080, H = 1350;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");

    // 背景グラデーション
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#0F1115");
    bg.addColorStop(1, "#1E1040");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // 装飾ライン
    ctx.strokeStyle = stanceColor + "44";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(80, 160); ctx.lineTo(W - 80, 160);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(80, H - 160); ctx.lineTo(W - 80, H - 160);
    ctx.stroke();

    // ブランド名
    ctx.fillStyle = "#C9A227";
    ctx.font = "bold 36px 'Helvetica Neue', Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("ひとり秘書", W / 2, 100);

    // 日付
    ctx.fillStyle = "#C5CBD3";
    ctx.font = "32px 'Helvetica Neue', Arial, sans-serif";
    ctx.fillText(dateLabel, W / 2, 210);

    // スタンスバッジ
    const badgeW = 280, badgeH = 72;
    const bx = (W - badgeW) / 2, by = 260;
    ctx.fillStyle = stanceColor + "33";
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(bx, by, badgeW, badgeH, 36);
    } else {
      ctx.rect(bx, by, badgeW, badgeH);
    }
    ctx.fill();
    ctx.strokeStyle = stanceColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(bx, by, badgeW, badgeH, 36);
    } else {
      ctx.rect(bx, by, badgeW, badgeH);
    }
    ctx.stroke();
    ctx.fillStyle = stanceColor;
    ctx.font = "bold 42px 'Helvetica Neue', Arial, sans-serif";
    ctx.fillText("今日は" + stance, W / 2, by + 48);

    // 主星
    ctx.fillStyle = "#E8EAED";
    ctx.font = "bold 64px 'Helvetica Neue', Arial, sans-serif";
    ctx.fillText(star, W / 2, 430);

    // 開運日ラベル
    if (koyomiLabel) {
      ctx.fillStyle = "#C9A227";
      ctx.font = "bold 34px 'Helvetica Neue', Arial, sans-serif";
      ctx.fillText(koyomiLabel, W / 2, 510);
    }

    // 今日の動き（折り返し）
    ctx.fillStyle = "#C5CBD3";
    ctx.font = "30px 'Helvetica Neue', Arial, sans-serif";
    const maxW = W - 160;
    const words = move || "";
    const lines = [];
    let cur = "";
    for (let i = 0; i < words.length; i++) {
      const next = cur + words[i];
      if (ctx.measureText(next).width > maxW && cur.length > 0) {
        lines.push(cur);
        cur = words[i];
      } else {
        cur = next;
      }
    }
    if (cur.length > 0) lines.push(cur);
    const lineH = 46;
    const startY = koyomiLabel ? 590 : 540;
    lines.slice(0, 6).forEach((l, i) => {
      ctx.fillText(l, W / 2, startY + i * lineH);
    });

    // フッター
    ctx.fillStyle = "#66707C";
    ctx.font = "26px 'Helvetica Neue', Arial, sans-serif";
    ctx.fillText("ひとり秘書 | 今日のコンディション", W / 2, H - 100);

    const dataUrl = canvas.toDataURL("image/png");

    // Share API（モバイル） or ダウンロード（デスクトップ）
    if (navigator.canShare && typeof navigator.share === "function") {
      canvas.toBlob((blob) => {
        if (!blob) { fallbackDownload(dataUrl); return; }
        const file = new File([blob], "fortune-card.png", { type: "image/png" });
        if (navigator.canShare({ files: [file] })) {
          navigator.share({ files: [file], title: "今日のコンディション" }).catch(() => fallbackDownload(dataUrl));
        } else {
          fallbackDownload(dataUrl);
        }
      }, "image/png");
    } else {
      fallbackDownload(dataUrl);
    }
  } catch (e) {
    console.error("[VIELE] fortune image error", e);
  }
}

function fallbackDownload(dataUrl) {
  try {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = "fortune-card.png";
    a.click();
  } catch { /* ignore */ }
}

/* ──────────────────────────────────────────────────────────────
   FortunePanel（本体）
   ────────────────────────────────────────────────────────────── */
/* 算命学・運氣の流れ：今日を主役に。今月/今年は初期は畳んでおき、見たい人だけ開く（過密回避） */
function SanmeiFlow({ birth, uranaiLevel }) {
  const [showMore, setShowMore] = useState(uranaiLevel === "high");
  const un = useMemo(() => sanmeiUn(birth, iso(new Date())), [birth && birth.date, birth && birth.time]);
  // 今日の開運日（optional: koyomiが未定義でも落ちない）
  const todayKoyomi = useMemo(() => {
    try { return typeof koyomi === "function" ? koyomi(iso(new Date())) : null; }
    catch { return null; }
  }, []);
  if (!un) return null;
  const stColor = un.day.stance === "攻め" ? C.green : un.day.stance === "守り" ? C.red : un.day.stance === "労い" ? C.blue : C.accent;
  const Period = ({ label, u, color }) => (
    <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 10, padding: "9px 11px", marginBottom: 8 }}>
      <div style={{ fontSize: 13, color, fontWeight: 700, marginBottom: 1 }}>{label}　{u.emoji} {u.star}（{u.ganzhi}）</div>
      <div style={{ fontSize: 13, color: C.text, lineHeight: 1.6 }}>{u.move}</div>
    </div>
  );
  return (
    <div id="sanmei-flow">
    <Acc
      title="算命学・運氣の流れ（今日の動き）"
      color={C.purple}
      defaultOpen={uranaiLevel !== "low"}
      badge={<span style={{ fontSize: 13, color: stColor, fontWeight: 700 }}>今日{un.day.emoji}{un.day.star}</span>}
    >
      <div style={{ fontSize: 13, color: C.faint, marginBottom: 8 }}>あなたの日干に、今動いている星（十大主星）を重ねて"流れ・動き方"を出します。人体星図と同じ星の言葉です。</div>
      {/* 開運日バッジ */}
      {todayKoyomi && todayKoyomi.labels && todayKoyomi.labels.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
          {todayKoyomi.labels.map((l) => (
            <span key={l.key} style={{ fontSize: 13, fontWeight: 700, color: "#0B0D11", background: todayKoyomi.best ? C.green : C.accent, borderRadius: 999, padding: "2px 10px" }}>
              {l.emoji} 今日は{l.name}
            </span>
          ))}
          {un.day.stance === "攻め" && todayKoyomi.labels.length > 0 && (
            <span style={{ fontSize: 13, fontWeight: 700, color: C.green }}>攻め×開運日 最高のタイミング！</span>
          )}
        </div>
      )}
      <div style={{ background: stColor + "14", border: `1px solid ${stColor}`, borderRadius: 10, padding: "10px 12px", marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: stColor, marginBottom: 2 }}>今日 ・ {un.day.emoji} {un.day.star}（{un.day.title}） ・ {un.day.stance}</div>
        <div style={{ fontSize: 13, color: C.text, lineHeight: 1.6 }}>{un.day.move}</div>
      </div>
      {/* 画像で保存/シェアボタン */}
      <button
        onClick={() => {
          const now2 = new Date();
          const dl = `${now2.getFullYear()}/${now2.getMonth() + 1}/${now2.getDate()}(${WD[now2.getDay()]})`;
          const kl = todayKoyomi && todayKoyomi.labels && todayKoyomi.labels.length > 0
            ? todayKoyomi.labels.map((l) => l.emoji + l.name).join(" ")
            : "";
          generateFortuneImage({
            dateLabel: dl,
            star: `${un.day.emoji} ${un.day.star}`,
            stance: un.day.stance,
            stanceColor: stColor,
            move: un.day.move,
            koyomiLabel: kl,
          });
        }}
        style={{ ...chipBtn, marginBottom: 10, background: C.purple, color: "#fff", borderColor: C.purple, fontWeight: 700 }}
      >
        画像で保存 / ストーリーズ用カードを作る
      </button>
      {showMore ? (
        <>
          <Period label="今月" u={un.month} color={C.blue} />
          <Period label="今年" u={un.year} color={C.purple} />
        </>
      ) : (
        <button onClick={() => setShowMore(true)} style={{ width: "100%", background: "transparent", border: `1px solid ${C.line}`, borderRadius: 10, padding: "8px 0", cursor: "pointer", color: C.sub, font: "inherit", fontSize: 13 }}>
          今月・今年の流れも見る　{un.month.emoji}{un.month.star}／{un.year.emoji}{un.year.star} ▼
        </button>
      )}
    </Acc>
    </div>
  );
}

function FortunePanel({ fortune, loading, error, aiOff, onRefresh, birth, onSaveBirth, members, onSaveMembers, uranaiLevel, usage, occupation }) {
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
    <>
    <Panel
      title="運気（年・月・日）"
      accent={C.purple}
      help="あなたの命式（四柱推命・西洋占星術・インド占星術）を根拠に、AIが年・月・日の運勢を鑑定します。各項目はタップで開閉。占いとして参考程度に。"
      right={<button onClick={onRefresh} disabled={loading} style={chipBtn}>{loading ? "占い中…" : "更新"}</button>}
    >
      {aiOff && <div style={{ fontSize: 12, color: C.sub, marginBottom: 8 }}>※ AI機能は現在オフです</div>}
      {uranaiLevel === "low" && (
        <div style={{ fontSize: 12, color: C.faint, background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 8, padding: "6px 10px", marginBottom: 10 }}>
          ※ 論理・データ派モード：占い情報は参考程度に表示しています。
        </div>
      )}
      {uranaiLevel === "high" && birth && birth.date && (
        <div style={{ fontSize: 12, color: C.accent, fontWeight: 700, background: C.accent + "14", border: `1px solid ${C.accent}`, borderRadius: 8, padding: "6px 10px", marginBottom: 10 }}>
          ⭐ 占い好きモード：今日の開運日・運気をフルに活用しましょう！
        </div>
      )}
      {(!birth || !birth.date) && (
        <BirthQuickInput onSave={onSaveBirth} />
      )}
      {error && <div style={{ fontSize: 12, color: C.red, marginBottom: 10, wordBreak: "break-word" }}>取得に失敗：{String((error && error.message) || error)}</div>}

      {birth && birth.date && !fortune && !loading && !error && <Empty>「更新」を押すと運気が出ます。</Empty>}

      {birth && birth.date && (() => {
        const s = shugojin(birth);
        return s ? (
          <div style={{ background: `linear-gradient(135deg, ${C.purple}1F, ${C.accent}14)`, border: `1px solid ${C.purple}`, borderRadius: 14, padding: "14px 16px", marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: C.accent, fontWeight: 700, letterSpacing: 1, marginBottom: 2 }}>🛡️ あなたの守護神</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: C.text }}>{s.label}<span style={{ fontSize: 13, color: C.faint, fontWeight: 400 }}>　{s.sub ? `（副：${s.subLabel}）` : ""}</span></div>
            <div style={{ fontSize: 13, color: C.text, lineHeight: 1.6, marginTop: 4 }}>{s.meaning}</div>
            <div style={{ fontSize: 13, color: C.sub, lineHeight: 1.6, marginTop: 4 }}>{s.summary}</div>
            <div style={{ fontSize: 13, color: C.accent, fontWeight: 600, lineHeight: 1.6, marginTop: 6 }}>
              今日のひと工夫 — 会食・商談・大事な場には開運色（{s.color}）を身につけると守護神の力が引き出せます。
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <span style={{ fontSize: 12, color: C.sub, background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 8, padding: "3px 10px" }}>開運色 <b style={{ color: C.text }}>{s.color}</b></span>
              <span style={{ fontSize: 12, color: C.sub, background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 8, padding: "3px 10px" }}>吉方位 <b style={{ color: C.text }}>{s.direction}</b></span>
            </div>
          </div>
        ) : null;
      })()}

      {birth && birth.date && (() => {
        const detail = sanmeiDetail(birth);
        return detail ? (
          <Acc
            title="算命学・人体星図（あなたの星）"
            color={C.purple}
            badge={<span style={{ fontSize: 12, color: C.purple, fontWeight: 700 }}>{detail.center.emoji}{detail.center.star}</span>}
          >
            <div style={{ fontSize: 13, color: C.faint, marginBottom: 4 }}>人体星図 = 生年月日から出す"心の設計図"　／　中心星・主星 = あなたの本質を表す星</div>
            <div style={{ fontSize: 13, color: C.sub, lineHeight: 1.6, marginBottom: 10 }}>
              生年月日から出した8つの星で心の設計図を読み解きます。各星をタップすると詳しい意味が出ます。中央＝本質、頭＝目上、腹＝社会、左手＝友人、右手＝身近な人から見たあなた。
            </div>
            <SanmeiChart detail={detail} />
          </Acc>
        ) : null;
      })()}

      {birth && birth.date && <TenchusatsuDaiunAcc birth={birth} />}

      {birth && birth.date && <SanmeiFlow birth={birth} uranaiLevel={uranaiLevel} />}

      {birth && birth.date && (
        <>
          <div style={{ fontSize: 11, color: C.faint, letterSpacing: 1, textAlign: "center", borderTop: `1px solid ${C.line}`, padding: "10px 0 4px", marginTop: 6 }}>── AI詳細鑑定（仕事運・金運など）──</div>
          {t.theme && (
            <Acc title="今日" badge={<span style={{ color: C.accent, fontSize: 14 }}>{stars(t.score)}</span>}>
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

      <div style={{ fontSize: 12, color: C.sub, marginTop: 4 }}>
        ひとり秘書の鑑定AIによる占いです ・ 参考程度に
      </div>
    </Panel>

    {/* usage=work/split のとき家族相性セクションは控えめ（title変更・AishouPanel非表示）。
        ただし occupation=president のときは仕事相性として AishouPanel を表示する。
        work_private なら通常の家族相性として表示。 */}
    {(() => {
      const isPresident = occupation === "president";
      // 社長 or work_private はパネルタイトルを仕事文脈に
      const panelTitle = isPresident
        ? "人との相性と運気（会食・取引先・幹部）"
        : (usage === "work" || usage === "split")
          ? "チームの相性と運気"
          : "家族・チームの相性と運気";
      const panelHelp = isPresident
        ? "取引先・幹部・会食相手の生年月日から、今日の運気や相性を算命学で読み解きます。商談・組む前の参考に。データはクラウドに保存されます。"
        : "家族・チームメンバーの生年月日から、今日の運気や相性を算命学で読み解きます。追加したメンバーのデータはクラウドに保存されます。";
      // 相性チャートを表示するか（社長ならwork/splitでも表示。それ以外はwork_privateのみ）
      const showAishou = isPresident || (usage !== "work" && usage !== "split");
      const aishouTitle = isPresident
        ? "相性チャート（会食相手・取引先・幹部）"
        : "相性チャート";
      return (
        <Panel
          title={panelTitle}
          accent={FAMILY_COLOR}
          help={panelHelp}
        >
          <Acc title="メンバーの管理" defaultOpen={false}>
            <MemberManager members={members} onSaveMembers={onSaveMembers} />
          </Acc>
          <Acc
            title={isPresident ? "今日のチーム・幹部の運気" : (usage === "work" || usage === "split") ? "今日のチーム運気" : "今日のチーム・家族の運気"}
            defaultOpen={isPresident || usage !== "work"}
            badge={<span style={{ fontSize: 12, color: FAMILY_COLOR, fontWeight: 700 }}>{(members || []).length > 0 ? (() => { try { const all = (birth && birth.date ? [{ name: birth.name || "あなた", birth }] : []).concat((members || []).map((m) => ({ name: m.name, birth: m.birth }))); const r = familyFortune(all); return "★★★★★".slice(0, r.teamScore) + "☆☆☆☆☆".slice(0, 5 - r.teamScore); } catch { return ""; } })() : ""}</span>}
          >
            <FamilyFortunePanel birth={birth} members={members} />
          </Acc>
          {birth && birth.date && (
            <QuickAishouPanel
              birth={birth}
              occupation={occupation}
              onAddMember={onSaveMembers ? (hint) => {
                // メンバー追加フォームへの誘導ヒント（実際の保存はMemberManagerが担う）
                // ここでは状態だけ渡す導線（重実装なし）
              } : null}
            />
          )}
          {showAishou && (
            <Acc title={aishouTitle} defaultOpen={false}>
              <AishouPanel birth={birth} members={members} occupation={occupation} />
            </Acc>
          )}
        </Panel>
      );
    })()}
    </>
  );
}

/* どのカレンダーを仕事/家族として取り込むかの設定 */
function CalendarSettings({ calList, roleForCal, onSetRole, onDisconnect, catForCal, onSetCat }) {
  const [open, setOpen] = useState(false);
  const ROLES = [
    { v: "work", label: "仕事" },
    { v: "family", label: "家族" },
    { v: "off", label: "取り込まない" },
  ];
  const CATS_OPT = ["自動", "施術", "制作", "集客", "経営"];
  return (
    <Panel
      title="カレンダー設定"
      accent={C.sub}
      help="どのGoogleカレンダーを取り込むかを選びます。『仕事』は時間メーターに反映、『家族』は別色でブロッカー表示（メーター除外）、『取り込まない』は非表示。仕事カレンダーには『区分』で既定の役割（施術/制作/集客/経営）を割り当てられます（カレンダーを用途別に分けている人向け。個別の予定はスケジュール側で上書きできます）。"
      right={<button onClick={() => setOpen((o) => !o)} style={chipBtn}>{open ? "閉じる" : "開く"}</button>}
    >
      {open && (
        <div style={{ display: "grid", gap: 12 }}>
          {calList.map((c) => {
            const role = roleForCal(c.id);
            const cat = catForCal ? catForCal(c.id) : "自動";
            return (
              <div key={c.id} style={{ display: "grid", gap: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 14 }}>{c.summary}{c.primary ? "（メイン）" : ""}</span>
                  <div style={{ display: "flex", gap: 4, flex: "0 0 auto" }}>
                    {ROLES.map((r) => (
                      <button
                        key={r.v}
                        onClick={() => onSetRole(c.id, r.v)}
                        style={{ fontSize: 12, padding: "4px 8px", borderRadius: 8, cursor: "pointer", border: `1px solid ${role === r.v ? C.accent : C.line}`, background: role === r.v ? C.accent : "transparent", color: role === r.v ? "#0B0D11" : C.sub, fontWeight: role === r.v ? 700 : 400 }}
                      >{r.label}</button>
                    ))}
                  </div>
                </div>
                {role === "work" && onSetCat && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", paddingLeft: 2 }}>
                    <span style={{ fontSize: 12, color: C.faint, flex: "0 0 auto" }}>区分</span>
                    {CATS_OPT.map((k) => (
                      <button
                        key={k}
                        onClick={() => onSetCat(c.id, k)}
                        style={{ fontSize: 12, padding: "3px 8px", borderRadius: 8, cursor: "pointer", border: `1px solid ${cat === k ? (catColor(k) || C.accent) : C.line}`, background: cat === k ? (catColor(k) || C.accent) : "transparent", color: cat === k ? "#0B0D11" : C.sub, fontWeight: cat === k ? 700 : 400 }}
                      >{k === "自動" ? "自動" : labelOf(k)}</button>
                    ))}
                  </div>
                )}
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

// 区分の表示名を業種に合わせて変える設定（4枠の色と労働/仕組み軸は不変。表示名だけ差し替え）。
function CatLabelSettings({ labels, onChange }) {
  const KEYS = Object.keys(CAT); // 施術/制作/集客/経営
  const axisHint = (k) => (k === "制作" || k === "集客" ? "仕組み（資産になる）" : "労働（自分が動く）");
  const setOne = (k, v) => { const next = { ...labels }; const t = (v || "").trim(); if (!t || t === k) delete next[k]; else next[k] = t; onChange(next); };
  return (
    <Panel
      title="区分の名前（業種に合わせる）"
      accent={C.sub}
      help="時間メーターやスケジュールで使う4つの区分の『表示名』を業種に合わせて変えられます。色と『労働/仕組み』の意味はそのまま。空欄にすると元の名前に戻ります。施術をしない方（コーチ・講師・制作業など）は下のプリセットが便利です。"
    >
      <div style={{ fontSize: 12, color: C.sub, marginBottom: 6 }}>業種プリセット（タップで一括設定）</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
        {CAT_PRESETS.map((p) => (
          <button key={p.id} onClick={() => onChange({ ...p.labels })} style={chipBtn}>{p.name}</button>
        ))}
      </div>
      <div style={{ display: "grid", gap: 10 }}>
        {KEYS.map((k) => (
          <div key={k} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: CAT[k], flex: "0 0 auto" }} />
            <div style={{ flex: "0 0 88px", minWidth: 0 }}>
              <div style={{ fontSize: 12, color: C.sub }}>{k}</div>
              <div style={{ fontSize: 12, color: C.faint }}>{axisHint(k)}</div>
            </div>
            <input value={labels[k] || ""} onChange={(e) => setOne(k, e.target.value)} placeholder={`例：${k}`} style={{ ...inp, marginBottom: 0, flex: 1, minWidth: 0 }} />
          </div>
        ))}
      </div>
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
                {onEdit && <button onClick={() => startEdit(it)} style={iconBtn} title="編集">✏️</button>}
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

/* タスク（締切・優先度つき。並び＝未完了→優先度→締切） */
const TASK_PRI = ["高", "中", "低"];
const PRI_W = { 高: 0, 中: 1, 低: 2 };
function TaskList({ items, onToggle, onAdd, onEdit, onRemove }) {
  const list = items || [];
  const [text, setText] = useState("");
  const [due, setDue] = useState("");
  const [pri, setPri] = useState("中");
  const [editId, setEditId] = useState(null);
  const [e, setE] = useState({ title: "", due: "", priority: "中" });
  const dueSig = (d) => {
    if (!d) return null;
    const diff = Math.ceil((new Date(d) - new Date()) / 86400000);
    if (diff < 0) return { c: C.red, t: `${-diff}日超過` };
    if (diff === 0) return { c: C.red, t: "今日まで" };
    if (diff <= 3) return { c: C.orange, t: `あと${diff}日` };
    return { c: C.sub, t: `あと${diff}日` };
  };
  const priColor = (p) => (p === "高" ? C.red : p === "低" ? C.faint : C.accent);
  const sorted = [...list].sort((a, b) =>
    (a.done ? 1 : 0) - (b.done ? 1 : 0)
    || (PRI_W[a.priority || "中"] - PRI_W[b.priority || "中"])
    || (new Date(a.due || "2999-12-31") - new Date(b.due || "2999-12-31"))
  );
  const startEdit = (it) => { setEditId(it.id); setE({ title: it.title, due: it.due || "", priority: it.priority || "中" }); };
  const saveEdit = () => { if (e.title.trim()) onEdit(editId, { title: e.title.trim(), due: e.due || "", priority: e.priority }); setEditId(null); };
  return (
    <Panel title="追加タスク" accent={C.purple} help="締切と優先度をつけて管理できます。締切が近い・過ぎたタスクは色で警告。並びは『未完了 → 優先度（高→低）→ 締切が近い順』です。">
      <div style={{ display: "grid", gap: 8 }}>
        {sorted.length === 0 && <Empty>タスクはありません。</Empty>}
        {sorted.map((it) => {
          const sig = dueSig(it.due);
          const isTaskSample = String(it.title || "").startsWith("（例）");
          return (
            <div key={it.id}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                <div style={{ marginTop: 2, flex: "0 0 auto" }}><Check done={it.done} onClick={() => onToggle(it.id)} /></div>
                {editId === it.id ? (
                  <div style={{ flex: 1, minWidth: 0, display: "grid", gap: 6 }}>
                    <input autoFocus value={e.title} onChange={(ev) => setE({ ...e, title: ev.target.value })} style={{ ...inp, marginBottom: 0 }} />
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                      <input type="date" value={e.due} onChange={(ev) => setE({ ...e, due: ev.target.value })} style={{ ...inp, marginBottom: 0, flex: "1 1 130px" }} />
                      <select value={e.priority} onChange={(ev) => setE({ ...e, priority: ev.target.value })} style={{ ...inp, marginBottom: 0, width: 84 }}>{TASK_PRI.map((p) => <option key={p} value={p}>優先{p}</option>)}</select>
                      <button onClick={saveEdit} style={chipBtn}>保存</button>
                      <button onClick={() => setEditId(null)} style={iconBtn} title="取消">✕</button>
                    </div>
                  </div>
                ) : (
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, lineHeight: 1.35, textDecoration: it.done ? "line-through" : "none", color: it.done ? C.faint : C.text }}>{it.title}</div>
                    <div style={{ marginTop: 3, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: priColor(it.priority || "中") }}>優先{it.priority || "中"}</span>
                      {sig && !it.done && <span style={{ fontSize: 12, color: sig.c, fontWeight: 600 }}>📅 {sig.t}</span>}
                      {it.due && it.done && <span style={{ fontSize: 12, color: C.faint }}>📅 {fmt(it.due)}</span>}
                    </div>
                  </div>
                )}
                {editId !== it.id && (
                  <div style={{ display: "flex", gap: 2, flex: "0 0 auto" }}>
                    <button onClick={() => startEdit(it)} style={iconBtn} title="編集">✏️</button>
                    <button onClick={() => onRemove(it.id)} style={iconBtn} title="削除">✕</button>
                  </div>
                )}
              </div>
              {isTaskSample && <div style={{ fontSize: 12, color: C.faint, paddingLeft: 50, marginTop: 2 }}>削除して自分のタスクを追加してください</div>}
            </div>
          );
        })}
      </div>
      <form onSubmit={(ev) => { ev.preventDefault(); if (!text.trim()) return; onAdd({ title: text.trim(), due: due || "", priority: pri }); setText(""); setDue(""); setPri("中"); }} style={{ display: "grid", gap: 6, marginTop: 12 }}>
        <input value={text} onChange={(ev) => setText(ev.target.value)} placeholder="タスクを追加…" style={{ ...inp, marginBottom: 0 }} />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <input type="date" value={due} onChange={(ev) => setDue(ev.target.value)} title="締切（任意）" style={{ ...inp, marginBottom: 0, flex: "1 1 130px" }} />
          <select value={pri} onChange={(ev) => setPri(ev.target.value)} style={{ ...inp, marginBottom: 0, width: 84 }}>{TASK_PRI.map((p) => <option key={p} value={p}>優先{p}</option>)}</select>
          <button type="submit" style={{ ...chipBtn, background: C.purple, color: C.invText, borderColor: C.purple }}>追加</button>
        </div>
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

  // CVR差分バッジ：目標CVR(goal/parent) vs 実績CVR(actual/parent) の差分を pt で表示
  // goal/actual 両方が数値として有効な場合のみ表示
  const CvrDiff = ({ goalNum, goalDen, actualNum, actualDen, label }) => {
    if (!goalDen || !goalNum) return null;
    const goalCvr = Math.round((goalNum / goalDen) * 100);
    if (!actualDen) return null;
    const actualCvr = Math.round((actualNum / actualDen) * 100);
    const diff = actualCvr - goalCvr;
    const color = diff >= 0 ? C.green : C.red;
    const sign = diff >= 0 ? "+" : "";
    return (
      <span style={{ fontSize: 12, color, fontWeight: 700, background: color + "18", borderRadius: 6, padding: "1px 6px", whiteSpace: "nowrap" }}>
        {label} 目標{goalCvr}% / 実績{actualCvr}% {sign}{diff}pt
      </span>
    );
  };

  const stage = (no, name, color, sub, pct, width, sig, cvrDiffNode) => (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 5, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: C.faint, flex: "0 0 auto" }}>{no}</span>
        <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{name}</span>
        {sig && <span style={{ fontSize: 12, color: sig.color, fontWeight: 600, whiteSpace: "nowrap" }}>{sig.dot}{sig.label}</span>}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 13, color: done(pct) || color, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{sub}</span>
        <span style={{ fontSize: 12, color: C.sub, width: 42, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{Math.round(pct)}%</span>
      </div>
      {cvrDiffNode && <div style={{ marginBottom: 4 }}>{cvrDiffNode}</div>}
      <div style={{ display: "flex", justifyContent: "center" }}>
        <FunnelBar pct={pct} color={done(pct) || color} width={width} />
      </div>
    </div>
  );

  return (
    <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 12, padding: 14, marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 15, fontWeight: 700, flex: 1, minWidth: 0 }}>{L.name}</span>
        {(() => {
          const upd = Number(L.updatedAt) || 0;
          if (!upd) return null;
          const d = Math.floor((Date.now() - upd) / 86400000);
          const stale = d >= 3;
          if (stale) return <button onClick={() => onEdit(L)} title="数字が古いままです。タップして最新の人数・売上に更新しましょう。" style={{ fontSize: 12, fontWeight: 700, color: C.invText, background: C.orange, border: "none", borderRadius: 6, padding: "2px 8px", cursor: "pointer", flex: "0 0 auto" }}>⚠️ {d}日前 → 更新</button>;
          return <span title="数字を最後に更新した日。手入力なので鮮度に注意。" style={{ fontSize: 12, color: C.faint, flex: "0 0 auto" }}>{d <= 0 ? "今日更新" : `${d}日前の数字`}</span>;
        })()}
        <button onClick={() => onEdit(L)} style={iconBtn} title="編集">✏️</button>
        <button onClick={() => onRemove(L.id)} style={iconBtn} title="削除">✕</button>
      </div>
      <div onClick={() => onEdit(L)} title="タップで数字を入力・更新" style={{ cursor: "pointer" }}>
        {stage("①", "先行登録", C.blue, `${reg} / ${goalReg}人`, regPct, "100%", sigReg,
          <CvrDiff goalNum={goalReg} goalDen={goalReg} actualNum={reg} actualDen={goalReg} label="登録率" />
        )}
        {stage("②", "本申込", C.purple, `${cv}人 · 申込率 ${cvRate}%`, cvPct, "82%", sigCv,
          <CvrDiff goalNum={goalCv} goalDen={goalReg} actualNum={cv} actualDen={reg || goalReg} label="転換CVR" />
        )}
        {stage("③", "売上", C.accent, `${manYen(rev)} / ${manYen(goalRev)}`, revPct, "64%", null, null)}
        <div style={{ fontSize: 12, color: C.sub, marginTop: 6, textAlign: "right" }}>客単価 {yen(price)} × 本申込{cv}人で自動計算</div>
      </div>
      <button onClick={() => onEdit(L)} style={{ ...chipBtn, width: "100%", justifyContent: "center", marginTop: 10, background: C.accent, color: "#0B0D11", borderColor: C.accent, fontWeight: 700 }}>✏️ 数字を入力・更新</button>
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
      <input value={obj.name} onChange={numF(obj, set, "name")} placeholder="名前（例：春の新講座）" style={inp} />
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
      help="「ローンチ」とは新しい講座・商品の期間限定の募集や販売のこと。それ『先行登録 → 本申込 → 売上』の進み具合を1枚で見ます。各段に目標と実績・達成率、締切まで何日かを信号(🟢=余裕 🟠=もうすぐ 🔴=締切すぎ)で表示。売上は『本申込の人数 × 客単価』で自動計算します。数字は✏️からいつでも更新できます。"
      right={<button onClick={() => { setMode(mode === "new" ? null : "new"); setF(blankNew); }} style={chipBtn}>＋販売を登録</button>}
    >
      {mode === "new" && (
        <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: C.sub, marginBottom: 8, lineHeight: 1.6 }}>まず「名前」と「締切日」だけ入れればOK。人数や金額の数字は、あとから✏️でいつでも更新できます。</div>
          {formFields(f, setF)}
          <button
            style={{ ...chipBtn, background: C.accent, color: "#0B0D11", borderColor: C.accent }}
            onClick={() => { if (!f.name.trim()) return; onAdd(toNums(f)); setF(blankNew); setMode(null); }}
          >追加</button>
        </div>
      )}
      {list.length === 0 && <Empty>まだ登録がありません。新しい講座・商品の販売を始めるとき、右上の「＋販売を登録」から目標人数・客単価・売上目標を入れると、登録→申込→売上の進み具合がグラフで見えます。</Empty>}
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
  // 月次サマリ：各項目の「年月」を date（無ければidのタイムスタンプ）から推定して集計
  const monthOf = (it) => {
    if (it.date) return String(it.date).slice(0, 7);
    const n = Number(String(it.id || "").slice(1));
    return n > 1e11 ? iso(new Date(n)).slice(0, 7) : null; // idは "m"+Date.now()
  };
  const nowD = new Date();
  const curYM = `${nowD.getFullYear()}-${pad2(nowD.getMonth() + 1)}`;
  const pvD = new Date(nowD.getFullYear(), nowD.getMonth() - 1, 1);
  const prevYM = `${pvD.getFullYear()}-${pad2(pvD.getMonth() + 1)}`;
  const sumKM = (kind, ym) => sum(list.filter((x) => x.kind === kind && monthOf(x) === ym));
  const incCur = sumKM("入金", curYM), expCur = sumKM("支払", curYM), incPrev = sumKM("入金", prevYM);
  const diffCur = incCur - expCur;
  const incPct = incPrev > 0 ? Math.round(((incCur - incPrev) / incPrev) * 100) : null;

  const isSample = (it) => String(it.title || "").startsWith("（例）");
  const renderRow = (it) => (
    <div key={it.id}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
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
            {it.kind && <span style={{ fontSize: 12, color: kindColor(it.kind), fontWeight: 700 }}>{it.kind}</span>}
            <button onClick={() => startEdit(it)} style={iconBtn} title="編集">✏️</button>
            <button onClick={() => onRemove(it.id)} style={iconBtn} title="削除">✕</button>
          </>
        )}
      </div>
      {isSample(it) && <div style={{ fontSize: 12, color: C.faint, paddingLeft: 50, marginTop: 2 }}>削除して自分の項目を追加してください</div>}
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
      <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 12px", marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: C.sub, marginBottom: 6 }}>{nowD.getMonth() + 1}月の集計</div>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "baseline", fontSize: 14 }}>
          <span style={{ color: C.green, fontWeight: 700 }}>入金 {yen(incCur)}</span>
          <span style={{ color: C.red, fontWeight: 700 }}>支払 {yen(expCur)}</span>
          <span style={{ color: C.text, fontWeight: 700 }}>差引 {yen(diffCur)}</span>
          {incPct !== null && <span style={{ fontSize: 12, color: incPct >= 0 ? C.green : C.red }}>前月比 入金 {incPct >= 0 ? "+" : ""}{incPct}%</span>}
        </div>
        <div style={{ fontSize: 12, color: C.faint, marginTop: 6 }}>※登録した日付で集計（過去データは登録日基準）。入金・支払の項目に金額を入れると反映されます。</div>
      </div>
      <SwipeView slides={slides} accent={C.accent} hint="← 横スワイプで すべて / 請求 / 売上 / 経費 →" />
      <form
        onSubmit={(ev) => { ev.preventDefault(); if (!title.trim()) return; onAdd({ title: title.trim(), amount: Number(amount) || 0, kind, date: iso(new Date()) }); setTitle(""); setAmount(""); }}
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
  return <div style={{ fontSize: 14, color: C.sub, padding: "8px 2px", lineHeight: 1.6 }}>{children}</div>;
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
      right={notifySupported && !notify ? <button onClick={onEnableNotify} style={chipBtn}>通知オン</button> : (notify ? <span style={{ fontSize: 12, color: C.green }}>通知オン</span> : null)}
    >
      {none ? (
        <div style={{ fontSize: 14, color: C.green, lineHeight: 1.7 }}>今日の対応はぜんぶ片付いてるよ。よかった。</div>
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
          <button onClick={onRefresh} disabled={refreshing} title="今すぐ最新の予定に更新" style={{ ...chipBtn, fontSize: 12, padding: "3px 8px", color: refreshing ? C.faint : C.green, borderColor: C.line }}>
            {refreshing ? "更新中…" : "🔄 更新"}
          </button>
        )}
      </div>
    );
  }
  const isErr = status === "error";
  return (
    <div style={{ fontSize: 13, color: C.text, background: C.panel2, border: `1px solid ${isErr ? C.red : C.orange}`, borderRadius: 8, padding: "9px 11px", marginBottom: 12 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "flex-start", marginBottom: 8 }}>
        <span>{isErr ? "⚠️" : "👀"}</span>
        <span style={{ color: isErr ? C.red : C.text, wordBreak: "break-word" }}>
          {isErr
            ? `カレンダー取得に失敗：${(error && error.message) || error}`
            : <><b style={{ color: C.orange }}>これは使い方のサンプルです（あなたの予定・実績ではありません）。</b>Googleカレンダーを連携すると、あなたの予定に置き換わります。一度連携すれば以後は自動で維持され、毎回ログインし直す必要はありません。<br /><span style={{ color: C.faint }}>連携は任意です。後からいつでもOK。連携しなくてもほかの機能はすべて使えます。</span></>}
        </span>
      </div>
      <button
        onClick={onConnect}
        disabled={connecting}
        style={{ ...chipBtn, background: connecting ? "transparent" : C.invBg, color: connecting ? C.sub : C.invText, borderColor: connecting ? C.line : C.invBg, fontWeight: 700 }}
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
          <div style={{ fontSize: 12, letterSpacing: 4, color: C.accent }}>社長・ひとり起業家のための</div>
          <h1 style={{ fontSize: 30, margin: "6px 0 12px" }}>ひとり秘書</h1>
          <p style={{ color: C.text, fontSize: 16, fontWeight: 700, lineHeight: 1.7, margin: "0 0 6px" }}>
            講座の締切も、経営の段取りも。<br />ぜんぶ逆算して「抜け漏れ」を防ぐ秘書。
          </p>
          <p style={{ color: C.sub, fontSize: 13, lineHeight: 1.7, margin: "0 0 24px" }}>
            事業を<strong style={{ color: C.text }}>ひとりで背負う人</strong>のための、段取り・意思決定・運気サポート。<br />ひとり起業家から会社経営者まで。
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

        <div style={{ textAlign: "center", fontSize: 13, fontWeight: 700, color: C.accent, marginBottom: 4 }}>
          ✓ 今は無料・クレジットカード登録なし
        </div>
        <div style={{ textAlign: "center", fontSize: 12, color: C.sub, marginBottom: 8 }}>
          正式版は買い切り ¥10,000 / サブスクなし・更新手続きも不要
        </div>
        <button
          onClick={onLogin}
          style={{ width: "100%", padding: "14px 16px", borderRadius: 12, border: "none", background: C.accent, color: "#0B0D11", fontWeight: 700, cursor: "pointer", fontSize: 16 }}
        >
          Googleではじめる
        </button>
        <p style={{ color: C.faint, fontSize: 12, lineHeight: 1.7, textAlign: "center", margin: "12px 0 0" }}>
          お試し版です。気に入らなければいつでもやめられます。<br />
          ログインすると、あなた専用のデータ領域が作られます。<br />他の人のデータとは完全に分かれています。
        </p>

        {error && (
          <div style={{ marginTop: 18, textAlign: "left", background: C.panel2, border: `1px solid ${C.red}`, borderRadius: 10, padding: 12 }}>
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
            <div style={{ fontSize: 12, color: C.faint, marginBottom: 4 }}>ご案内の送り先</div>
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
        <p style={{ color: C.faint, fontSize: 12, lineHeight: 1.7, margin: "16px 0 0" }}>
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
  // 予定の役割を記憶/変更したときの一時メッセージ（学習したことを見える化）
  const [catMsg, setCatMsg] = useState("");
  const catMsgRef = useRef(null);
  const flashCatMsg = (m) => { setCatMsg(m); if (catMsgRef.current) clearTimeout(catMsgRef.current); catMsgRef.current = setTimeout(() => setCatMsg(""), 3500); };

  // ── 通知（任意）：開いた時に遅れがあればブラウザ通知 ──
  const notifySupported = typeof Notification !== "undefined";
  const [notify, setNotify] = useState(() => localStorage.getItem("viele-notify") === "1");
  const notifiedRef = useRef(false);
  const cloud = useCloud(firebaseEnabled ? user?.uid || null : null, seed);
  const local = useLocal(STORE_KEY, seed);
  const { data, loading, error, update } = firebaseEnabled ? cloud : local;
  // 区分の表示名を業種設定で差し替え（描画前に反映。子コンポーネントは labelOf() で参照）
  // profile.occupation からも自動でプリセットを適用（catLabels が明示設定されていれば優先）
  CAT_LABELS = (() => {
    const explicit = (data && data.catLabels) || {};
    if (Object.keys(explicit).length > 0) return explicit;
    const occ = data && data.profile && data.profile.occupation;
    if (occ) {
      const preset = CAT_PRESETS.find((p) => p.id === occ);
      if (preset) return preset.labels;
    }
    return {};
  })();
  // テーマを描画前に反映（C や inp/chipBtn/iconBtn が現在テーマの色で解決される）
  THEME_NAME = data && data.theme === "light" ? "light" : "dark";

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
  // 端末のオーバースクロール等で地が見えても背景が揃うよう、body色をテーマに追従させる
  useEffect(() => { document.body.style.background = THEMES[THEME_NAME].bg; }, [data && data.theme]);
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
  // 許可リスト外でログインした人は"行き止まり"にせず、事前登録（waitlist）へ案内する
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
  const calCat = data.calCat || {};       // カレンダーID→既定の役割(施術/制作/集客/経営)。未設定はタイトルから自動判定。
  const axisOfCat = (cat) => (cat === "制作" || cat === "集客" ? "仕組み" : "労働");
  const axisMap = data.axisMap || {}; // 予定名→労働/仕組み の手動上書き（メーターの精度を上げる）
  // 予定名→役割を記憶（同名の予定にも次回から自動適用）。"自動"を渡すと記憶を消して自動判定へ戻す。
  const setEventCat = (title, cat) => {
    const next = { ...catMap };
    if (cat === "自動") { delete next[title]; flashCatMsg(`「${title}」を自動判定に戻しました`); }
    else { next[title] = cat; flashCatMsg(`「${title}」を${labelOf(cat)}として記憶しました（同名の予定にも反映）`); }
    update({ catMap: next });
  };
  // 予定名→「労働/仕組み」を記憶。"自動"でcatからの自動判定に戻す。メーターの仕組み化%の精度に直結。
  const setEventAxis = (title, axis) => {
    const next = { ...axisMap };
    if (axis === "自動") { delete next[title]; flashCatMsg(`「${title}」の労働/仕組みを自動に戻しました`); }
    else { next[title] = axis; flashCatMsg(`「${title}」を「${axis}」として記憶しました（同名の予定にも反映）`); }
    update({ axisMap: next });
  };
  const setCalRole = (calId, role) => update({ calConfig: { ...calConfig, [calId]: role } });
  // カレンダー単位の既定区分。"自動"で解除（タイトルから判定に戻す）。
  const setCalCat = (calId, cat) => { const next = { ...calCat }; if (cat === "自動") delete next[calId]; else next[calId] = cat; update({ calCat: next }); };
  const catForCal = (calId) => calCat[calId] || "自動";
  const roleForCal = (calId) => {
    if (calConfig[calId]) return calConfig[calId];
    const c = calList.find((x) => x.id === calId);
    return c && c.primary ? "work" : "off"; // 既定: primary=仕事、その他=取り込まない
  };
  const buildEntry = (ev) => {
    const role = roleForCal(ev.calendarId);
    // 終日予定は "YYYY-MM-DD" のみの文字列が来る。そのまま new Date() するとUTC00:00解釈になり
    // JSTでは前日になるため、終日のときはローカル時刻の00:00として解釈する。
    const startRaw = ev.startISO;
    const start = ev.allDay && /^\d{4}-\d{2}-\d{2}$/.test(startRaw)
      ? new Date(startRaw + "T00:00:00")
      : new Date(startRaw);
    const end = ev.endISO ? (ev.allDay && /^\d{4}-\d{2}-\d{2}$/.test(ev.endISO) ? new Date(ev.endISO + "T00:00:00") : new Date(ev.endISO)) : null;
    const hours = ev.allDay ? 0 : end ? Math.max(0.25, (end - start) / 3600000) : 1;
    // 役割の決定順：①予定名で記憶(manual) ②カレンダー単位の既定(cal) ③タイトルから自動(auto)
    let cat, axis, catSource;
    if (role === "family") { cat = "家族"; axis = "家族"; catSource = "family"; }
    else if (catMap[ev.title]) { cat = catMap[ev.title]; axis = axisOfCat(cat); catSource = "manual"; }
    else if (calCat[ev.calendarId]) { cat = calCat[ev.calendarId]; axis = axisOfCat(cat); catSource = "cal"; }
    else { const c = classifyEvent(ev.title); cat = c.cat; axis = c.axis; catSource = "auto"; }
    // 労働/仕組みの手動上書き（家族以外）。axisSourceでUI表示を出し分け。
    let axisSource = "auto";
    if (role !== "family" && axisMap[ev.title]) { axis = axisMap[ev.title]; axisSource = "manual"; }
    return { ...ev, role, start, wd: start.getDay(), time: ev.allDay ? "終日" : `${pad2(start.getHours())}:${pad2(start.getMinutes())}`, hours, cat, axis, catSource, axisSource };
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

  // 書き込み可能なカレンダーID（予定一覧での✏️編集・✕削除の可否判定に使う）
  const writableCalIds = new Set((calList || []).filter((c) => c.accessRole === "owner" || c.accessRole === "writer").map((c) => c.id));

  const alerts = computeAlerts(data);
  // 売上タブのローンチ締切を、仕事タブの締切ボードに読み取り専用で並べるためのリンク項目
  const launchLinked = (data.launches || []).flatMap((L) =>
    launchDeadlines(L).map((d) => ({ id: `lk:${L.id}:${d.stage}`, title: L.name, stage: `${d.stage}締切`, date: d.date, linked: true }))
  );
  const moneyOutstanding = (data.money || []).filter((x) => !x.done).reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const briefFirst = (data.digest && data.digest.briefing ? data.digest.briefing.split("\n").filter((l) => l.trim())[0] : "");

  // トップのタブ（キー方式。ニュース/運気は設定で非表示にできる＝販売時はコアに集中できる）
  // ニュースは既定で非表示（既存ユーザーにも適用。設定で明示的にON=news:false にすれば表示）
  const hiddenTabs = { news: true, ...((data && data.hiddenTabs) || {}) };
  const ALL_TABS = [
    { key: "home", label: "ホーム" },
    { key: "work", label: "仕事" },
    { key: "money", label: "売上" },
    { key: "tasks", label: "タスク" },
    { key: "news", label: "ニュース" },
    { key: "fortune", label: "運気" },
  ];
  const TABS = ALL_TABS.filter((t) => !hiddenTabs[t.key]);
  // タブバーから隠れていても、ホームのカード（ニュース1行/運気）から開いた場合は表示できるようにする
  const activeTab = ALL_TABS.some((t) => t.key === tab) ? tab : "home";
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
      <header style={{ position: "sticky", top: 0, zIndex: 10, background: C.bg, borderBottom: `1px solid ${C.line}`, padding: "10px 14px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <strong style={{ fontSize: 16, letterSpacing: 1 }}>ひとり秘書</strong>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: C.sub }}>{dateLabel}</span>
          <button onClick={cycleFont} title="文字サイズを変える" style={{ ...iconBtn, fontSize: 12, padding: "4px 8px", width: "auto", border: `1px solid ${C.line}`, borderRadius: 8 }}>文字{fontLabel}</button>
          <button onClick={() => update({ theme: data.theme === "light" ? "dark" : "light" })} title="背景の明るさを変える" style={{ ...iconBtn, fontSize: 12, padding: "4px 8px", width: "auto", border: `1px solid ${C.line}`, borderRadius: 8 }}>{data.theme === "light" ? "🌙暗くする" : "🌞明るくする"}</button>
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
この端末だけに保存中です。スマホとパソコンなど複数の端末で同じデータを使うには、初期設定が必要です（詳しくは案内ページへ）。
          </div>
        )}

        {activeTab === "home" && (() => {
          const pendingTasks = (data.tasks || []).filter((x) => !x.done).length;
          const remaining = alerts.late.length + alerts.soon.length + pendingTasks;
          const profile = data.profile || null;
          const uranaiLevel = (profile && profile.uranaiLevel) || null;
          const usage = (profile && profile.usage) || null;
          // オンボーディングウィザード：profile未完了かつスキップ済みでなければ表示
          const showOnboarding = !(profile && profile.done) && !data.onboardingSkipped;
          // お母さんの声かけ（momVoice: 未設定はオン扱い）
          const momVoiceOn = data.momVoice !== false;
          const homeEnergy = (() => { try { return (data.birth && data.birth.date) ? dayEnergy(data.birth, iso(new Date())) : null; } catch { return null; } })();
          const momMsgs = momVoiceOn ? computeMomMessages(data, alerts, dayBuckets[0] && dayBuckets[0].items, homeEnergy) : { praise: null, worries: [], restCare: null };
          return (
            <>
              {/* 初回ヒアリング ウィザード */}
              {showOnboarding && (
                <OnboardingWizard
                  onSave={({ profile: p, birth: b, catLabels }) => {
                    const patch = { profile: p, onboardingSkipped: false };
                    if (b) {
                      const pref = PREFS.find((x) => x[0] === "東京");
                      patch.birth = { date: b, time: "12:00", place: "東京", lat: pref[1], lon: pref[2], utcOffset: 9, gender: "" };
                    }
                    if (catLabels && Object.keys(catLabels).length > 0) patch.catLabels = catLabels;
                    update(patch);
                  }}
                  onSkip={() => update({ onboardingSkipped: true })}
                />
              )}
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
                        if (window.confirm("サンプルデータをすべて削除しますか？この操作は取り消せません。\n※ 生年月日・プロフィール・記念日はそのまま残ります。")) {
                          update({ trips: [], deadlines: [], launches: [], content: [], money: [], tasks: [], manualEvents: [], sampleNotice: false });
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
                const isPresidentOnboard = profile && profile.occupation === "president";
                const steps = [
                  { n: 1, label: "自分のデータにする", hint: "上の「サンプルを全部消す」or「これは自分のデータ」を押す", done: !data.sampleNotice },
                  { n: 2, label: "生年月日を登録する", hint: isPresidentOnboard ? "「意思決定の一手」と経営カレンダーが動き出します" : "「今日の一手」と経営カレンダーが動き出します", done: !!data.birth, action: () => setTab("fortune"), btn: "運気タブへ" },
                  { n: 3, label: "Googleカレンダーを連携（任意）", hint: isPresidentOnboard ? "会議・会食・商談の予定が自動で取り込まれ、逆算の段取りも自動生成" : "予定が自動で取り込まれ、逆算の手配も自動生成", done: usingCal, action: connectCalendar, btn: "連携する" },
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
              {/* 業種プロンプト：catLabels 未設定・sampleNotice 終了後・industryPromptDismissed でなければ表示。
                  ただしウィザード完了済み(profile.done)またはスキップ済み(onboardingSkipped)のときは非表示
                  （ウィザードで職種を設定しているため二重になる） */}
              {!data.sampleNotice && !data.industryPromptDismissed && !Object.keys(data.catLabels || {}).length && !showOnboarding && !(data.profile && data.profile.done) && (
                <IndustryPrompt
                  onSelect={(preset) => {
                    update({ catLabels: preset.labels, industryPromptDismissed: true });
                  }}
                  onDismiss={() => update({ industryPromptDismissed: true })}
                />
              )}
              <BriefingCard fortune={data.fortune} birth={data.birth} today={dayBuckets[0].items} late={alerts.late.length} soon={alerts.soon.length} outstanding={moneyOutstanding} brief={briefFirst} onTab={setTab} remaining={remaining} pendingTasks={pendingTasks} hideFortune={!!hiddenTabs.fortune} hideNews={!!hiddenTabs.news} profile={profile} annivSettings={data.annivSettings} anniversaries={data.anniversaries} />
              {/* お母さんの声かけ（褒める・心配・休息ケア） */}
              <MomVoiceCard praise={momMsgs.praise} worries={momMsgs.worries} restCare={momMsgs.restCare} restCareTab={momMsgs.restCareTab} guide={momMsgs.guide} onTab={setTab} />
              {/* 出生情報未登録時のクイック入力バナー（サンプル削除後・一般利用の「空状態」に表示） */}
              {(!data.birth || !data.birth.date) && !data.sampleNotice && (
                <BirthQuickInput
                  onSave={(b) => { update({ birth: b }); setTab("fortune"); }}
                  onDismiss={null}
                  occupation={profile && profile.occupation}
                />
              )}
              <AlertSummary alerts={alerts} notify={notify} notifySupported={notifySupported} onEnableNotify={enableNotify} />
              <AnniversaryPanel
                annivSettings={data.annivSettings}
                anniversaries={data.anniversaries}
                onUpdateSettings={(s) => update({ annivSettings: s })}
                onUpdateAnniversaries={(a) => update({ anniversaries: a })}
                onAddTrip={addTrip}
              />
              {usingCal && <AddEventBar calList={calList} onCreate={createCalEvent} busy={calWriteBusy} msg={calWriteMsg} onReconnect={connectCalendar} />}
              {catMsg && (
                <div style={{ background: C.green + "1A", border: `1px solid ${C.green}`, color: C.text, borderRadius: 10, padding: "8px 12px", marginBottom: 10, fontSize: 13 }}>✓ {catMsg}</div>
              )}
              {/* usage=split: 仕事/プライベートの表示切替ラベル（カテゴリフィルタの案内） */}
              {usage === "split" && (
                <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 10, padding: "8px 12px", marginBottom: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: C.accent }}>↔️ 仕事とプライベートを分けて管理中</span>
                  <span style={{ fontSize: 12, color: C.sub }}>仕事=区分タグあり ／ プライベート=「家族」カラー</span>
                </div>
              )}
              <Schedule days={dayBuckets} {...calProps} onSetCat={setEventCat} onSetAxis={setEventAxis} writableIds={writableCalIds} onEditEvent={updateCalEvent} onDeleteEvent={deleteCalEvent} editBusy={calWriteBusy} />
              <TimeMeter entries={scheduleEntries} {...calProps} />
              {(usingCal || manualEntries.length > 0) && <Upcoming events={upcoming} writableIds={writableCalIds} onEditEvent={updateCalEvent} onDeleteEvent={deleteCalEvent} editBusy={calWriteBusy} />}
              <Acc title="設定・取り込み" defaultOpen={false}>
                {usingCal && calList.length > 0 && <CalendarSettings calList={calList} roleForCal={roleForCal} onSetRole={setCalRole} onDisconnect={disconnectCalendar} catForCal={catForCal} onSetCat={setCalCat} />}
                <CatLabelSettings labels={data.catLabels || {}} onChange={(l) => update({ catLabels: l })} />
                <ScheduleImport importing={importing} msg={importMsg} count={(data.manualEvents || []).length} onPick={importSchedule} onClear={clearManual} />
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
                {/* お母さんの声かけ オン/オフ */}
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.line}` }}>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>お母さんの声かけ</div>
                  <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", padding: "4px 0" }}>
                    <input
                      type="checkbox"
                      checked={data.momVoice !== false}
                      onChange={(ev) => update({ momVoice: ev.target.checked })}
                      style={{ width: 18, height: 18, flex: "0 0 auto" }}
                    />
                    <span style={{ fontSize: 14 }}>褒める・心配する・休息をすすめる声かけを表示する</span>
                  </label>
                  <div style={{ fontSize: 12, color: C.faint, marginTop: 2 }}>ホームの「今朝のまとめ」付近に、状況に合った一言が出ます。</div>
                </div>
                {/* プロフィール設定（ウィザード完了後の変更用） */}
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.line}` }}>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>プロフィール設定</div>
                  {profile && profile.done ? (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                      <span style={{ fontSize: 13, color: C.sub }}>
                        職種: {(ONBOARD_OCCUPATIONS.find((o) => o.id === profile.occupation) || {}).label || profile.occupation}
                        ・ 規模: {(ONBOARD_SCALES.find((s) => s.id === profile.scale) || {}).label || profile.scale}
                        ・ 用途: {(ONBOARD_USAGES.find((u) => u.id === profile.usage) || {}).label || profile.usage}
                        ・ 運気: {(ONBOARD_URANAI.find((u) => u.id === profile.uranaiLevel) || {}).label || profile.uranaiLevel}
                      </span>
                      <button
                        onClick={() => update({ profile: null, onboardingSkipped: false })}
                        style={{ ...chipBtn, fontSize: 12, color: C.sub, borderColor: C.line }}
                      >再設定</button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ fontSize: 13, color: C.sub }}>まだ設定されていません。</span>
                      <button
                        onClick={() => update({ onboardingSkipped: false })}
                        style={{ ...chipBtn, fontSize: 12, background: C.accent, color: "#0B0D11", borderColor: C.accent }}
                      >セットアップを開始</button>
                    </div>
                  )}
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
                {/* 価格・プラン */}
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.line}` }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 4 }}>料金プラン</div>
                  <div style={{ background: C.accent + "18", border: `1px solid ${C.accent}`, borderRadius: 10, padding: "10px 14px" }}>
                    <div style={{ fontSize: 15, fontWeight: 800, color: C.text, marginBottom: 3 }}>買い切り ¥10,000（サブスクではありません）</div>
                    <div style={{ fontSize: 12, color: C.sub, lineHeight: 1.7 }}>秘書の手間と鑑定費用をこれ1つに。一度きりのお支払いでずっと使えます。<br />月額なし・更新なし・解約手続き不要です。</div>
                  </div>
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
              usage={(data.profile && data.profile.usage) || null}
            />
            <DeadlineBoard deadlines={data.deadlines} linked={launchLinked} launches={data.launches} birth={data.birth} onAdd={addDeadline} onAddBulk={addDeadlinesBulk} onEdit={editDeadline} onRemove={removeDeadline} />
            <CheckList
              title="コンテンツ制作サイクル"
              accent={C.blue}
              items={data.content}
              onToggle={content.toggle}
              onAdd={content.add}
              onEdit={content.edit}
              onRemove={content.remove}
              placeholder="制作物を追加…"
              renderMeta={(it) => it.phase && <span style={{ fontSize: 12, color: C.blue, fontWeight: 700 }}>{it.phase}</span>}
            />
          </>
        )}

        {activeTab === "money" && (
          <>
            <LaunchKpi
              launches={data.launches}
              onAdd={(item) => launches.add({ ...item, updatedAt: Date.now() })}
              onEdit={(id, patch) => launches.edit(id, { ...patch, updatedAt: Date.now() })}
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
          <TaskList
            items={data.tasks}
            onToggle={tasks.toggle}
            onAdd={tasks.add}
            onEdit={tasks.edit}
            onRemove={tasks.remove}
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

        {activeTab === "fortune" && (() => {
          const fortuneProfile = data.profile || null;
          const fortuneUranai = (fortuneProfile && fortuneProfile.uranaiLevel) || null;
          const fortuneUsage = (fortuneProfile && fortuneProfile.usage) || null;
          return (
            <>
              <BizCalendar
                birth={data.birth}
                trips={data.trips}
                deadlines={data.deadlines}
                launches={data.launches}
                events={pool.map((e) => ({ date: `${e.start.getFullYear()}-${pad2(e.start.getMonth() + 1)}-${pad2(e.start.getDate())}`, title: e.title }))}
                onPlan={(d) => addDeadline({ title: fortuneProfile && fortuneProfile.occupation === "president" ? "重要決断・商談" : "発信・告知", stage: "告知", date: d })}
                profile={fortuneProfile}
              />
              <BestDaysPanel
                birth={data.birth}
                occupation={fortuneProfile && fortuneProfile.occupation}
                onPlan={(d) => addDeadline({ title: fortuneProfile && fortuneProfile.occupation === "president" ? "重要決断・商談" : "大事な予定", stage: "告知", date: d })}
              />
              <FortunePanel
                fortune={data.fortune}
                loading={fortuneLoading}
                error={fortuneError}
                aiOff={!!(data.fortune && data.fortune.aiEnabled === false)}
                onRefresh={() => refreshFortune()}
                birth={data.birth}
                onSaveBirth={(b) => { update({ birth: b }); refreshFortune(b); }}
                members={data.members || []}
                onSaveMembers={(m) => update({ members: m })}
                uranaiLevel={fortuneUranai}
                usage={fortuneUsage}
                occupation={fortuneProfile && fortuneProfile.occupation}
              />
            </>
          );
        })()}

        <footer style={{ textAlign: "center", color: C.faint, fontSize: 12, padding: "12px 0 32px" }}>
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
const inp = dyn(() => ({
  width: "100%",
  boxSizing: "border-box",
  background: C.panel,
  border: `1px solid ${C.line}`,
  borderRadius: 8,
  color: C.text,
  padding: "8px 10px",
  fontSize: 14,
  marginBottom: 8,
  outline: "none",
}));
const lbl = dyn(() => ({
  flex: 1,
  minWidth: 0,
  fontSize: 13,
  color: C.sub,
  display: "flex",
  flexDirection: "column",
  gap: 3,
}));
const chipBtn = dyn(() => ({
  background: "transparent",
  border: `1px solid ${C.line}`,
  color: C.text,
  borderRadius: 8,
  padding: "9px 14px",
  fontSize: 14,
  cursor: "pointer",
  whiteSpace: "nowrap",
  minHeight: 40,
  display: "inline-flex",
  alignItems: "center",
}));
const iconBtn = dyn(() => ({
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
}));

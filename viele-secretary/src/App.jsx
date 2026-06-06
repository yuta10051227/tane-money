import { useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, GoogleAuthProvider } from "firebase/auth";
import { auth, googleProvider, firebaseEnabled } from "./firebase";
import { useCloud } from "./useCloud";
import { useLocal } from "./useLocal";
import { CALENDAR_SCOPE, fetchCalendarList, fetchEvents, classifyEvent, isNotable, startOfWeekMonday, pad2 } from "./calendar";

const STORE_KEY = "viele-secretary";

/* ──────────────────────────────────────────────────────────────
   配色（落ち着いた秘書ダッシュボード）
   ────────────────────────────────────────────────────────────── */
const C = {
  bg: "#0F1115",
  panel: "#171A21",
  panel2: "#1E222B",
  line: "#2A2F3A",
  text: "#E8EAED",
  sub: "#A7AEB8",
  faint: "#8C95A2",
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
  return startOfDay(d).toISOString().slice(0, 10);
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
        title: "大阪セミナー登壇",
        template: "遠方登壇",
        date: iso(addDays(now, 21)),
        items: templateItems("遠方登壇").map((it, i) => ({ ...it, done: i < 2 })),
      },
      {
        id: "t2",
        title: "福岡 日帰り施術会",
        template: "日帰り",
        date: iso(addDays(now, 9)),
        items: templateItems("日帰り").map((it, i) => ({ ...it, done: i < 1 })),
      },
      {
        id: "t3",
        title: "バリ 海外実習",
        template: "海外実習",
        date: iso(addDays(now, 75)),
        items: templateItems("海外実習").map((it, i) => ({ ...it, done: i < 1 })),
      },
    ],
    // 二段ローンチ：LINE先行登録 → セミナー本申込
    deadlines: [
      { id: "d1", title: "LINE先行登録 開始", date: iso(addDays(now, 25)), stage: "先行登録" },
      { id: "d2", title: "セミナー本申込 開始", date: iso(addDays(now, 40)), stage: "本申込" },
    ],
    content: [
      { id: "c1", title: "YouTube 長尺（今週分）", phase: "撮影", done: false },
      { id: "c2", title: "ショート 切り抜き 3本", phase: "編集", done: false },
      { id: "c3", title: "ブログ 1本（SEO）", phase: "執筆", done: true },
    ],
    money: [
      { id: "m1", title: "MF請求書 今月分 発行", amount: 0, kind: "請求", done: false },
      { id: "m2", title: "Academy 月額 入金確認", amount: 0, kind: "入金", done: false },
    ],
    tasks: [{ id: "k1", title: "確定申告まわりの資料整理", done: false }],
    // 固定費・サブスク。次回請求日は保存せず anchorDate＋サイクルから毎回算出する
    // （月が替わると自動で次回へ繰り越す＝再計算不要）。amount は1サイクルあたりの金額（円）。
    subscriptions: [
      { id: "s1", name: "Adobe Creative Cloud", amount: 7280, cycle: "monthly", anchorDate: iso(addDays(now, -27)), category: "制作・学習", note: "写真プラン", active: true },
      { id: "s2", name: "ChatGPT Plus", amount: 3000, cycle: "monthly", anchorDate: iso(addDays(now, 18)), category: "仕事ツール", note: "", active: true },
      { id: "s3", name: "Notion", amount: 1650, cycle: "monthly", anchorDate: iso(addDays(now, 11)), category: "仕事ツール", note: "プラスプラン", active: true },
      { id: "s4", name: "Netflix", amount: 1890, cycle: "monthly", anchorDate: iso(addDays(now, 24)), category: "生活・通信", note: "", active: true },
      { id: "s5", name: "ドメイン更新（お名前.com）", amount: 1500, cycle: "yearly", anchorDate: iso(addDays(now, 45)), category: "経営・会計", note: "", active: true },
    ],
    subSettings: { remindDays: 7, notify: false },
    // 定期収入（売上）。固定費と対称。毎月の発生額は anchorDate＋cycle から自動計上。
    recurringRevenues: [
      { id: "r1", name: "月額顧問（A社）", customer: "A社", amount: 50000, cycle: "monthly", anchorDate: iso(addDays(now, 5)), category: "顧問・コンサル", note: "", active: true },
      { id: "r2", name: "オンラインサロン", customer: "", amount: 120000, cycle: "monthly", anchorDate: iso(addDays(now, -10)), category: "講座・月額", note: "会費合計", active: true },
    ],
    // 単発収入（実績ログ）
    revenues: [
      { id: "o1", title: "単発施術 まとめ", customer: "", amount: 84000, date: iso(addDays(now, -3)), category: "施術・サービス" },
      { id: "o2", title: "スポットコンサル", customer: "B社", amount: 50000, date: iso(addDays(now, -12)), category: "顧問・コンサル" },
    ],
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
        width: 28,
        height: 28,
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
function TripChain({ trips, onToggle, onAdd, onRemove, onEditTrip, onAddItem, onEditItem, onRemoveItem }) {
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
    <Panel title="出張・遠征の逆算チェーン" accent={C.green} help="本番日から逆算して、各手配の締切と信号（🟢=済 🟠=もうすぐ 🔴=遅れ）を自動表示します。「型から追加」で遠征の種類を選ぶと、手配項目が一式そろいます。" right={<AddTrip onAdd={onAdd} />}>
      {(!trips || trips.length === 0) && <Empty>遠征予定はありません。右上の「＋型から追加」で作成。</Empty>}
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
                  <span style={{ fontSize: 11, color: C.sub, border: `1px solid ${C.line}`, borderRadius: 6, padding: "1px 6px" }}>{trip.template}</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 12, color: C.sub }}>本番 {fmt(trip.date)}</span>
                  <button onClick={() => startTrip(trip)} style={iconBtn} title="編集">✎</button>
                  <button onClick={() => onRemove(trip.id)} style={iconBtn} title="削除">✕</button>
                </div>
              )}
              <div style={{ fontSize: 12, color: dleft < 0 ? C.red : C.accent, margin: "4px 0 10px" }}>
                {dleft < 0 ? `本番から${-dleft}日経過` : `本番まであと ${dleft}日`} ・ 手配 {doneCount}/{trip.items.length}
              </div>
              <div style={{ display: "grid", gap: 6 }}>
                {trip.items.map((item, idx) => {
                  const sig = itemSignal(item, trip.date);
                  if (editItem && editItem.tripId === trip.id && editItem.idx === idx) {
                    return (
                      <div key={idx} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <input value={ie.label} onChange={(e) => setIe({ ...ie, label: e.target.value })} style={{ ...inp, marginBottom: 0, flex: "1 1 120px" }} />
                        <input value={ie.daysBefore} onChange={(e) => setIe({ ...ie, daysBefore: e.target.value })} inputMode="numeric" title="本番の何日前" style={{ ...inp, marginBottom: 0, width: 56 }} />
                        <span style={{ fontSize: 11, color: C.faint }}>日前</span>
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
                      </div>
                    </div>
                  );
                })}
              </div>
              {addItemFor === trip.id ? (
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                  <input autoFocus value={ni.label} onChange={(e) => setNi({ ...ni, label: e.target.value })} placeholder="手配項目" style={{ ...inp, marginBottom: 0, flex: "1 1 120px" }} />
                  <input value={ni.daysBefore} onChange={(e) => setNi({ ...ni, daysBefore: e.target.value })} inputMode="numeric" style={{ ...inp, marginBottom: 0, width: 56 }} />
                  <span style={{ fontSize: 11, color: C.faint }}>日前</span>
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
      <input placeholder="タイトル（例：大阪登壇）" value={title} onChange={(e) => setTitle(e.target.value)} style={inp} />
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
function DeadlineBoard({ deadlines, onAdd, onAddBulk, onEdit, onRemove }) {
  const sorted = [...(deadlines || [])].sort((a, b) => new Date(a.date) - new Date(b.date));
  const [mode, setMode] = useState(null); // null | "single" | "template"
  const blank = { title: "", stage: "", date: iso(addDays(new Date(), 14)) };
  const [f, setF] = useState(blank);
  const [editId, setEditId] = useState(null);
  const [e, setE] = useState(blank);
  const [tpl, setTpl] = useState(Object.keys(LAUNCH_TEMPLATES)[0]);
  const [anchor, setAnchor] = useState(iso(addDays(new Date(), 21)));
  const startEdit = (d) => { setEditId(d.id); setE({ title: d.title, stage: d.stage || "", date: d.date }); };
  const saveEdit = () => { if (e.title.trim()) onEdit(editId, { title: e.title.trim(), stage: e.stage, date: e.date }); setEditId(null); };
  const preview = buildLaunch(tpl, anchor);

  return (
    <Panel
      title="締切からの逆算（二段ローンチ）"
      accent={C.purple}
      help="販売や募集の節目（締切）を時系列に並べ、残り日数を信号で表示します。「型で一括作成」を使うと、本申込日などの基準日を1つ入れるだけで、予告・先行登録・リマインド・締切までを逆算してまとめて作れます。"
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
          if (editId === d.id) {
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
            <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 12, background: C.panel2, borderRadius: 12, padding: "12px 14px" }}>
              <span style={{ width: 28, height: 28, borderRadius: "50%", background: C.panel, border: `1px solid ${C.line}`, display: "grid", placeItems: "center", fontSize: 13, color: C.sub, flex: "0 0 auto" }}>
                {i + 1}
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15 }}>{d.title}</div>
                <div style={{ fontSize: 12, color: C.sub }}>{d.stage} ・ {fmt(d.date)}</div>
              </div>
              <span style={{ fontSize: 13, color: sig.color, fontWeight: 600 }}>{sig.dot} {sig.label}</span>
              <button onClick={() => startEdit(d)} style={iconBtn} title="編集">✎</button>
              <button onClick={() => onRemove(d.id)} style={iconBtn} title="削除">✕</button>
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
function TimeMeter({ entries, source, status, error, count, onConnect, connecting }) {
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
      <CalStatusNote source={source} status={status} error={error} count={count} onConnect={onConnect} connecting={connecting} />
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
function ScheduleRow({ e, source, onSetCat }) {
  const isFamily = e.role === "family";
  const canEdit = source === "calendar" && !!onSetCat && !isFamily;
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
      <span style={{ fontVariantNumeric: "tabular-nums", color: C.sub, fontSize: 14, width: 46, flex: "0 0 auto", paddingTop: 1 }}>{e.time}</span>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: catColor(e.cat), flex: "0 0 auto", marginTop: 7 }} />
      <span style={{ flex: 1, minWidth: 0, fontSize: 15, lineHeight: 1.35, color: isFamily ? C.sub : C.text }}>{e.title}</span>
      {canEdit ? (
        <button
          onClick={() => onSetCat(e.title, CAT_CYCLE[(CAT_CYCLE.indexOf(e.cat) + 1) % CAT_CYCLE.length])}
          style={{ flex: "0 0 auto", fontSize: 12, color: catColor(e.cat), background: "transparent", border: `1px solid ${C.line}`, borderRadius: 6, padding: "2px 8px", cursor: "pointer" }}
        >{e.cat} ⇄</button>
      ) : (
        <span style={{ fontSize: 12, color: catColor(e.cat), flex: "0 0 auto" }}>{e.cat}</span>
      )}
    </div>
  );
}

// 横スワイプで今日→明日→明後日…と切り替わる日別スケジュール
function Schedule({ days, source, status, error, count, onConnect, connecting, onSetCat }) {
  const scroller = useRef(null);
  const [idx, setIdx] = useState(0);
  const list = days || [];

  const goTo = (i) => {
    const n = Math.max(0, Math.min(list.length - 1, i));
    const el = scroller.current;
    if (el) el.scrollTo({ left: el.clientWidth * n, behavior: "smooth" });
    setIdx(n);
  };
  const onScroll = () => {
    const el = scroller.current;
    if (el) setIdx(Math.round(el.scrollLeft / el.clientWidth));
  };

  const cur = list[idx];
  return (
    <Panel title="予定（横スワイプで先の日へ）" accent={C.blue}>
      <CalStatusNote source={source} status={status} error={error} count={count} onConnect={onConnect} connecting={connecting} />

      {/* 日付ナビ */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <button onClick={() => goTo(idx - 1)} disabled={idx === 0} style={{ ...iconBtn, width: 32, fontSize: 18, opacity: idx === 0 ? 0.3 : 1 }} aria-label="前の日">‹</button>
        <div style={{ flex: 1, textAlign: "center", fontSize: 14, fontWeight: 700 }}>
          {cur ? `${cur.label}（${cur.date.getMonth() + 1}/${cur.date.getDate()} ${WD[cur.date.getDay()]}）` : ""}
        </div>
        <button onClick={() => goTo(idx + 1)} disabled={idx >= list.length - 1} style={{ ...iconBtn, width: 32, fontSize: 18, opacity: idx >= list.length - 1 ? 0.3 : 1 }} aria-label="次の日">›</button>
      </div>

      {/* 横スクロール（スワイプでスナップ） */}
      <div
        ref={scroller}
        onScroll={onScroll}
        style={{ display: "flex", overflowX: "auto", scrollSnapType: "x mandatory", WebkitOverflowScrolling: "touch", scrollbarWidth: "none" }}
      >
        {list.map((day) => (
          <div key={day.key} style={{ flex: "0 0 100%", minWidth: "100%", scrollSnapAlign: "start", boxSizing: "border-box" }}>
            {day.items.length === 0 ? (
              <Empty>予定はありません。</Empty>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {day.items.map((e, i) => (
                  <ScheduleRow key={i} e={e} source={source} onSetCat={onSetCat} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ドット */}
      <div style={{ display: "flex", justifyContent: "center", gap: 6, marginTop: 12 }}>
        {list.map((day, i) => (
          <button
            key={day.key}
            onClick={() => goTo(i)}
            aria-label={day.label}
            style={{ width: i === idx ? 18 : 7, height: 7, borderRadius: 4, border: "none", padding: 0, cursor: "pointer", background: i === idx ? C.blue : C.line }}
          />
        ))}
      </div>
      <div style={{ fontSize: 11, color: C.faint, marginTop: 8, textAlign: "center" }}>← 横スワイプ / 矢印で 今日・明日・明後日… →</div>
    </Panel>
  );
}

/* 今後の予定（先2ヶ月・重要イベント）。月ごとにまとめ、初期は10件表示。 */
function Upcoming({ events }) {
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
    <Panel title="今後の予定（先2ヶ月）" accent={FAMILY_COLOR} help="出張・登壇・ライブ・イベント等の重要予定と、家族・プライベートの予定（別色）を先まで表示します。日常の細かい予定は出しません。">
      {list.length === 0 ? (
        <Empty>先2ヶ月に重要な予定はありません。</Empty>
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          {groups.map((g) => (
            <div key={g.key}>
              <div style={{ fontSize: 12, color: C.sub, fontWeight: 700, marginBottom: 6 }}>{g.key}</div>
              <div style={{ display: "grid", gap: 8 }}>
                {g.items.map((e, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                    <span style={{ fontVariantNumeric: "tabular-nums", color: C.sub, fontSize: 13, width: 78, flex: "0 0 auto", paddingTop: 1 }}>
                      {e.start.getMonth() + 1}/{e.start.getDate()}({WD[e.start.getDay()]}){e.allDay ? "" : ` ${e.time}`}
                    </span>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: catColor(e.cat), flex: "0 0 auto", marginTop: 6 }} />
                    <span style={{ flex: 1, minWidth: 0, fontSize: 14, lineHeight: 1.35, color: e.role === "family" ? C.sub : C.text }}>{e.title}</span>
                    <span style={{ fontSize: 11, color: catColor(e.cat), flex: "0 0 auto" }}>{e.role === "family" ? "家族" : e.cat}</span>
                  </div>
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
                      style={{ fontSize: 11, padding: "4px 8px", borderRadius: 6, cursor: "pointer", border: `1px solid ${role === r.v ? C.accent : C.line}`, background: role === r.v ? C.accent : "transparent", color: role === r.v ? "#0B0D11" : C.sub, fontWeight: role === r.v ? 700 : 400 }}
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
const MONEY_KINDS = ["請求", "入金", "支払"];

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

  return (
    <Panel
      title="請求・お金"
      accent={C.accent}
      right={<span style={{ fontSize: 12, color: outstanding > 0 ? C.accent : C.sub }}>未処理 {yen(outstanding)}</span>}
    >
      <div style={{ display: "grid", gap: 8 }}>
        {list.length === 0 && <Empty>項目はありません。</Empty>}
        {list.map((it) => (
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
                <span style={{ flex: 1, fontSize: 14, textDecoration: it.done ? "line-through" : "none", color: it.done ? C.faint : C.text }}>{it.title}</span>
                {it.amount > 0 && <span style={{ fontSize: 13, color: it.done ? C.faint : C.text, fontVariantNumeric: "tabular-nums" }}>{yen(it.amount)}</span>}
                {it.kind && <span style={{ fontSize: 11, color: kindColor(it.kind) }}>{it.kind}</span>}
                <button onClick={() => startEdit(it)} style={iconBtn} title="編集">✎</button>
                <button onClick={() => onRemove(it.id)} style={iconBtn} title="削除">✕</button>
              </>
            )}
          </div>
        ))}
      </div>
      <form
        onSubmit={(ev) => { ev.preventDefault(); if (!title.trim()) return; onAdd({ title: title.trim(), amount: Number(amount) || 0, kind }); setTitle(""); setAmount(""); }}
        style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}
      >
        <input value={title} onChange={(ev) => setTitle(ev.target.value)} placeholder="請求・入金項目" style={{ ...inp, marginBottom: 0, flex: "1 1 120px" }} />
        <input value={amount} onChange={(ev) => setAmount(ev.target.value)} placeholder="金額" inputMode="numeric" style={{ ...inp, marginBottom: 0, width: 84 }} />
        <select value={kind} onChange={(ev) => setKind(ev.target.value)} style={{ ...inp, marginBottom: 0, width: 70 }}>
          {MONEY_KINDS.map((k) => <option key={k}>{k}</option>)}
        </select>
        <button type="submit" style={chipBtn}>追加</button>
      </form>
    </Panel>
  );
}

function Empty({ children }) {
  return <div style={{ fontSize: 13, color: C.faint, padding: "6px 2px" }}>{children}</div>;
}

/* ──────────────────────────────────────────────────────────────
   固定費・サブスク管理
   次回請求日は保存せず anchorDate＋サイクルから「今日」基準で毎回算出する。
   → 月が替わるたびに自動で次回へ繰り越され、合計・年換算も自動再計算される。
   ────────────────────────────────────────────────────────────── */
const SUB_CATS = {
  仕事ツール: C.blue,
  集客・広告: C.purple,
  経営・会計: C.accent,
  制作・学習: C.green,
  生活・通信: C.orange,
  その他: C.faint,
};
const subCatColor = (c) => SUB_CATS[c] || C.faint;

const CYCLES = [
  { v: "monthly", label: "月払い", short: "月", months: 1 },
  { v: "quarterly", label: "四半期（3ヶ月）", short: "3ヶ月", months: 3 },
  { v: "halfyearly", label: "半年払い", short: "半年", months: 6 },
  { v: "yearly", label: "年払い", short: "年", months: 12 },
];
const cycleMonths = (v) => CYCLES.find((c) => c.v === v)?.months || 1;
const cycleShort = (v) => CYCLES.find((c) => c.v === v)?.short || "月";
// 1ヶ月あたりの金額（月額換算）
const toMonthly = (amount, cycle) => Math.round((Number(amount) || 0) / cycleMonths(cycle));

// 月末クランプ付きの「Nヶ月後」。元の請求日(31日など)の意図を保つため必ず anchor から数える。
function addMonthsClamped(baseDate, m) {
  const d = new Date(baseDate);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + m);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return startOfDay(d);
}

// anchorDate からサイクルを繰り上げ、「今日以降で最初の請求日」を返す
function nextBilling(sub, from) {
  const step = cycleMonths(sub.cycle);
  const anchor = startOfDay(new Date(sub.anchorDate));
  const today = startOfDay(from || new Date());
  if (anchor >= today) return anchor;
  let k = 1;
  let d = addMonthsClamped(anchor, step);
  while (d < today && k < 1200) {
    k += 1;
    d = addMonthsClamped(anchor, step * k);
  }
  return d;
}

// 請求までの残り日数で信号を出す（緑=余裕 / 橙=もうすぐ / 赤=本日・超過）
function subSignal(nextDateISO) {
  const diff = daysUntil(nextDateISO);
  if (diff < 0) return { color: C.red, dot: "🔴", label: `${-diff}日超過`, diff };
  if (diff === 0) return { color: C.red, dot: "🔴", label: "本日請求", diff };
  if (diff <= 7) return { color: C.orange, dot: "🟠", label: `あと${diff}日`, diff };
  if (diff <= 30) return { color: C.green, dot: "🟢", label: `あと${diff}日`, diff };
  return { color: C.faint, dot: "⚪️", label: `あと${diff}日`, diff };
}

// 金額＋サイクルの表示（年/半年/四半期は月額換算を併記）
function priceLabel(sub) {
  const m = toMonthly(sub.amount, sub.cycle);
  if (sub.cycle === "monthly") return `${yen(sub.amount)}/月`;
  return `${yen(sub.amount)}/${cycleShort(sub.cycle)}（月換算${yen(m)}）`;
}

/* 上部のタブ切替（ダッシュボード／固定費） */
function MainTabs({ tab, onChange, dueCount }) {
  const TABS = [
    { v: "dashboard", label: "ホーム" },
    { v: "subscriptions", label: "固定費" },
    { v: "revenue", label: "売上" },
  ];
  return (
    <div style={{ display: "flex", gap: 4, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 4, marginBottom: 16 }}>
      {TABS.map((t) => {
        const on = tab === t.v;
        return (
          <button
            key={t.v}
            onClick={() => onChange(t.v)}
            style={{ flex: 1, padding: "9px 0", fontSize: 13, fontWeight: on ? 700 : 400, color: on ? C.text : C.sub, background: on ? C.panel2 : "transparent", border: on ? `1px solid ${C.line}` : "1px solid transparent", borderRadius: 8, cursor: "pointer", textAlign: "center", position: "relative" }}
          >
            {t.label}
            {t.v === "subscriptions" && dueCount > 0 && (
              <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, color: "#0B0D11", background: C.orange, borderRadius: 10, padding: "1px 7px" }}>{dueCount}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* KPIカード1枚 */
function KpiCard({ label, value, valueColor, sub }) {
  return (
    <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 12, padding: "14px 16px" }}>
      <div style={{ fontSize: 11, color: C.faint, marginBottom: 4, letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: valueColor || C.text, lineHeight: 1.15 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.faint, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

/* 有効/無効トグル（スイッチ） */
function Switch({ on, onClick }) {
  return (
    <button
      onClick={onClick}
      aria-label={on ? "有効（タップで一時停止）" : "停止中（タップで有効化）"}
      style={{ background: on ? C.green : C.line, border: "none", borderRadius: 20, width: 38, height: 22, cursor: "pointer", position: "relative", flex: "0 0 auto", padding: 0 }}
    >
      <span style={{ position: "absolute", top: 2, left: on ? 18 : 2, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 0.15s" }} />
    </button>
  );
}

/* 追加・編集フォーム（アコーディオン） */
function SubForm({ initial, onSave, onCancel }) {
  const [f, setF] = useState(
    initial || { name: "", amount: "", cycle: "monthly", anchorDate: iso(new Date()), category: "仕事ツール", note: "" }
  );
  const valid = f.name.trim() && Number(f.amount) > 0 && f.anchorDate;
  return (
    <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 12, padding: 14, marginBottom: 14 }}>
      <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="サービス名（例：Notion、Claude Pro）" style={inp} />
      <div style={{ display: "flex", gap: 8 }}>
        <input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} inputMode="numeric" placeholder="金額" style={{ ...inp, flex: 1 }} />
        <select value={f.cycle} onChange={(e) => setF({ ...f, cycle: e.target.value })} style={{ ...inp, flex: 1 }}>
          {CYCLES.map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}
        </select>
      </div>
      <label style={{ fontSize: 11, color: C.faint, display: "block", marginBottom: 4 }}>次回（または直近）の請求日 — ここを起点に毎月自動で繰り越します</label>
      <input type="date" value={f.anchorDate} onChange={(e) => setF({ ...f, anchorDate: e.target.value })} style={inp} />
      <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} style={inp}>
        {Object.keys(SUB_CATS).map((c) => <option key={c}>{c}</option>)}
      </select>
      <input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="メモ（プラン名・用途など／任意）" style={inp} />
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button
          onClick={() => valid && onSave({ name: f.name.trim(), amount: Number(f.amount) || 0, cycle: f.cycle, anchorDate: f.anchorDate, category: f.category, note: f.note.trim() })}
          disabled={!valid}
          style={{ ...chipBtn, background: valid ? C.accent : "transparent", color: valid ? "#0B0D11" : C.faint, borderColor: valid ? C.accent : C.line, cursor: valid ? "pointer" : "not-allowed" }}
        >保存</button>
        <button onClick={onCancel} style={chipBtn}>取消</button>
      </div>
    </div>
  );
}

/* 固定費・サブスクのタブ本体 */
function SubscriptionsTab({ subs, settings, onAdd, onEdit, onRemove, onToggle, onSettings, uid }) {
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState(null);
  const list = subs || [];
  const remindDays = settings?.remindDays ?? 7;

  // 派生値（毎回算出＝常に最新。月替わりで自動繰越）
  const enriched = useMemo(() => {
    return list.map((s) => {
      const next = nextBilling(s);
      const nextISO = iso(next);
      return { ...s, _next: next, _nextISO: nextISO, _monthly: toMonthly(s.amount, s.cycle), _sig: subSignal(nextISO) };
    });
  }, [list]);

  const active = enriched.filter((s) => s.active);
  const monthTotal = active.reduce((t, s) => t + s._monthly, 0);
  const yearTotal = monthTotal * 12;

  // 今月の請求予定（有効分で、次回請求日が今暦月に入るもの）
  const today = new Date();
  const inThisMonth = (d) => d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth();
  const thisMonthCharge = active.filter((s) => inThisMonth(s._next)).reduce((t, s) => t + (Number(s.amount) || 0), 0);

  // リマインド対象（有効・残りremindDays日以内）
  const due = active.filter((s) => s._sig.diff <= remindDays).sort((a, b) => a._sig.diff - b._sig.diff);

  // カテゴリ内訳（月額換算ベース）
  const catTotals = {};
  active.forEach((s) => { catTotals[s.category] = (catTotals[s.category] || 0) + s._monthly; });
  const catRows = Object.keys(SUB_CATS).filter((c) => catTotals[c] > 0);

  // 一覧の並び：有効→停止、各々 残日数の昇順
  const sorted = [...enriched].sort((a, b) => (a.active === b.active ? a._sig.diff - b._sig.diff : a.active ? -1 : 1));

  // ブラウザ通知（オプトイン）。許可済み＆閾値内なら、その端末で1日1回だけ通知。
  useEffect(() => {
    if (!settings?.notify || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    // dedupeキーはuid別（共有端末で別アカウントの通知済み状態を引き継がない）
    const key = `viele-sub-notified-${uid || "local"}`;
    const todayKey = iso(new Date());
    if (localStorage.getItem(key) === todayKey) return;
    if (due.length > 0) {
      try {
        // ロック画面に契約先が露出しないよう、本文は件数のみ（詳細はアプリ起動後に表示）
        new Notification("まもなく固定費の請求があります", { body: `${due.length}件の請求が${remindDays}日以内に予定されています` });
        localStorage.setItem(key, todayKey);
      } catch { /* ignore */ }
    }
  }, [settings?.notify, due.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const enableNotify = async () => {
    if (typeof Notification === "undefined") { onSettings({ notify: false }); return; }
    if (settings?.notify) { onSettings({ notify: false }); return; }
    const p = await Notification.requestPermission();
    onSettings({ notify: p === "granted" });
  };

  return (
    <>
      {/* サマリー */}
      <Panel title="今月の固定費" accent={C.accent} help="登録した固定費・サブスクを月額換算して合計します。次回請求日は登録した請求日を起点に毎月自動で繰り越され、合計・年換算も自動で再計算されます。停止中（一時解約）の項目は合計から除外します。">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <KpiCard label="月合計（月額換算）" value={yen(monthTotal)} sub={`年換算 ${yen(yearTotal)}`} />
          <KpiCard label="今月の請求予定" value={yen(thisMonthCharge)} valueColor={thisMonthCharge > 0 ? C.text : C.sub} sub={`${due.length > 0 ? `まもなく ${due.length}件` : "直近の請求なし"}`} />
          <KpiCard label="有効な固定費" value={`${active.length}件`} sub={`登録 ${list.length}件`} />
          <KpiCard label="1日あたり" value={yen(Math.round(monthTotal / 30))} sub="月合計 ÷ 30" />
        </div>
      </Panel>

      {/* リマインド */}
      {due.length > 0 && (
        <div style={{ background: "#241B07", border: `1px solid ${C.accent}`, borderRadius: 16, padding: 16, marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: C.accent }}>🟠 まもなく請求（{remindDays}日以内）</span>
          </div>
          <div style={{ display: "grid", gap: 2 }}>
            {due.slice(0, 6).map((s) => (
              <div key={s.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, padding: "5px 0", borderTop: `1px solid rgba(201,162,39,0.18)` }}>
                <span style={{ color: C.text, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name} ・ {yen(s.amount)}</span>
                <span style={{ color: s._sig.color, fontWeight: 600, flex: "0 0 auto", marginLeft: 8 }}>{fmt(s._nextISO)} {s._sig.label}</span>
              </div>
            ))}
            {due.length > 6 && <div style={{ fontSize: 12, color: C.faint, marginTop: 4 }}>他 {due.length - 6}件</div>}
          </div>
        </div>
      )}

      {/* 一覧＋追加 */}
      <Panel title="サブスク一覧" accent={C.blue} right={<button onClick={() => { setAdding((v) => !v); setEditId(null); }} style={chipBtn}>{adding ? "閉じる" : "＋追加"}</button>}>
        {adding && (
          <SubForm
            onCancel={() => setAdding(false)}
            onSave={(item) => { onAdd(item); setAdding(false); }}
          />
        )}
        {sorted.length === 0 && !adding && <Empty>サブスクは登録されていません。右上の「＋追加」から登録できます。</Empty>}
        <div style={{ display: "grid", gap: 10 }}>
          {sorted.map((s) =>
            editId === s.id ? (
              <SubForm
                key={s.id}
                initial={{ name: s.name, amount: s.amount, cycle: s.cycle, anchorDate: s.anchorDate, category: s.category, note: s.note || "" }}
                onCancel={() => setEditId(null)}
                onSave={(patch) => { onEdit(s.id, patch); setEditId(null); }}
              />
            ) : (
              <div key={s.id} style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 12, padding: "12px 14px", opacity: s.active ? 1 : 0.5 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: subCatColor(s.category), flex: "0 0 auto" }} />
                  <span style={{ fontSize: 10, color: subCatColor(s.category), border: `1px solid ${subCatColor(s.category)}`, borderRadius: 5, padding: "1px 6px", flex: "0 0 auto" }}>{s.category}</span>
                  <span style={{ flex: 1, fontSize: 14, fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}{!s.active && <span style={{ fontSize: 10, color: C.faint, marginLeft: 6 }}>停止中</span>}</span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: C.text, fontVariantNumeric: "tabular-nums", flex: "0 0 auto" }}>{yen(s.amount)}<span style={{ fontSize: 11, color: C.faint, fontWeight: 400 }}>/{cycleShort(s.cycle)}</span></span>
                  <Switch on={s.active} onClick={() => onToggle(s.id)} />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 12, color: C.sub, flex: 1, minWidth: 0 }}>次回 {fmt(s._nextISO)}{s.cycle !== "monthly" ? `（月換算 ${yen(s._monthly)}）` : ""}{s.note ? ` ・ ${s.note}` : ""}</span>
                  <span style={{ fontSize: 12, color: s._sig.color, fontWeight: 600, flex: "0 0 auto" }}>{s._sig.dot} {s._sig.label}</span>
                  <button onClick={() => { setEditId(s.id); setAdding(false); }} style={iconBtn} title="編集">✎</button>
                  <button onClick={() => onRemove(s.id)} style={iconBtn} title="削除">✕</button>
                </div>
              </div>
            )
          )}
        </div>
      </Panel>

      {/* カテゴリ内訳 */}
      <Panel title="カテゴリ内訳（月額換算）" accent={C.purple} right={<span style={{ fontSize: 13, color: C.sub }}>月 {yen(monthTotal)}</span>}>
        {catRows.length === 0 ? (
          <Empty>有効な固定費がありません。</Empty>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {catRows.map((cat) => (
              <div key={cat}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                  <span style={{ color: subCatColor(cat) }}>● {cat}</span>
                  <span style={{ color: C.sub }}>{yen(catTotals[cat])}（{monthTotal > 0 ? Math.round((catTotals[cat] / monthTotal) * 100) : 0}%）</span>
                </div>
                <Bar value={catTotals[cat]} total={monthTotal} color={subCatColor(cat)} />
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* 設定（リマインド日数・通知） */}
      <Panel title="リマインド設定" accent={C.sub}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <span style={{ fontSize: 14, flex: 1 }}>請求の何日前から知らせる</span>
          <button onClick={() => onSettings({ remindDays: Math.max(1, remindDays - 1) })} style={iconBtn}>－</button>
          <span style={{ fontSize: 15, fontWeight: 700, width: 48, textAlign: "center" }}>{remindDays}日前</span>
          <button onClick={() => onSettings({ remindDays: Math.min(30, remindDays + 1) })} style={iconBtn}>＋</button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14 }}>ブラウザ通知</div>
            <div style={{ fontSize: 11, color: C.faint }}>この端末で、請求が近い日に1日1回お知らせします（任意）。</div>
          </div>
          <Switch on={!!settings?.notify} onClick={enableNotify} />
        </div>
      </Panel>
    </>
  );
}

/* カレンダー連携の状態表示＋連携ボタン（時間メーター/今日の予定の上に出す） */
function CalStatusNote({ source, status, error, count, onConnect, connecting }) {
  if (source === "calendar") {
    return (
      <div style={{ fontSize: 12, color: C.green, background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 8, padding: "7px 10px", marginBottom: 12, display: "flex", gap: 6, alignItems: "center" }}>
        <span>✅</span>
        <span>Googleカレンダー連携中（今週 {count}件を反映）</span>
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
            : "サンプル表示（準備中）— Googleカレンダーと連携すると、今週の実績が自動で反映されます。"}
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
   売上（収入）
   固定費と対称のデータモデル。定期収入は固定費と同じ nextBilling/cycle
   ロジックを共有し、毎月の発生額を毎回算出する（＝自動計上）。
   ────────────────────────────────────────────────────────────── */
const REV_CATS = {
  施術・サービス: C.green,
  講座・月額: C.blue,
  顧問・コンサル: C.accent,
  物販: C.purple,
  広告・アフィリ: C.orange,
  その他: C.faint,
};
const revCatColor = (c) => REV_CATS[c] || C.faint;

// 指定の暦月(year, monthは0始まり)にこの定期項目の請求/入金が発生するか → 金額(無ければ0)
// 月差がサイクル(月数)の倍数なら発生。日付クランプは月の判定に影響しないので月だけで判定できる。
function billedInMonth(item, year, month) {
  const step = cycleMonths(item.cycle);
  const anchor = new Date(item.anchorDate);
  const target = year * 12 + month;
  const base = anchor.getFullYear() * 12 + anchor.getMonth();
  const diff = target - base;
  if (diff < 0 || diff % step !== 0) return 0;
  return Number(item.amount) || 0;
}

/* 定期収入の追加・編集フォーム（固定費のSubFormに顧客名を足した収入版） */
function RevRecForm({ initial, onSave, onCancel }) {
  const [f, setF] = useState(
    initial || { name: "", customer: "", amount: "", cycle: "monthly", anchorDate: iso(new Date()), category: "顧問・コンサル", note: "" }
  );
  const valid = f.name.trim() && Number(f.amount) > 0 && f.anchorDate;
  return (
    <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 12, padding: 14, marginBottom: 14 }}>
      <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="名目（例：月額顧問、オンラインサロン）" style={inp} />
      <input value={f.customer} onChange={(e) => setF({ ...f, customer: e.target.value })} placeholder="顧客・取引先（任意）" style={inp} />
      <div style={{ display: "flex", gap: 8 }}>
        <input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} inputMode="numeric" placeholder="金額" style={{ ...inp, flex: 1 }} />
        <select value={f.cycle} onChange={(e) => setF({ ...f, cycle: e.target.value })} style={{ ...inp, flex: 1 }}>
          {CYCLES.map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}
        </select>
      </div>
      <label style={{ fontSize: 11, color: C.faint, display: "block", marginBottom: 4 }}>次回（または直近）の入金日 — ここを起点に毎月自動で計上します</label>
      <input type="date" value={f.anchorDate} onChange={(e) => setF({ ...f, anchorDate: e.target.value })} style={inp} />
      <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} style={inp}>
        {Object.keys(REV_CATS).map((c) => <option key={c}>{c}</option>)}
      </select>
      <input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="メモ（任意）" style={inp} />
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button
          onClick={() => valid && onSave({ name: f.name.trim(), customer: f.customer.trim(), amount: Number(f.amount) || 0, cycle: f.cycle, anchorDate: f.anchorDate, category: f.category, note: f.note.trim() })}
          disabled={!valid}
          style={{ ...chipBtn, background: valid ? C.green : "transparent", color: valid ? "#0B0D11" : C.faint, borderColor: valid ? C.green : C.line, cursor: valid ? "pointer" : "not-allowed" }}
        >保存</button>
        <button onClick={onCancel} style={chipBtn}>取消</button>
      </div>
    </div>
  );
}

/* 単発収入の追加・編集フォーム */
function RevOnceForm({ initial, onSave, onCancel }) {
  const [f, setF] = useState(
    initial || { title: "", customer: "", amount: "", date: iso(new Date()), category: "施術・サービス" }
  );
  const valid = f.title.trim() && Number(f.amount) > 0 && f.date;
  return (
    <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 12, padding: 14, marginBottom: 14 }}>
      <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="内容（例：単発施術、スポットコンサル）" style={inp} />
      <input value={f.customer} onChange={(e) => setF({ ...f, customer: e.target.value })} placeholder="顧客・取引先（任意）" style={inp} />
      <div style={{ display: "flex", gap: 8 }}>
        <input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} inputMode="numeric" placeholder="金額" style={{ ...inp, flex: 1 }} />
        <input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} style={{ ...inp, flex: 1 }} />
      </div>
      <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} style={inp}>
        {Object.keys(REV_CATS).map((c) => <option key={c}>{c}</option>)}
      </select>
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button
          onClick={() => valid && onSave({ title: f.title.trim(), customer: f.customer.trim(), amount: Number(f.amount) || 0, date: f.date, category: f.category })}
          disabled={!valid}
          style={{ ...chipBtn, background: valid ? C.green : "transparent", color: valid ? "#0B0D11" : C.faint, borderColor: valid ? C.green : C.line, cursor: valid ? "pointer" : "not-allowed" }}
        >保存</button>
        <button onClick={onCancel} style={chipBtn}>取消</button>
      </div>
    </div>
  );
}

/* 売上タブ本体。固定費(月額換算 fixedMonthly / 今月分 fixedThisMonth)を受け取り「手残り」を出す。 */
function RevenueTab({ recurring, oneTime, fixedMonthly, fixedThisMonth, recOps, onceOps }) {
  const [addingRec, setAddingRec] = useState(false);
  const [addingOnce, setAddingOnce] = useState(false);
  const [editRec, setEditRec] = useState(null);
  const [editOnce, setEditOnce] = useState(null);
  const recs = recurring || [];
  const onces = oneTime || [];
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth();

  const recActive = recs.filter((r) => r.active);
  const mrr = recActive.reduce((t, r) => t + toMonthly(r.amount, r.cycle), 0); // 月次定期収入(MRR)
  const recThisMonth = recActive.reduce((t, r) => t + billedInMonth(r, y, m), 0);
  const onceThisMonth = onces.filter((r) => { const d = new Date(r.date); return d.getFullYear() === y && d.getMonth() === m; }).reduce((t, r) => t + (Number(r.amount) || 0), 0);
  const revThisMonth = recThisMonth + onceThisMonth; // 今月売上（定期の今月発生＋単発の今月実績）
  const takeHome = revThisMonth - fixedThisMonth;     // 今月の手残り

  // 直近12ヶ月の売上推移（単発実績＋定期の発生額）
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(y, m - i, 1);
    const total = onces.filter((r) => { const x = new Date(r.date); return x.getFullYear() === d.getFullYear() && x.getMonth() === d.getMonth(); }).reduce((t, r) => t + (Number(r.amount) || 0), 0)
      + recActive.reduce((t, r) => t + billedInMonth(r, d.getFullYear(), d.getMonth()), 0);
    months.push({ key: i, label: `${d.getMonth() + 1}`, isNow: i === 0, total });
  }
  const maxRev = Math.max(1, ...months.map((x) => x.total));

  // カテゴリ内訳（今月売上ベース）
  const catTotals = {};
  recActive.forEach((r) => { const a = billedInMonth(r, y, m); if (a) catTotals[r.category] = (catTotals[r.category] || 0) + a; });
  onces.filter((r) => { const d = new Date(r.date); return d.getFullYear() === y && d.getMonth() === m; }).forEach((r) => { catTotals[r.category] = (catTotals[r.category] || 0) + (Number(r.amount) || 0); });
  const catRows = Object.keys(REV_CATS).filter((c) => catTotals[c] > 0);

  const sortedRec = [...recs].sort((a, b) => (a.active === b.active ? 0 : a.active ? -1 : 1));
  const sortedOnce = [...onces].sort((a, b) => new Date(b.date) - new Date(a.date));

  return (
    <>
      {/* サマリー（手残りが主役） */}
      <Panel title="今月の売上と手残り" accent={C.green} help="「今月売上」は、登録した定期収入のうち今月発生する分と、今月の単発収入の合算です。定期収入は一度登録すれば毎月自動で計上されます。「今月の手残り」は今月売上から固定費（固定費タブの今月分）を引いた金額で、黒字は緑・赤字は赤で表示します。">
        <div style={{ background: C.panel2, border: `1px solid ${takeHome >= 0 ? C.green : C.red}`, borderRadius: 12, padding: "16px 18px", marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: C.faint, marginBottom: 4 }}>今月の手残り（売上 − 固定費）</div>
          <div style={{ fontSize: 30, fontWeight: 800, fontVariantNumeric: "tabular-nums", color: takeHome >= 0 ? C.green : C.red, lineHeight: 1.1 }}>{takeHome >= 0 ? "" : "−"}{yen(Math.abs(takeHome))}</div>
          <div style={{ fontSize: 12, color: C.sub, marginTop: 6 }}>売上 {yen(revThisMonth)} − 固定費 {yen(fixedThisMonth)}</div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <KpiCard label="今月売上" value={yen(revThisMonth)} valueColor={C.green} sub={`定期 ${yen(recThisMonth)}・単発 ${yen(onceThisMonth)}`} />
          <KpiCard label="MRR（月次定期収入）" value={yen(mrr)} sub={`年換算 ${yen(mrr * 12)}`} />
          <KpiCard label="固定費（今月）" value={yen(fixedThisMonth)} sub={`月額換算 ${yen(fixedMonthly)}`} />
          <KpiCard label="利益率（今月）" value={revThisMonth > 0 ? `${Math.round((takeHome / revThisMonth) * 100)}%` : "—"} valueColor={takeHome >= 0 ? C.green : C.red} sub="手残り ÷ 売上" />
        </div>
      </Panel>

      {/* 12ヶ月推移 */}
      <Panel title="売上の推移（直近12ヶ月）" accent={C.blue} right={<span style={{ fontSize: 12, color: C.sub }}>最大 {yen(maxRev)}</span>}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 120, padding: "0 2px" }}>
          {months.map((mo) => (
            <div key={mo.key} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, minWidth: 0 }}>
              <div style={{ width: "100%", display: "flex", alignItems: "flex-end", height: 96 }}>
                <div title={yen(mo.total)} style={{ width: "100%", height: `${Math.max(2, (mo.total / maxRev) * 96)}px`, background: mo.isNow ? C.green : C.panel2, border: `1px solid ${mo.isNow ? C.green : C.line}`, borderRadius: 4 }} />
              </div>
              <span style={{ fontSize: 9, color: mo.isNow ? C.green : C.faint }}>{mo.label}</span>
            </div>
          ))}
        </div>
      </Panel>

      {/* 定期収入 */}
      <Panel title="定期収入（毎月自動で計上）" accent={C.green} help="顧問料・月額講座・サブスク売上など、毎月決まって入る収入を登録します。一度登録すれば、月が替わるたびに自動で今月の売上に計上されます。" right={<button onClick={() => { setAddingRec((v) => !v); setEditRec(null); }} style={chipBtn}>{addingRec ? "閉じる" : "＋追加"}</button>}>
        {addingRec && <RevRecForm onCancel={() => setAddingRec(false)} onSave={(item) => { recOps.add(item); setAddingRec(false); }} />}
        {sortedRec.length === 0 && !addingRec && <Empty>定期収入は登録されていません。右上の「＋追加」から登録できます。</Empty>}
        <div style={{ display: "grid", gap: 10 }}>
          {sortedRec.map((r) =>
            editRec === r.id ? (
              <RevRecForm key={r.id} initial={{ name: r.name, customer: r.customer || "", amount: r.amount, cycle: r.cycle, anchorDate: r.anchorDate, category: r.category, note: r.note || "" }} onCancel={() => setEditRec(null)} onSave={(patch) => { recOps.edit(r.id, patch); setEditRec(null); }} />
            ) : (
              <div key={r.id} style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 12, padding: "12px 14px", opacity: r.active ? 1 : 0.5 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: revCatColor(r.category), flex: "0 0 auto" }} />
                  <span style={{ fontSize: 10, color: revCatColor(r.category), border: `1px solid ${revCatColor(r.category)}`, borderRadius: 5, padding: "1px 6px", flex: "0 0 auto" }}>{r.category}</span>
                  <span style={{ flex: 1, fontSize: 14, fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}{!r.active && <span style={{ fontSize: 10, color: C.faint, marginLeft: 6 }}>停止中</span>}</span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: C.green, fontVariantNumeric: "tabular-nums", flex: "0 0 auto" }}>{yen(r.amount)}<span style={{ fontSize: 11, color: C.faint, fontWeight: 400 }}>/{cycleShort(r.cycle)}</span></span>
                  <Switch on={r.active} onClick={() => recOps.toggle(r.id)} />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 12, color: C.sub, flex: 1, minWidth: 0 }}>次回 {fmt(iso(nextBilling(r)))}{r.cycle !== "monthly" ? `（月換算 ${yen(toMonthly(r.amount, r.cycle))}）` : ""}{r.customer ? ` ・ ${r.customer}` : ""}</span>
                  <button onClick={() => { setEditRec(r.id); setAddingRec(false); }} style={iconBtn} title="編集">✎</button>
                  <button onClick={() => recOps.remove(r.id)} style={iconBtn} title="削除">✕</button>
                </div>
              </div>
            )
          )}
        </div>
      </Panel>

      {/* 単発収入 */}
      <Panel title="単発の売上" accent={C.purple} right={<button onClick={() => { setAddingOnce((v) => !v); setEditOnce(null); }} style={chipBtn}>{addingOnce ? "閉じる" : "＋追加"}</button>}>
        {addingOnce && <RevOnceForm onCancel={() => setAddingOnce(false)} onSave={(item) => { onceOps.add(item); setAddingOnce(false); }} />}
        {sortedOnce.length === 0 && !addingOnce && <Empty>単発の売上は登録されていません。スポット案件や物販などをここに記録します。</Empty>}
        <div style={{ display: "grid", gap: 8 }}>
          {sortedOnce.map((r) =>
            editOnce === r.id ? (
              <RevOnceForm key={r.id} initial={{ title: r.title, customer: r.customer || "", amount: r.amount, date: r.date, category: r.category }} onCancel={() => setEditOnce(null)} onSave={(patch) => { onceOps.edit(r.id, patch); setEditOnce(null); }} />
            ) : (
              <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: revCatColor(r.category), flex: "0 0 auto" }} />
                <span style={{ fontSize: 13, color: C.sub, width: 64, flex: "0 0 auto", fontVariantNumeric: "tabular-nums" }}>{fmt(r.date)}</span>
                <span style={{ flex: 1, fontSize: 14, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}{r.customer ? <span style={{ color: C.faint, fontSize: 12 }}> ・ {r.customer}</span> : null}</span>
                <span style={{ fontSize: 14, fontWeight: 700, color: C.green, fontVariantNumeric: "tabular-nums", flex: "0 0 auto" }}>{yen(r.amount)}</span>
                <button onClick={() => { setEditOnce(r.id); setAddingOnce(false); }} style={iconBtn} title="編集">✎</button>
                <button onClick={() => onceOps.remove(r.id)} style={iconBtn} title="削除">✕</button>
              </div>
            )
          )}
        </div>
      </Panel>

      {/* カテゴリ内訳 */}
      <Panel title="売上カテゴリ内訳（今月）" accent={C.accent} right={<span style={{ fontSize: 13, color: C.sub }}>今月 {yen(revThisMonth)}</span>}>
        {catRows.length === 0 ? (
          <Empty>今月の売上がありません。</Empty>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {catRows.map((cat) => (
              <div key={cat}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                  <span style={{ color: revCatColor(cat) }}>● {cat}</span>
                  <span style={{ color: C.sub }}>{yen(catTotals[cat])}（{revThisMonth > 0 ? Math.round((catTotals[cat] / revThisMonth) * 100) : 0}%）</span>
                </div>
                <Bar value={catTotals[cat]} total={revThisMonth} color={revCatColor(cat)} />
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* 自動取り込み（今後） */}
      <div style={{ fontSize: 12, color: C.sub, background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 12, padding: "12px 14px", marginBottom: 16 }}>
        <div style={{ color: C.text, fontWeight: 700, marginBottom: 4 }}>売上の自動取り込み（順次対応予定）</div>
        Googleスプレッドシート連携・Stripe/銀行のCSV取込・Stripe実売上の自動同期に対応予定です。現在は「定期収入の自動計上＋手入力」で、外部にデータを預けずにこの端末・アカウントだけで完結します。
      </div>
    </>
  );
}

/* ──────────────────────────────────────────────────────────────
   ログインゲート
   ────────────────────────────────────────────────────────────── */
function LoginGate({ onLogin, error }) {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: C.bg, color: C.text }}>
      <div style={{ textAlign: "center", maxWidth: 360, padding: 24 }}>
        <div style={{ fontSize: 13, letterSpacing: 4, color: C.accent }}>VIELE</div>
        <h1 style={{ fontSize: 26, margin: "8px 0 6px" }}>secretary</h1>
        <p style={{ color: C.sub, fontSize: 14, marginBottom: 28 }}>
          一人社長のための秘書ダッシュボード。<br />本人だけが閲覧・全端末で同期。
        </p>
        <button
          onClick={onLogin}
          style={{ width: "100%", padding: "12px 16px", borderRadius: 12, border: "none", background: C.text, color: "#0B0D11", fontWeight: 700, cursor: "pointer", fontSize: 15 }}
        >
          Googleでログイン
        </button>
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

/* Firestore等のデータ取得エラー画面 */
function ErrorScreen({ error, onSignOut }) {
  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ fontSize: 11, letterSpacing: 4, color: C.accent }}>VIELE</div>
      <h2 style={{ color: C.red, fontSize: 16, marginTop: 8 }}>データに接続できません</h2>
      <p style={{ color: C.sub, fontSize: 13 }}>
        多くの場合 Firestore のルール未公開が原因です（ルールを公開すると直ります）。
      </p>
      <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 12, background: C.panel, padding: 12, borderRadius: 8 }}>
        {String(error?.code || "")} {String(error?.message || error)}
      </pre>
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
  const [fontScale, setFontScale] = useState(() => Number(localStorage.getItem("viele-fontscale")) || 1);
  const cycleFont = () => {
    const next = fontScale >= 1.3 ? 1 : fontScale === 1 ? 1.15 : 1.3;
    setFontScale(next);
    try { localStorage.setItem("viele-fontscale", String(next)); } catch { /* ignore */ }
  };
  const fontLabel = fontScale >= 1.3 ? "特大" : fontScale > 1 ? "大" : "標準";
  const seed = useMemo(() => makeSeed(), []);
  const [mainTab, setMainTab] = useState("dashboard"); // dashboard | subscriptions

  // ── Googleカレンダー連携（任意・クライアント側・複数カレンダー）──
  const [calToken, setCalToken] = useState(() => sessionStorage.getItem("viele-cal-token") || null);
  const [calList, setCalList] = useState([]);   // 利用可能なカレンダー一覧
  const [calEvents, setCalEvents] = useState([]); // 全カレンダーの生イベント（calendarId付き）
  const [calStatus, setCalStatus] = useState("idle"); // idle|loading|ok|error
  const [calError, setCalError] = useState(null);
  const [connecting, setConnecting] = useState(false);

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
        const all = (
          await Promise.all(list.map((c) => fetchEvents(calToken, c.id, timeMin, timeMax).catch(() => [])))
        ).flat();
        if (cancelled) return;
        setCalEvents(all);
        setCalStatus("ok");
      } catch (err) {
        if (cancelled) return;
        if (err.status === 401) { sessionStorage.removeItem("viele-cal-token"); setCalToken(null); }
        setCalError(err);
        setCalStatus("error");
      }
    })();
    return () => { cancelled = true; };
  }, [calToken]);

  // 連携（カレンダー読み取り権限を追加要求して再認証→アクセストークン取得）
  const connectCalendar = async () => {
    setConnecting(true);
    setCalError(null);
    try {
      const provider = new GoogleAuthProvider();
      provider.addScope(CALENDAR_SCOPE);
      const result = await signInWithPopup(auth, provider);
      const token = GoogleAuthProvider.credentialFromResult(result)?.accessToken;
      if (token) { sessionStorage.setItem("viele-cal-token", token); setCalToken(token); }
      else { setCalError(new Error("アクセストークンを取得できませんでした")); setCalStatus("error"); }
    } catch (e) {
      setCalError(e);
      setCalStatus("error");
    }
    setConnecting(false);
  };

  // カレンダー連携を解除（トークンを失効＝revoke＋破棄）
  const disconnectCalendar = () => {
    const t = calToken;
    if (t) {
      fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(t), { method: "POST", mode: "no-cors" }).catch(() => {});
    }
    sessionStorage.removeItem("viele-cal-token");
    setCalToken(null); setCalEvents([]); setCalList([]); setCalStatus("idle"); setCalError(null);
  };

  // ログアウト時はカレンダートークンも破棄（共有端末対策）
  const logout = () => {
    sessionStorage.removeItem("viele-cal-token");
    signOut(auth);
  };


  const cloud = useCloud(firebaseEnabled ? user?.uid || null : null, seed);
  const local = useLocal(STORE_KEY, seed);
  const { data, loading, error, update } = firebaseEnabled ? cloud : local;

  useEffect(() => {
    if (!firebaseEnabled) return; // ローカルモードは認証なし
    const unsub = onAuthStateChanged(auth, (u) => setUser(u || null));
    // リダイレクト方式ログインの結果・エラーを拾う
    getRedirectResult(auth).catch((e) => setAuthError(e));
    return unsub;
  }, []);

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
  };
  // 削除は誤操作防止のため確認を挟む
  const confirmDelete = (fn) => { if (window.confirm("削除しますか？この操作は取り消せません。")) fn(); };
  const removeTrip = (id) => confirmDelete(() => update({ trips: data.trips.filter((t) => t.id !== id) }));
  const editTrip = (id, patch) => update({ trips: data.trips.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
  const mapTripItems = (tripId, fn) =>
    update({ trips: data.trips.map((t) => (t.id === tripId ? { ...t, items: fn(t.items) } : t)) });
  const addTripItem = (tripId, item) => mapTripItems(tripId, (items) => [...items, { ...item, done: false }]);
  const editTripItem = (tripId, idx, patch) =>
    mapTripItems(tripId, (items) => items.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  const removeTripItem = (tripId, idx) => confirmDelete(() => mapTripItems(tripId, (items) => items.filter((_, i) => i !== idx)));

  // ── 締切（二段ローンチ）操作 ──
  const addDeadline = (d) => update({ deadlines: [...(data.deadlines || []), { id: "d" + Date.now(), ...d }] });
  const addDeadlinesBulk = (arr) =>
    update({ deadlines: [...(data.deadlines || []), ...arr.map((d, i) => ({ id: "d" + Date.now() + "_" + i, ...d }))] });
  const editDeadline = (id, patch) => update({ deadlines: data.deadlines.map((x) => (x.id === id ? { ...x, ...patch } : x)) });
  const removeDeadline = (id) => confirmDelete(() => update({ deadlines: data.deadlines.filter((x) => x.id !== id) }));

  // ── 汎用リスト操作（content / money / tasks）──
  const makeListOps = (key) => ({
    toggle: (id) => update({ [key]: data[key].map((x) => (x.id === id ? { ...x, done: !x.done } : x)) }),
    add: (item) => {
      const base = typeof item === "string" ? { title: item } : item;
      update({ [key]: [...data[key], { id: key[0] + Date.now(), done: false, ...base }] });
    },
    edit: (id, patch) => update({ [key]: data[key].map((x) => (x.id === id ? { ...x, ...patch } : x)) }),
    remove: (id) => confirmDelete(() => update({ [key]: data[key].filter((x) => x.id !== id) })),
  });
  const content = makeListOps("content");
  const money = makeListOps("money");
  const tasks = makeListOps("tasks");

  // ── 固定費・サブスク操作（既存ドキュメントには無い場合があるので必ず || [] でフォールバック）──
  const subsList = data.subscriptions || [];
  const subSettings = data.subSettings || { remindDays: 7, notify: false };
  const subsOps = {
    add: (item) => update({ subscriptions: [...subsList, { id: "s" + Date.now(), active: true, ...item }] }),
    edit: (id, patch) => update({ subscriptions: subsList.map((x) => (x.id === id ? { ...x, ...patch } : x)) }),
    remove: (id) => confirmDelete(() => update({ subscriptions: subsList.filter((x) => x.id !== id) })),
    toggle: (id) => update({ subscriptions: subsList.map((x) => (x.id === id ? { ...x, active: !x.active } : x)) }),
  };
  const setSubSettings = (patch) => update({ subSettings: { ...subSettings, ...patch } });

  // タブ上のバッジ用：リマインド対象（有効・残りremindDays日以内）の件数
  const subDueCount = subsList
    .filter((s) => s.active)
    .filter((s) => subSignal(iso(nextBilling(s))).diff <= (subSettings.remindDays ?? 7)).length;

  // ── 売上（収入）操作。定期収入 recurringRevenues／単発 revenues。必ず || [] フォールバック ──
  const recRevList = data.recurringRevenues || [];
  const oneRevList = data.revenues || [];
  const recRevOps = {
    add: (item) => update({ recurringRevenues: [...recRevList, { id: "r" + Date.now(), active: true, ...item }] }),
    edit: (id, patch) => update({ recurringRevenues: recRevList.map((x) => (x.id === id ? { ...x, ...patch } : x)) }),
    remove: (id) => confirmDelete(() => update({ recurringRevenues: recRevList.filter((x) => x.id !== id) })),
    toggle: (id) => update({ recurringRevenues: recRevList.map((x) => (x.id === id ? { ...x, active: !x.active } : x)) }),
  };
  const oneRevOps = {
    add: (item) => update({ revenues: [...oneRevList, { id: "o" + Date.now(), ...item }] }),
    edit: (id, patch) => update({ revenues: oneRevList.map((x) => (x.id === id ? { ...x, ...patch } : x)) }),
    remove: (id) => confirmDelete(() => update({ revenues: oneRevList.filter((x) => x.id !== id) })),
  };

  // 固定費の月額換算合計／今月発生分（売上タブの「手残り」計算に渡す）
  const _now = new Date();
  const subActive = subsList.filter((s) => s.active);
  const fixedMonthly = subActive.reduce((t, s) => t + toMonthly(s.amount, s.cycle), 0);
  const fixedThisMonth = subActive.reduce((t, s) => t + billedInMonth(s, _now.getFullYear(), _now.getMonth()), 0);

  const today = new Date();
  const dateLabel = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日(${WD[today.getDay()]})`;

  // ── カレンダー由来データの組み立て（複数カレンダー対応）──
  const usingCal = !!calToken && calStatus === "ok";
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

  // 今週の時間メーター：仕事カレンダーの時間指定予定のみ（家族は除外）
  const weekStart = startOfWeekMonday(today);
  const weekEnd = addDays(weekStart, 7);
  const weekWork = includedEntries.filter((e) => e.role === "work" && !e.allDay && e.start >= weekStart && e.start < weekEnd);
  const scheduleEntries = usingCal ? weekWork : LOG;
  const scheduleSource = usingCal ? "calendar" : "sample";

  // 今日の予定：仕事＋家族（本日分）／横スワイプで先の日も見られるよう数日分を用意
  const todayStart = startOfDay(today);
  const todayEnd = addDays(todayStart, 1);
  const DAYS_AHEAD = 7;
  const dayBuckets = [];
  for (let d = 0; d < DAYS_AHEAD; d++) {
    const ds = addDays(todayStart, d);
    const de = addDays(ds, 1);
    const items = usingCal
      ? includedEntries.filter((e) => e.start >= ds && e.start < de).sort((a, b) => a.time.localeCompare(b.time))
      : LOG.filter((e) => e.wd === ds.getDay()).slice().sort((a, b) => a.time.localeCompare(b.time));
    const label = d === 0 ? "今日" : d === 1 ? "明日" : d === 2 ? "明後日" : `${ds.getMonth() + 1}/${ds.getDate()}`;
    dayBuckets.push({ key: d, date: ds, label, items });
  }

  // 今後の予定（先2ヶ月）：家族は全件、仕事は重要イベント（出張/ライブ/終日 等）のみ
  const upcoming = includedEntries
    .filter((e) => e.start >= todayEnd && e.start < addDays(today, 62) && (e.role === "family" || isNotable(e)))
    .sort((a, b) => a.start - b.start);

  const calProps = {
    source: scheduleSource,
    status: calStatus,
    error: calError,
    onConnect: connectCalendar,
    connecting,
    count: weekWork.length,
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "system-ui, -apple-system, 'Hiragino Sans', sans-serif" }}>
      {/* ヘッダー */}
      <header style={{ position: "sticky", top: 0, zIndex: 10, background: "rgba(15,17,21,0.85)", backdropFilter: "blur(8px)", borderBottom: `1px solid ${C.line}`, padding: "12px 18px", display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ fontSize: 11, letterSpacing: 3, color: C.accent }}>VIELE</div>
        <strong style={{ fontSize: 15 }}>secretary</strong>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: C.sub }}>{dateLabel}</span>
        <button onClick={cycleFont} title="文字サイズを変える" style={{ ...iconBtn, fontSize: 12, padding: "4px 8px", width: "auto", border: `1px solid ${C.line}`, borderRadius: 8 }}>
          文字{fontLabel}
        </button>
        {firebaseEnabled && (
          <button onClick={logout} style={{ ...iconBtn, fontSize: 12, padding: "4px 10px", width: "auto" }}>ログアウト</button>
        )}
      </header>

      <main style={{ maxWidth: 760, margin: "0 auto", padding: 18, position: "relative", zoom: fontScale }}>
        {!firebaseEnabled && (
          <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 12, padding: "10px 14px", marginBottom: 16, fontSize: 12, color: C.sub, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: C.accent }}>●</span>
            ローカルモード — この端末に保存中。複数端末で同期するには <code style={{ color: C.text }}>.env</code> にFirebaseの値を設定してください（README参照）。
          </div>
        )}

        <MainTabs tab={mainTab} onChange={setMainTab} dueCount={subDueCount} />

        {mainTab === "dashboard" && (
          <>
            <TripChain
              trips={data.trips}
              onToggle={toggleTripItem}
              onAdd={addTrip}
              onRemove={removeTrip}
              onEditTrip={editTrip}
              onAddItem={addTripItem}
              onEditItem={editTripItem}
              onRemoveItem={removeTripItem}
            />
            <DeadlineBoard deadlines={data.deadlines} onAdd={addDeadline} onAddBulk={addDeadlinesBulk} onEdit={editDeadline} onRemove={removeDeadline} />
            <TimeMeter entries={scheduleEntries} {...calProps} />
            <Schedule days={dayBuckets} {...calProps} onSetCat={setEventCat} />
            {usingCal && <Upcoming events={upcoming} />}
            {usingCal && calList.length > 0 && <CalendarSettings calList={calList} roleForCal={roleForCal} onSetRole={setCalRole} onDisconnect={disconnectCalendar} />}

            <CheckList
              title="コンテンツ制作サイクル"
              accent={C.blue}
              items={data.content}
              onToggle={content.toggle}
              onAdd={content.add}
              onEdit={content.edit}
              onRemove={content.remove}
              placeholder="制作物を追加…"
              renderMeta={(it) => it.phase && <span style={{ fontSize: 11, color: C.blue }}>{it.phase}</span>}
            />

            <MoneyList
              items={data.money}
              onToggle={money.toggle}
              onAdd={money.add}
              onEdit={money.edit}
              onRemove={money.remove}
            />

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
          </>
        )}

        {mainTab === "subscriptions" && (
          <SubscriptionsTab
            subs={subsList}
            settings={subSettings}
            onAdd={subsOps.add}
            onEdit={subsOps.edit}
            onRemove={subsOps.remove}
            onToggle={subsOps.toggle}
            onSettings={setSubSettings}
            uid={firebaseEnabled ? user?.uid : "local"}
          />
        )}

        {mainTab === "revenue" && (
          <RevenueTab
            recurring={recRevList}
            oneTime={oneRevList}
            fixedMonthly={fixedMonthly}
            fixedThisMonth={fixedThisMonth}
            recOps={recRevOps}
            onceOps={oneRevOps}
          />
        )}

        <footer style={{ textAlign: "center", color: C.faint, fontSize: 11, padding: "12px 0 32px" }}>
          {firebaseEnabled
            ? `${user?.displayName ? user.displayName + " として" : ""}ログイン中 ・ 全端末でFirestore同期`
            : "ローカルモード ・ この端末に保存"}
        </footer>
      </main>
    </div>
  );
}

function Splash({ text }) {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: C.bg, color: C.sub }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 11, letterSpacing: 4, color: C.accent }}>VIELE</div>
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
const chipBtn = {
  background: "transparent",
  border: `1px solid ${C.line}`,
  color: C.text,
  borderRadius: 8,
  padding: "6px 12px",
  fontSize: 12,
  cursor: "pointer",
  whiteSpace: "nowrap",
};
const iconBtn = {
  background: "transparent",
  border: "none",
  color: C.faint,
  cursor: "pointer",
  fontSize: 13,
  width: 24,
  flex: "0 0 auto",
};

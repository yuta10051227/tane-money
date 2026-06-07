import { useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, GoogleAuthProvider } from "firebase/auth";
import { auth, googleProvider, firebaseEnabled } from "./firebase";
import { useCloud } from "./useCloud";
import { useLocal } from "./useLocal";
import { CALENDAR_SCOPE, fetchCalendarList, fetchEvents, classifyEvent, isNotable, startOfWeekMonday, pad2 } from "./calendar";
import { revokeToken } from "./gauth";

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

/* 「今日の要対応」集約：遅れ(late) と もうすぐ(soon) を抽出（取りこぼし防止） */
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
  late.sort((a, b) => a.diff - b.diff);
  soon.sort((a, b) => a.diff - b.diff);
  return { late, soon };
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
    // まとめ(ニュース)の情報源（編集可）
    feeds: [
      { id: "f1", name: "Googleニュース", url: "https://news.google.com/rss?hl=ja&gl=JP&ceid=JP:ja" },
      { id: "f2", name: "SNS集客・マーケ", url: "https://news.google.com/rss/search?q=SNS%20マーケティング%20集客&hl=ja&gl=JP&ceid=JP:ja" },
      { id: "f3", name: "個人事業・フリーランス", url: "https://news.google.com/rss/search?q=個人事業主%20フリーランス&hl=ja&gl=JP&ceid=JP:ja" },
    ],
    digest: null,
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
        <button onClick={() => goTo(idx - 1)} disabled={idx === 0} style={{ ...iconBtn, width: 32, fontSize: 18, opacity: idx === 0 ? 0.3 : 1 }} aria-label="前へ">‹</button>
        <div style={{ flex: 1, textAlign: "center", fontSize: 14, fontWeight: 700 }}>{cur.label}</div>
        <button onClick={() => goTo(idx + 1)} disabled={idx >= slides.length - 1} style={{ ...iconBtn, width: 32, fontSize: 18, opacity: idx >= slides.length - 1 ? 0.3 : 1 }} aria-label="次へ">›</button>
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
      {hint && <div style={{ fontSize: 11, color: C.faint, marginTop: 8, textAlign: "center" }}>{hint}</div>}
    </>
  );
}

function Schedule({ days, source, status, error, count, onConnect, connecting, onSetCat }) {
  const list = days || [];
  const slides = list.map((day) => ({
    key: day.key,
    label: `${day.label}（${day.date.getMonth() + 1}/${day.date.getDate()} ${WD[day.date.getDay()]}）`,
    content: day.items.length === 0
      ? <Empty>予定はありません。</Empty>
      : <div style={{ display: "grid", gap: 10 }}>{day.items.map((e, i) => <ScheduleRow key={i} e={e} source={source} onSetCat={onSetCat} />)}</div>,
  }));
  return (
    <Panel title="予定（横スワイプで先の日へ）" accent={C.blue}>
      <CalStatusNote source={source} status={status} error={error} count={count} onConnect={onConnect} connecting={connecting} />
      <SwipeView slides={slides} accent={C.blue} hint="← 横スワイプ / 矢印で 今日・明日・明後日… →" />
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

/* 今日のまとめ（ニュースRSS集約＋任意でAI要約） */
function DigestPanel({ digest, loading, error, onRefresh, feeds, onAddFeed, onRemoveFeed }) {
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const items = (digest && digest.items) || [];
  const shown = showAll ? items : items.slice(0, 12);
  const briefLines = (digest && digest.briefing ? digest.briefing.split("\n") : []).filter((l) => l.trim());

  return (
    <Panel
      title="今日のまとめ（ニュース）"
      accent={C.blue}
      help="登録した情報源(RSS)の新着をまとめて表示します。サーバーのGeminiキーを設定すると、見出しから『今日の3行ブリーフィング』をAIが自動生成します(未設定でも見出しは出ます)。"
      right={<button onClick={onRefresh} disabled={loading} style={chipBtn}>{loading ? "取得中…" : "更新"}</button>}
    >
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
                    <div style={{ fontSize: 11, color: C.faint }}>{it.source}{it.date ? ` ・ ${fmtNews(it.date)}` : ""}</div>
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

      {digest && digest.aiEnabled === false && briefLines.length === 0 && (
        <div style={{ fontSize: 11, color: C.faint, marginTop: 12 }}>
          ※ AI要約はオフ（GeminiキーをVercelに設定すると自動でオンになります）
        </div>
      )}

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
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="RSSのURL" style={{ ...inp, marginBottom: 0, flex: "1 1 140px" }} />
              <button onClick={() => { if (!url.trim()) return; onAddFeed({ name: name.trim(), url: url.trim() }); setName(""); setUrl(""); }} style={chipBtn}>追加</button>
            </div>
            <div style={{ fontSize: 11, color: C.faint }}>例：ブログ等のRSS、Googleニュース検索のRSS。記事は見出し＋出典リンクのみ表示します。</div>
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
          {it.kind && <span style={{ fontSize: 11, color: kindColor(it.kind) }}>{it.kind}</span>}
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
          {late.length > 5 && <div style={{ fontSize: 12, color: C.faint }}>ほか遅れ {late.length - 5}件</div>}
          {soon.slice(0, 5).map((e, i) => (
            <Row key={"s" + i} dot="🟠" color={C.orange} label={e.label} right={e.diff === 0 ? "今日" : `あと${e.diff}日`} />
          ))}
          {soon.length > 5 && <div style={{ fontSize: 12, color: C.faint }}>ほか間近 {soon.length - 5}件</div>}
        </div>
      )}
    </Panel>
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

  // ── Googleカレンダー連携（Firebaseポップアップ＋localStorage、約1時間有効）──
  const [calToken, setCalToken] = useState(() => localStorage.getItem("viele-cal-token") || null);
  const [calList, setCalList] = useState([]);
  const [calEvents, setCalEvents] = useState([]);
  const [calStatus, setCalStatus] = useState("idle"); // idle|loading|ok|error
  const [calError, setCalError] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [tab, setTab] = useState(0); // トップのタブ（ホーム/仕事/売上/タスク/ニュース）
  const tabTouch = useRef(null);

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

  // 「連携」：カレンダー読み取り権限を要求してアクセストークン取得（約1時間有効）
  const connectCalendar = async () => {
    setConnecting(true);
    setCalError(null);
    try {
      const provider = new GoogleAuthProvider();
      provider.addScope(CALENDAR_SCOPE);
      const result = await signInWithPopup(auth, provider);
      const token = GoogleAuthProvider.credentialFromResult(result)?.accessToken;
      if (token) { localStorage.setItem("viele-cal-token", token); setCalToken(token); }
      else throw new Error("アクセストークンを取得できませんでした");
    } catch (e) {
      setCalError(e);
      setCalStatus("error");
    }
    setConnecting(false);
  };

  // カレンダー連携を解除（トークン失効＝revoke＋破棄）
  const disconnectCalendar = () => {
    revokeToken(calToken);
    localStorage.removeItem("viele-cal-token");
    setCalToken(null); setCalEvents([]); setCalList([]); setCalStatus("idle"); setCalError(null);
  };

  // ログアウト（共有端末対策でカレンダートークンも破棄）
  const logout = () => {
    revokeToken(calToken);
    localStorage.removeItem("viele-cal-token");
    signOut(auth);
  };

  // ── 今日のまとめ（ニュース）状態 ──
  const [digestLoading, setDigestLoading] = useState(false);
  const [digestError, setDigestError] = useState(null);
  const digestRef = useRef(false);

  // ── 通知（任意）：開いた時に遅れがあればブラウザ通知 ──
  const notifySupported = typeof Notification !== "undefined";
  const [notify, setNotify] = useState(() => localStorage.getItem("viele-notify") === "1");
  const notifiedRef = useRef(false);
  const enableNotify = async () => {
    if (!notifySupported) { alert("この端末/ブラウザは通知に対応していません。"); return; }
    const p = await Notification.requestPermission();
    if (p === "granted") { setNotify(true); localStorage.setItem("viele-notify", "1"); }
    else alert("通知が許可されませんでした。端末の設定から許可できます。");
  };
  const cloud = useCloud(firebaseEnabled ? user?.uid || null : null, seed);
  const local = useLocal(STORE_KEY, seed);
  const { data, loading, error, update } = firebaseEnabled ? cloud : local;

  // 開いた時に遅れがあればブラウザ通知（dataを使うのでdata宣言後に置く）
  useEffect(() => {
    if (notifiedRef.current || !notify || !data) return;
    if (!notifySupported || Notification.permission !== "granted") return;
    const { late, soon } = computeAlerts(data);
    if (late.length + soon.length > 0) {
      try {
        new Notification("VIELE secretary｜今日の要対応", {
          body: `遅れ ${late.length}件・もうすぐ ${soon.length}件`,
          icon: "/icon-512.png",
        });
      } catch { /* iOS等はnew Notification不可。無視 */ }
    }
    notifiedRef.current = true;
  }, [notify, data, notifySupported]);

  // ── 今日のまとめ（ニュース）取得 ──
  const refreshDigest = async () => {
    if (!data) return;
    setDigestLoading(true);
    setDigestError(null);
    try {
      const fp = (data.feeds || []).map((f) => encodeURIComponent(f.url)).join(",");
      const r = await fetch(`/api/digest?summarize=1${fp ? `&feeds=${fp}` : ""}`);
      const j = await r.json();
      if (j.error) throw new Error(j.error);
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

  // ── 汎用リスト操作（content / money / tasks / feeds）──
  // 既存ユーザーで未定義のキーでも落ちないよう (data[key] || []) で防御
  const makeListOps = (key) => ({
    toggle: (id) => update({ [key]: (data[key] || []).map((x) => (x.id === id ? { ...x, done: !x.done } : x)) }),
    add: (item) => {
      const base = typeof item === "string" ? { title: item } : item;
      update({ [key]: [...(data[key] || []), { id: key[0] + Date.now(), done: false, ...base }] });
    },
    edit: (id, patch) => update({ [key]: (data[key] || []).map((x) => (x.id === id ? { ...x, ...patch } : x)) }),
    remove: (id) => confirmDelete(() => update({ [key]: (data[key] || []).filter((x) => x.id !== id) })),
  });
  const content = makeListOps("content");
  const money = makeListOps("money");
  const tasks = makeListOps("tasks");
  const feedsOps = makeListOps("feeds");

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

  const alerts = computeAlerts(data);

  // トップのタブ
  const TABS = ["ホーム", "仕事", "売上", "タスク", "ニュース"];
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
      setTab((v) => Math.max(0, Math.min(TABS.length - 1, v + (dx < 0 ? 1 : -1))));
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "system-ui, -apple-system, 'Hiragino Sans', sans-serif" }}>
      {/* ヘッダー＋タブバー */}
      <header style={{ position: "sticky", top: 0, zIndex: 10, background: "rgba(15,17,21,0.9)", backdropFilter: "blur(8px)", borderBottom: `1px solid ${C.line}`, padding: "10px 14px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <div style={{ fontSize: 11, letterSpacing: 3, color: C.accent }}>VIELE</div>
          <strong style={{ fontSize: 15 }}>secretary</strong>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: C.sub }}>{dateLabel}</span>
          <button onClick={cycleFont} title="文字サイズを変える" style={{ ...iconBtn, fontSize: 12, padding: "4px 8px", width: "auto", border: `1px solid ${C.line}`, borderRadius: 8 }}>文字{fontLabel}</button>
          {firebaseEnabled && <button onClick={logout} style={{ ...iconBtn, fontSize: 12, padding: "4px 8px", width: "auto" }}>ログアウト</button>}
        </div>
        <div style={{ display: "flex", gap: 6, overflowX: "auto", scrollbarWidth: "none" }}>
          {TABS.map((t, i) => (
            <button
              key={t}
              onClick={() => setTab(i)}
              style={{ flex: "0 0 auto", padding: "6px 14px", borderRadius: 999, border: `1px solid ${tab === i ? C.accent : C.line}`, background: tab === i ? C.accent : "transparent", color: tab === i ? "#0B0D11" : C.sub, fontSize: 13, fontWeight: tab === i ? 700 : 400, cursor: "pointer" }}
            >{t}</button>
          ))}
        </div>
      </header>

      <main onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} style={{ maxWidth: 760, margin: "0 auto", padding: 18, position: "relative", zoom: fontScale }}>
        {!firebaseEnabled && (
          <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 12, padding: "10px 14px", marginBottom: 16, fontSize: 12, color: C.sub, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: C.accent }}>●</span>
            ローカルモード — この端末に保存中。複数端末で同期するには <code style={{ color: C.text }}>.env</code> にFirebaseの値を設定してください（README参照）。
          </div>
        )}

        {tab === 0 && (
          <>
            <AlertSummary alerts={alerts} notify={notify} notifySupported={notifySupported} onEnableNotify={enableNotify} />
            <Schedule days={dayBuckets} {...calProps} onSetCat={setEventCat} />
            <TimeMeter entries={scheduleEntries} {...calProps} />
            {usingCal && <Upcoming events={upcoming} />}
            {usingCal && calList.length > 0 && <CalendarSettings calList={calList} roleForCal={roleForCal} onSetRole={setCalRole} onDisconnect={disconnectCalendar} />}
          </>
        )}

        {tab === 1 && (
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
          </>
        )}

        {tab === 2 && (
          <MoneyList
            items={data.money}
            onToggle={money.toggle}
            onAdd={money.add}
            onEdit={money.edit}
            onRemove={money.remove}
          />
        )}

        {tab === 3 && (
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

        {tab === 4 && (
          <DigestPanel
            digest={data.digest}
            loading={digestLoading}
            error={digestError}
            onRefresh={refreshDigest}
            feeds={data.feeds}
            onAddFeed={(f) => feedsOps.add(f)}
            onRemoveFeed={(id) => feedsOps.remove(id)}
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

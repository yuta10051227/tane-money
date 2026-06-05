import { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult, signOut } from "firebase/auth";
import { auth, googleProvider, firebaseEnabled } from "./firebase";
import { useCloud } from "./useCloud";
import { useLocal } from "./useLocal";

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
  sub: "#9AA1AC",
  faint: "#6B7280",
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
    updatedAt: Date.now(),
  };
}

/* ──────────────────────────────────────────────────────────────
   小物UI
   ────────────────────────────────────────────────────────────── */
function Panel({ title, accent, right, children }) {
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
      <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
        <span style={{ width: 8, height: 18, borderRadius: 4, background: accent || C.accent, marginRight: 10 }} />
        <h2 style={{ fontSize: 15, fontWeight: 700, letterSpacing: 0.4, margin: 0, flex: 1 }}>{title}</h2>
        {right}
      </div>
      {children}
    </section>
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
        width: 22,
        height: 22,
        borderRadius: 7,
        border: `1.5px solid ${done ? C.green : C.line}`,
        background: done ? C.green : "transparent",
        color: "#0B0D11",
        cursor: "pointer",
        flex: "0 0 auto",
        display: "grid",
        placeItems: "center",
        fontSize: 13,
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
function TripChain({ trips, onToggle, onAdd, onRemove }) {
  return (
    <Panel
      title="出張・遠征の逆算チェーン"
      accent={C.green}
      right={<AddTrip onAdd={onAdd} />}
    >
      {(!trips || trips.length === 0) && <Empty>遠征予定はありません。右上の「＋型から追加」で作成。</Empty>}
      <div style={{ display: "grid", gap: 14 }}>
        {(trips || []).map((trip) => {
          const dleft = daysUntil(trip.date);
          const doneCount = trip.items.filter((i) => i.done).length;
          return (
            <div key={trip.id} style={{ background: C.panel2, borderRadius: 12, padding: 14 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <strong style={{ fontSize: 14 }}>{trip.title}</strong>
                <span style={{ fontSize: 11, color: C.sub, border: `1px solid ${C.line}`, borderRadius: 6, padding: "1px 6px" }}>
                  {trip.template}
                </span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 12, color: C.sub }}>本番 {fmt(trip.date)}</span>
                <button onClick={() => onRemove(trip.id)} style={iconBtn} title="削除">✕</button>
              </div>
              <div style={{ fontSize: 12, color: dleft < 0 ? C.red : C.accent, margin: "4px 0 10px" }}>
                {dleft < 0 ? `本番から${-dleft}日経過` : `本番まであと ${dleft}日`} ・ 手配 {doneCount}/{trip.items.length}
              </div>
              <div style={{ display: "grid", gap: 6 }}>
                {trip.items.map((item, idx) => {
                  const sig = itemSignal(item, trip.date);
                  return (
                    <div key={idx} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <Check done={item.done} onClick={() => onToggle(trip.id, idx)} />
                      <span style={{ flex: 1, fontSize: 13, textDecoration: item.done ? "line-through" : "none", color: item.done ? C.faint : C.text }}>
                        {item.label}
                      </span>
                      {!item.done && (
                        <span style={{ fontSize: 11, color: C.faint }}>締切 {fmt(sig.deadlineISO)}</span>
                      )}
                      <span style={{ fontSize: 11, color: sig.color, minWidth: 54, textAlign: "right" }}>
                        {sig.dot} {sig.label}
                      </span>
                    </div>
                  );
                })}
              </div>
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
function DeadlineBoard({ deadlines }) {
  const sorted = [...(deadlines || [])].sort((a, b) => new Date(a.date) - new Date(b.date));
  return (
    <Panel title="締切からの逆算（二段ローンチ）" accent={C.purple}>
      {sorted.length === 0 && <Empty>締切は登録されていません。</Empty>}
      <div style={{ display: "grid", gap: 10 }}>
        {sorted.map((d, i) => {
          const sig = deadlineSignal(d.date);
          return (
            <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 12, background: C.panel2, borderRadius: 12, padding: "12px 14px" }}>
              <span style={{ width: 26, height: 26, borderRadius: "50%", background: C.panel, border: `1px solid ${C.line}`, display: "grid", placeItems: "center", fontSize: 12, color: C.sub }}>
                {i + 1}
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14 }}>{d.title}</div>
                <div style={{ fontSize: 11, color: C.sub }}>{d.stage} ・ {fmt(d.date)}</div>
              </div>
              <span style={{ fontSize: 12, color: sig.color, fontWeight: 600 }}>{sig.dot} {sig.label}</span>
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
function TimeMeter() {
  const total = LOG.reduce((s, e) => s + e.hours, 0);
  const byCat = useMemo(() => {
    const m = {};
    for (const k of Object.keys(CAT)) m[k] = 0;
    for (const e of LOG) m[e.cat] += e.hours;
    return m;
  }, []);
  const labor = LOG.filter((e) => e.axis === "労働").reduce((s, e) => s + e.hours, 0);
  const system = total - labor;
  const systemPct = total > 0 ? Math.round((system / total) * 100) : 0;

  return (
    <Panel title="今週の時間配分メーター" accent={C.accent} right={<span style={{ fontSize: 12, color: C.sub }}>計 {total}h</span>}>
      <div style={{ display: "grid", gap: 12 }}>
        {Object.keys(CAT).map((cat) => (
          <div key={cat}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
              <span style={{ color: CAT[cat] }}>● {cat}</span>
              <span style={{ color: C.sub }}>{byCat[cat]}h</span>
            </div>
            <Bar value={byCat[cat]} total={total} color={CAT[cat]} />
          </div>
        ))}
      </div>

      <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px solid ${C.line}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.sub, marginBottom: 6 }}>
          <span>労働（自分が動く） {labor}h</span>
          <span>仕組み（資産になる） {system}h</span>
        </div>
        <div style={{ display: "flex", height: 12, borderRadius: 6, overflow: "hidden" }}>
          <div style={{ width: `${100 - systemPct}%`, background: C.orange }} />
          <div style={{ width: `${systemPct}%`, background: C.green }} />
        </div>
        <div style={{ fontSize: 12, color: systemPct >= 40 ? C.green : C.orange, marginTop: 8 }}>
          仕組み化 {systemPct}% — {systemPct >= 40 ? "資産づくりに時間が回っています。" : "労働比率が高め。仕組み側へ寄せる余地あり。"}
        </div>
      </div>
    </Panel>
  );
}

/* ──────────────────────────────────────────────────────────────
   今日の予定（LOGから本日の曜日を抽出）
   ────────────────────────────────────────────────────────────── */
function Today() {
  const wd = new Date().getDay();
  const items = LOG.filter((e) => e.wd === wd).sort((a, b) => a.time.localeCompare(b.time));
  return (
    <Panel title={`今日の予定（${WD[wd]}曜）`} accent={C.blue}>
      {items.length === 0 ? (
        <Empty>今日の登録予定はありません。</Empty>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {items.map((e, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontVariantNumeric: "tabular-nums", color: C.sub, fontSize: 13, width: 46 }}>{e.time}</span>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: CAT[e.cat] }} />
              <span style={{ flex: 1, fontSize: 14 }}>{e.title}</span>
              <span style={{ fontSize: 11, color: CAT[e.cat] }}>{e.cat}</span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/* ──────────────────────────────────────────────────────────────
   汎用チェックリスト（コンテンツ / お金 / 追加タスク）
   ────────────────────────────────────────────────────────────── */
function CheckList({ title, accent, items, onToggle, onAdd, onRemove, renderMeta, placeholder }) {
  const [text, setText] = useState("");
  const list = items || [];
  return (
    <Panel title={title} accent={accent}>
      <div style={{ display: "grid", gap: 8 }}>
        {list.length === 0 && <Empty>項目はありません。</Empty>}
        {list.map((it) => (
          <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Check done={it.done} onClick={() => onToggle(it.id)} />
            <span style={{ flex: 1, fontSize: 14, textDecoration: it.done ? "line-through" : "none", color: it.done ? C.faint : C.text }}>
              {it.title}
            </span>
            {renderMeta && renderMeta(it)}
            <button onClick={() => onRemove(it.id)} style={iconBtn} title="削除">✕</button>
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

function Empty({ children }) {
  return <div style={{ fontSize: 13, color: C.faint, padding: "6px 2px" }}>{children}</div>;
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
  const seed = useMemo(() => makeSeed(), []);

  // Firebase設定があればクラウド同期、なければこの端末にローカル保存。
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
  if (error) return <ErrorScreen error={error} onSignOut={() => signOut(auth)} />;
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
  const removeTrip = (id) => update({ trips: data.trips.filter((t) => t.id !== id) });

  // ── 汎用リスト操作（content / money / tasks）──
  const makeListOps = (key) => ({
    toggle: (id) => update({ [key]: data[key].map((x) => (x.id === id ? { ...x, done: !x.done } : x)) }),
    add: (title) => update({ [key]: [...data[key], { id: key[0] + Date.now(), title, done: false }] }),
    remove: (id) => update({ [key]: data[key].filter((x) => x.id !== id) }),
  });
  const content = makeListOps("content");
  const money = makeListOps("money");
  const tasks = makeListOps("tasks");

  const today = new Date();
  const dateLabel = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日(${WD[today.getDay()]})`;

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "system-ui, -apple-system, 'Hiragino Sans', sans-serif" }}>
      {/* ヘッダー */}
      <header style={{ position: "sticky", top: 0, zIndex: 10, background: "rgba(15,17,21,0.85)", backdropFilter: "blur(8px)", borderBottom: `1px solid ${C.line}`, padding: "12px 18px", display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ fontSize: 11, letterSpacing: 3, color: C.accent }}>VIELE</div>
        <strong style={{ fontSize: 15 }}>secretary</strong>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: C.sub }}>{dateLabel}</span>
        {firebaseEnabled && (
          <button onClick={() => signOut(auth)} style={{ ...iconBtn, fontSize: 12, padding: "4px 10px", width: "auto" }}>ログアウト</button>
        )}
      </header>

      <main style={{ maxWidth: 760, margin: "0 auto", padding: 18, position: "relative" }}>
        {!firebaseEnabled && (
          <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 12, padding: "10px 14px", marginBottom: 16, fontSize: 12, color: C.sub, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: C.accent }}>●</span>
            ローカルモード — この端末に保存中。複数端末で同期するには <code style={{ color: C.text }}>.env</code> にFirebaseの値を設定してください（README参照）。
          </div>
        )}
        <TripChain trips={data.trips} onToggle={toggleTripItem} onAdd={addTrip} onRemove={removeTrip} />
        <DeadlineBoard deadlines={data.deadlines} />
        <TimeMeter />
        <Today />

        <CheckList
          title="コンテンツ制作サイクル"
          accent={C.blue}
          items={data.content}
          onToggle={content.toggle}
          onAdd={content.add}
          onRemove={content.remove}
          placeholder="制作物を追加…"
          renderMeta={(it) => it.phase && <span style={{ fontSize: 11, color: C.blue }}>{it.phase}</span>}
        />

        <CheckList
          title="請求・お金"
          accent={C.accent}
          items={data.money}
          onToggle={money.toggle}
          onAdd={money.add}
          onRemove={money.remove}
          placeholder="請求・入金項目を追加…"
          renderMeta={(it) => it.kind && <span style={{ fontSize: 11, color: it.kind === "入金" ? C.green : C.accent }}>{it.kind}</span>}
        />

        <CheckList
          title="追加タスク"
          accent={C.purple}
          items={data.tasks}
          onToggle={tasks.toggle}
          onAdd={tasks.add}
          onRemove={tasks.remove}
          placeholder="タスクを追加…"
        />

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

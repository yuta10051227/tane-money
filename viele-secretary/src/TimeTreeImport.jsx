// TimeTree移行：スクリーンショットをAI(サーバー側Gemini)で解析し、Googleカレンダーに一括登録する。
// - 画像解析は親(App)から渡される onParse(file) を使う（キーはサーバー側で秘匿）。
// - カレンダー書き込みは gauth/calendar の既存関数を直接使う（createEvent / checkDuplicate）。
// - 予定はタイトルからカテゴリー(施術/制作/集客/経営/その他)を自動判定し、
//   「カテゴリー別の登録先カレンダー」へ振り分けて登録できる。
// - 既存の Firebase 認証・占術・カレンダー表示には一切手を入れない。

import { useState, useMemo } from "react";
import { getAccessToken } from "./gauth";
import { fetchCalendarList, createEvent, checkDuplicate, classifyEvent, pad2 } from "./calendar";

const CATS = ["施術", "制作", "集客", "経営", "その他"];

// import-schedule の戻り {date, time, title}（time は "HH:MM" か "終日"）を登録用に正規化
function normalizeEvent(e) {
  const allDay = !e.time || e.time === "終日";
  return {
    title: e.title || "(無題)",
    date: e.date,
    start_time: allDay ? "" : String(e.time),
    end_time: "",
    all_day: allDay,
    location: "",
    notes: "",
    category: classifyEvent(e.title).cat, // 施術/制作/集客/経営/その他
    status: "pending", // pending | success | skipped | failed
    error: "",
  };
}

// "YYYY-MM-DD" の翌日（終日イベントの end 用）
function nextDateStr(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
// "HH:MM" に1時間足す（end_time 未指定時のデフォルト）
function addOneHour(hhmm) {
  const [h, m] = String(hhmm).split(":").map((n) => Number(n) || 0);
  let nh = h + 1;
  if (nh > 23) nh = 23;
  return `${pad2(nh)}:${pad2(m)}`;
}
const hhmm = (t) => (String(t).length === 4 ? "0" + t : String(t)); // "9:00"→"09:00" の保険

// 正規化イベント → createEvent に渡す Calendar API 形式
function toEventBody(ev, includeTime) {
  const allDay = ev.all_day || !ev.start_time || !includeTime;
  if (allDay) {
    return { summary: ev.title, start: { date: ev.date }, end: { date: nextDateStr(ev.date) } };
  }
  const st = hhmm(ev.start_time);
  const et = hhmm(ev.end_time || addOneHour(ev.start_time));
  return {
    summary: ev.title,
    location: ev.location || undefined,
    description: ev.notes || undefined,
    start: { dateTime: `${ev.date}T${st}:00`, timeZone: "Asia/Tokyo" },
    end: { dateTime: `${ev.date}T${et}:00`, timeZone: "Asia/Tokyo" },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// calCatMap = { [calendarId]: "施術"|... }（既存のカレンダー区分設定）。プロパティが無ければ {}。
export default function TimeTreeImport({ C, onParse, calCatMap = {} }) {
  const [files, setFiles] = useState([]);          // {id, file, name}
  const [parsing, setParsing] = useState(false);
  const [parseMsg, setParseMsg] = useState(null);
  const [events, setEvents] = useState([]);        // 正規化イベント配列
  const [token, setToken] = useState(null);
  const [calendars, setCalendars] = useState([]);
  const [catCal, setCatCal] = useState({});        // { [category]: calendarId } 手動マッピング上書き
  const [calMsg, setCalMsg] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [skipDup, setSkipDup] = useState(true);
  const [includeTime, setIncludeTime] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [progress, setProgress] = useState(null);  // {done, total}
  const [result, setResult] = useState(null);      // {success, skipped, failed}
  const [dragOver, setDragOver] = useState(false);

  // ── スタイル（C パレット踏襲）──
  const card = { background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, marginTop: 10 };
  const btnPrimary = { padding: "10px 16px", borderRadius: 10, border: `1px solid ${C.accent}`, background: C.accent, color: "#0B0D11", fontWeight: 700, cursor: "pointer", fontSize: 14 };
  const btnGhost = { padding: "8px 14px", borderRadius: 10, border: `1px solid ${C.line}`, background: C.panel, color: C.text, fontWeight: 700, cursor: "pointer", fontSize: 13 };
  const labelRow = { display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.text, cursor: "pointer", padding: "4px 0" };
  const selStyle = { padding: "7px 9px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.panel, color: C.text, fontSize: 13, maxWidth: "100%", boxSizing: "border-box" };

  const primaryId = useMemo(() => {
    const p = calendars.find((c) => c.primary) || calendars[0];
    return p ? p.id : "";
  }, [calendars]);

  // calCatMap を逆引きして、カテゴリーの既定カレンダーを推定（無ければメイン）
  const defaultCalForCat = (cat) => {
    const hit = calendars.find((c) => calCatMap[c.id] === cat);
    return hit ? hit.id : primaryId;
  };
  // カテゴリーの実際の登録先（手動上書き優先）
  const resolveCal = (cat) => catCal[cat] || defaultCalForCat(cat);

  // 解析結果に含まれるカテゴリー（表示順は CATS 準拠）
  const presentCats = useMemo(() => {
    const set = new Set(events.map((e) => e.category));
    return CATS.filter((c) => set.has(c));
  }, [events]);

  const addFiles = (fileList) => {
    const imgs = Array.from(fileList || []).filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return;
    setFiles((prev) => [...prev, ...imgs.map((f, i) => ({ id: `${Date.now()}_${i}_${f.name}`, file: f, name: f.name }))]);
    setResult(null);
  };
  const removeFile = (id) => setFiles((prev) => prev.filter((f) => f.id !== id));

  // ① 解析：各画像を onParse に通して予定を抽出
  const doParse = async () => {
    if (!files.length || parsing) return;
    setParsing(true); setParseMsg(null); setResult(null);
    const all = [];
    let failed = 0;
    let lastErr = "";
    for (const f of files) {
      try {
        const evs = await onParse(f.file); // [{date, time, title}]
        (evs || []).forEach((e) => { if (e && e.date && e.title) all.push(normalizeEvent(e)); });
      } catch (err) {
        failed += 1;
        lastErr = String((err && err.message) || err);
      }
    }
    // 抽出結果内の重複（同一 date|time|title）を除外
    const seen = new Set();
    const uniq = all.filter((e) => {
      const k = `${e.date}|${e.start_time}|${e.title}`;
      if (seen.has(k)) return false; seen.add(k); return true;
    });
    setEvents(uniq);
    setParseMsg(
      uniq.length
        ? `${uniq.length}件の予定を読み取りました${failed ? `（${failed}枚は解析失敗）` : ""}`
        : `予定を読み取れませんでした${failed ? `（${failed}枚失敗：${lastErr}）` : "。別のスクショで再試行してください"}`
    );
    setParsing(false);
  };

  // ② Googleカレンダーに接続してカレンダー一覧を取得
  const connect = async () => {
    if (connecting) return;
    setConnecting(true); setCalMsg(null);
    try {
      const t = await getAccessToken({ interactive: true });
      setToken(t);
      const list = await fetchCalendarList(t);
      setCalendars(list);
      setCalMsg(list.length ? null : "書き込めるカレンダーが見つかりませんでした");
    } catch (e) {
      setCalMsg("接続に失敗しました：" + String((e && e.message) || e));
    }
    setConnecting(false);
  };

  // 1イベントのカテゴリーを手動変更
  const setEventCategory = (idx, cat) => setEvents((prev) => prev.map((x, i) => (i === idx ? { ...x, category: cat } : x)));

  // ③ 登録：カテゴリー別の登録先へ。重複チェック→createEvent（150ms間隔）。進捗・ステータス逐次更新
  const doRegister = async () => {
    if (registering || !events.length) return;
    if (!calendars.length) { setCalMsg("先に「Googleカレンダーに接続」してください"); return; }
    setRegistering(true); setResult(null); setCalMsg(null);

    let t = token;
    try {
      if (!t) { t = await getAccessToken({ interactive: true }); setToken(t); }
    } catch (e) {
      setCalMsg("Googleの認証に失敗しました：" + String((e && e.message) || e));
      setRegistering(false);
      return;
    }

    // すでに成功したものは除く＝再実行で二重登録しない
    const targets = events.map((e, i) => ({ e, i })).filter(({ e }) => e.status !== "success");
    let success = 0, skipped = 0, failed = 0;
    setProgress({ done: 0, total: targets.length });

    for (let n = 0; n < targets.length; n++) {
      const { e, i } = targets[n];
      const calId = resolveCal(e.category);
      let status = "success", error = "";
      try {
        if (!calId) throw new Error("登録先カレンダーが未設定");
        if (skipDup) {
          const dup = await checkDuplicate(t, calId, e.title, e.date);
          if (dup) { status = "skipped"; skipped += 1; }
        }
        if (status !== "skipped") {
          await createEvent(t, calId, toEventBody(e, includeTime));
          success += 1;
        }
      } catch (err) {
        status = "failed"; error = String((err && err.message) || err); failed += 1;
      }
      setEvents((prev) => prev.map((x, idx) => (idx === i ? { ...x, status, error } : x)));
      setProgress({ done: n + 1, total: targets.length });
      if (n < targets.length - 1) await sleep(150); // レート制限回避
    }

    setResult({ success, skipped, failed });
    setRegistering(false);
  };

  const statusUI = (s) => {
    if (s === "success") return { color: C.green, label: "追加済み" };
    if (s === "skipped") return { color: C.orange || C.sub, label: "重複スキップ" };
    if (s === "failed") return { color: C.red, label: "失敗" };
    return { color: C.sub, label: "追加予定" };
  };
  const calName = (id) => { const c = calendars.find((x) => x.id === id); return c ? c.summary : "（未選択）"; };

  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.line}` }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>📅 TimeTree → Googleカレンダー移行</div>
      <div style={{ fontSize: 12, color: C.sub, lineHeight: 1.6, marginBottom: 8 }}>
        TimeTreeのスクショを読み込み、予定をカテゴリー別のGoogleカレンダーに一括登録します。複数枚まとめて解析できます。
      </div>

      {/* アップロード領域 */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
        style={{ border: `2px dashed ${dragOver ? C.accent : C.line}`, borderRadius: 12, padding: 16, textAlign: "center", background: dragOver ? C.accent + "11" : C.panel }}
      >
        <div style={{ fontSize: 13, color: C.sub, marginBottom: 8 }}>ここに画像をドラッグ＆ドロップ、または</div>
        <label style={{ ...btnGhost, display: "inline-block" }}>
          画像を選ぶ
          <input type="file" accept="image/*" multiple style={{ display: "none" }} onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        </label>
      </div>

      {/* 選択中ファイル */}
      {files.length > 0 && (
        <div style={card}>
          <div style={{ fontSize: 12, color: C.sub, marginBottom: 6 }}>選択中の画像 {files.length}枚</div>
          <div style={{ display: "grid", gap: 4 }}>
            {files.map((f) => (
              <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>🖼️ {f.name}</span>
                <button onClick={() => removeFile(f.id)} style={{ ...btnGhost, padding: "2px 8px", fontSize: 12 }} title="外す">✕</button>
              </div>
            ))}
          </div>
          <button onClick={doParse} disabled={parsing} style={{ ...btnPrimary, marginTop: 10, opacity: parsing ? 0.6 : 1 }}>
            {parsing ? "解析中…" : "スクショを解析する"}
          </button>
          {parseMsg && <div style={{ fontSize: 12, color: C.sub, marginTop: 8 }}>{parseMsg}</div>}
        </div>
      )}

      {/* 解析結果 */}
      {events.length > 0 && (
        <div style={card}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 8 }}>読み取った予定 {events.length}件</div>
          <div style={{ display: "grid", gap: 6, maxHeight: 300, overflowY: "auto" }}>
            {events.map((ev, i) => {
              const ui = statusUI(ev.status);
              return (
                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 8px", background: C.panel, borderRadius: 8, borderLeft: `3px solid ${ui.color}` }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: C.text }}>{ev.title}</div>
                    <div style={{ fontSize: 11, color: C.sub, marginTop: 1 }}>
                      {ev.date}{ev.all_day ? "・終日" : ev.start_time ? `・${ev.start_time}` : ""}
                      {calendars.length > 0 && <span> → {calName(resolveCal(ev.category))}</span>}
                    </div>
                    {ev.error && <div style={{ fontSize: 11, color: C.red, marginTop: 1 }}>{ev.error}</div>}
                  </div>
                  {/* カテゴリー（誤判定はここで修正可） */}
                  <select value={ev.category} onChange={(e) => setEventCategory(i, e.target.value)} style={{ ...selStyle, fontSize: 11, padding: "3px 6px", flex: "0 0 auto" }}>
                    {CATS.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <span style={{ fontSize: 11, fontWeight: 700, color: ui.color, flex: "0 0 auto", marginTop: 3 }}>{ui.label}</span>
                </div>
              );
            })}
          </div>

          {/* 接続 / カテゴリー別 登録先 */}
          <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
            {calendars.length === 0 ? (
              <button onClick={connect} disabled={connecting} style={{ ...btnGhost, opacity: connecting ? 0.6 : 1 }}>
                {connecting ? "接続中…" : "Googleカレンダーに接続"}
              </button>
            ) : (
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 6 }}>カテゴリー別の登録先カレンダー</div>
                <div style={{ display: "grid", gap: 6 }}>
                  {presentCats.map((cat) => (
                    <div key={cat} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ flex: "0 0 64px", fontSize: 13, color: C.text }}>{cat}</span>
                      <span style={{ flex: "0 0 auto", color: C.sub }}>→</span>
                      <select value={resolveCal(cat)} onChange={(e) => setCatCal((m) => ({ ...m, [cat]: e.target.value }))} style={{ ...selStyle, flex: 1 }}>
                        {calendars.map((c) => (
                          <option key={c.id} value={c.id}>{c.summary}{c.primary ? "（メイン）" : ""}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: C.faint, marginTop: 4 }}>
                  既定はカレンダー設定の区分から自動。ここで変更すると、その区分の予定がまとめてそのカレンダーに入ります。
                </div>
              </div>
            )}

            <label style={labelRow}>
              <input type="checkbox" checked={skipDup} onChange={(e) => setSkipDup(e.target.checked)} style={{ width: 17, height: 17, accentColor: C.accent }} />
              重複する予定はスキップ（同じ日・同じタイトル）
            </label>
            <label style={labelRow}>
              <input type="checkbox" checked={includeTime} onChange={(e) => setIncludeTime(e.target.checked)} style={{ width: 17, height: 17, accentColor: C.accent }} />
              時刻情報を含める（オフにすると全て終日で登録）
            </label>
          </div>

          {calMsg && <div style={{ fontSize: 12, color: C.red, marginTop: 8 }}>{calMsg}</div>}

          <button onClick={doRegister} disabled={registering || !calendars.length} style={{ ...btnPrimary, marginTop: 12, width: "100%", opacity: registering || !calendars.length ? 0.6 : 1 }}>
            {registering ? "登録中…" : "Googleカレンダーに登録"}
          </button>

          {progress && (
            <div style={{ fontSize: 12, color: C.sub, marginTop: 8, textAlign: "center" }}>
              {progress.done} / {progress.total} 件 処理
            </div>
          )}
          {result && (
            <div style={{ fontSize: 13, color: C.text, marginTop: 8, textAlign: "center", lineHeight: 1.6 }}>
              <span style={{ color: C.green, fontWeight: 700 }}>追加 {result.success}</span>
              ・<span style={{ color: C.orange || C.sub, fontWeight: 700 }}>スキップ {result.skipped}</span>
              ・<span style={{ color: C.red, fontWeight: 700 }}>失敗 {result.failed}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

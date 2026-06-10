// VIELE secretary — 命式計算エンジン（自前）。astronomy-engine(MIT) で天体位置を算出し、
// 西洋占星術(サイン/ASC) ・ 四柱推命(年月日時の干支) ・ インド占星術(サイデリアル/ナクシャトラ/現行ダシャー) を計算。
// 検証: 本人の鑑定JSON(senjutsu.jp)と太陽/月/ASC/惑星/四柱が一致することを確認済み。

import * as A from "astronomy-engine";

const norm = (d) => ((d % 360) + 360) % 360;
const SIGNS = ["牡羊", "牡牛", "双子", "蟹", "獅子", "乙女", "天秤", "蠍", "射手", "山羊", "水瓶", "魚"];
const G = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"];
const Z = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"];
const NAK = ["アシュヴィニー", "バラニー", "クリッティカー", "ローヒニー", "ムリガシラー", "アールドラー", "プナルヴァス", "プシュヤ", "アーシュレーシャー", "マガー", "プールヴァファルグニー", "ウッタラファルグニー", "ハスタ", "チトラー", "スヴァーティー", "ヴィシャーカー", "アヌラーダー", "ジエーシュター", "ムーラ", "プールヴァアシャーダー", "ウッタラアシャーダー", "シュラヴァナ", "ダニシュター", "シャタビシャー", "プールヴァバードラパダー", "ウッタラバードラパダー", "レーヴァティー"];
// ヴィムショッタリ・ダシャー（合計120年）。ナクシャトラ起点ルーラー順。
const DASHA = [["ケートゥ", 7], ["金星", 20], ["太陽", 6], ["月", 10], ["火星", 7], ["ラーフ", 18], ["木星", 16], ["土星", 19], ["水星", 17]];

const signOf = (lon) => SIGNS[Math.floor(norm(lon) / 30)] + "座";
const degInSign = (lon) => (norm(lon) % 30).toFixed(1);

function jdn(y, m, d) {
  const a = Math.floor((14 - m) / 12), yy = y + 4800 - a, mm = m + 12 * a - 3;
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}
// 日柱: 1990-10-05 = 癸卯(index39) で較正
const DAY_ANCHOR = jdn(1990, 10, 5) - 39;

// Lahiri アヤナムシャ近似（J2000=約23.86°, 約0.0139°/年ドリフト）
function lahiri(year) { return 23.86 + (year - 2000) * 0.013889; }

export function computeChart(birth) {
  const { date, time = "12:00", utcOffset = 9, lat = 35.68, lon = 139.69 } = birth || {};
  const [Y, M, D] = String(date).split("-").map(Number);
  const [hh, mm] = String(time).split(":").map(Number);
  const utc = new Date(Date.UTC(Y, M - 1, D, hh - utcOffset, mm || 0));
  const t = A.MakeTime(utc);

  // 天体黄経（of date, tropical）
  const elon = (body) =>
    body === A.Body.Sun ? norm(A.SunPosition(t).elon)
      : body === A.Body.Moon ? norm(A.EclipticGeoMoon(t).lon)
        : norm(A.Ecliptic(A.GeoVector(body, t, true)).elon);
  const P = {
    太陽: elon(A.Body.Sun), 月: elon(A.Body.Moon), 水星: elon(A.Body.Mercury),
    金星: elon(A.Body.Venus), 火星: elon(A.Body.Mars), 木星: elon(A.Body.Jupiter), 土星: elon(A.Body.Saturn),
  };

  // ASC（上昇宮）
  const gst = A.SiderealTime(t);
  const ramcDeg = norm(gst * 15 + lon);
  const eps = 23.4393 * Math.PI / 180, ramc = ramcDeg * Math.PI / 180, phi = lat * Math.PI / 180;
  const asc = norm(Math.atan2(Math.cos(ramc), -(Math.sin(ramc) * Math.cos(eps) + Math.tan(phi) * Math.sin(eps))) * 180 / Math.PI);

  // ── 四柱推命 ──
  // 年柱（立春[約2/4]で切替）
  const solarYear = (M < 2 || (M === 2 && D < 4)) ? Y - 1 : Y;
  const yIdx = ((solarYear - 1984) % 60 + 60) % 60;
  const yearPillar = G[yIdx % 10] + Z[yIdx % 12];
  // 月柱（太陽黄経で節月を判定。立春=黄経315°=寅月）
  const bucket = Math.floor(norm(P.太陽 - 315) / 30); // 0=寅..11=丑
  const monthBranch = (2 + bucket) % 12;
  const yearStem = yIdx % 10;
  const tigerStem = (yearStem % 5 * 2 + 2) % 10; // 五虎遁: 寅月の天干
  const monthStem = (tigerStem + bucket) % 10;
  const monthPillar = G[monthStem] + Z[monthBranch];
  // 日柱
  const dIdx = ((jdn(Y, M, D) - DAY_ANCHOR) % 60 + 60) % 60;
  const dayStem = dIdx % 10;
  const dayPillar = G[dayStem] + Z[dIdx % 12];
  // 時柱（五鼠遁）
  const hourBranch = Math.floor(((hh + 1) % 24) / 2);
  const hourStem = (dayStem % 5 * 2 + hourBranch) % 10;
  const hourPillar = G[hourStem] + Z[hourBranch];

  // ── インド占星術（サイデリアル）──
  const ayan = lahiri(Y);
  const sidMoon = norm(P.月 - ayan);
  const nakIdx = Math.floor(sidMoon / (360 / 27));
  const nakFrac = (sidMoon % (360 / 27)) / (360 / 27);
  const sidSun = norm(P.太陽 - ayan);

  // 現行ヴィムショッタリ・ダシャー（大運/サブ期）
  const dasha = currentDasha(utc, nakIdx, nakFrac, new Date());

  // 命式テキスト（Geminiへ渡す根拠）
  const lines = [
    `生年月日: ${date} ${time} / 出生地(緯度${lat} 経度${lon}) / UTC+${utcOffset}`,
    `四柱推命: 年柱 ${yearPillar} / 月柱 ${monthPillar} / 日柱 ${dayPillar} / 時柱 ${hourPillar} ・ 日主 ${G[dayStem]}`,
    `西洋占星術: ${Object.entries(P).map(([k, v]) => `${k} ${signOf(v)}${degInSign(v)}°`).join(" / ")} / ASC ${signOf(asc)}${degInSign(asc)}°`,
    `インド占星術: 月のナクシャトラ ${NAK[nakIdx]} / 月 ${signOf(sidMoon)}(サイデリアル) / 太陽 ${signOf(sidSun)}(サイデリアル)`,
    `インド大運(ダシャー): ${dasha.md}期 中の ${dasha.ad}期${dasha.adRange ? `（${dasha.adRange}）` : ""}`,
  ];

  return {
    text: lines.join("\n"),
    yearPillar, monthPillar, dayPillar, hourPillar, dayMaster: G[dayStem],
    western: Object.fromEntries(Object.entries(P).map(([k, v]) => [k, signOf(v)])),
    asc: signOf(asc),
    nakshatra: NAK[nakIdx],
    dasha,
  };
}

// 現行ダシャー（大運MD・サブ期AD）を求める
function currentDasha(birthUtc, nakIdx, nakFrac, today) {
  const startRulerIdx = nakIdx % 9;
  // 大運の並びと開始日
  const mds = [];
  let cursor = new Date(birthUtc);
  for (let i = 0; i < 9; i++) {
    const [ruler, yrs] = DASHA[(startRulerIdx + i) % 9];
    const dur = i === 0 ? yrs * (1 - nakFrac) : yrs;
    const start = new Date(cursor);
    const end = new Date(cursor.getTime() + dur * 365.2425 * 86400000);
    mds.push({ ruler, yrs, start, end });
    cursor = end;
  }
  const md = mds.find((p) => today >= p.start && today < p.end) || mds[mds.length - 1];
  // サブ期(AD)
  let adRuler = md.ruler, adRange = "";
  const mdRulerIdx = DASHA.findIndex((x) => x[0] === md.ruler);
  let c2 = new Date(md.start);
  const mdLen = md.end - md.start;
  for (let i = 0; i < 9; i++) {
    const [ruler, yrs] = DASHA[(mdRulerIdx + i) % 9];
    const adLen = mdLen * (yrs / 120);
    const s = new Date(c2), e = new Date(c2.getTime() + adLen);
    if (today >= s && today < e) { adRuler = ruler; adRange = `${s.getFullYear()}.${s.getMonth() + 1}〜${e.getFullYear()}.${e.getMonth() + 1}`; break; }
    c2 = e;
  }
  return { md: md.ruler, ad: adRuler, adRange };
}

/* ──────────────────────────────────────────────────────────────
   その日の「気」：本人の日主（五行）と、その日の日干の五行の関係から
   スコア(1〜5)とスタンス(攻め/守り/整える/労い)を決定論的に算出。
   → 日ごとに本当に変化する運気の波を作る（AI任せの固定値を排除）。
   ────────────────────────────────────────────────────────────── */
const FIVE = { 甲: "木", 乙: "木", 丙: "火", 丁: "火", 戊: "土", 己: "土", 庚: "金", 辛: "金", 壬: "水", 癸: "水" };
const GEN = { 木: "火", 火: "土", 土: "金", 金: "水", 水: "木" };   // X 生 Y
const CTRL = { 木: "土", 土: "水", 水: "火", 火: "金", 金: "木" };  // X 剋 Y

// dateISO("YYYY-MM-DD") の日干支から関係を出す
function relationFor(meElem, dateISO) {
  const d = new Date(dateISO + "T00:00:00");
  const idx = ((jdn(d.getFullYear(), d.getMonth() + 1, d.getDate()) - DAY_ANCHOR) % 60 + 60) % 60;
  const stem = G[idx % 10], branch = Z[idx % 12];
  const other = FIVE[stem];
  let relation, score, stance, focus;
  if (other === meElem) { relation = "比和（仲間の気）"; score = 3; stance = "整える"; focus = "足場を固め、淡々と整える日。無理に広げない。"; }
  else if (GEN[other] === meElem) { relation = "印（支えられる）"; score = 4; stance = "労い"; focus = "人や学びに支えられる日。受け取り、休み、充電してよい。"; }
  else if (GEN[meElem] === other) { relation = "食傷（生み出す）"; score = 5; stance = "攻め"; focus = "表現・発信・制作が伸びる日。アウトプットで前進。"; }
  else if (CTRL[meElem] === other) { relation = "財（掴みにいく）"; score = 4; stance = "攻め"; focus = "成果・お金を取りにいける日。動けば返ってくる。"; }
  else { relation = "官殺（試される）"; score = 2; stance = "守り"; focus = "プレッシャーがかかる日。守りを固め、背伸びしない。"; }
  return { ganZhi: stem + branch, stem, branch, element: other, relation, score, stance, focus };
}

// 本日・明日・今月の日別スコアを返す
export function dayEnergy(birth, todayISO) {
  const me = FIVE[computeChart(birth).dayMaster] || "水";
  const t = new Date(todayISO + "T00:00:00");
  const tomorrow = new Date(t); tomorrow.setDate(t.getDate() + 1);
  const iso = (x) => x.toISOString().slice(0, 10);
  const today = relationFor(me, todayISO);
  const tmr = relationFor(me, iso(tomorrow));
  // 今月の日別スコア（運気グラフ用）
  const yy = t.getFullYear(), mm = t.getMonth();
  const dim = new Date(yy, mm + 1, 0).getDate();
  const monthDays = [];
  for (let day = 1; day <= dim; day++) monthDays.push(relationFor(me, `${yy}-${String(mm + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`).score);
  return { me, today, tomorrow: tmr, monthDays };
}


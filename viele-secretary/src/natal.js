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

// 複数の日付の「気」をまとめて返す（命式計算は1回だけ）。逆算チェーンの本番日コンディション用。
// 返り値: { "YYYY-MM-DD": { stance, score, relation, focus, ... } }
export function stancesFor(birth, dateISOs) {
  const out = {};
  try {
    const me = FIVE[computeChart(birth).dayMaster] || "水";
    for (const d of dateISOs || []) {
      if (d && !out[d]) out[d] = relationFor(me, String(d).slice(0, 10));
    }
  } catch { /* 出生情報が不正なら何も返さない */ }
  return out;
}

/* ──────────────────────────────────────────────────────────────
   算命学：十大主星（中心星）＝ あなたの「経営キャラ」
   日干 × 月支の蔵干(本気) の通変星から、決定論的に1つの星を算出。
   占いというより気質の型。遊び心＋自己理解で「毎日開きたくなる」を補強。
   ────────────────────────────────────────────────────────────── */
const HIDDEN = { 子: "癸", 丑: "己", 寅: "甲", 卯: "乙", 辰: "戊", 巳: "丙", 午: "丁", 未: "己", 申: "庚", 酉: "辛", 戌: "戊", 亥: "壬" };
// 通変星 → 算命学・十大主星
const TEN_GOD_TO_STAR = {
  比肩: "貫索星", 劫財: "石門星", 食神: "鳳閣星", 傷官: "調舒星", 偏財: "禄存星",
  正財: "司禄星", 偏官: "車騎星", 正官: "牽牛星", 偏印: "龍高星", 印綬: "玉堂星",
};
// 日干(me) と 対象干(other) の通変星を判定
function tenGod(meStem, otherStem) {
  const me = FIVE[meStem], ot = FIVE[otherStem];
  const sameYin = (G.indexOf(meStem) % 2) === (G.indexOf(otherStem) % 2); // 陰陽が同じか
  if (me === ot) return sameYin ? "比肩" : "劫財";
  if (GEN[me] === ot) return sameYin ? "食神" : "傷官";   // 我 生 彼
  if (CTRL[me] === ot) return sameYin ? "偏財" : "正財";  // 我 剋 彼
  if (CTRL[ot] === me) return sameYin ? "偏官" : "正官";  // 彼 剋 我
  if (GEN[ot] === me) return sameYin ? "偏印" : "印綬";   // 彼 生 我
  return "比肩";
}
const STAR_DESC = {
  貫索星: { emoji: "🌳", title: "独立独歩タイプ", desc: "マイペースに一つを貫く人。ブレない軸が最大の強み。", biz: "流行を追うより『自分のやり方をコツコツ続ける』ことで信頼と実績が積み上がります。", attack: "続けてきた定番をもう一歩前へ。" },
  石門星: { emoji: "🤝", title: "輪を広げるタイプ", desc: "人を巻き込み輪を作る社交家。仲間づくりが得意。", biz: "一人で抱えるより、コラボ・コミュニティ・チームで動くと一気に伸びます。", attack: "仲間・コラボに声をかけて巻き込みを。" },
  鳳閣星: { emoji: "🍀", title: "楽しむ表現タイプ", desc: "自然体で楽しみながら表現する人。場を和ませる発信が映える。", biz: "肩肘張らない発信や体験提供が武器。『楽しさ』をそのまま商品にできます。", attack: "楽しい発信・体験で人を集めて。" },
  調舒星: { emoji: "🎨", title: "こだわり職人タイプ", desc: "繊細で美意識が高い表現者。独自の世界観で深く刺さる。", biz: "量より質。世界観・作品性を磨いて『あなただから』の指名を取りにいきましょう。", attack: "こだわりの世界観を一点集中で出して。" },
  禄存星: { emoji: "💝", title: "奉仕・愛情タイプ", desc: "面倒見がよく与える人。サービス精神で人とお金を引き寄せる。", biz: "手厚いホスピタリティが収益に直結。『尽くす』があなたの集客力です。", attack: "手厚い特典・サービスで攻めて。" },
  司禄星: { emoji: "🏦", title: "堅実・蓄積タイプ", desc: "地道に積み上げ管理する堅実家。継続・ストック化が得意。", biz: "サブスク・会員制・リピートなど『積み上がる売上』と好相性です。", attack: "リピート・会員化の案内を出して。" },
  車騎星: { emoji: "⚡", title: "行動・突破タイプ", desc: "スピードと行動力で前進する人。動いて道を開く実行派。", biz: "考える前にまず動く。スピード勝負・先陣・営業の現場で力を発揮します。", attack: "スピード勝負。先陣を切って動いて。" },
  牽牛星: { emoji: "🎖️", title: "信頼・実務タイプ", desc: "真面目で責任感が強く、信用を大事にする人。", biz: "きっちりした実務とブランド・権威性で『安心して任せられる』を売りに。", attack: "実績・信頼を前面に打ち出して。" },
  龍高星: { emoji: "🐉", title: "冒険・革新タイプ", desc: "好奇心旺盛で型破り。新しい挑戦・改造・海外に縁。", biz: "新規開拓や既存のやり方の刷新で輝く。実験を恐れず仕掛けていきましょう。", attack: "新しい企画・試みを仕掛けて。" },
  玉堂星: { emoji: "📚", title: "知性・教育タイプ", desc: "学びと伝えるのが得意な理論派。教えること全般と好相性。", biz: "講座・体系化したコンテンツ・教える仕事で価値が最大化します。", attack: "教える・解説コンテンツで価値を出して。" },
};
// あなたの経営キャラ（算命学・中心星）を返す。出生情報が無ければ null。
export function sanmei(birth) {
  if (!birth || !birth.date) return null;
  try {
    const c = computeChart(birth);
    const me = c.dayMaster;
    const monthBranch = String(c.monthPillar).slice(-1);
    const hidden = HIDDEN[monthBranch] || me;
    const god = tenGod(me, hidden);
    const star = TEN_GOD_TO_STAR[god] || "貫索星";
    return { star, god, ...STAR_DESC[star] };
  } catch { return null; }
}


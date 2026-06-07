// VIELE secretary — 運気API（年運・月運・日運）
// ユーザー自身が取得した命式データ(西洋占星術/四柱推命/インドダシャー)を根拠に、
// Geminiが「断定的で愛ある厳しさ(細木数子風)」で鑑定。外部占い文は再配信しない。
// 出典: 大久保占い研究室 (senjutsu.jp) — データのライセンスに従い明記。

import { geminiText } from "./_gemini.js";

export default async function handler(req, res) {
  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};
    const today = body.today || new Date().toISOString().slice(0, 10);
    // 命式テキストはクライアント側(自前エンジン)で計算済みのものを受け取る
    const chart = body.chart || "";

    const key = process.env.GEMINI_API_KEY;
    if (!key) { res.status(200).json({ aiEnabled: false }); return; }
    if (!chart) { res.status(200).json({ aiEnabled: true, error: "命式が未設定です" }); return; }

    const d = new Date(today + "T00:00:00");
    const tomorrowD = new Date(d); tomorrowD.setDate(d.getDate() + 1);
    const tomorrow = tomorrowD.toISOString().slice(0, 10);
    const yy = d.getFullYear();
    const mm = d.getMonth() + 1;
    const dim = new Date(yy, mm, 0).getDate(); // 今月の日数

    const prompt =
      `あなたは断定的で歯切れがよく、愛のある厳しさで導く占い師です（細木数子の六星占術のような毅然とした口調）。` +
      `相手は施術業＋コンテンツ発信の一人社長。実用的で背中を押す助言にしてください。\n` +
      `次の命式データを根拠に、本日(${today})・明日(${tomorrow})・${mm}月(${dim}日間)・${yy}年の運勢を占ってください。\n【命式】\n${chart}\n` +
      `口調は言い切る（例:「〜しなさい」「〜は禁物」「〜が吉」）。ただし脅さない、前向きに。\n` +
      `スコアは1〜5の整数。月の日別・年の月別は運気の波が分かるよう変化をつけること。\n` +
      `出力は必ず次のJSONのみ（前置き・説明・コードフェンス不要）:\n` +
      `{"today":{"score":整数,"theme":"今日の一言","work":"仕事運1〜2文","money":"金運1〜2文","social":"対人運1〜2文","action":"今日の行動1文","caution":"戒め1文","color":"ラッキーカラー"},` +
      `"tomorrow":{"score":整数,"theme":"明日の一言","work":"仕事運1文","money":"金運1文","social":"対人運1文","action":"明日の行動1文","caution":"戒め1文","color":"ラッキーカラー"},` +
      `"month":{"theme":"今月のテーマ","flow":"今月の流れ2〜3文","advice":"今月の指針1文","days":[${dim}個の整数スコア配列(1日〜${dim}日)]},` +
      `"year":{"theme":"今年のテーマ","flow":"今年の大きな流れ2〜3文","peak":"好機の時期","caution":"慎むべき時期","months":[12個の整数スコア配列(1月〜12月)]}}`;

    let txt;
    try { txt = await geminiText(key, prompt); }
    catch (e) { res.status(200).json({ aiEnabled: true, error: String((e && e.message) || e) }); return; }

    txt = (txt || "").replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
    let fortune = null;
    try { fortune = JSON.parse(txt); } catch { /* ignore */ }

    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json({
      aiEnabled: true,
      fortune,
      raw: fortune ? undefined : txt,
      source: "命式: 自前計算(astronomy-engine) / 鑑定: AI",
      generatedAt: Date.now(),
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}


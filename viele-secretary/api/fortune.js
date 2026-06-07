// VIELE secretary — 運気API（年運・月運・日運）
// ユーザー自身が取得した命式データ(西洋占星術/四柱推命/インドダシャー)を根拠に、
// Geminiが「断定的で愛ある厳しさ(細木数子風)」で鑑定。外部占い文は再配信しない。
// 出典: 大久保占い研究室 (senjutsu.jp) — データのライセンスに従い明記。

export default async function handler(req, res) {
  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};
    const chart = body.chart || "";
    const today = body.today || new Date().toISOString().slice(0, 10);

    const key = process.env.GEMINI_API_KEY;
    if (!key) { res.status(200).json({ aiEnabled: false }); return; }
    if (!chart) { res.status(200).json({ aiEnabled: true, error: "命式データが未設定です" }); return; }

    const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
    const prompt =
      `あなたは断定的で歯切れがよく、愛のある厳しさで導く占い師です（細木数子の六星占術のような毅然とした口調）。` +
      `相手は施術業＋コンテンツ発信の一人社長。実用的で背中を押す助言にしてください。\n` +
      `次の命式データと本日(${today})を根拠に、年・月・日の運勢を占ってください。\n【命式】\n${chart}\n` +
      `口調は言い切る（例:「〜しなさい」「〜は禁物」「〜が吉」）。ただし脅さない、前向きに。\n` +
      `出力は必ず次のJSONのみ（前置き・説明・コードフェンス不要）:\n` +
      `{"today":{"score":1から5の整数,"theme":"今日の一言","work":"仕事運1〜2文","money":"金運1〜2文","social":"対人運1〜2文","action":"今日とるべき行動1文","caution":"戒め1文","color":"ラッキーカラー"},` +
      `"month":{"theme":"今月のテーマ","flow":"今月の流れ2〜3文","advice":"今月の指針1文"},` +
      `"year":{"theme":"今年のテーマ","flow":"今年の大きな流れ2〜3文","peak":"好機の時期","caution":"慎むべき時期"}}`;

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
    );
    if (!r.ok) {
      let d = ""; try { d = (await r.json())?.error?.message || ""; } catch { /* ignore */ }
      res.status(200).json({ aiEnabled: true, error: `Gemini ${r.status} ${d}`.trim() });
      return;
    }
    const j = await r.json();
    let txt = (j?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
    txt = txt.replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
    let fortune = null;
    try { fortune = JSON.parse(txt); } catch { /* ignore */ }

    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json({
      aiEnabled: true,
      fortune,
      raw: fortune ? undefined : txt,
      source: "大久保占い研究室 (senjutsu.jp)",
      generatedAt: Date.now(),
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}

// VIELE secretary — 今日の運気API（Vercelサーバーレス関数）
// 生年月日時・出生地と本日の日付から、算命学/四柱推命テイストの運勢をGeminiで生成。
// 外部占いサイトの内容は使わない（オリジナル生成）。GEMINI_API_KEY 必須。

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, "http://localhost");
    const birth = u.searchParams.get("birth") || "";   // 生年月日 YYYY-MM-DD
    const time = u.searchParams.get("time") || "";       // 出生時刻 HH:MM
    const place = u.searchParams.get("place") || "";     // 出生地
    const name = u.searchParams.get("name") || "";
    const today = u.searchParams.get("today") || new Date().toISOString().slice(0, 10);

    const key = process.env.GEMINI_API_KEY;
    if (!key) { res.status(200).json({ aiEnabled: false }); return; }
    if (!birth) { res.status(200).json({ aiEnabled: true, error: "生年月日が未設定です" }); return; }

    const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
    const prompt =
      `あなたは算命学・四柱推命に通じた占い師兼・一人社長の秘書です。次の人物の【${today} の運勢】を日本語で占ってください。\n` +
      `生年月日:${birth} 出生時刻:${time || "不明"} 出生地:${place || "不明"} 名前:${name || "（非公開）"}\n` +
      `施術業・コンテンツ発信の一人社長という前提で、仕事に活かせる実用的な助言にしてください。\n` +
      `出力は必ず次のJSONのみ（前置き・説明・コードフェンスは一切不要）:\n` +
      `{"score":1から5の整数,"theme":"今日のテーマを一言","work":"仕事運1〜2文","money":"金運1〜2文","social":"対人運1〜2文","action":"今日とると良い行動を1文","color":"ラッキーカラー","caution":"気をつける点を1文"}`;

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
    try { fortune = JSON.parse(txt); } catch { /* JSONでなければraw */ }

    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json({ aiEnabled: true, fortune, raw: fortune ? undefined : txt, generatedAt: Date.now() });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}

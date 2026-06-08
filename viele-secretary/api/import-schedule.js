// VIELE secretary — 予定スクショ取り込みAPI。TimeTree等のスクリーンショットから予定をGemini Visionで抽出。
import { geminiParts } from "./_gemini.js";

export default async function handler(req, res) {
  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};
    const image = body.image || "";
    const today = body.today || new Date().toISOString().slice(0, 10);
    const mime = body.mime || "image/jpeg";

    const key = process.env.GEMINI_API_KEY;
    if (!key) { res.status(200).json({ aiEnabled: false }); return; }
    if (!image) { res.status(200).json({ aiEnabled: true, error: "画像がありません" }); return; }

    const b64 = image.replace(/^data:[^;]+;base64,/, "");
    const year = today.slice(0, 4);
    const prompt =
      `これはカレンダーアプリ(TimeTree等)のスクリーンショットです。本日は${today}。\n` +
      `写っている予定をすべて読み取り、JSON配列**のみ**で返してください（前置き・説明・コードフェンス不要）。\n` +
      `各要素: {"date":"YYYY-MM-DD","time":"HH:MM または 終日","title":"予定名"}\n` +
      `・年が画面に無ければ ${year} 年とみなす。\n・月日のみなら本日(${today})に最も近い日付で補完。\n・終日予定は time を "終日" に。\n・予定が無ければ []。`;

    let txt = await geminiParts(key, [
      { inline_data: { mime_type: mime, data: b64 } },
      { text: prompt },
    ]);
    txt = (txt || "").replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
    let events = [];
    try {
      const parsed = JSON.parse(txt);
      if (Array.isArray(parsed)) events = parsed.filter((e) => e && e.date && e.title);
    } catch { /* ignore */ }

    res.status(200).json({ aiEnabled: true, events, raw: events.length ? undefined : txt });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}

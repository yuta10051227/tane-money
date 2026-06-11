// VIELE secretary — 告知文の下書きAPI。締切/イベントの内容から、LINE/SNS/メールの下書きをGeminiで生成。
import { geminiText } from "./_gemini.js";
import { requireUser } from "./_auth.js";

export default async function handler(req, res) {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};
    const context = body.context || "";
    const extra = body.extra || ""; // 補足（任意）

    const key = process.env.GEMINI_API_KEY;
    if (!key) { res.status(200).json({ aiEnabled: false }); return; }
    if (!context) { res.status(200).json({ aiEnabled: true, error: "告知内容が未設定です" }); return; }

    const prompt =
      `あなたは施術家・コンテンツ発信の一人社長の秘書兼コピーライターです。次の告知について、温かく信頼感のある日本語で投稿の下書きを作ってください。` +
      `誇大表現や煽りは避け、読み手のメリットを1つ示し、具体的な行動（登録/申込/参加/予約）を1つだけ促してください。\n` +
      `告知内容: ${context}\n${extra ? `補足: ${extra}\n` : ""}` +
      `出力は必ず次のJSONのみ（前置き・コードフェンス不要）:\n` +
      `{"line":"公式LINE向けの短文(絵文字を少し, 3〜5行, 親しみやすく)","sns":"X/Instagram向け投稿(2〜3行＋ハッシュタグ2〜3個)","mail":"メール向け(1行目に『件名: 〜』, その後に丁寧な本文)"}`;

    let txt = await geminiText(key, prompt);
    txt = (txt || "").replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
    let drafts = null;
    try { drafts = JSON.parse(txt); } catch { /* ignore */ }

    res.status(200).json({ aiEnabled: true, drafts, raw: drafts ? undefined : txt });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}

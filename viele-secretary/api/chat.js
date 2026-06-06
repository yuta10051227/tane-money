// AI秘書（会話型）— Vercel サーバレス関数。
// ANTHROPIC_API_KEY はサーバ側の環境変数にのみ置く（ブラウザには絶対に出さない）。
// クライアントから {messages, context} を受け取り、Claude の回答をストリーミングで返す。
import Anthropic from "@anthropic-ai/sdk";

// 関数の最大実行時間（秒）。ストリーミングで体感は速いが上限を少し延ばす。
export const config = { maxDuration: 30 };

function buildSystem(context) {
  return [
    "あなたは一人社長（施術家・コンテンツ発信者など）のための、有能で誠実な秘書です。",
    "ユーザーの売上・固定費・サブスクのデータに基づき、簡潔で実用的な助言をします。",
    "日本語で、結論から答え、必要に応じて短い箇条書きを使う。",
    "与えられたデータの範囲で答え、数字を勝手に創作しない。データに無いことは『データからは分かりません』と正直に言う。",
    "売上の落ち込みや離脱しかけている取引先に気づいたら、確認や連絡を促す。",
    "長い前置きや思考過程は書かず、最終的な回答だけを返す。",
    "",
    "--- 現在の財務サマリー（ユーザーの実データ） ---",
    context && String(context).slice(0, 6000),
  ].join("\n");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: "AI秘書が未設定です。Vercelの環境変数に ANTHROPIC_API_KEY を設定して再デプロイしてください。" });
    return;
  }
  try {
    const { messages, context } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: "messages required" });
      return;
    }
    // 直近20件・各4000字までに制限（暴走・コスト対策）。role は user/assistant のみ許可。
    const safeMessages = messages.slice(-20).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content || "").slice(0, 4000),
    }));

    const client = new Anthropic({ apiKey });
    // 既定は最新最強の Opus 4.8。コスト調整したい場合は CLAUDE_MODEL に
    // claude-sonnet-4-6 / claude-haiku-4-5 を設定すると切り替わる。
    const model = process.env.CLAUDE_MODEL || "claude-opus-4-8";

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");

    const stream = client.messages.stream({
      model,
      max_tokens: 1500,
      thinking: { type: "disabled" }, // チャットは即応性重視（思考は使わない）
      system: buildSystem(context),
      messages: safeMessages,
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        res.write(event.delta.text);
      }
    }
    res.end();
  } catch (e) {
    const msg = String(e?.message || e);
    if (!res.headersSent) res.status(500).json({ error: msg });
    else res.end();
  }
}

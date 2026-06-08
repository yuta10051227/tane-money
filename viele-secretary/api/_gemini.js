// Gemini 呼び出し共通ヘルパー。モデル廃止に強い（候補を順に試し、全滅なら利用可能モデルを自動検出）。

const BASE = "https://generativelanguage.googleapis.com/v1beta";

function candidates() {
  return [
    process.env.GEMINI_MODEL,
    "gemini-flash-latest",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
  ].filter(Boolean);
}

async function tryModel(key, model, parts) {
  const r = await fetch(`${BASE}/models/${model}:generateContent?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts }] }),
  });
  if (r.ok) {
    const j = await r.json();
    return { text: (j?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim() };
  }
  let msg = "";
  try { msg = (await r.json())?.error?.message || ""; } catch { /* ignore */ }
  return { error: { status: r.status, msg } };
}

// モデルが見つからない系のエラーか（次の候補を試すべきか）
function isModelError(status, msg) {
  return status === 404 || /not found|not available|is not supported|unknown name|models\//i.test(msg || "");
}

// parts（テキスト＋画像など）でGemini生成。モデル廃止に強い。
export async function geminiParts(key, parts) {
  let last = "";
  for (const model of candidates()) {
    const res = await tryModel(key, model, parts);
    if (res.text !== undefined) return res.text;
    last = `${res.error.status} ${res.error.msg}`;
    if (!isModelError(res.error.status, res.error.msg)) throw new Error("Gemini " + last);
  }
  try {
    const lr = await fetch(`${BASE}/models?key=${key}&pageSize=200`);
    if (lr.ok) {
      const lj = await lr.json();
      const found = (lj.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent") && /flash/i.test(m.name || ""))
        .map((m) => (m.name || "").replace(/^models\//, ""));
      for (const model of found) {
        const res = await tryModel(key, model, parts);
        if (res.text !== undefined) return res.text;
        last = `${res.error.status} ${res.error.msg}`;
      }
    }
  } catch { /* ignore */ }
  throw new Error("Gemini 利用可能なモデルが見つかりません (" + last + ")");
}

export async function geminiText(key, prompt) {
  return geminiParts(key, [{ text: prompt }]);
}

// VIELE secretary — 運気API（年運・月運・日運）
// 自前エンジンの命式＋「その日の気」(命式から決定論的に算出したスコア/スタンス)を根拠に、
// Geminiが“やさしめ＋メリハリ”で鑑定（攻め/守り/整える/労いを日替わりで）。
// スコア・運気の波は命式由来の決定論値で確定させ、毎日きちんと変化させる。外部占い文は再配信しない。

import { geminiText } from "./_gemini.js";
import { requireUser } from "./_auth.js";
import { consumeQuota, quotaExceededBody } from "./_quota.js";

export default async function handler(req, res) {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};
    const today = body.today || new Date().toISOString().slice(0, 10);
    // 命式テキストはクライアント側(自前エンジン)で計算済みのものを受け取る
    const chart = body.chart || "";
    const situation = body.situation || "";
    const energy = body.energy || null; // その日の気（スコア/スタンス/関係）を決定論的に算出済み

    const key = process.env.GEMINI_API_KEY;
    if (!key) { res.status(200).json({ aiEnabled: false }); return; }
    if (!chart) { res.status(200).json({ aiEnabled: true, error: "命式が未設定です" }); return; }

    const d = new Date(today + "T00:00:00");
    const tomorrowD = new Date(d); tomorrowD.setDate(d.getDate() + 1);
    const tomorrow = tomorrowD.toISOString().slice(0, 10);
    const yy = d.getFullYear();
    const mm = d.getMonth() + 1;
    const dim = new Date(yy, mm, 0).getDate(); // 今月の日数

    // スタンスごとの口調ガイド（やさしめ＋メリハリ）
    const STANCE_TONE = {
      攻め: "今日は追い風。明るく熱く背中を押す。『動けば返ってくる』と前向きに。",
      守り: "今日は試される日。やさしく、守りを固めるよう労わる。脅さず『無理しないで』の姿勢。",
      整える: "今日は淡々と整える日。落ち着いたトーンで、足元を整えることを肯定する。",
      労い: "今日は充電してよい日。しっかり褒め、労い、『休むのも仕事』と伝える。",
    };
    const te = energy && energy.today ? energy.today : null;
    const tme = energy && energy.tomorrow ? energy.tomorrow : null;
    const energyBlock = te
      ? `【その日の気（命式から算出済み・これを必ず土台にする）】\n` +
        `本日: ${te.ganZhi}・${te.relation}・スタンス=${te.stance}（${te.focus}）スコア${te.score}\n` +
        (tme ? `明日: ${tme.ganZhi}・${tme.relation}・スタンス=${tme.stance}（${tme.focus}）スコア${tme.score}\n` : "") +
        `本日の口調方針: ${STANCE_TONE[te.stance] || ""}\n`
      : "";

    const prompt =
      `あなたは、あたたかく寄り添いながら要所では背中を押す“秘書のような占い師”です。` +
      `相手は施術業＋コンテンツ発信の一人社長。基本は応援・労い・肯定。日によってメリハリをつけ、勝負日は熱く、しんどい日はやさしく労わってください。` +
      `絶対に毎日同じ説教を繰り返さないこと。脅さない、詰めない、追い込まない。\n` +
      `次の命式と「その日の気」を根拠に、本日(${today})・明日(${tomorrow})・${mm}月(${dim}日間)・${yy}年の運勢を占ってください。\n【命式】\n${chart}\n` +
      energyBlock +
      (situation ? `【参考：いま抱えていること】\n${situation}\nこれは“今日の一手(action)”を1つだけ、やさしく具体的に添えるためだけに使う。仕事運・金運・対人運・戒めに毎回これを持ち込まないこと（同じ話の繰り返しを避ける）。\n` : "") +
      `口調はやさしく、要所だけ言い切る。命令ばかりにしない。「〜してみよう」「今日は休んでいい」「よくやっている」等、肯定や労いも入れる。\n` +
      `戒め(caution)は“脅し”ではなく“やさしい気づき”にし、日替わりで内容を必ず変える。\n` +
      `出力は必ず次のJSONのみ（前置き・説明・コードフェンス不要）:\n` +
      `{"today":{"score":整数,"theme":"今日の一言","work":"仕事運1〜2文","money":"金運1〜2文","social":"対人運1〜2文","action":"今日の一手1文","caution":"やさしい気づき1文","color":"ラッキーカラー"},` +
      `"tomorrow":{"score":整数,"theme":"明日の一言","work":"仕事運1文","money":"金運1文","social":"対人運1文","action":"明日の一手1文","caution":"やさしい気づき1文","color":"ラッキーカラー"},` +
      `"month":{"theme":"今月のテーマ","flow":"今月の流れ2〜3文","advice":"今月の指針1文","days":[${dim}個の整数スコア配列(1日〜${dim}日)]},` +
      `"year":{"theme":"今年のテーマ","flow":"今年の大きな流れ2〜3文","peak":"好機の時期","caution":"慎むべき時期","months":[12個の整数スコア配列(1月〜12月)]}}`;

    const quota = await consumeQuota(user.uid);
    if (!quota.ok) { res.status(429).json(quotaExceededBody(quota.limit)); return; }

    let txt;
    try { txt = await geminiText(key, prompt); }
    catch (e) { res.status(200).json({ aiEnabled: true, error: String((e && e.message) || e) }); return; }

    txt = (txt || "").replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
    let fortune = null;
    try { fortune = JSON.parse(txt); } catch { /* ignore */ }

    // スコア・運気の波は命式から算出した決定論値で上書き（AIの固定値・揺れを排除＝毎日ちゃんと変わる）
    if (fortune && energy) {
      if (fortune.today && te) { fortune.today.score = te.score; fortune.today.stance = te.stance; }
      if (fortune.tomorrow && tme) { fortune.tomorrow.score = tme.score; fortune.tomorrow.stance = tme.stance; }
      if (fortune.month && Array.isArray(energy.monthDays) && energy.monthDays.length) fortune.month.days = energy.monthDays;
    }

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


/**
 * api/push-cron.js — Vercel Cron から毎朝呼ばれるプッシュ通知送信エンドポイント
 *
 * スケジュール: 0 22 * * * （22:00 UTC = 07:00 JST）
 * 認証: Authorization: Bearer ${CRON_SECRET}
 *
 * 環境変数:
 *   CRON_SECRET         — Vercel Cron が送る Bearer トークン
 *   VAPID_PUBLIC_KEY    — VAPID 公開鍵（npx web-push generate-vapid-keys で生成）
 *   VAPID_PRIVATE_KEY   — VAPID 秘密鍵
 *   VAPID_SUBJECT       — mailto:your@email.com 形式
 *   FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY
 *                       — api/_admin.js 参照
 */

import webpush from "web-push";
import { initAdmin } from "./_admin.js";
import { FieldValue } from "firebase-admin/firestore";
import { dayEnergy, koyomi } from "../src/natal.js";

// ── JST 基準の「今日0時」を返すユーティリティ ──────────────────────────
function todayJST() {
  const nowUTC = Date.now();
  const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const jstNowMs = nowUTC + JST_OFFSET_MS;
  const jstTodayMs = jstNowMs - (jstNowMs % (24 * 60 * 60 * 1000));
  return new Date(jstTodayMs - JST_OFFSET_MS);
}

// 今日の "YYYY-MM-DD"（JST）
function todayJSTiso() {
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const y = jstNow.getUTCFullYear();
  const m = String(jstNow.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jstNow.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// "YYYY-MM-DD" → JST 当日0時の Date
function parseISOasJST(dateISO) {
  const [y, m, d] = (dateISO || "").split("-").map(Number);
  if (!y || !m || !d) return null;
  const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  return new Date(Date.UTC(y, m - 1, d) - JST_OFFSET_MS);
}

// JST 基準の経過日数（正=未来、負=過去）
function daysUntilJST(dateISO) {
  const target = parseISOasJST(dateISO);
  if (!target) return 0;
  const today = todayJST();
  return Math.round((target - today) / 86400000);
}

// "YYYY-MM-DD" に n 日加算した "YYYY-MM-DD" を返す
function addDaysISO(dateISO, n) {
  const d = parseISOasJST(dateISO);
  if (!d) return dateISO;
  const jstMs = d.getTime() + (n + 9) * 60 * 60 * 1000;
  const jstDate = new Date(jstMs);
  const y = jstDate.getUTCFullYear();
  const mo = String(jstDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(jstDate.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

// ── computeAlerts 相当（サーバーサイド版・JST 基準）─────────────────────
function computeServerAlerts(data) {
  let late = 0;
  let soon = 0;
  let tomorrow = []; // 明日締切のタイトル

  (data.trips || []).forEach((t) => {
    (t.items || []).forEach((it) => {
      if (it.done) return;
      const deadlineISO = addDaysISO(t.date, -(it.daysBefore || 0));
      const diff = daysUntilJST(deadlineISO);
      if (diff < 0) late += 1;
      else if (diff <= 3) soon += 1;
      if (diff === 1) tomorrow.push(it.label || t.title || "手配");
    });
  });

  (data.deadlines || []).forEach((d) => {
    const diff = daysUntilJST(d.date);
    if (diff < 0) late += 1;
    else if (diff <= 7) soon += 1;
    if (diff === 1) tomorrow.push(d.title || "締切");
  });

  const pendingTasks = (data.tasks || []).filter((x) => !x.done).length;

  return { late, soon, pendingTasks, tomorrow };
}

// ── スタンス絵文字 ────────────────────────────────────────────────────
const STANCE_EMOJI = { 攻め: "⚔️", 守り: "🛡️", 整える: "🌿", 労い: "💛" };

// ── ユーザー1件分のプッシュペイロードを組み立てる ─────────────────────
function buildPayload(data, todayISO) {
  const lastSeen = data.lastSeen || 0;
  const msSinceLastSeen = Date.now() - lastSeen;
  const daysSinceSeen = msSinceLastSeen / 86400000;

  // ── 再エンゲージ（3日以上アクセスなし）───────────────────────────────
  if (lastSeen > 0 && daysSinceSeen >= 3) {
    const days = Math.floor(daysSinceSeen);
    return {
      title: "ひとり秘書｜最近どう？",
      body: `${days}日ぶりだね。今日の予定、一緒に確認しよ。`,
      url: "/",
      tag: "viele-reengagement",
    };
  }

  // ── 今日のスタンスを計算 ─────────────────────────────────────────────
  let stanceLabel = "";
  let focusText = "";
  let koyomiEmoji = "";
  const birth = data.birth;
  if (birth && birth.date) {
    try {
      const energy = dayEnergy(birth, todayISO);
      stanceLabel = energy.today.stance;
      focusText = energy.today.focus;
    } catch { /* birth データが不正な場合は無視 */ }
    try {
      const k = koyomi(todayISO);
      const good = (k.labels || []).filter((l) => l.good);
      if (good.length > 0) koyomiEmoji = good.map((l) => l.emoji).join("");
    } catch { /* 暦計算エラーは無視 */ }
  }

  const { late, soon, pendingTasks, tomorrow } = computeServerAlerts(data);
  const totalAlerts = late + soon + pendingTasks;

  // ── 明日締切の専用メッセージ（最優先）───────────────────────────────
  if (tomorrow.length > 0) {
    const names = tomorrow.slice(0, 2).join("・");
    const suffix = tomorrow.length > 2 ? `ほか${tomorrow.length - 2}件` : "";
    return {
      title: "ひとり秘書｜明日締切だよ",
      body: `「${names}${suffix}」の締切が明日。今日中に確認しておこ。`,
      url: "/",
      tag: "viele-tomorrow",
    };
  }

  // ── アラートあり ──────────────────────────────────────────────────────
  if (totalAlerts > 0) {
    const emoji = STANCE_EMOJI[stanceLabel] || "📋";
    const stancePart = stanceLabel ? `${emoji}今日は${stanceLabel}の日。` : "";
    const alertPart = `遅れ${late}・もうすぐ${soon}・タスク${pendingTasks}件ある。`;
    return {
      title: `ひとり秘書｜おはよう${koyomiEmoji}`,
      body: stancePart + alertPart,
      url: "/",
      tag: "viele-push",
      renotify: true,
    };
  }

  // ── アラートなし・スタンスのみ ────────────────────────────────────────
  if (stanceLabel) {
    const emoji = STANCE_EMOJI[stanceLabel] || "🌅";
    return {
      title: `ひとり秘書｜おはよう${koyomiEmoji}`,
      body: `${emoji}今日は${stanceLabel}の日。${focusText}`,
      url: "/",
      tag: "viele-push",
    };
  }

  // 生年月日未設定かつアラートなし → 送信しない
  return null;
}

// ── web-push 初期化 ──────────────────────────────────────────────────
function setupWebPush() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;

  if (!publicKey || !privateKey || !subject) {
    throw new Error(
      "web-push: 環境変数 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT が未設定です。"
    );
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
}

// ── メインハンドラ ───────────────────────────────────────────────────────
export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return res.status(500).json({ error: "CRON_SECRET 未設定（Vercel環境変数に設定してください）" });
  }
  const auth = req.headers["authorization"] || "";
  if (auth !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    setupWebPush();
    const db = initAdmin();
    const todayISO = todayJSTiso();

    const snapshot = await db.collection("users").get();

    let sent = 0;
    let skipped = 0;
    let expired = 0;
    let errors = 0;

    await Promise.all(
      snapshot.docs.map(async (docSnap) => {
        const data = docSnap.data();
        const pushSub = data.pushSub;

        if (!pushSub || !pushSub.endpoint) {
          skipped += 1;
          return;
        }

        const payload = buildPayload(data, todayISO);
        if (!payload) {
          skipped += 1;
          return;
        }

        try {
          await webpush.sendNotification(pushSub, JSON.stringify(payload));
          sent += 1;
        } catch (err) {
          const statusCode = err && err.statusCode;
          if (statusCode === 404 || statusCode === 410) {
            expired += 1;
            try {
              await db
                .collection("users")
                .doc(docSnap.id)
                .update({ pushSub: FieldValue.delete() });
            } catch (delErr) {
              console.error(`pushSub 削除失敗 uid=${docSnap.id}`, delErr);
            }
          } else {
            errors += 1;
            console.error(`push 送信エラー uid=${docSnap.id}`, err);
          }
        }
      })
    );

    return res.status(200).json({
      ok: true,
      total: snapshot.size,
      sent,
      skipped,
      expired,
      errors,
      todayISO,
      runAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("push-cron 致命的エラー", err);
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
}

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

// ── JST 基準の「今日0時」を返すユーティリティ ──────────────────────────
// cron は UTC で走るため、JST(UTC+9) の当日0時を明示的に計算する。
// これにより日付判定がサーバーのタイムゾーン設定に依存しない。
function todayJST() {
  const nowUTC = Date.now();
  const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  // JST での「今日0時」の UTC ミリ秒
  const jstNowMs = nowUTC + JST_OFFSET_MS;
  const jstTodayMs = jstNowMs - (jstNowMs % (24 * 60 * 60 * 1000));
  return new Date(jstTodayMs - JST_OFFSET_MS); // UTC に戻す
}

// "YYYY-MM-DD" → JST 当日0時の Date（文字列比較用）
function parseISOasJST(dateISO) {
  // "2025-06-10" のような文字列は JST 0時として扱う
  const [y, m, d] = (dateISO || "").split("-").map(Number);
  if (!y || !m || !d) return null;
  const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  return new Date(Date.UTC(y, m - 1, d) - JST_OFFSET_MS); // JST 0:00 を UTC に変換
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
  d.setUTCDate(d.getUTCDate() + n + 9); // UTC+9 補正
  // JST 日付として取り出す
  const jstMs = d.getTime() + 9 * 60 * 60 * 1000;
  const jstDate = new Date(jstMs);
  const y = jstDate.getUTCFullYear();
  const m = String(jstDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(jstDate.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ── computeAlerts 相当（サーバーサイド版・JST 基準）─────────────────────
function computeServerAlerts(data) {
  let late = 0;
  let soon = 0;

  // trips[].items[] の締切チェック（手配チェックリスト）
  (data.trips || []).forEach((t) => {
    (t.items || []).forEach((it) => {
      if (it.done) return;
      const deadlineISO = addDaysISO(t.date, -(it.daysBefore || 0));
      const diff = daysUntilJST(deadlineISO);
      if (diff < 0) {
        late += 1;
      } else if (diff <= 3) {
        soon += 1;
      }
    });
  });

  // deadlines[] の締切チェック
  (data.deadlines || []).forEach((d) => {
    const diff = daysUntilJST(d.date);
    // late: 過去、soon: 0〜7日以内
    if (diff < 0) {
      late += 1;
    } else if (diff <= 7) {
      soon += 1;
    }
  });

  // tasks[] の未完了件数
  const pendingTasks = (data.tasks || []).filter((x) => !x.done).length;

  return { late, soon, pendingTasks };
}

// ── web-push 初期化（リクエストごとに idempotent に設定）──────────────
function setupWebPush() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT; // "mailto:you@example.com"

  if (!publicKey || !privateKey || !subject) {
    throw new Error(
      "web-push: 環境変数 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT が未設定です。"
    );
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
}

// ── メインハンドラ ───────────────────────────────────────────────────────
export default async function handler(req, res) {
  // ── 認証チェック ──
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers["authorization"] || "";
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  // GET / POST 以外は弾く
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    setupWebPush();
    const db = initAdmin();

    // users コレクション全件取得
    const snapshot = await db.collection("users").get();

    let sent = 0;
    let skipped = 0;
    let expired = 0;
    let errors = 0;

    await Promise.all(
      snapshot.docs.map(async (docSnap) => {
        const data = docSnap.data();
        const pushSub = data.pushSub;

        // pushSub が無いユーザーはスキップ
        if (!pushSub || !pushSub.endpoint) {
          skipped += 1;
          return;
        }

        const { late, soon, pendingTasks } = computeServerAlerts(data);
        const remaining = late + soon + pendingTasks;

        // 要対応がゼロなら通知しない
        if (remaining === 0) {
          skipped += 1;
          return;
        }

        const payload = JSON.stringify({
          title: `VIELE secretary｜今日の残り ${remaining}件`,
          body: `遅れ${late}・もうすぐ${soon}・タスク${pendingTasks}`,
          url: "/",
        });

        try {
          await webpush.sendNotification(pushSub, payload);
          sent += 1;
        } catch (err) {
          const statusCode = err && err.statusCode;
          if (statusCode === 404 || statusCode === 410) {
            // 購読が失効 → Firestore から pushSub を削除
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
      runAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("push-cron 致命的エラー", err);
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
}

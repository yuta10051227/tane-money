/**
 * api/_quota.js — ユーザーごとのAI利用上限（1日あたり）
 *
 * Gemini課金が暴走（クライアントのリトライループ・不正利用・想定外の多用）で
 * 破綻しないよう、認証済みユーザー単位で「本日(JST)の呼び出し回数」を上限管理する。
 * カウントは Firestore の aiUsage/{uid} に保存し、トランザクションで原子的に増やす。
 *
 * 環境変数:
 *   AI_DAILY_LIMIT — 1ユーザーあたりの1日の上限回数（未設定/不正なら 40）
 *
 * 失敗時の方針:
 *   Firestore が未設定/トランザクション失敗のときは「止めない（フェイルオープン）」。
 *   上限は安全弁であり、第三者ブロックは _auth.js の許可リストが担う。
 */

import { initAdmin } from "./_admin.js";

// Asia/Tokyo の YYYY-MM-DD（日付の境界を日本時間に固定）
function tokyoDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function dailyLimit() {
  const n = parseInt(process.env.AI_DAILY_LIMIT || "", 10);
  return Number.isFinite(n) && n > 0 ? n : 40;
}

/**
 * uid の本日(JST)のAI利用を1回ぶん消費する。
 * - 上限内: カウントを +1 して { ok:true, used, limit, remaining } を返す
 * - 上限超過: カウントは増やさず { ok:false, used, limit, remaining:0 } を返す
 * - Firestore未設定/エラー: { ok:true, skipped:true, limit } を返す（機能は止めない）
 */
export async function consumeQuota(uid) {
  const limit = dailyLimit();
  if (!uid) return { ok: true, skipped: true, limit };

  let db;
  try {
    db = initAdmin();
  } catch {
    return { ok: true, skipped: true, limit };
  }

  const today = tokyoDate();
  const ref = db.collection("aiUsage").doc(uid);

  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() : null;
      let count = data && data.date === today ? data.count || 0 : 0;
      if (count >= limit) {
        return { ok: false, used: count, limit, remaining: 0 };
      }
      count += 1;
      tx.set(ref, { date: today, count, updatedAt: new Date().toISOString() }, { merge: true });
      return { ok: true, used: count, limit, remaining: Math.max(0, limit - count) };
    });
  } catch {
    // トランザクション失敗時は機能を止めない
    return { ok: true, skipped: true, limit };
  }
}

// 上限超過時のレスポンス本文（各APIで使い回す）
export function quotaExceededBody(limit) {
  return {
    aiEnabled: true,
    quotaExceeded: true,
    error: `本日のAI利用上限（1日${limit}回）に達しました。日付が変わるとまたご利用いただけます。`,
  };
}

/**
 * api/_auth.js — APIエンドポイント共通の認証ガード
 *
 * クライアントが付与する Authorization: Bearer <Firebase IDトークン> を検証し、
 * メール許可リスト（ALLOWLIST_EMAILS）を満たすユーザーだけを通す。
 * これにより、URLを知る第三者が無認証でAPI（Gemini課金・カレンダー操作）を
 * 叩くのを防ぐ。
 *
 * 環境変数:
 *   FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY
 *     — firebase-admin の初期化に必要（IDトークン検証に必須）
 *   ALLOWLIST_EMAILS
 *     — 利用を許可するメールのカンマ区切り。firestore.rules の ALLOWLIST と同じ値にする。
 *       未設定/空 なら「ログイン済み(メール確認済み)の全員」を許可（rules の空配列と同挙動）。
 */

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

function ensureAdmin() {
  if (getApps().length > 0) return;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "auth: 環境変数 FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY が未設定です。"
    );
  }
  initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
}

function allowlist() {
  return (process.env.ALLOWLIST_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * リクエストを検証し、許可ユーザーなら { uid, email } を返す。
 * 失敗時は res に 401/403 を書いて null を返す（呼び出し側は `if (!user) return;`）。
 */
export async function requireUser(req, res) {
  try {
    const h = req.headers.authorization || req.headers.Authorization || "";
    const m = /^Bearer\s+(.+)$/i.exec(typeof h === "string" ? h : "");
    if (!m) {
      res.status(401).json({ error: "unauthorized", message: "ログインが必要です" });
      return null;
    }
    ensureAdmin();
    const decoded = await getAuth().verifyIdToken(m[1]);
    const email = (decoded.email || "").toLowerCase();
    const list = allowlist();
    if (list.length > 0 && (!decoded.email_verified || !list.includes(email))) {
      res.status(403).json({ error: "forbidden", message: "このアカウントは利用を許可されていません" });
      return null;
    }
    return { uid: decoded.uid, email };
  } catch {
    res.status(401).json({ error: "unauthorized", message: "認証に失敗しました" });
    return null;
  }
}

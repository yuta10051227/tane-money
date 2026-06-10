/**
 * api/_admin.js — firebase-admin 初期化ヘルパー（シングルトン）
 *
 * 環境変数:
 *   FIREBASE_PROJECT_ID    — Firebase プロジェクト ID
 *   FIREBASE_CLIENT_EMAIL  — サービスアカウントのメールアドレス
 *   FIREBASE_PRIVATE_KEY   — サービスアカウントの秘密鍵（\n を実改行に置換して使う）
 *
 * Vercel のサーバーレス関数は同一インスタンスが再利用されることがあるため、
 * initializeApp() の二重呼び出しを防ぐ。
 */

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function initAdmin() {
  // 既に初期化済みのアプリがあれば再利用
  if (getApps().length > 0) {
    return getFirestore();
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  // Vercel の環境変数に設定する際は \n のままでも実改行でも動くよう両対応
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "firebase-admin: 環境変数 FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY が未設定です。"
    );
  }

  initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });

  return getFirestore();
}

export { initAdmin };

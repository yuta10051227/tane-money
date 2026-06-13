/**
 * api/_auth.js — APIエンドポイント共通の認証ガード（依存ゼロ版）
 *
 * クライアントが付与する Authorization: Bearer <Firebase IDトークン> を検証し、
 * メール許可リスト（ALLOWLIST_EMAILS）を満たすユーザーだけを通す。
 *
 * 【設計変更の理由】
 * 以前は firebase-admin で検証していたが、Vercel のサーバーレス環境では
 * firebase-admin の動的依存がバンドルされず実行時にクラッシュ（500/非JSON応答）し、
 * 「カレンダー取得に失敗」になる事故が起きた。本実装は Node 標準の crypto のみで
 * Google の公開証明書を使って IDトークンを検証する。外部依存・サービスアカウント鍵
 * （FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY）は不要。
 *
 * 環境変数（任意）:
 *   FIREBASE_PROJECT_ID — 未設定なら下記 DEFAULT_PROJECT_ID を使う（projectIdは公開情報）
 *   ALLOWLIST_EMAILS    — 利用を許可するメールのカンマ区切り。未設定/空ならログイン済み全員を許可。
 */

import crypto from "node:crypto";

const DEFAULT_PROJECT_ID = "viele-secretary";
const CERTS_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

function projectId() {
  return process.env.FIREBASE_PROJECT_ID || DEFAULT_PROJECT_ID;
}

// Google の公開証明書（kid -> PEM）。Cache-Control に従ってメモリキャッシュする。
let _certCache = { keys: null, exp: 0 };
async function googleCerts() {
  const now = Date.now();
  if (_certCache.keys && now < _certCache.exp) return _certCache.keys;
  const r = await fetch(CERTS_URL);
  if (!r.ok) throw new Error("certs " + r.status);
  const keys = await r.json();
  const cc = r.headers.get("cache-control") || "";
  const m = /max-age=(\d+)/.exec(cc);
  _certCache = { keys, exp: now + (m ? parseInt(m[1], 10) * 1000 : 3600 * 1000) };
  return keys;
}

function b64urlToBuf(s) {
  return Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// Firebase IDトークン（RS256 JWT）を検証して payload を返す。失敗時は throw。
async function verifyIdToken(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) throw new Error("malformed");
  const header = JSON.parse(b64urlToBuf(parts[0]).toString("utf8"));
  const payload = JSON.parse(b64urlToBuf(parts[1]).toString("utf8"));
  if (header.alg !== "RS256" || !header.kid) throw new Error("bad header");

  const certs = await googleCerts();
  const pem = certs[header.kid];
  if (!pem) throw new Error("unknown kid");
  const pub = new crypto.X509Certificate(pem).publicKey;
  const ok = crypto.verify(
    "RSA-SHA256",
    Buffer.from(parts[0] + "." + parts[1]),
    pub,
    b64urlToBuf(parts[2])
  );
  if (!ok) throw new Error("bad signature");

  const pid = projectId();
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now - 60) throw new Error("expired");
  if (typeof payload.iat === "number" && payload.iat > now + 300) throw new Error("iat future");
  if (payload.aud !== pid) throw new Error("bad aud");
  if (payload.iss !== `https://securetoken.google.com/${pid}`) throw new Error("bad iss");
  if (!payload.sub) throw new Error("no sub");
  return payload;
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
    const decoded = await verifyIdToken(m[1]);
    const email = (decoded.email || "").toLowerCase();
    const list = allowlist();
    if (list.length > 0 && (!decoded.email_verified || !list.includes(email))) {
      res.status(403).json({ error: "forbidden", message: "このアカウントは利用を許可されていません" });
      return null;
    }
    return { uid: decoded.sub, email };
  } catch {
    res.status(401).json({ error: "unauthorized", message: "認証に失敗しました" });
    return null;
  }
}

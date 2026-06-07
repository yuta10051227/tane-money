// Google Identity Services (GIS) によるアクセストークン取得。
// 一度同意すれば、prompt:"" で「画面を出さずに」トークンを取り直せる＝実質の自動再連携。
// トークンはメモリ保持（呼び出し側のstate）。クライアントIDは公開前提の値。

import { CALENDAR_SCOPE } from "./calendar";

const CLIENT_ID = "752964285770-94aqtjgb7v33g854l7osvndvgh26jc70.apps.googleusercontent.com";

let scriptPromise = null;
let tokenClient = null;

function loadGis() {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) return resolve();
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Google認証スクリプトの読み込みに失敗しました"));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

/**
 * アクセストークンを取得。
 * @param {{interactive:boolean}} opts interactive=true で同意画面を出す（初回）。false は無音取得。
 * @returns {Promise<string>} access_token
 */
export async function getAccessToken({ interactive }) {
  await loadGis();
  return new Promise((resolve, reject) => {
    if (!tokenClient) {
      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: CALENDAR_SCOPE,
        callback: () => {},
      });
    }
    tokenClient.callback = (resp) => {
      if (resp && resp.access_token) resolve(resp.access_token);
      else reject(new Error((resp && resp.error) || "トークン取得に失敗"));
    };
    tokenClient.error_callback = (err) => reject(new Error((err && (err.type || err.message)) || "トークン取得エラー"));
    try {
      tokenClient.requestAccessToken({ prompt: interactive ? "consent" : "" });
    } catch (e) {
      reject(e);
    }
  });
}

// トークンを失効（revoke）
export function revokeToken(token) {
  if (!token) return;
  try { fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(token), { method: "POST", mode: "no-cors" }).catch(() => {}); } catch { /* ignore */ }
}

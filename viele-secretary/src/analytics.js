// src/analytics.js — 製品計測（PostHog）/ プライバシー最優先
//
// VIELEは個人・金銭情報を扱うため、PII（メール・氏名・金額・予定の中身など）は一切送らない。
// 送るのは「どの機能が・いつ・どれくらい使われたか」という匿名のファネルイベントのみ。
// - autocapture / session recording はオフ（入力値やDOM文言の自動収集を防ぐ）
// - 個人の識別子は Firebase の uid（不可逆な匿名ID）だけ。メール等は渡さない
// - VITE_POSTHOG_KEY が未設定なら完全に無効（何も初期化せず・何も送らない）

import posthog from "posthog-js";

let enabled = false;

export function initAnalytics() {
  if (enabled) return;
  const key = import.meta.env.VITE_POSTHOG_KEY;
  if (!key) return; // キー未設定なら計測オフ（無料・無送信で動く）
  const host = import.meta.env.VITE_POSTHOG_HOST || "https://us.i.posthog.com";
  try {
    posthog.init(key, {
      api_host: host,
      autocapture: false,                 // 自動クリック収集オフ（誤ってPIIを拾わない）
      capture_pageview: false,            // SPAなので手動管理
      capture_pageleave: true,
      disable_session_recording: true,    // 画面録画オフ（個人情報保護）
      mask_all_text: true,                // 万一の収集時もテキストをマスク
      mask_all_element_attributes: true,
      persistence: "localStorage",
      person_profiles: "identified_only", // ログイン済みユーザーのみプロファイル化
    });
    enabled = true;
  } catch (e) {
    try { console.warn("[analytics] init failed", e); } catch { /* ignore */ }
  }
}

// uid は匿名の不可逆ID。メール・氏名などPIIは絶対に渡さない。
export function identifyUser(uid) {
  if (!enabled || !uid) return;
  try { posthog.identify(uid); } catch { /* ignore */ }
}

export function track(event, props) {
  if (!enabled) return;
  try { posthog.capture(event, props); } catch { /* ignore */ }
}

export function resetAnalytics() {
  if (!enabled) return;
  try { posthog.reset(); } catch { /* ignore */ }
}

/**
 * push-sw.js — Web Push 受信専用 Service Worker
 *
 * vite-plugin-pwa(workbox) が生成する SW から
 *   importScripts("/push-sw.js")
 * で読み込まれる。
 * このファイル自体は独立した SW ではなく「拡張スクリプト」として動作する。
 */

// ── プッシュ受信 ──────────────────────────────────────────────────
self.addEventListener("push", (event) => {
  let payload = { title: "ひとり秘書", body: "", url: "/" };
  try {
    if (event.data) {
      payload = { ...payload, ...event.data.json() };
    }
  } catch {
    // JSON パース失敗時はデフォルトのまま
  }

  const { title, body, url } = payload;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icon-512.png",
      badge: "/icon-512.png",
      data: { url: url || "/" },
      // 同じタグで重複通知を折りたたむ
      tag: "viele-push",
      renotify: true,
    })
  );
});

// ── 通知タップ ────────────────────────────────────────────────────
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // 既に開いているタブがあればフォーカスしてナビゲート
        for (const client of clientList) {
          if ("focus" in client) {
            client.navigate(targetUrl);
            return client.focus();
          }
        }
        // タブが無ければ新規ウィンドウを開く
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
      })
  );
});

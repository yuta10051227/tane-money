/* FCM バックグラウンド受信用サービスワーカー(アプリを閉じていてもプッシュを表示)。
   ルート直下に置く必要がある(スコープ /)。messagingSenderId は本番値。 */
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyCrwnL1XisVygG11z5CLq4FTPXIanZqT8E',
  projectId: 'tane-money',
  messagingSenderId: '168102674534',
  appId: '1:168102674534:web:691b66d776ed0d60b5ada7',
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const n = (payload && payload.notification) || {};
  self.registration.showNotification(n.title || 'タネマネー', {
    body: n.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
  });
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then((list) => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    if (clients.openWindow) return clients.openWindow('/');
  }));
});

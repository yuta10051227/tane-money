const CACHE = 'tane-money-v3';
const PRECACHE = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  // Firebase/CDN は常にネットワーク
  if (url.includes('firestore') || url.includes('firebase') ||
      url.includes('cdnjs') || url.includes('googleapis') ||
      url.includes('gstatic')) return;

  // 画像アセット(/assets/)はネットワーク優先: 差し替えた絵が即反映され、古い絵が残らない。
  // オフライン時のみキャッシュにフォールバック。
  if (url.includes('/assets/')) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res && res.status === 200 && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request).then(c => c || new Response('Offline', {status: 503})))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetchPromise = fetch(e.request).then(res => {
        if (res && res.status === 200 && e.request.method === 'GET') {
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        }
        return res;
      }).catch(() => cached || new Response('Offline', {status: 503}));
      // キャッシュ優先（オフライン時は即キャッシュを返す）
      return cached || fetchPromise;
    })
  );
});

const CACHE = 'tane-money-99a6a54';
// バージョン固定のCDN資産(React/Firebase/フォントCSS)はimmutable扱いでprecache。
// install時に取りに行き、以降のリピート起動はネットワーク無しで即起動できる。
const CDN_PRECACHE = [
  'https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js',
];
const PRECACHE = ['/', '/index.html', '/manifest.json', '/icon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/icon-512-maskable.png'];

// バージョン固定でキャッシュ優先にしてよいCDN(=URLにバージョンが含まれ中身が変わらない)。
// 注意: firestore(データAPI)は常にネットワークにするため対象外。
function isImmutableCDN(url) {
  return url.includes('cdnjs.cloudflare.com') ||
         url.includes('gstatic.com/firebasejs') ||
         url.includes('fonts.googleapis.com') ||
         url.includes('fonts.gstatic.com');
}

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c =>
      // CDNはCORS不透明レスポンスでも貼れるよう個別put(失敗は無視)
      Promise.all([
        c.addAll(PRECACHE).catch(() => {}),
        ...CDN_PRECACHE.map(u =>
          fetch(u, { mode: 'no-cors' }).then(r => c.put(u, r)).catch(() => {})
        ),
      ])
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim()).then(() =>
      // 新バージョンが有効化されたら、開いている全ページに通知して「更新する」バーを出させる。
      // CACHE名は build が 'tane-money-<version>' に毎デプロイ書き換える（＝SW更新が必ず走る）。
      self.clients.matchAll({ includeUncontrolled: true }).then(cs =>
        cs.forEach(c => c.postMessage({ type: 'SW_ACTIVATED', version: CACHE.replace('tane-money-', '') }))
      )
    )
  );
});

// ページ側から即時更新を要求できるように
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Firestore等のデータAPIは常にネットワーク（キャッシュしない）
  if (url.includes('firestore') || url.includes('googleapis.com/google.firestore')) return;

  // バージョン確認用 /version.json と /api/ は常にネットワーク（キャッシュ介在させない）
  if (url.includes('/version.json') || url.includes('/api/')) return;

  // バージョン固定CDN(React/Firebase/フォント)はキャッシュ優先 → リピート起動を高速化
  if (isImmutableCDN(url)) {
    e.respondWith(
      caches.match(e.request).then(cached =>
        cached || fetch(e.request).then(res => {
          if (res && (res.status === 200 || res.type === 'opaque') && e.request.method === 'GET') {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        }).catch(() => cached || new Response('Offline', { status: 503 }))
      )
    );
    return;
  }

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

  // それ以外(HTML/ナビゲーション=アプリ本体)はネットワーク優先: 新しいデプロイを即反映。
  // オフライン時のみキャッシュにフォールバック(古いHTMLが残って更新が届かない問題を防ぐ)。
  e.respondWith(
    fetch(e.request).then(res => {
      if (res && res.status === 200 && e.request.method === 'GET') {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request).then(c => c || new Response('Offline', {status: 503})))
  );
});

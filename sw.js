// アプリ本体をキャッシュして、オフラインでも開けるようにする。
// データ取得は一切しないので、キャッシュするのは静的ファイルだけ。

const CACHE = "oldwares-v2";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./js/app.js",
  "./js/barcode.js",
  "./js/brands.js",
  "./js/chart.js",
  "./js/identify.js",
  "./js/normalize.js",
  "./js/parsing.js",
  "./js/photo.js",
  "./js/quote.js",
  "./js/stats.js",
  "./js/store.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  // 画面遷移はキャッシュした index.html を返す（オフラインでも起動できる）
  if (request.mode === "navigate") {
    event.respondWith(
      caches.match("./index.html").then((cached) => cached || fetch(request))
    );
    return;
  }

  // 静的ファイルはキャッシュ優先。無ければ取得してキャッシュに入れる
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response.ok && new URL(request.url).origin === self.location.origin) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
    )
  );
});

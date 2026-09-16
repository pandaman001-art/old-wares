// アプリ本体をキャッシュして、オフラインでも開けるようにする。
// データ取得は一切しないので、キャッシュするのは静的ファイルだけ。
//
// 方針:
//   HTML と JS は「ネットワーク優先」。更新をすぐ反映しつつ、圏外ではキャッシュから返す。
//   アイコンとマニフェストは滅多に変わらないのでキャッシュ優先。
//   読み書きは必ず今のキャッシュ（CACHE）に限定する。caches.match は全キャッシュを
//   横断検索してしまい、古い版が残っていると新しい版を配れなくなるため。

// 上げるときは js/app.js の APP_VERSION も揃えること
const CACHE = "oldwares-v4";
const INDEX = "./index.html";
const ASSETS = [
  "./",
  INDEX,
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
    caches
      .open(CACHE)
      // addAll も HTTP キャッシュを迂回させる。古いファイルを掴んだまま入れないように
      .then((cache) =>
        Promise.all(
          ASSETS.map(async (asset) => {
            const response = await fetch(asset, { cache: "no-store", credentials: "same-origin" });
            if (response.ok) await cache.put(asset, response);
          })
        )
      )
      .then(() => self.skipWaiting())
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

/**
 * ネットワークを先に試し、取れたらキャッシュを更新する。圏外ならキャッシュから返す。
 *
 * no-store を付けてブラウザの HTTP キャッシュを迂回するのが肝。GitHub Pages は
 * max-age=600 を返すので、素の fetch だと更新後も 10 分は古いファイルが返ってくる。
 */
async function networkFirst(request, cacheKey = request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request.url, { cache: "no-store", credentials: "same-origin" });
    if (response.ok) cache.put(cacheKey, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    throw error;
  }
}

/** キャッシュにあればそれを返し、無ければ取得して入れておく。 */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 画面遷移は index.html を返す（圏外でも起動できる）
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, INDEX));
    return;
  }

  // コードは常に最新を優先する。古いコードと新しい HTML が混ざるのを避けるため
  if (/\.(?:js|html|webmanifest)$/.test(url.pathname)) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

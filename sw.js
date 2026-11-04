const CACHE_NAME = "yejian-shell-v32";
// 体积大的阅读字体不进安装预缓存，改成首次阅读时按需缓存，避免手机上装 SW 时长时间等 5MB 字体。
const APP_FILES = ["./", "./index.html", "./styles.css?v=1.8.3", "./app.js?v=1.8.3", "./manifest.webmanifest", "./icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("yejian-shell-") && key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  // 页面导航不用浏览器 HTTP 缓存里的旧副本，否则刚发布的新版本可能要等很久才生效。
  const init = request.mode === "navigate" ? { cache: "no-cache" } : undefined;

  event.respondWith(
    fetch(request, init).then((response) => {
      if (response.ok) event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone())));
      return response;
    }).catch(async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      if (request.mode === "navigate") return caches.match("./index.html");
      return Response.error();
    })
  );
});

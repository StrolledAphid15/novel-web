const CACHE_NAME = "yejian-shell-v37";
const APP_FILES = [
  "./", "./index.html", "./styles.css?v=1.10.2", "./app.js?v=1.10.2",
  "./js/model.js?v=1.10.2", "./js/storage.js?v=1.10.2", "./js/profiles.js?v=1.10.2",
  "./js/reader-text.js?v=1.10.2", "./js/reader-epub.js?v=1.10.4",
  "./js/sync-model.js?v=1.10.2", "./js/ui.js?v=1.10.2", "./js/reader.js?v=1.10.2", "./js/github.js?v=1.10.2",
  "./js/sync.js?v=1.10.4", "./js/library.js?v=1.10.2",
  "./vendor/jszip-3.10.1.min.js", "./vendor/epub-0.3.93.min.js",
  "./fonts/FZFWZHUZGDLMCJW.TTF",
  "./manifest.webmanifest", "./icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("yejian-shell-") && key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    // Versioned scripts, EPUB components and fonts are ready without a network wait.
    if (cached && request.mode !== "navigate") return cached;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(request, { cache: "no-cache", signal: controller.signal });
      if (!response.ok && request.mode === "navigate") throw new Error("页面请求失败");
      if (response.ok) event.waitUntil(cache.put(request, response.clone()));
      return response;
    } catch {
      if (cached) return cached;
      if (request.mode === "navigate") return (await cache.match("./index.html")) || Response.error();
      return Response.error();
    } finally {
      clearTimeout(timeout);
    }
  })());
});

const CACHE_NAME = "yejian-shell-v35";
const APP_FILES = [
  "./", "./index.html", "./styles.css?v=1.10.2", "./app.js?v=1.10.2",
  "./js/model.js?v=1.10.2", "./js/storage.js?v=1.10.2", "./js/profiles.js?v=1.10.2",
  "./js/reader-text.js?v=1.10.2", "./js/reader-epub.js?v=1.10.2",
  "./js/sync-model.js?v=1.10.2", "./js/ui.js?v=1.10.2", "./js/reader.js?v=1.10.2", "./js/github.js?v=1.10.2",
  "./js/sync.js?v=1.10.2", "./js/library.js?v=1.10.2",
  "./manifest.webmanifest", "./icon.svg"
];

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

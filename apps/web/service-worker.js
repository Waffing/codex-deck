const prefix = "codexdeck-static-";
const cacheName = prefix + "__BUILD__";
const files = new Set("__STATIC_URLS__");
self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil((async () => {
  for (const name of await caches.keys()) {
    if (name.startsWith(prefix) && name !== cacheName) await caches.delete(name);
  }
  await self.clients.claim();
})()));
self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || request.mode === "navigate" || url.origin !== self.location.origin ||
      url.search || !files.has(url.pathname) || request.headers.has("authorization") || request.headers.has("range")) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    const stored = await cache.match(url.href);
    if (stored) return stored;
    const response = await fetch(request);
    const mime = response.headers.get("content-type") || "";
    if (response.status !== 200 || response.type !== "basic" || response.redirected ||
        response.headers.get("X-CodexDeck-Static") !== "1" ||
        !/^(?:(?:application|text)\/javascript|text\/css|font\/[\w.-]+|image\/(?:png|svg\+xml))(?:;|$)/i.test(mime) ||
        /(?:private|no-store)/i.test(response.headers.get("cache-control") || "")) return response;
    try { await cache.put(url.href, response.clone()); } catch { /* Quota exhaustion must not interrupt asset loading. */ }
    return response;
  })());
});

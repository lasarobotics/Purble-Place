/* Cache app resources only. Authenticated API snapshots live in user-partitioned
   IndexedDB; writes always pass through the durable scouting outbox. */
const CACHE = "hazehub-shell-v1";
self.addEventListener("install", event => { self.skipWaiting(); });
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith("hazehub-shell-") && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (url.pathname.startsWith("/_next/static/")) {
      const hit = await cache.match(req);
      if (hit) return hit;
    }
    try {
      const response = await fetch(req);
      if (response.ok) await cache.put(req, response.clone());
      return response;
    } catch (error) {
      const hit = await cache.match(req);
      if (hit) return hit;
      throw error;
    }
  })());
});
self.addEventListener("message", event => {
  if (event.data?.type !== "WARM_ROUTES") return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const assets = new Set(["/field.png"]);
    for (const route of event.data.routes || []) {
      if (typeof route !== "string" || !/^\/[a-z/-]*$/.test(route)) continue;
      try {
        const response = await fetch(route);
        if (!response.ok) continue;
        const html = await response.clone().text();
        await cache.put(route, response);
        for (const match of html.matchAll(/(?:src|href)="([^"\s]+)"/g)) {
          if (match[1].startsWith("/_next/static/")) assets.add(match[1].replaceAll("&amp;", "&"));
        }
      } catch { /* Retry preparation at the next online visit. */ }
    }
    await Promise.all([...assets].map(async url => {
      if (await cache.match(url)) return;
      try { const response = await fetch(url); if (response.ok) await cache.put(url, response); } catch {}
    }));
    event.source?.postMessage({ type: "OFFLINE_READY" });
  })());
});

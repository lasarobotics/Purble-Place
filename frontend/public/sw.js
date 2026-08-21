/* HazeHub service worker: keep the app usable with no signal.
 *
 * Venue wifi is the single most reliable failure at an FRC event. A scout who
 * cannot load the page cannot scout, and reloading the tab between matches is
 * exactly the moment the connection is worst. So the whole app shell is kept
 * on the device.
 *
 * Three strategies, chosen per request:
 *
 *   Navigations      network first, then the cached shell. The shell is the
 *                    real app, so a scout who opens it offline gets the same
 *                    page they always use, running against IndexedDB.
 *   Static assets    cache first. Hashed build output never changes under a
 *                    given URL, so going to the network for it is waste.
 *   API GETs         network first, falling back to the last good response.
 *                    A stale schedule beats no schedule; the page says which
 *                    one it is using.
 *
 * Writes are never cached or replayed here. Scouting submissions go through
 * the IndexedDB queue in lib/db.ts, which already owns retry, idempotency and
 * conflict handling. Two mechanisms racing to resend the same report is how
 * duplicates get invented.
 */

const VERSION = "hazehub-v3";
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;
const API_CACHE = `${VERSION}-api`;

/* Pages a scout can land on with no connection. Everything else falls back to
 * whichever of these is cached. */
const SHELL_ROUTES = ["/", "/home", "/scout", "/pit", "/picklists", "/status", "/login"];

/* API responses worth keeping a copy of. All reads, all cheap, all things the
 * scouting form needs to render the right controls and the right robot. */
const CACHEABLE_API = ["/api/game", "/api/matches", "/api/auth/config", "/api/teams"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // addAll is atomic: one 404 during a deploy would throw the whole
      // install away, so each route is allowed to fail on its own.
      await Promise.all(
        SHELL_ROUTES.map((route) =>
          cache.add(new Request(route, { cache: "reload" })).catch(() => {})
        )
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSET_CACHE, API_CACHE]);
      const names = await caches.keys();
      await Promise.all(names.map((n) => (keep.has(n) ? null : caches.delete(n))));
      await self.clients.claim();
    })()
  );
});

/** Let the page ask for an immediate upgrade after a deploy. */
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

function isAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    /\.(?:js|css|woff2?|png|jpg|jpeg|svg|webp|ico)$/.test(url.pathname)
  );
}

/* Same-origin only, on purpose.
 *
 * In every real deployment one process serves both the web app and the API,
 * so /api/... is same-origin and gets cached. In `next dev` the API is a
 * separate origin on :8000, and a worker cannot always reach a cross-origin
 * host: intercepting those turned working requests into 503s and broke the
 * dev server. Letting them go straight to the network costs nothing, because
 * that configuration never ships. */
function isCacheableApi(url, sameOrigin) {
  return sameOrigin && CACHEABLE_API.some((prefix) => url.pathname.startsWith(prefix));
}

/* Storing is best effort. A response that arrived fine must still be returned
 * even if writing it to the cache failed, and it can fail for reasons that
 * have nothing to do with the network: an opaque cross-origin response, a
 * full disk, a private window. Treating a failed put as a failed request is
 * how a working API started answering 503 from the worker. */
async function store(cache, request, response) {
  if (!response.ok) return; // caching a 500 would serve it back all event
  try {
    await cache.put(request, response.clone());
  } catch {
    /* not cacheable here; the request still succeeded */
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  await store(cache, request, response);
  return response;
}

async function networkFirst(request, cacheName, fallbackRequest) {
  const cache = await caches.open(cacheName);
  let response;
  try {
    response = await fetch(request);
  } catch (err) {
    const hit =
      (await cache.match(request)) ||
      (fallbackRequest ? await cache.match(fallbackRequest) : undefined);
    if (hit) return hit;
    throw err;
  }
  await store(cache, request, response);
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await networkFirst(request, SHELL_CACHE);
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          // Any cached page is better than the browser's offline error: the
          // app is a client-side router, so it will find its own way from here.
          const hit =
            (await cache.match(request)) ||
            (await cache.match("/home")) ||
            (await cache.match("/"));
          if (hit) return hit;
          return new Response(
            "<!doctype html><meta charset=utf-8><title>HazeHub offline</title>" +
              "<style>body{background:#0a0b0d;color:#e7e8ea;font:14px system-ui;" +
              "display:grid;place-items:center;height:100vh;margin:0;text-align:center}" +
              "p{color:#989aa1;max-width:34ch}</style>" +
              "<div><h1>No connection</h1><p>Open HazeHub once while online and " +
              "it will keep working here without one.</p></div>",
            { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 503 }
          );
        }
      })()
    );
    return;
  }

  if (sameOrigin && isAsset(url)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE).catch(() => fetch(request)));
    return;
  }

  if (isCacheableApi(url, sameOrigin)) {
    event.respondWith(
      networkFirst(request, API_CACHE).catch(
        () =>
          new Response(JSON.stringify({ detail: "Offline, no cached copy of this yet." }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          })
      )
    );
  }
});

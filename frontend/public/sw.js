/* Purble Place service worker: keep the app usable with no signal.
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

const VERSION = "purble-place-v11";
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;
const API_CACHE = `${VERSION}-api`;

/* Pages a scout can land on with no connection. Everything else falls back to
 * whichever of these is cached. */
const SHELL_ROUTES = [
  "/rankings", "/admin/final-picklist", "/admin/accounts", "/", "/home", "/pits", "/scout", "/pit", "/picklists", "/meeting", "/results", "/match-schedule", "/data-analysis", "/picklist-simulator", "/data", "/status", "/account", "/login",
  "/admin", "/admin/compare", "/admin/data-picklist", "/admin/forms", "/admin/picklists", "/admin/seasons",
  "/admin/system", "/admin/team-rank", "/admin/team-search",
];
const PUBLIC_ASSETS = [
  "/brand/lasa-robotics.png", "/brand/urple.png", "/fonts/noto-sans-black.ttf", "/field.png", "/icon.svg", "/manifest.webmanifest",
  "/pineapples/pineapple1.gif", "/pineapples/pineapple2.gif", "/pineapples/pineapple3.gif",
  "/pineapples/pineapple4.gif", "/pineapples/pineapple5.gif",
];

/* API responses worth keeping a copy of. All reads, all cheap, all things the
 * scouting form needs to render the right controls and the right robot. */
const CACHEABLE_API = []; // API snapshots are partitioned by user in IndexedDB.

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      // Keep installation light so a deploy cannot compete with the page the
      // user is trying to open. The app asks for the complete route set once
      // the initial screen is idle.
      await warmRoutes(["/", "/login"]);
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
    /\.(?:js|css|woff2?|ttf|png|jpg|jpeg|svg|webp|gif|ico|webmanifest)$/.test(url.pathname)
  );
}

function discoverAssets(text) {
  const found = new Set(PUBLIC_ASSETS);
  const patterns = [
    /(?:src|href)=["']([^"'\s]+)["']/g,
    /url\(["']?([^"')\s]+)["']?\)/g,
    /(\/_next\/static\/[^"'()\s\\]+)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = (match[1] || "").replaceAll("&amp;", "&");
      try {
        const url = new URL(raw, self.location.origin);
        if (url.origin === self.location.origin && !url.pathname.endsWith("/") && (isAsset(url) || PUBLIC_ASSETS.includes(url.pathname))) {
          found.add(`${url.pathname}${url.search}`);
        }
      } catch { /* Ignore malformed markup emitted by third-party code. */ }
    }
  }
  return found;
}

async function warmRoutes(routes) {
  const shellCache = await caches.open(SHELL_CACHE);
  const assetCache = await caches.open(ASSET_CACHE);
  const assets = new Set(PUBLIC_ASSETS);

  for (const route of routes) {
    if (typeof route !== "string" || !/^\/[a-z0-9/-]*$/.test(route)) continue;
    try {
      const response = await fetch(new Request(route, { cache: "reload", credentials: "same-origin" }));
      if (!response.ok) continue;
      const html = await response.clone().text();
      await shellCache.put(route, response);
      for (const asset of discoverAssets(html)) assets.add(asset);
    } catch { /* Retry preparation the next time the app opens online. */ }
  }

  // Asset files can reference more chunks and fonts. Follow those references
  // until the complete same-origin dependency graph is stored locally.
  const queued = [...assets];
  const visited = new Set();
  while (queued.length && visited.size < 1000) {
    const url = queued.shift();
    if (!url || visited.has(url)) continue;
    visited.add(url);
    try {
      let response = await assetCache.match(url);
      if (!response) {
        response = await fetch(new Request(url, { cache: "reload", credentials: "same-origin" }));
        if (!response.ok) continue;
        await assetCache.put(url, response.clone());
      }
      const type = response.headers.get("content-type") || "";
      if (/text\/|javascript|json/.test(type)) {
        const text = await response.clone().text();
        for (const dependency of discoverAssets(text)) if (!visited.has(dependency)) queued.push(dependency);
      }
    } catch { /* One optional asset must not prevent the rest from caching. */ }
  }
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
            "<!doctype html><meta charset=utf-8><title>Purble Place offline</title>" +
              "<style>body{background:#0a0b0d;color:#e7e8ea;font:14px system-ui;" +
              "display:grid;place-items:center;height:100vh;margin:0;text-align:center}" +
              "p{color:#989aa1;max-width:34ch}</style>" +
              "<div><h1>No connection</h1><p>Open Purble Place once while online and " +
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

self.addEventListener("message", event => {
  if (event.data?.type !== "WARM_ROUTES") return;
  event.waitUntil((async () => {
    await warmRoutes(event.data.routes?.length ? event.data.routes : SHELL_ROUTES);
    event.source?.postMessage({ type: "OFFLINE_READY" });
  })());
});

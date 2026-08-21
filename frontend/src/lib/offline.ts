"use client";
// Register the service worker that keeps HazeHub usable with no signal.
//
// The worker itself is public/sw.js. This is only the handshake, plus the
// small amount of state the UI needs to be honest about what is cached.
import { useEffect, useState } from "react";

export interface OfflineState {
  /** The worker is installed and controlling this page. */
  ready: boolean;
  /** The browser has no service worker support, or the page is not secure. */
  supported: boolean;
}

/** Service workers need a secure context. localhost counts as one. */
function isSupported(): boolean {
  if (typeof window === "undefined") return false;
  if (!("serviceWorker" in navigator)) return false;
  return window.isSecureContext;
}

/**
 * The worker is a production-only thing, deliberately.
 *
 * Static assets are cached first, which is right in production because every
 * `/_next/static/` URL carries a build hash and therefore never changes
 * content. The dev server serves those same paths *unhashed* and recompiles
 * them in place, so cache-first pins whatever chunk was cached first and the
 * browser silently runs stale code through every edit. That is an afternoon
 * lost to "my change is not showing up", so development does not get a worker
 * at all.
 */
const ENABLED = process.env.NODE_ENV === "production";

export function useOffline(): OfflineState {
  const [ready, setReady] = useState(false);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    if (!isSupported()) return;

    if (!ENABLED) {
      // Clear out a worker left behind by a production build served from the
      // same origin, or the developer inherits exactly the staleness above.
      navigator.serviceWorker.getRegistrations()
        .then((regs) => regs.forEach((r) => r.unregister()))
        .catch(() => {});
      return;
    }

    setSupported(true);

    let alive = true;
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        if (!alive) return;
        setReady(!!navigator.serviceWorker.controller);
        // A deploy mid-event should not wait for every tab to be closed
        // before the fix reaches the person holding the tablet.
        reg.addEventListener("updatefound", () => {
          const next = reg.installing;
          next?.addEventListener("statechange", () => {
            if (next.state === "installed" && navigator.serviceWorker.controller) {
              next.postMessage("skip-waiting");
            }
          });
        });
      })
      .catch(() => {
        // An unregistrable worker is not a reason to stop: the IndexedDB
        // queue is what actually protects submitted scouting.
      });

    const onControllerChange = () => setReady(true);
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    return () => {
      alive = false;
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  return { ready, supported };
}

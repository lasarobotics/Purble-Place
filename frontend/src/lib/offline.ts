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

export function useOffline(): OfflineState {
  const [ready, setReady] = useState(false);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    if (!isSupported()) return;
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

"use client";
import { useEffect, useRef } from "react";
import { api, getToken } from "./api";

// Subscribe to live server events (scout_submitted, bet_placed, match_advanced,
// picklist_changed, ...). Vercel's serverless functions can't hold WebSockets
// open, so this polls GET /api/events with a cursor every few seconds and
// feeds the exact same (event, payload) pairs to the bus the old socket did.
// Polling pauses while the tab is hidden and backs off while offline.

const POLL_MS = 5000;

interface EventFeed {
  now: string;
  events: { event: string; payload: any; ts: string }[];
}

export function useLiveEvents(onEvent: (event: string, payload: any) => void) {
  const cb = useRef(onEvent);
  cb.current = onEvent;

  useEffect(() => {
    if (typeof window === "undefined") return;
    let stopped = false;
    let cursor = "";
    let timer: any;
    let inFlight = false;

    const poll = async () => {
      if (stopped || inFlight) return;
      if (!getToken()) return;
      if (document.visibilityState === "hidden") return;
      if (typeof navigator !== "undefined" && !navigator.onLine) return;
      inFlight = true;
      try {
        const q = cursor ? `?since=${encodeURIComponent(cursor)}` : "";
        const feed = await api<EventFeed>(`/api/events${q}`);
        cursor = feed.now || cursor;
        for (const e of feed.events || []) {
          try {
            cb.current(e.event, e.payload);
          } catch {}
        }
      } catch {
        // Backend briefly unreachable — the next tick retries.
      } finally {
        inFlight = false;
      }
    };

    poll();
    timer = setInterval(poll, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", poll);

    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", poll);
    };
  }, []);
}

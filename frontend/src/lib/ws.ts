"use client";
import { useEffect, useRef } from "react";
import { api, getToken, wsUrl } from "./api";

// Live server events (submission_ack, scout_submitted, bet_placed,
// match_advanced, picklist_changed, ...) with two transports:
//
//   1. WebSocket to /ws, instant, used when the host supports it (local dev,
//      LAN server, container hosts).
//   2. Polling GET /api/events?since=<cursor>, the serverless fallback
//      (Vercel functions can't hold sockets open). Same (event, payload)
//      pairs, same bus.
//
// The client tries the socket first; after two failed connects it settles on
// polling for the rest of the session.

const POLL_MS = 5000;
const WS_CONNECT_TIMEOUT_MS = 4000;
const MAX_WS_FAILURES = 2;

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
    let ws: WebSocket | null = null;
    let wsFailures = 0;
    let usePolling = false;
    let pollTimer: any;
    let retryTimer: any;
    let connectTimer: any;
    let cursor = "";
    let inFlight = false;

    // ---- Polling transport -------------------------------------------------
    const poll = async () => {
      if (stopped || inFlight || !getToken()) return;
      if (document.visibilityState === "hidden") return;
      if (typeof navigator !== "undefined" && !navigator.onLine) return;
      inFlight = true;
      try {
        const q = cursor ? `?since=${encodeURIComponent(cursor)}` : "";
        const feed = await api<EventFeed>(`/api/events${q}`);
        cursor = feed.now || cursor;
        for (const e of feed.events || []) {
          try { cb.current(e.event, e.payload); } catch {}
        }
      } catch {
        // Backend briefly unreachable, the next tick retries.
      } finally {
        inFlight = false;
      }
    };

    const startPolling = () => {
      if (usePolling || stopped) return;
      usePolling = true;
      poll();
      pollTimer = setInterval(poll, POLL_MS);
    };

    // ---- WebSocket transport ----------------------------------------------
    const connectWs = () => {
      if (stopped || usePolling || !getToken()) return;
      let opened = false;
      try {
        ws = new WebSocket(wsUrl());
      } catch {
        onWsFailure();
        return;
      }
      connectTimer = setTimeout(() => {
        if (!opened) { try { ws?.close(); } catch {} }
      }, WS_CONNECT_TIMEOUT_MS);
      ws.onopen = () => {
        opened = true;
        wsFailures = 0;
        clearTimeout(connectTimer);
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          cb.current(msg.event, msg.payload);
        } catch {}
      };
      ws.onclose = () => {
        clearTimeout(connectTimer);
        if (stopped) return;
        if (!opened) onWsFailure();
        else retryTimer = setTimeout(connectWs, 2000); // was working, reconnect
      };
      ws.onerror = () => { try { ws?.close(); } catch {} };
    };

    const onWsFailure = () => {
      wsFailures += 1;
      if (wsFailures >= MAX_WS_FAILURES) startPolling();
      else retryTimer = setTimeout(connectWs, 1500);
    };

    const kick = () => {
      if (stopped) return;
      if (usePolling) poll();
      else if (!ws || ws.readyState === WebSocket.CLOSED) connectWs();
    };

    connectWs();
    const onVisible = () => { if (document.visibilityState === "visible") kick(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", kick);

    return () => {
      stopped = true;
      clearInterval(pollTimer);
      clearTimeout(retryTimer);
      clearTimeout(connectTimer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", kick);
      try { ws?.close(); } catch {}
    };
  }, []);
}

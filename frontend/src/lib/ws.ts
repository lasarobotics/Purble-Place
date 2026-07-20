"use client";
import { useEffect, useRef } from "react";
import { wsUrl, getToken } from "./api";

// Subscribe to the MegaScout live event stream (submission_ack, scout_submitted,
// bet_placed, match_advanced, picklist_changed, ...) over a WebSocket to the
// local server's /ws hub. This is the on-prem realtime path from the Strategy
// Router design: the device gets an immediate acknowledgement that MegaScout
// has its submission, and every dashboard updates without polling.
//
// Auto-reconnects with backoff; reconnects on tab focus / network return.

export function useLiveEvents(onEvent: (event: string, payload: any) => void) {
  const cb = useRef(onEvent);
  cb.current = onEvent;

  useEffect(() => {
    if (typeof window === "undefined") return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: any;
    let backoff = 1000;

    const connect = () => {
      if (closed || !getToken()) return;
      try {
        ws = new WebSocket(wsUrl());
      } catch {
        schedule();
        return;
      }
      ws.onopen = () => {
        backoff = 1000; // reset backoff once a connection is established
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          cb.current(msg.event, msg.payload);
        } catch {}
      };
      ws.onclose = () => {
        if (!closed) schedule();
      };
      ws.onerror = () => {
        try { ws?.close(); } catch {}
      };
    };

    const schedule = () => {
      clearTimeout(retry);
      retry = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15000); // cap reconnect delay at 15s
    };

    const kick = () => {
      // Force an immediate reconnect attempt when the tab/network comes back.
      if (closed) return;
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        backoff = 1000;
        connect();
      }
    };

    connect();
    const onVisible = () => {
      if (document.visibilityState === "visible") kick();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", kick);

    return () => {
      closed = true;
      clearTimeout(retry);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", kick);
      try { ws?.close(); } catch {}
    };
  }, []);
}

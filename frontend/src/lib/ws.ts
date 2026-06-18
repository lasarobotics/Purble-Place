"use client";
import { useEffect, useRef } from "react";
import { wsUrl, getToken } from "./api";

// Subscribe to live server events (scout_submitted, bet_placed, match_advanced,
// picklist_changed, ...). Auto-reconnects. The SignalR stand-in.
export function useLiveEvents(onEvent: (event: string, payload: any) => void) {
  const cb = useRef(onEvent);
  cb.current = onEvent;

  useEffect(() => {
    if (typeof window === "undefined") return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: any;

    const connect = () => {
      if (!getToken()) return;
      try {
        ws = new WebSocket(wsUrl());
      } catch {
        retry = setTimeout(connect, 4000);
        return;
      }
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          cb.current(msg.event, msg.payload);
        } catch {}
      };
      ws.onclose = () => {
        if (!closed) retry = setTimeout(connect, 4000);
      };
      ws.onerror = () => {
        try { ws?.close(); } catch {}
      };
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(retry);
      try { ws?.close(); } catch {}
    };
  }, []);
}

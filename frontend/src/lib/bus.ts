// Tiny pub/sub so live server events can nudge any page to refetch.
import { useEffect } from "react";

type Handler = (event: string, payload: any) => void;
const handlers = new Set<Handler>();

export function onBus(h: Handler): () => void {
  handlers.add(h);
  return () => handlers.delete(h);
}
export function emitBus(event: string, payload: any) {
  handlers.forEach((h) => {
    try { h(event, payload); } catch {}
  });
}

// Data-changing server events that analytics/schedule pages care about.
export const DATA_EVENTS = [
  "scout_submitted",
  "settings_changed",
  "match_advanced",
  "pit_submitted",
  "film_updated",
];

/** Run `load` on mount and again whenever a data-changing live event fires.
 *  Kills the "page fetched once and went stale" class of bug. */
export function useLiveRefetch(load: () => void, events: string[] = DATA_EVENTS) {
  useEffect(() => {
    load();
    return onBus((e) => {
      if (events.includes(e)) load();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);
}

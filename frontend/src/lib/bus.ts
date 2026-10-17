// Tiny pub/sub so live server events can nudge any page to refetch.
import { useEffect } from "react";
import { invalidateAnalysis } from "./api";

type Handler = (event: string, payload: any) => void;
const handlers = new Set<Handler>();

export function onBus(h: Handler): () => void {
  handlers.add(h);
  return () => handlers.delete(h);
}
export function emitBus(event: string, payload: any) {
  if (DATA_EVENTS.includes(event)) invalidateAnalysis();
  handlers.forEach((h) => {
    try { h(event, payload); } catch {}
  });
}

// Data-changing server events that analytics/schedule pages care about.
export const DATA_EVENTS = [
  "scout_submitted",
  "scouting_corrected",
  "settings_changed",
  "match_advanced",
  "pit_submitted",
  "film_updated",
  "season_changed",
  "form_changed",
];

/** Run `load` on mount and again whenever a data-changing live event fires.
 *  Kills the "page fetched once and went stale" class of bug. */
export function useLiveRefetch(load: () => void, events: string[] = DATA_EVENTS) {
  useEffect(() => {
    load();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => { clearTimeout(timer); timer = setTimeout(load, 150); };
    const reconnect = () => { invalidateAnalysis(); refresh(); };
    const unsubscribe = onBus((e) => {
      if (events.includes(e)) refresh();
    });
    window.addEventListener("online", reconnect);
    return () => { unsubscribe(); clearTimeout(timer); window.removeEventListener("online", reconnect); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);
}

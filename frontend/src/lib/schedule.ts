"use client";
// The match schedule, offline first.
//
// Scouts lose wifi constantly at venues, and a scout who cannot see which
// robot they are assigned to cannot scout at all. So every successful fetch
// is written to IndexedDB, and every read falls back to that copy. The hook
// tells you which source you got so the UI can say so honestly rather than
// silently showing stale alliances.
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { cacheSchedule, cachedSchedule, cachedScheduleInfo } from "./db";
import type { MatchRec } from "./types";

export type ScheduleSource = "network" | "cache" | "none";

export interface ScheduleState {
  matches: MatchRec[];
  event: string;
  source: ScheduleSource;
  savedAt: number | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

export async function loadSchedule(
  event?: string
): Promise<{ matches: MatchRec[]; event: string; source: ScheduleSource; savedAt: number | null }> {
  const query = event ? `?event=${encodeURIComponent(event)}&refresh=true` : "?refresh=true";
  try {
    const res = await api<{ event: string; matches: MatchRec[] }>(`/api/matches${query}`);
    if (res.matches?.length) {
      await cacheSchedule(res.event, res.matches).catch(() => {});
      return { matches: res.matches, event: res.event, source: "network", savedAt: Date.now() };
    }
  } catch {
    // Offline or the server is unreachable. Fall through to the local copy.
  }
  const info = await cachedScheduleInfo().catch(() => ({ event: "", savedAt: null, count: 0 }));
  const matches = await cachedSchedule(event || info.event).catch(() => [] as MatchRec[]);
  return {
    matches,
    event: event || info.event,
    source: matches.length ? "cache" : "none",
    savedAt: info.savedAt,
  };
}

export function useSchedule(event?: string): ScheduleState {
  const [state, setState] = useState<Omit<ScheduleState, "refresh">>({
    matches: [],
    event: event || "",
    source: "none",
    savedAt: null,
    loading: true,
  });

  const refresh = useCallback(async () => {
    const next = await loadSchedule(event);
    setState({ ...next, loading: false });
  }, [event]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const next = await loadSchedule(event);
      if (alive) setState({ ...next, loading: false });
    })();
    // Re-fetch as soon as the connection returns so a device that was offline
    // through a schedule change catches up without anyone thinking about it.
    const onOnline = () => { void refresh(); };
    const timer = window.setInterval(() => { if (navigator.onLine) void refresh(); }, 60_000);
    window.addEventListener("online", onOnline);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("online", onOnline);
    };
  }, [event, refresh]);

  return { ...state, refresh };
}

/** Which teams are on the field for a given qual match. */
export function teamsForMatch(
  matches: MatchRec[],
  matchNumber: number,
  compLevel = "qm"
): { red: number[]; blue: number[] } {
  const m = matches.find(
    (x) => x.match_number === matchNumber && x.comp_level === compLevel
  );
  return { red: m?.red || [], blue: m?.blue || [] };
}

"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { onBus } from "./bus";
import type { Team } from "./types";

export function usePicklistTeams(event?: string) {
  const [pool, setPool] = useState<number[]>([]);
  const [teams, setTeams] = useState<Record<number, Team>>({});
  useEffect(() => {
    let alive = true;
    setPool([]); setTeams({});
    (async () => {
      let numbers: number[] = [];
      try { numbers = await api<number[]>("/api/admin/event-teams"); }
      catch { const r = await api<{ matches: { red: number[]; blue: number[] }[] }>("/api/matches"); numbers = [...new Set(r.matches.flatMap(m => [...m.red, ...m.blue]))]; }
      if (!alive) return;
      setPool(numbers.sort((a, b) => a - b));
      for (let i = 0; i < numbers.length; i += 24) {
        const rows = await api<Team[]>("/api/teams/batch", { method: "POST", body: { teams: numbers.slice(i, i + 24) } });
        if (!alive) return;
        setTeams(t => ({ ...t, ...Object.fromEntries(rows.map(r => [r.team_number, r])) }));
      }
    })().catch(() => {});
    return () => { alive = false; };
  }, [event]);
  return { pool, teams };
}

// WebSocket notifications normally update immediately. Polling recovers after
// dropped events, restarts, or a browser returning from background suspension.
export function usePicklistLive(load: () => void, interval = 15000) {
  useEffect(() => {
    load();
    const off = onBus(e => { if (e === "picklist_changed" || e === "settings_changed") load(); });
    const tick = () => {
      if (document.visibilityState === "visible" && navigator.onLine) load();
    };
    const timer = setInterval(tick, interval);
    const visible = () => { if (document.visibilityState === "visible") tick(); };
    window.addEventListener("online", load);
    document.addEventListener("visibilitychange", visible);
    return () => { off(); clearInterval(timer); window.removeEventListener("online", load); document.removeEventListener("visibilitychange", visible); };
  }, [load, interval]);
}

export function useRecoveredEdit<T>(key: string, save: (data: T) => Promise<void | ((latest: T) => T)>, delayMs = 900) {
  const [pending, setPending] = useState<T | null>(null);
  const [status, setStatus] = useState("Saved");
  const value = useRef<T | null>(null);
  const callback = useRef(save); callback.current = save;
  const busy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    value.current = null; setPending(null); setStatus("Saved");
    try { const stored = localStorage.getItem(key); if (stored) { value.current = JSON.parse(stored); setPending(value.current); setStatus("Recovered unsaved changes — review and retry"); } } catch {}
    return () => { clearTimeout(timer.current); generation.current++; };
  }, [key]);
  const flush = useCallback(async () => {
    if (busy.current || !value.current) return false;
    busy.current = true;
    const payload = value.current;
    const run = generation.current;
    setStatus("Saving");
    try {
      const rebase = await callback.current(payload);
      if (run !== generation.current) return false;
      if (value.current === payload) {
        value.current = null; setPending(null); localStorage.removeItem(key); setStatus("Saved");
      } else {
        if (rebase && value.current) { value.current = rebase(value.current); setPending(value.current); localStorage.setItem(key, JSON.stringify(value.current)); }
        setStatus("Saving");
        timer.current = setTimeout(() => { void flush(); }, delayMs);
      }
      return true;
    } catch (e: any) { if (run === generation.current) setStatus(`Save Failed: ${e.message}`); return false; }
    finally { busy.current = false; }
  }, [key, delayMs]);
  const enqueue = useCallback((data: T) => {
    value.current = data; setPending(data); setStatus("Saving");
    try { localStorage.setItem(key, JSON.stringify(data)); }
    catch { setStatus("Save Failed: local recovery storage is full; keep this page open"); }
    clearTimeout(timer.current); timer.current = setTimeout(() => { void flush(); }, delayMs);
  }, [key, flush, delayMs]);
  useEffect(() => {
    if (status === "Saving" && pending && !busy.current) {
      timer.current = setTimeout(() => { void flush(); }, delayMs);
    }
    return () => clearTimeout(timer.current);
  }, [status, pending, flush, delayMs]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (value.current) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  const discard = () => { clearTimeout(timer.current); value.current = null; setPending(null); localStorage.removeItem(key); setStatus("Saved"); };
  return { pending, enqueue, flush, status, discard };
}

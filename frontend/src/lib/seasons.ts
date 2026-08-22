"use client";
// Seasons: the client side of the multi-season platform.
//
// A season owns a game definition, the forms built for it, and everything
// scouted through them. The frontend never names a game element; it asks the
// season what its game contains and renders that.
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { GameDefinition } from "./formdef";

export type SeasonStatus = "setup" | "active" | "archived";

export interface SeasonSummary {
  season_id: string;
  year: number;
  game_name: string;
  status: SeasonStatus;
  game_version: number;
  copied_from: string;
  notes: string;
  created_at: string;
  updated_at: string;
  updated_by: string;
}

export interface SeasonWithGame extends SeasonSummary {
  definition: GameDefinition;
}

export interface ChecklistItem {
  key: string;
  label: string;
  done: boolean;
  hint: string;
}

export interface SeasonRevisionSummary {
  version: number;
  parent_version: number;
  message: string;
  author_name: string;
  created_at: string;
  reverted_from: number;
  summary: string;
  current: boolean;
}

export interface SeasonMeta {
  field_map_modes: string[];
  statuses: string[];
  per_modes: string[];
  rule_dimensions: { key: string; label: string; source: string }[];
}

export interface SeasonDiff {
  from: number;
  to: number;
  total: number;
  groups: Record<string, { added: string[]; removed: string[]; changed: string[] }>;
  scalars?: Record<string, { from: unknown; to: unknown }>;
  field_map_changed?: boolean;
}

// --------------------------------------------------------------------------
// API
// --------------------------------------------------------------------------
export const listSeasons = () =>
  api<{ current: string; seasons: SeasonSummary[] }>("/api/seasons");

export const getSeason = (seasonId: string) =>
  api<SeasonWithGame>(`/api/seasons/${seasonId}`);

export const getChecklist = (seasonId: string) =>
  api<ChecklistItem[]>(`/api/seasons/${seasonId}/checklist`);

export const getSeasonHistory = (seasonId: string) =>
  api<SeasonRevisionSummary[]>(`/api/seasons/${seasonId}/history`);

export const getSeasonDiff = (seasonId: string, from: number, to: number) =>
  api<SeasonDiff>(`/api/seasons/${seasonId}/diff?from_version=${from}&to_version=${to}`);

export const getSeasonMeta = () => api<SeasonMeta>("/api/seasons/meta");

export const validateGame = (definition: GameDefinition) =>
  api<{ problems: string[] }>("/api/seasons/validate", {
    method: "POST",
    body: { definition },
  });

export const saveGame = (
  seasonId: string,
  definition: GameDefinition,
  message: string,
  expectedVersion: number | null
) =>
  api<{ version: number; summary: string }>(`/api/seasons/${seasonId}/definition`, {
    method: "POST",
    body: { definition, message, expected_version: expectedVersion },
  });

export const revertGame = (seasonId: string, version: number, message = "") =>
  api<{ version: number; reverted_from: number }>(`/api/seasons/${seasonId}/revert`, {
    method: "POST",
    body: { version, message },
  });

export const createSeason = (body: {
  season_id: string;
  year: number;
  copy_from?: string;
  copy_forms?: boolean;
  notes?: string;
}) => api<SeasonSummary>("/api/seasons", { method: "POST", body });

export const setSeasonStatus = (seasonId: string, status: SeasonStatus) =>
  api<SeasonSummary>(`/api/seasons/${seasonId}/status`, {
    method: "POST",
    body: { status },
  });

export const seedSeasonForms = (seasonId: string) =>
  api<{ forms: string[] }>(`/api/seasons/${seasonId}/seed-forms`, { method: "POST" });

// --------------------------------------------------------------------------
// The season a scout is working in
// --------------------------------------------------------------------------
const CACHE_KEY = "hazehub.season";

/**
 * The current season and its game, cached on the device.
 *
 * A scout who opens the app with no signal still has to get the right game,
 * so every successful fetch is written to localStorage and every read falls
 * back to it.
 */
export function useCurrentSeason(): {
  season: SeasonSummary | null;
  game: GameDefinition | null;
  loading: boolean;
} {
  const [season, setSeason] = useState<SeasonSummary | null>(null);
  const [game, setGame] = useState<GameDefinition | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;

    try {
      const raw = window.localStorage.getItem(CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw);
        setSeason(cached.season);
        setGame(cached.game);
        setLoading(false);
      }
    } catch {}

    listSeasons()
      .then(async ({ current, seasons }) => {
        if (!alive) return;
        const row = seasons.find((s) => s.season_id === current) || seasons[0] || null;
        if (!row) return;
        const full = await getSeason(row.season_id);
        if (!alive) return;
        setSeason(full);
        setGame(full.definition);
        try {
          window.localStorage.setItem(
            CACHE_KEY,
            JSON.stringify({ season: full, game: full.definition })
          );
        } catch {}
      })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false); });

    return () => { alive = false; };
  }, []);

  return { season, game, loading };
}

/** An empty game, for a season that has not been configured yet. */
export function blankGame(year: number): GameDefinition {
  return {
    name: "",
    year,
    phases: [],
    pieces: [],
    locations: [],
    actions: [],
    rules: [],
    endgame: [],
    endgame_label: "Endgame",
    tags: [],
    field_map: { image: "", zones: [], mode: "point", orientation: "landscape" },
  };
}

"use client";
// The game being scouted, fetched from the server and cached on the device.
//
// FRC changes the game every year, so the endgame levels and the quick tags on
// the scouting form change with it. They are defined once in backend/app/game.py
// and served from /api/game, which means a new season needs no TypeScript
// change at all: edit the Python, restart, and the buttons follow.
//
// The definition is cached in localStorage because a scout who opens the app
// with no signal still has to see the right form. The built-in copy below is
// the last resort for a device that has never once been online.
import { useEffect, useState } from "react";
import { api } from "./api";

export interface EndgameLevel {
  key: string;
  label: string;
  points: number;
}

export interface GameTag {
  tag: string;
  tone: "good" | "bad";
}

export interface GameDef {
  season_id?: string;
  game_version?: number;
  season: number;
  name: string;
  auto_made: number;
  teleop_made: number;
  auto_leave: number;
  auto_endgame_bonus: number;
  stop_bonus: number;
  foul_penalty: number;
  endgame_label: string;
  endgame: EndgameLevel[];
  endgame_none: string;
  scoring_noun: string;
  tags: GameTag[];
  phases: string[];
}

const CACHE_KEY = "hazehub.game";

/** Used only until the first successful fetch on a brand new device. */
export const FALLBACK_GAME: GameDef = {
  season: 2026,
  name: "Rebuilt",
  auto_made: 4,
  teleop_made: 2.5,
  auto_leave: 3,
  auto_endgame_bonus: 4,
  stop_bonus: 1.5,
  foul_penalty: 2,
  endgame_label: "Endgame climb",
  endgame: [
    { key: "none", label: "No climb", points: 0 },
    { key: "l1", label: "L1", points: 3 },
    { key: "l2", label: "L2", points: 6 },
    { key: "l3", label: "L3", points: 12 },
  ],
  endgame_none: "none",
  scoring_noun: "attempt",
  tags: [
    { tag: "Fast cycles", tone: "good" },
    { tag: "Strong auto", tone: "good" },
    { tag: "Clutch climb", tone: "good" },
    { tag: "Great defense", tone: "good" },
    { tag: "Smart driver", tone: "good" },
    { tag: "Consistent", tone: "good" },
    { tag: "Good under pressure", tone: "good" },
    { tag: "Great partner", tone: "good" },
    { tag: "Died on field", tone: "bad" },
    { tag: "Dropped pieces", tone: "bad" },
    { tag: "Slow cycles", tone: "bad" },
    { tag: "Tippy / unstable", tone: "bad" },
    { tag: "Penalty prone", tone: "bad" },
    { tag: "Struggled vs defense", tone: "bad" },
    { tag: "Comms issues", tone: "bad" },
  ],
  phases: ["auto", "teleop"],
};

function readCache(): GameDef | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GameDef;
    return parsed?.endgame?.length ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(game: GameDef) {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(game));
  } catch {
    // A full or disabled storage is not a reason to stop scouting.
  }
}

/** The definition to render with right now, without waiting on the network. */
export function currentGame(): GameDef {
  return readCache() || FALLBACK_GAME;
}

export async function loadGame(): Promise<GameDef> {
  try {
    const game = await api<GameDef>("/api/game", { auth: false });
    if (game?.endgame?.length) {
      game.endgame_none = game.endgame_none || game.endgame.find(level => level.key === "none")?.key || "none";
      game.tags = game.tags || [];
      writeCache(game);
      return game;
    }
  } catch {
    // Offline. The cached copy is the whole point.
  }
  return currentGame();
}

/**
 * The game definition, available synchronously from cache and refreshed in
 * the background.
 *
 * Rendering never blocks on this: the form comes up with the cached game and
 * quietly corrects itself if the server has a newer one, which is what a
 * scout on a flaky connection needs.
 */
export function useGame(): GameDef {
  const [game, setGame] = useState<GameDef>(FALLBACK_GAME);

  useEffect(() => {
    setGame(currentGame());
    let alive = true;
    loadGame().then((g) => { if (alive) setGame(g); });
    return () => { alive = false; };
  }, []);

  return game;
}

export function endgameLabel(game: GameDef, key: string): string {
  return game.endgame.find((l) => l.key === key)?.label ?? key;
}

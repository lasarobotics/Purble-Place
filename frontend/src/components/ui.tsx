"use client";
import { MetricLabel } from "./MetricLabel";
import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/api";
import type { Team } from "@/lib/types";

// FRC 418 Purple Haze · FRC 436 Purple Rain, highlighted across the app.
export const HOME_TEAMS = [418, 436];

type AvatarTeam = Pick<Team, "team_number"> & Partial<Omit<Team, "team_number">>;
type TeamLike = AvatarTeam | ({ team: number } & Partial<Team>);
const teamProfileCache = new Map<number, AvatarTeam>();
const pendingProfiles = new Map<number, Promise<AvatarTeam | null>>();
const batchWaiters = new Map<number, { resolve: (team: AvatarTeam | null) => void }[]>();
let batchFlush: ReturnType<typeof setTimeout> | null = null;

export function Loading({ label = "Loading..." }: { label?: string }) {
  return (
    <div className="loading-wrap">
      <div style={{ textAlign: "center" }}>
        <div className="spinner" style={{ margin: "0 auto 12px" }} />
        <div className="muted">{label}</div>
      </div>
    </div>
  );
}

export function Empty({ title }: { icon?: string; title: string; sub?: string }) {
  return (
    <div className="empty">
      <h3 style={{ margin: "0 0 4px" }}>{title}</h3>
    </div>
  );
}

export function Stat({ label, value, accent }: { label: string; value: React.ReactNode; accent?: boolean }) {
  return (
    <div className="stat">
      <div className="label"><MetricLabel>{label}</MetricLabel></div>
      <div className={"value" + (accent ? " haze" : "")}>{value}</div>
    </div>
  );
}

function normalizeTeam(team: TeamLike): AvatarTeam {
  const teamNumber = "team_number" in team ? team.team_number : team.team;
  return {
    ...team,
    team_number: teamNumber,
    nickname: team.nickname || "",
  };
}

function flushTeamProfileBatch() {
  batchFlush = null;
  const numbers = [...batchWaiters.keys()];
  if (!numbers.length) return;
  const waiters = new Map(batchWaiters);
  batchWaiters.clear();
  (async () => {
    const byNumber = new Map<number, AvatarTeam>();
    try {
      for (let i = 0; i < numbers.length; i += 24) {
        const slice = numbers.slice(i, i + 24);
        const rows = await api<Team[]>("/api/teams/batch", { method: "POST", body: { teams: slice } });
        for (const row of rows) byNumber.set(row.team_number, normalizeTeam(row));
      }
    } catch {
      /* Individual waiters resolve null below. */
    }
    for (const [teamNumber, resolvers] of waiters) {
      const profile = byNumber.get(teamNumber) || null;
      if (profile) teamProfileCache.set(teamNumber, profile);
      pendingProfiles.delete(teamNumber);
      for (const { resolve } of resolvers) resolve(profile);
    }
  })();
}

function fetchTeamProfile(teamNumber: number): Promise<AvatarTeam | null> {
  if (teamProfileCache.has(teamNumber)) return Promise.resolve(teamProfileCache.get(teamNumber)!);
  const pending = pendingProfiles.get(teamNumber);
  if (pending) return pending;
  const req = new Promise<AvatarTeam | null>((resolve) => {
    const queue = batchWaiters.get(teamNumber) || [];
    queue.push({ resolve });
    batchWaiters.set(teamNumber, queue);
    if (!batchFlush) batchFlush = setTimeout(flushTeamProfileBatch, 0);
  });
  pendingProfiles.set(teamNumber, req);
  return req;
}

function useResolvedTeam(team: TeamLike): AvatarTeam {
  // A batch/profile response deliberately includes these keys even when TBA
  // has no photo. Treat that as resolved; otherwise every avatar in a list
  // launches its own network request and can overwhelm a small event server.
  const profileSupplied = "nickname" in team || "avatar" in team || "name" in team;
  const normalized = normalizeTeam(team);
  const teamNumber = normalized.team_number;
  const avatar = normalized.avatar || "";
  const nickname = normalized.nickname || "";
  const [resolved, setResolved] = useState<AvatarTeam>(() => {
    if (profileSupplied) teamProfileCache.set(teamNumber, normalized);
    return teamProfileCache.get(teamNumber) || normalized;
  });

  useEffect(() => {
    const base = normalized;
    if (!teamNumber) return;
    if (profileSupplied) {
      teamProfileCache.set(teamNumber, base);
      setResolved(base);
      return;
    }
    const cached = teamProfileCache.get(teamNumber);
    if (cached) {
      setResolved({ ...base, ...cached });
      return;
    }
    let alive = true;
    setResolved(base);
    fetchTeamProfile(teamNumber).then((profile) => {
      if (alive && profile) setResolved({ ...base, ...profile });
    });
    return () => { alive = false; };
  }, [teamNumber, avatar, nickname, profileSupplied]);

  return resolved;
}

export function TeamAvatar({ team, size = "" }: { team: TeamLike; size?: "sm" | "lg" | "" }) {
  const normalized = useResolvedTeam(team);
  const home = HOME_TEAMS.includes(normalized.team_number) ? " home" : "";
  const cls = "avatar" + (size ? " " + size : "") + home;
  if (normalized.avatar) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={cls} src={normalized.avatar} alt={`${normalized.team_number}`} />;
  }
  return (
    <div
      className={cls}
      style={{
        display: "grid",
        placeItems: "center",
        fontWeight: 800,
        fontSize: size === "lg" ? "0.9rem" : "0.68rem",
        background: "var(--panel-2)",
        overflow: "hidden",
      }}
      aria-label={`Team ${normalized.team_number}`}
    >
      {String(normalized.team_number).slice(-2)}
    </div>
  );
}

export function TeamIdentity({
  team,
  size = "sm",
  showNickname = true,
}: {
  team: TeamLike;
  size?: "sm" | "lg" | "";
  showNickname?: boolean;
}) {
  const normalized = useResolvedTeam(team);
  return (
    <span className="team-id">
      <TeamAvatar team={normalized} size={size} />
      <span className="team-id-text">
        <b>{normalized.team_number}</b>
        {showNickname && normalized.nickname && <span>{normalized.nickname}</span>}
      </span>
    </span>
  );
}

export function Modal({ children, onClose, dialog = false }: { children: React.ReactNode; onClose: () => void; dialog?: boolean }) {
  // Portal to <body>: ancestors with backdrop-filter/transform (e.g. .card)
  // create containing blocks that would trap a position:fixed overlay.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape" && document.querySelectorAll(".modal-back").length === 1) onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  if (!mounted) return null;
  return createPortal(
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role={dialog ? "dialog" : undefined} aria-modal={dialog ? true : undefined} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Yes/no dialog for a change that quietly ruins data if it was a mis-tap.
 *
 * Used by the alliance and station switches on the scouting page: those two
 * controls decide which robot every following submission is about, and a
 * thumb brushing them mid-match sends the rest of the day's scouting to the
 * wrong team without anything looking wrong on screen.
 */
export function Confirm({
  title,
  body,
  confirmLabel = "Yes, change it",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: {
  title: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <Modal onClose={onCancel}>
      <div className="confirm">
        <h3>{title}</h3>
        {body && <div className="confirm-body">{body}</div>}
        <div className="confirm-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>{cancelLabel}</button>
          <button type="button" className="btn primary" onClick={onConfirm} autoFocus>{confirmLabel}</button>
        </div>
      </div>
    </Modal>
  );
}

export function Bar({ value, max = 1 }: { value: number; max?: number }) {
  const w = Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  return (
    <div className="bar">
      <span style={{ width: `${w}%` }} />
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  color,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  color?: (v: T) => "" | "red" | "blue";
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button
          key={o.value}
          className={value === o.value ? "on " + (color ? color(o.value) : "") : ""}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          type="button"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Stepper({
  value,
  onChange,
  min = 0,
  max = 999,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  const set = (v: number) => onChange(Math.max(min, Math.min(max, v)));
  return (
    <div className="stepper">
      <button type="button" aria-label="Decrease" disabled={value <= min} onClick={() => set(value - 1)}>−</button>
      <input
        aria-label="Count"
        value={value}
        inputMode="numeric"
        onChange={(e) => {
          const n = parseInt(e.target.value.replace(/[^0-9]/g, ""), 10);
          set(isNaN(n) ? 0 : n);
        }}
      />
      <button type="button" aria-label="Increase" disabled={value >= max} onClick={() => set(value + 1)}>+</button>
    </div>
  );
}

export function Rating({ value, onChange, max = 5 }: { value: number; onChange: (v: number) => void; max?: number }) {
  return (
    <div className="row" style={{ gap: 6 }}>
      {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          type="button"
          aria-label={`Rate ${n} of ${max}`}
          aria-pressed={n === value}
          onClick={() => onChange(n)}
          className={"btn sm rating-button" + (n === value ? " is-selected" : "")}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

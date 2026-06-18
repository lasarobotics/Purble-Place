"use client";
import React from "react";
import type { Team } from "@/lib/types";

type AvatarTeam = Pick<Team, "team_number"> & Partial<Omit<Team, "team_number">>;
type TeamLike = AvatarTeam | ({ team: number } & Partial<Team>);

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading-wrap">
      <div style={{ textAlign: "center" }}>
        <div className="spinner" style={{ margin: "0 auto 12px" }} />
        <div className="muted">{label}</div>
      </div>
    </div>
  );
}

export function Empty({ icon = "✨", title, sub }: { icon?: string; title: string; sub?: string }) {
  return (
    <div className="empty">
      <div className="big">{icon}</div>
      <h3 style={{ margin: "0 0 4px" }}>{title}</h3>
      {sub && <p style={{ margin: 0 }}>{sub}</p>}
    </div>
  );
}

export function Stat({ label, value, accent }: { label: string; value: React.ReactNode; accent?: boolean }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
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

export function TeamAvatar({ team, size = "" }: { team: TeamLike; size?: "sm" | "lg" | "" }) {
  const normalized = normalizeTeam(team);
  const cls = "avatar" + (size ? " " + size : "");
  if (normalized.avatar) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={cls} src={normalized.avatar} alt={`${normalized.team_number}`} />;
  }
  const hue = (normalized.team_number * 47) % 360;
  return (
    <div
      className={cls}
      style={{
        display: "grid",
        placeItems: "center",
        fontWeight: 800,
        fontSize: size === "lg" ? "1rem" : "0.7rem",
        background: `linear-gradient(135deg, hsl(${hue} 50% 30%), hsl(${(hue + 40) % 360} 55% 22%))`,
      }}
    >
      {normalized.team_number}
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
  const normalized = normalizeTeam(team);
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

export function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
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
      <button type="button" onClick={() => set(value - 1)}>−</button>
      <input
        value={value}
        inputMode="numeric"
        onChange={(e) => {
          const n = parseInt(e.target.value.replace(/[^0-9]/g, ""), 10);
          set(isNaN(n) ? 0 : n);
        }}
      />
      <button type="button" onClick={() => set(value + 1)}>+</button>
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
          onClick={() => onChange(n)}
          className="btn sm"
          style={{
            width: 38,
            padding: "8px 0",
            background: n <= value ? "var(--haze)" : "var(--panel-2)",
            borderColor: n <= value ? "transparent" : "var(--border)",
          }}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

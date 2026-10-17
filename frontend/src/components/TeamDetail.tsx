"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { num } from "@/lib/format";
import type { PitEntry, Team } from "@/lib/types";
import { TeamAvatar } from "./ui";

export function TeamDetail({ team }: { team: Team }) {
  const [full, setFull] = useState<Team>(team);
  const [pit, setPit] = useState<PitEntry | null>(null);

  useEffect(() => {
    setFull(team);
    // Enrich with media if not already present.
    if (!team.photos || team.photos.length === 0 || team.epa == null) {
      api<Team>(`/api/teams/${team.team_number}`).then(setFull).catch(() => {});
    }
    api<PitEntry | null>(`/api/pit/${team.team_number}`).then(setPit).catch(() => {});
  }, [team.team_number]);

  const photos = Array.from(new Set([
    ...((pit?.robot_photos || []).filter(Boolean)),
    ...(pit?.robot_photo ? [pit.robot_photo] : []),
    ...((full.photos || []).filter(Boolean)),
  ]));

  return (
    <div>
      <div className="row" style={{ gap: 14, marginBottom: 14 }}>
        <TeamAvatar team={full} size="lg" />
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0 }}>{full.team_number}</h2>
          <div className="muted">{full.nickname || "-"}</div>
          <div className="faint" style={{ fontSize: "0.8rem" }}>
            {[full.city, full.state, full.country].filter(Boolean).join(", ")}
          </div>
        </div>
        {full.epa != null && (
          <div style={{ marginLeft: "auto", textAlign: "right" }}>
            <div className="faint" style={{ fontSize: "0.7rem" }}>STATBOTICS EPA</div>
            <div className="haze-text" style={{ fontSize: "1.7rem", fontWeight: 900 }}>{num(full.epa, 0)}</div>
          </div>
        )}
      </div>

      {photos.length > 0 ? (
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px,1fr))", marginBottom: 14 }}>
          {photos.map((p, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} src={p} alt={`robot ${i}`} style={{ width: "100%", borderRadius: 12, border: "1px solid var(--border)", aspectRatio: "4/3", objectFit: "cover" }} />
          ))}
        </div>
      ) : (
        <p className="muted">No photos</p>
      )}

      {pit && (pit.drivetrain || pit.archetype || pit.capabilities?.length || pit.notes) && (
        <div className="card tight">
          <div className="card-h"><h3 style={{ fontSize: "0.95rem" }}>Pit Notes</h3></div>
          {pit.archetype && <div className="row" style={{ justifyContent: "space-between" }}><span className="muted">Archetype</span><b>{pit.archetype}</b></div>}
          {pit.drivetrain && <div className="row" style={{ justifyContent: "space-between" }}><span className="muted">Drivetrain</span><b>{pit.drivetrain}</b></div>}
          {pit.weight_lbs ? <div className="row" style={{ justifyContent: "space-between" }}><span className="muted">Weight</span><b>{pit.weight_lbs} lb</b></div> : null}
          {pit.can_climb && pit.can_climb !== "none" && <div className="row" style={{ justifyContent: "space-between" }}><span className="muted">Climb</span><b>{pit.can_climb.toUpperCase()}</b></div>}
          {(pit.capabilities?.length ?? 0) > 0 && (
            <div className="tag-list" style={{ marginTop: 8 }}>
              {pit.capabilities!.map((c) => <span key={c} className="chip">{c}</span>)}
            </div>
          )}
          {pit.notes && <p style={{ marginTop: 8 }}>{pit.notes}</p>}
        </div>
      )}
    </div>
  );
}

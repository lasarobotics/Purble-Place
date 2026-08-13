"use client";
// The team's locked-in final pick order, shown at the top of every screen
// where somebody is building a picklist.
//
// Once alliance selection is decided, a scout still tinkering with their own
// list should be able to see what the team actually settled on without going
// to find it. Renders nothing at all until a final list has teams in it, so
// it costs no space for most of the event.
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { onBus } from "@/lib/bus";
import type { Picklist, Team } from "@/lib/types";
import { ClickableTeam } from "@/components/TeamDetailModal";

interface FinalList extends Picklist {
  division: string;
}

const justificationOf = (it: { justification?: string; note?: string }) =>
  it.justification ?? it.note ?? "";

export function FinalPicklists({ teams = {} }: { teams?: Record<number, Team> }) {
  const [finals, setFinals] = useState<FinalList[]>([]);
  const [extra, setExtra] = useState<Record<number, Team>>({});

  const load = useCallback(async () => {
    try {
      setFinals(await api<FinalList[]>("/api/picklists/finals"));
    } catch {
      setFinals([]);
    }
  }, []);

  useEffect(() => {
    load();
    return onBus((e) => { if (e === "picklist_changed") load(); });
  }, [load]);

  // Resolve any team the caller has not already loaded, so the names and
  // avatars show up even on a screen that did not fetch them.
  useEffect(() => {
    const missing = Array.from(new Set(finals.flatMap((l) => l.items.map((i) => i.team))))
      .filter((n) => n && !teams[n] && !extra[n]);
    if (!missing.length) return;
    api<Team[]>("/api/teams/batch", { method: "POST", body: { teams: missing.slice(0, 24) } })
      .then((rows) => setExtra((cur) => ({ ...cur, ...Object.fromEntries(rows.map((t) => [t.team_number, t])) })))
      .catch(() => {});
  }, [finals, teams, extra]);

  if (!finals.length) return null;

  const lookup = (n: number) => teams[n] || extra[n] || { team_number: n, nickname: "" };

  return (
    <section className="final-picks card" style={{ marginBottom: 16 }}>
      <div className="card-h">
        <h2 style={{ margin: 0, fontSize: "1rem" }}>Final pick order</h2>
        <span className="badge haze">Decided by the team</span>
      </div>
      <p className="faint" style={{ margin: "0 0 10px", fontSize: "0.78rem" }}>
        This is what we are actually picking. Your own lists below do not change it.
      </p>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
        {finals.map((l) => (
          <div key={l.id} className="final-pick-card">
            <div className="card-h">
              <h3 style={{ margin: 0, fontSize: "0.9rem" }}>
                {l.division} · {l.pick_round === 1 ? "First pick" : "Second pick"}
              </h3>
              <span className="badge muted">{l.items.length}</span>
            </div>
            <ol className="list-card-items">
              {l.items.map((it, i) => (
                <li key={it.team}>
                  <span className="rank-chip sm">{i + 1}</span>
                  <ClickableTeam team={lookup(it.team)} />
                  {justificationOf(it) && <span className="pick-why">{justificationOf(it)}</span>}
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </section>
  );
}

"use client";
import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { onBus } from "@/lib/bus";
import { matchLabel, num } from "@/lib/format";
import type { MatchRec, Team } from "@/lib/types";
import { Loading, Empty, TeamAvatar, Modal } from "@/components/ui";
import { TeamDetail } from "@/components/TeamDetail";

export default function PreMatchPage() {
  const [data, setData] = useState<{ event: string; current: MatchRec | null; on_deck: MatchRec[]; current_number: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<MatchRec | null>(null);
  const [expand, setExpand] = useState<Team | null>(null);
  const [lookup, setLookup] = useState("");

  const load = useCallback(async () => {
    try {
      const c = await api<any>("/api/matches/current");
      setData(c);
      setView((v) => v || c.current || c.on_deck?.[0] || null);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    return onBus((e) => { if (e === "match_advanced" || e === "settings_changed") load(); });
  }, [load]);

  async function doLookup(e: React.FormEvent) {
    e.preventDefault();
    const n = parseInt(lookup.replace(/[^0-9]/g, ""), 10);
    if (!n) return;
    try {
      const t = await api<Team>(`/api/teams/${n}`);
      setExpand(t);
    } catch {}
  }

  if (loading) return <Loading />;
  if (!data?.event) {
    return (
      <div>
        <h1>🤖 Pre-Match</h1>
        <Empty icon="🗓️" title="No event selected" sub="An admin needs to set the current event in the Dashboard." />
      </div>
    );
  }

  const options = [data.current, ...(data.on_deck || [])].filter(Boolean) as MatchRec[];

  return (
    <div>
      <div className="page-title"><h1>🤖 Pre-Match</h1>
        <span className="badge muted">{data.event}</span>
      </div>
      <p className="page-sub">Scout the robots while you wait — tap any team for robot photos & stats.</p>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="spread" style={{ gap: 12, flexWrap: "wrap" }}>
          <div className="seg" style={{ flexWrap: "wrap" }}>
            {options.map((m) => (
              <button key={m.match_key} className={view?.match_key === m.match_key ? "on" : ""} onClick={() => setView(m)}>
                {matchLabel(m.comp_level, m.match_number)}{m.match_number === data.current_number ? " · LIVE" : ""}
              </button>
            ))}
          </div>
          <form onSubmit={doLookup} className="row" style={{ gap: 8 }}>
            <input value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="Look up team #" style={{ width: 150 }} />
            <button className="btn" type="submit">🔎</button>
          </form>
        </div>
      </div>

      {view ? (
        <div className="grid cols-2">
          <Alliance teams={view.red_teams || []} color="red" onExpand={setExpand} />
          <Alliance teams={view.blue_teams || []} color="blue" onExpand={setExpand} />
        </div>
      ) : (
        <Empty title="No upcoming matches" />
      )}

      {expand && (
        <Modal onClose={() => setExpand(null)}>
          <TeamDetail team={expand} />
        </Modal>
      )}
    </div>
  );
}

function Alliance({ teams, color, onExpand }: { teams: Team[]; color: "red" | "blue"; onExpand: (t: Team) => void }) {
  return (
    <div className={`card ${color === "red" ? "bg-red-soft alliance-red" : "bg-blue-soft alliance-blue"}`}>
      <div className="card-h">
        <h3 style={{ color: color === "red" ? "#fca5a5" : "#93c5fd" }}>{color.toUpperCase()} ALLIANCE</h3>
      </div>
      <div className="grid" style={{ gap: 10 }}>
        {teams.map((t) => (
          <div key={t.team_number} className="team-chip" style={{ padding: 12 }} onClick={() => onExpand(t)}>
            <TeamAvatar team={t} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="row" style={{ gap: 8 }}>
                <span className="tnum" style={{ fontSize: "1.1rem" }}>{t.team_number}</span>
                {t.epa != null && <span className="badge haze">EPA {num(t.epa, 0)}</span>}
              </div>
              <div className="tname">{t.nickname || "—"}</div>
            </div>
            <span className="badge muted">{t.photos?.length ? `📷 ${t.photos.length}` : "tap"}</span>
          </div>
        ))}
        {!teams.length && <div className="faint">Teams to be determined.</div>}
      </div>
    </div>
  );
}

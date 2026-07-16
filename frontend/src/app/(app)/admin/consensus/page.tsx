"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { num, pct } from "@/lib/format";
import type { DisagreementRow } from "@/lib/types";
import { Empty, Loading, Bar } from "@/components/ui";
import { ClickableTeam } from "@/components/TeamDetailModal";
import { Icon } from "@/components/icons";

const FLAG_META: Record<string, { label: string; cls: string }> = {
  scouts_disagree: { label: "Scouts disagree", cls: "amber" },
  numbers_look_better_than_eyes: { label: "Numbers > eye test", cls: "red" },
  eyes_look_better_than_numbers: { label: "Eye test > numbers", cls: "blue" },
};

export default function ConsensusPage() {
  const [data, setData] = useState<{ explanation: string; teams: DisagreementRow[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    api<{ explanation: string; teams: DisagreementRow[] }>("/api/admin/disagreements")
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading label="Cross-examining the scouting record…" />;

  const teams = data?.teams ?? [];
  const flagged = teams.filter((t) => t.flags.length > 0);

  return (
    <div>
      <div className="page-title">
        <h1>Consensus Radar</h1>
        {flagged.length > 0 && <span className="badge amber">{flagged.length} flagged</span>}
      </div>
      <p className="page-sub">
        Where the scouting record disagrees with itself — re-watch these on film before the
        picklist locks. {data?.explanation}
      </p>

      {teams.length === 0 ? (
        <div className="card"><Empty icon="radar" title="No scouting data yet" sub="Disagreements appear once matches are scouted." /></div>
      ) : (
        <div className="grid" style={{ gap: 12 }}>
          {teams.map((t) => {
            const expanded = open === t.team;
            return (
              <div key={t.team} className={"card tight consensus-row" + (t.flags.length ? " flagged" : "")}>
                <div className="spread" style={{ flexWrap: "wrap", gap: 10 }}>
                  <ClickableTeam team={{ team_number: t.team, nickname: t.nickname, avatar: t.avatar }} />
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    {t.flags.map((f) => (
                      <span key={f} className={`badge ${FLAG_META[f]?.cls ?? "muted"}`}>
                        {FLAG_META[f]?.label ?? f}
                      </span>
                    ))}
                    <span className="badge muted">{t.matches} matches</span>
                  </div>
                </div>

                <div className="consensus-meters">
                  <div>
                    <div className="spread"><span className="faint">Disagreement score</span><b className="mono">{num(t.score, 2)}</b></div>
                    <Bar value={t.score} max={1} />
                  </div>
                  <div>
                    <div className="spread"><span className="faint">Output percentile</span><b className="mono">{pct(t.quant_pct)}</b></div>
                    <Bar value={t.quant_pct} max={1} />
                  </div>
                  <div>
                    <div className="spread"><span className="faint">Eye-test percentile</span><b className="mono">{pct(t.qual_pct)}</b></div>
                    <Bar value={t.qual_pct} max={1} />
                  </div>
                </div>

                {t.conflicts.length > 0 && (
                  <button className="btn sm ghost" style={{ marginTop: 10 }} onClick={() => setOpen(expanded ? null : t.team)}>
                    <Icon name="search" size={14} />
                    {expanded ? "Hide" : "Show"} conflicting reports ({t.conflicts.length})
                  </button>
                )}
                {expanded && (
                  <div className="consensus-conflicts">
                    {t.conflicts.map((c) => (
                      <div key={c.match} className="consensus-conflict">
                        <span className="badge haze">Q{c.match}</span>
                        <span className="badge amber">{num(c.spread, 1)} pt spread</span>
                        {c.reports.map((r, i) => (
                          <span key={i} className="badge muted">
                            scout {r.scout_id}: {num(r.points, 1)} pts
                          </span>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

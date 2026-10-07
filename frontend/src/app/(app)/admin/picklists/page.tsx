"use client";
// Every picklist at the event, in one place, grouped by whose it is.
//
// No password. Reaching this page already requires a strategy or admin
// account, and the picklist meeting screen at /meeting is where lists are
// actually edited during selection. This page is for reviewing what everyone
// submitted and promoting a list to a final list for 418 or 436.
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { onBus } from "@/lib/bus";
import { timeAgo } from "@/lib/format";
import { useToast } from "@/lib/toast";
import type { MeetingPicklists, Picklist, Team } from "@/lib/types";
import { Confirm, Loading, Empty } from "@/components/ui";
import { ClickableTeam } from "@/components/TeamDetailModal";
import { FinalPicklists } from "@/components/FinalPicklists";
import { NoteText } from "@/components/MatchRef";

const FINAL_DIVISIONS = ["418", "436"] as const;
const isFinalList = (p: Picklist) => p.owner_id.startsWith("final-");
const finalDivision = (p: Picklist) => p.owner_id.replace("final-", "");
const justificationOf = (it: { justification?: string; note?: string }) =>
  it.justification ?? it.note ?? "";

export default function AllPicklistsPage() {
  const toast = useToast();
  const [data, setData] = useState<MeetingPicklists | null>(null);
  const [teams, setTeams] = useState<Record<number, Team>>({});
  const [round, setRound] = useState<1 | 2>(1);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState<Picklist | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<MeetingPicklists>("/api/picklists/meeting"));
    } catch (e: any) {
      toast(e.message || "Could not load picklists", "err");
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    load();
    return onBus((e) => { if (e === "picklist_changed") load(); });
  }, [load]);

  useEffect(() => {
    if (!data) return;
    const all = [...data.master, ...data.strategy, ...data.scouter];
    const nums = Array.from(new Set(all.flatMap((l) => l.items.map((i) => i.team))))
      .filter((n) => n && !teams[n]);
    if (!nums.length) return;
    api<Team[]>("/api/teams/batch", { method: "POST", body: { teams: nums.slice(0, 24) } })
      .then((rows) => setTeams((cur) => ({ ...cur, ...Object.fromEntries(rows.map((t) => [t.team_number, t])) })))
      .catch(() => {});
  }, [data, teams]);

  async function makeFinal(division: "418" | "436", source: Picklist) {
    try {
      await api(`/api/picklists/finals/${division}`, {
        method: "POST",
        body: { source_id: source.id, pick_round: source.pick_round },
      });
      toast(`Copied ${source.owner_name}'s list into Final ${division}`, "ok");
      load();
    } catch (e: any) {
      toast(e.message || "Could not update the final picklist", "err");
    }
  }

  async function clearFinal(list: Picklist) {
    const division = finalDivision(list);
    setClearing(null);
    try {
      await api(`/api/picklists/finals/${division}?pick_round=${list.pick_round}`, { method: "DELETE" });
      toast(`Cleared Final ${division}`, "ok");
      load();
    } catch (e: any) {
      toast(e.message || "Could not clear the final picklist", "err");
    }
  }

  if (loading) return <Loading />;

  const forRound = (rows: Picklist[]) => rows.filter((l) => l.pick_round === round);
  const master = forRound(data?.master ?? []);
  const strategy = forRound(data?.strategy ?? []);
  const scouter = forRound(data?.scouter ?? []);
  const total = master.length + strategy.length + scouter.length;

  return (
    <div>
      <div className="page-title">
        <h1>All Pick Lists</h1>
        <div className="seg">
          <button className={round === 1 ? "on" : ""} onClick={() => setRound(1)}>First pick</button>
          <button className={round === 2 ? "on" : ""} onClick={() => setRound(2)}>Second pick</button>
        </div>
      </div>


      <FinalPicklists teams={teams} />

      {total === 0 ? (
        <Empty icon="list" title="No picklists yet" sub="They appear here as people build them." />
      ) : (
        <>
          <Group title="Master and final lists" lists={master} teams={teams} onFinal={makeFinal} onClearFinal={setClearing} big />
          <Group title="Strategy lists" lists={strategy} teams={teams} onFinal={makeFinal} onClearFinal={setClearing} big />
          <Group title="Scouter lists" lists={scouter} teams={teams} onFinal={makeFinal} onClearFinal={setClearing} />
        </>
      )}

      {clearing && (
        <Confirm
          title={`Delete Final ${finalDivision(clearing)}?`}
          body={
            <>
              This empties the <b>{finalDivision(clearing)} {clearing.pick_round === 1 ? "first" : "second"} pick</b>{" "}
              list for everyone.
            </>
          }
          confirmLabel="Yes, delete it"
          onConfirm={() => clearFinal(clearing)}
          onCancel={() => setClearing(null)}
        />
      )}
    </div>
  );
}

function Group({
  title,
  lists,
  teams,
  onFinal,
  onClearFinal,
  big,
}: {
  title: string;
  lists: Picklist[];
  teams: Record<number, Team>;
  onFinal: (d: "418" | "436", p: Picklist) => void;
  onClearFinal: (p: Picklist) => void;
  big?: boolean;
}) {
  if (!lists.length) return null;
  return (
    <section style={{ marginBottom: 20 }}>
      <div className="card-h">
        <h2 style={{ fontSize: "1rem", margin: 0 }}>{title}</h2>
        <span className="badge muted">{lists.length}</span>
      </div>
      <div
        className="grid auto"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${big ? 300 : 210}px, 1fr))`, marginTop: 10 }}
      >
        {lists.map((p) => (
          <div key={p.id} className="card tight" style={p.is_master ? { borderColor: "var(--haze)" } : {}}>
            <div className="card-h">
              <div>
                <h3 style={{ fontSize: "0.95rem", margin: 0 }}>
                  {p.owner_name}{" "}
                  {isFinalList(p) && <span className="badge haze">final {finalDivision(p)}</span>}
                  {p.is_master && !isFinalList(p) && <span className="badge haze">master</span>}
                </h3>
                <div className="faint" style={{ fontSize: "0.72rem" }}>{timeAgo(p.updated_at)}</div>
              </div>
              <span className="badge muted">{p.items.length}</span>
            </div>

            {p.items.length === 0 ? (
              <p className="faint" style={{ fontSize: "0.8rem", margin: 0 }}>Empty</p>
            ) : (
              <ol className="list-card-items">
                {p.items.slice(0, big ? 15 : 8).map((it, i) => (
                  <li key={it.team}>
                    <span className="rank-chip sm">{i + 1}</span>
                    <ClickableTeam
                      team={teams[it.team] || { team_number: it.team, nickname: "" }}
                      showNickname={!!big}
                    />
                    {big && justificationOf(it) && (
                      <span className="pick-why">
                        <NoteText note={justificationOf(it)} team={it.team} />
                      </span>
                    )}
                  </li>
                ))}
                {p.items.length > (big ? 15 : 8) && (
                  <li className="faint">and {p.items.length - (big ? 15 : 8)} more</li>
                )}
              </ol>
            )}

            {p.items.length > 0 && !isFinalList(p) && (
              <div className="btn-row" style={{ marginTop: 10 }}>
                {FINAL_DIVISIONS.map((d) => (
                  <button key={d} className="btn sm" onClick={() => onFinal(d, p)}>
                    Final {d}
                  </button>
                ))}
              </div>
            )}
            {isFinalList(p) && p.items.length > 0 && (
              <div className="btn-row" style={{ marginTop: 10 }}>
                <button className="btn sm danger" onClick={() => onClearFinal(p)}>
                  Delete Final {finalDivision(p)}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

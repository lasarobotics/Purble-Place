"use client";
// Picklist meeting mode.
//
// This is what goes on the projector while the alliance selection happens.
// The two master lists are on top and editable; strategy lists sit below at
// readable size as the main input; everyone else's lists are compressed to a
// reference strip at the bottom. That ordering is the whole point of the
// screen, so it comes straight from the server's priority field rather than
// being re-derived here.
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { onBus } from "@/lib/bus";
import { timeAgo } from "@/lib/format";
import type { MeetingPicklists, Picklist, PicklistItem, Team } from "@/lib/types";
import { Loading, Modal } from "@/components/ui";
import { PicklistBoard } from "@/components/PicklistBoard";
import { ClickableTeam } from "@/components/TeamDetailModal";
import { FinalPicklists } from "@/components/FinalPicklists";
import { NoteText } from "@/components/MatchRef";

export default function MeetingPage() {
  const { session } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<MeetingPicklists | null>(null);
  const [teams, setTeams] = useState<Record<number, Team>>({});
  const [pool, setPool] = useState<number[]>([]);
  const [round, setRound] = useState<1 | 2>(1);
  const [saving, setSaving] = useState(false);
  // The list somebody tapped to read in full. Strategy lists are shown
  // side by side to save projector space, which truncates the reasoning
  // exactly when the room is arguing about it.
  const [expanded, setExpanded] = useState<Picklist | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<MeetingPicklists>("/api/picklists/meeting"));
    } catch (e: any) {
      toast(e.message || "Could not load picklists", "err");
    }
  }, [toast]);

  useEffect(() => {
    load();
    return onBus((e) => { if (e === "picklist_changed") load(); });
  }, [load]);

  useEffect(() => {
    if (!data) return;
    const all = Array.from(
      new Set(
        [...data.master, ...data.strategy, ...data.scouter].flatMap((l) =>
          l.items.map((i) => i.team)
        )
      )
    );
    (async () => {
      try {
        const res = await api<{ matches: { red: number[]; blue: number[] }[] }>("/api/matches");
        const scheduled = Array.from(new Set(res.matches.flatMap((m) => [...m.red, ...m.blue])));
        const combined = Array.from(new Set([...all, ...scheduled])).sort((a, b) => a - b);
        setPool(combined);
        for (let i = 0; i < combined.length; i += 24) {
          const rows = await api<Team[]>("/api/teams/batch", {
            method: "POST",
            body: { teams: combined.slice(i, i + 24) },
          });
          setTeams((cur) => ({ ...cur, ...Object.fromEntries(rows.map((t) => [t.team_number, t])) }));
        }
      } catch {}
    })();
  }, [data]);

  async function saveMaster(list: Picklist, items: PicklistItem[]) {
    setSaving(true);
    try {
      await api(`/api/picklists/${list.id}`, { method: "PUT", body: { name: list.name, items } });
      await load();
    } catch (e: any) {
      toast(e.message || "Could not save", "err");
    } finally {
      setSaving(false);
    }
  }

  if (!data) return <Loading label="Loading picklists" />;

  const master = data.master.find((l) => l.pick_round === round);
  const strategy = data.strategy.filter((l) => l.pick_round === round);
  const scouters = data.scouter.filter((l) => l.pick_round === round);
  const canEditMaster = !!session && (session.is_admin || session.picklist_only);

  return (
    <div className="meeting">
      <div className="page-title">
        <h1>Picklist Meeting</h1>
        <div className="row" style={{ gap: 8 }}>
          <div className="seg">
            <button className={round === 1 ? "on" : ""} onClick={() => setRound(1)}>First pick</button>
            <button className={round === 2 ? "on" : ""} onClick={() => setRound(2)}>Second pick</button>
          </div>
          {saving && <span className="badge muted">Saving</span>}
        </div>
      </div>

      <FinalPicklists teams={teams} />

      <section className="meeting-master card">
        <div className="card-h">
          <h2 style={{ margin: 0 }}>Master list</h2>
          <span className="badge haze">This is the list we pick from</span>
        </div>
        {master ? (
          <PicklistBoard
            key={master.id}
            list={master}
            teams={teams}
            pool={pool}
            canEdit={canEditMaster}
            onChange={(items) => saveMaster(master, items)}
          />
        ) : (
          <p className="faint">No master list yet.</p>
        )}
      </section>

      <section className="meeting-strategy">
        <h2>Strategy lists</h2>
        {strategy.length === 0 ? (
          <p className="faint">No strategy lists for this pick yet.</p>
        ) : (
          <div className="grid cols-2">
            {strategy.map((l) => (
              <ListCard key={l.id} list={l} teams={teams} size="lg" onExpand={setExpanded} />
            ))}
          </div>
        )}
      </section>

      <section className="meeting-scouters">
        <h2>Scouter lists</h2>
        {scouters.length === 0 ? (
          <p className="faint">No scouter lists for this pick yet.</p>
        ) : (
          <div className="scouter-strip">
            {scouters.map((l) => (
              <ListCard key={l.id} list={l} teams={teams} size="sm" onExpand={setExpanded} />
            ))}
          </div>
        )}
      </section>

      {expanded && (
        <ListDetail list={expanded} teams={teams} onClose={() => setExpanded(null)} />
      )}
    </div>
  );
}

function ListCard({
  list,
  teams,
  size,
  onExpand,
}: {
  list: Picklist;
  teams: Record<number, Team>;
  size: "lg" | "sm";
  onExpand?: (list: Picklist) => void;
}) {
  const expandable = !!onExpand && list.items.length > 0;
  return (
    <article
      className={"card tight list-card " + size + (expandable ? " expandable" : "")}
      onClick={expandable ? () => onExpand!(list) : undefined}
      role={expandable ? "button" : undefined}
      tabIndex={expandable ? 0 : undefined}
      onKeyDown={
        expandable
          ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onExpand!(list); } }
          : undefined
      }
    >
      <div className="card-h">
        <h3 style={{ margin: 0 }}>{list.owner_name}</h3>
        <span className="faint" style={{ fontSize: "0.72rem" }}>{timeAgo(list.updated_at)}</span>
      </div>
      {list.items.length === 0 ? (
        <p className="faint" style={{ margin: 0 }}>Empty</p>
      ) : (
        <ol className="list-card-items">
          {list.items.map((it, i) => {
            const note = it.justification ?? it.note ?? "";
            return (
              <li key={it.team}>
                <span className="rank-chip sm">{i + 1}</span>
                <ClickableTeam
                  team={teams[it.team] || { team_number: it.team, nickname: "" }}
                  showNickname={size === "lg"}
                />
                {size === "lg" && note && (
                  <span className="pick-why"><NoteText note={note} team={it.team} /></span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {expandable && <span className="list-card-more faint">Tap for the full list</span>}
    </article>
  );
}

/** One list at readable size, with every rank and every reason. */
function ListDetail({
  list,
  teams,
  onClose,
}: {
  list: Picklist;
  teams: Record<number, Team>;
  onClose: () => void;
}) {
  return (
    <Modal onClose={onClose}>
      <div className="list-detail">
        <div className="card-h">
          <div>
            <h3 style={{ margin: 0 }}>{list.owner_name}</h3>
            <span className="faint" style={{ fontSize: "0.76rem" }}>
              {list.pick_round === 1 ? "First pick" : "Second pick"} · {list.items.length} ranked ·
              updated {timeAgo(list.updated_at)}
            </span>
          </div>
          <button className="btn sm ghost" onClick={onClose}>Close</button>
        </div>
        {list.items.length === 0 ? (
          <p className="faint" style={{ margin: 0 }}>This list is empty.</p>
        ) : (
          <ol className="list-detail-items">
            {list.items.map((it, i) => {
              const note = it.justification ?? it.note ?? "";
              return (
                <li key={it.team}>
                  <span className="rank-chip">{i + 1}</span>
                  <div className="list-detail-body">
                    <ClickableTeam team={teams[it.team] || { team_number: it.team, nickname: "" }} />
                    {note ? (
                      <p className="list-detail-why"><NoteText note={note} team={it.team} /></p>
                    ) : (
                      <p className="list-detail-why faint">No reason written.</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </Modal>
  );
}

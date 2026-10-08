"use client";
// The team's locked-in final pick order, shown at the top of every screen
// where somebody is building a picklist.
//
// Once alliance selection is decided, a scout still tinkering with their own
// list should be able to see what the team actually settled on without going
// to find it. Renders nothing at all until a final list has teams in it, so
// it costs no space for most of the event.
//
// Admin and strategy get edit and clear controls in place, including on the
// picklist meeting screen: the final order changes during selection, when
// the team you wanted has just been taken, and having to leave the meeting
// screen to fix it is how a list goes stale.
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { onBus } from "@/lib/bus";
import type { Picklist, PicklistItem, Team } from "@/lib/types";
import { ClickableTeam } from "@/components/TeamDetailModal";
import { NoteText } from "@/components/MatchRef";
import { PicklistBoard } from "@/components/PicklistBoard";
import { Confirm, Modal } from "@/components/ui";

interface FinalList extends Picklist {
  division: string;
}

const justificationOf = (it: { justification?: string; note?: string }) =>
  it.justification ?? it.note ?? "";

export function FinalPicklists({ teams = {} }: { teams?: Record<number, Team> }) {
  const { session } = useAuth();
  const toast = useToast();
  const [finals, setFinals] = useState<FinalList[]>([]);
  const [extra, setExtra] = useState<Record<number, Team>>({});
  const [pool, setPool] = useState<number[]>([]);
  const [editing, setEditing] = useState<FinalList | null>(null);
  const [clearing, setClearing] = useState<FinalList | null>(null);

  const canManage = !!session?.is_admin;

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

  // The pool of teams to add from is only needed once somebody actually opens
  // the editor, so it is fetched then rather than on every page that shows
  // the final order.
  useEffect(() => {
    if (!editing || pool.length) return;
    api<{ matches: { red: number[]; blue: number[] }[] }>("/api/matches")
      .then((res) => {
        const scheduled = Array.from(new Set(res.matches.flatMap((m) => [...m.red, ...m.blue])));
        const ranked = finals.flatMap((l) => l.items.map((i) => i.team));
        setPool(Array.from(new Set([...scheduled, ...ranked])).sort((a, b) => a - b));
      })
      .catch(() => {});
  }, [editing, pool.length, finals]);

  async function saveFinal(list: FinalList, items: PicklistItem[]) {
    try {
      await api(`/api/picklists/${list.id}`, { method: "PUT", body: { name: list.name, items } });
      await load();
    } catch (e: any) {
      toast(e.message || "Could not save the final list", "err");
    }
  }

  async function clearFinal(list: FinalList) {
    setClearing(null);
    try {
      await api(`/api/picklists/finals/${list.division}?pick_round=${list.pick_round}`, {
        method: "DELETE",
      });
      toast(`Cleared Final ${list.division} ${list.pick_round === 1 ? "first" : "second"} pick`, "ok");
      if (editing?.id === list.id) setEditing(null);
      await load();
    } catch (e: any) {
      toast(e.message || "Could not clear the final list", "err");
    }
  }

  if (!finals.length) return null;

  const lookup = (n: number) => teams[n] || extra[n] || { team_number: n, nickname: "" };

  return (
    <section className="final-picks card" style={{ marginBottom: 16 }}>
      <div className="card-h">
        <h2 style={{ margin: 0, fontSize: "1rem" }}>Final pick order</h2>
        <span className="badge haze">Decided by the team</span>
      </div>


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
                  {justificationOf(it) && (
                    <span className="pick-why"><NoteText note={justificationOf(it)} team={it.team} /></span>
                  )}
                </li>
              ))}
            </ol>
            {canManage && (
              <div className="btn-row" style={{ marginTop: 10 }}>
                <button className="btn sm" onClick={() => setEditing(l)}>Edit</button>
                <button className="btn sm danger" onClick={() => setClearing(l)}>Delete</button>
              </div>
            )}
          </div>
        ))}
      </div>

      {editing && (
        <Modal onClose={() => setEditing(null)}>
          <div className="final-edit">
            <div className="card-h">
              <h3 style={{ margin: 0 }}>
                Final {editing.division} · {editing.pick_round === 1 ? "First pick" : "Second pick"}
              </h3>
              <button className="btn sm ghost" onClick={() => setEditing(null)}>Done</button>
            </div>
            <PicklistBoard
              key={editing.id}
              list={editing}
              teams={{ ...teams, ...extra }}
              pool={pool}
              canEdit
              onChange={(items) => saveFinal(editing, items)}
            />
          </div>
        </Modal>
      )}

      {clearing && (
        <Confirm
          title={`Delete Final ${clearing.division}?`}
          body={
            <>
              This empties the <b>{clearing.division} {clearing.pick_round === 1 ? "first" : "second"} pick</b> list
              for everyone.
            </>
          }
          confirmLabel="Yes, delete it"
          onConfirm={() => clearFinal(clearing)}
          onCancel={() => setClearing(null)}
        />
      )}
    </section>
  );
}

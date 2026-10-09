"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { onBus } from "@/lib/bus";
import { timeAgo } from "@/lib/format";
import type { Picklist, PicklistItem, Team } from "@/lib/types";
import { Loading } from "@/components/ui";
import { PicklistBoard } from "@/components/PicklistBoard";
import { FinalPicklists } from "@/components/FinalPicklists";

export default function PicklistsPage() {
  const { session } = useAuth();
  const toast = useToast();
  const [lists, setLists] = useState<Picklist[]>([]);
  const [round, setRound] = useState<1 | 2>(1);
  const [teams, setTeams] = useState<Record<number, Team>>({});
  const [pool, setPool] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string>("");
  const pendingSave = useRef<any>(null);

  const load = useCallback(async () => {
    try {
      setLists(await api<Picklist[]>("/api/picklists/mine"));
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    return onBus((e) => { if (e === "picklist_changed") load(); });
  }, [load]);

  // The pool is every team that has been scouted at this event, plus anyone
  // already on the list, so a ranked team never vanishes if scouting is thin.
  useEffect(() => {
    (async () => {
      let nums: number[] = [];
      try {
        nums = await api<number[]>("/api/admin/event-teams");
      } catch {
        // Scouters cannot reach the admin route. Fall back to the schedule.
        try {
          const res = await api<{ matches: { red: number[]; blue: number[] }[] }>("/api/matches");
          nums = Array.from(new Set(res.matches.flatMap((m) => [...m.red, ...m.blue])));
        } catch {}
      }
      const ranked = lists.flatMap((l) => l.items.map((i) => i.team));
      const all = Array.from(new Set([...nums, ...ranked])).sort((a, b) => a - b);
      setPool(all);
      if (all.length) {
        try {
          const rows = await api<Team[]>("/api/teams/batch", { method: "POST", body: { teams: all.slice(0, 24) } });
          setTeams((cur) => ({ ...cur, ...Object.fromEntries(rows.map((t) => [t.team_number, t])) }));
          for (let i = 24; i < all.length; i += 24) {
            const more = await api<Team[]>("/api/teams/batch", { method: "POST", body: { teams: all.slice(i, i + 24) } });
            setTeams((cur) => ({ ...cur, ...Object.fromEntries(more.map((t) => [t.team_number, t])) }));
          }
        } catch {}
      }
    })();
  }, [lists]);

  const active = lists.find((l) => l.pick_round === round);

  // Autosave. A picklist meeting moves fast and nobody should lose an edit
  // because they forgot to press a button, but a keystroke per write would be
  // wasteful, so edits are debounced into one save.
  const save = useCallback(
    (list: Picklist, items: PicklistItem[]) => {
      clearTimeout(pendingSave.current);
      pendingSave.current = setTimeout(async () => {
        setSaving(true);
        try {
          const updated = await api<Picklist>(`/api/picklists/${list.id}`, {
            method: "PUT",
            body: { name: list.name, items },
          });
          setLists((cur) => cur.map((l) => (l.id === updated.id ? updated : l)));
          setSavedAt(new Date().toISOString());
        } catch (e: any) {
          toast(e.message || "Could not save", "err");
        } finally {
          setSaving(false);
        }
      }, 700);
    },
    [toast]
  );

  if (loading) return <Loading />;

  return (
    <div>
      <div className="page-title"><h1>Picklists</h1></div>


      <FinalPicklists teams={teams} />

      <div className="row" style={{ gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <div className="seg">
          <button className={round === 1 ? "on" : ""} onClick={() => setRound(1)}>First pick</button>
          <button className={round === 2 ? "on" : ""} onClick={() => setRound(2)}>Second pick</button>
        </div>
        <span className="badge muted">
          {saving ? "Saving" : savedAt ? `Saved ${timeAgo(savedAt)}` : "Changes save automatically"}
        </span>
      </div>

      {active && (
        <PicklistBoard
          key={active.id}
          list={active}
          teams={teams}
          pool={pool}
          canEdit={active.owner_id === session?.scout_id || !!session}
          onChange={(items) => save(active, items)}
        />
      )}
    </div>
  );
}

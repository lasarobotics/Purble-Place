"use client";
import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { onBus } from "@/lib/bus";
import { timeAgo } from "@/lib/format";
import type { Picklist, PicklistItem, Team } from "@/lib/types";
import { Loading, Empty, TeamIdentity } from "@/components/ui";

const PICKLIST_PASSWORD = "PickListSTRAT";
const toSlots = (items: PicklistItem[]) => {
  const slots = items.map((it) => String(it.team || ""));
  while (slots.length < 4) slots.push("");
  return slots;
};
const toItems = (slots: string[]): PicklistItem[] =>
  slots
    .map((slot) => parseInt(slot.replace(/[^0-9]/g, ""), 10))
    .filter((team, index, all) => team && all.indexOf(team) === index)
    .map((team) => ({ team, tier: "first" }));

export default function PicklistsPage() {
  const { session } = useAuth();
  const toast = useToast();
  const [mine, setMine] = useState<Picklist[]>([]);
  const [active, setActive] = useState<Picklist | null>(null);
  const [loading, setLoading] = useState(true);
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState("");

  const load = useCallback(async () => {
    try {
      const list = await api<Picklist[]>("/api/picklists/mine");
      setMine(list);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    setUnlocked(sessionStorage.getItem("hazehub.picklist.unlocked") === "1");
  }, []);

  useEffect(() => {
    load();
    return onBus((e) => { if (e === "picklist_changed") load(); });
  }, [load]);

  useEffect(() => {
    setActive((cur) => cur || mine[0] || null);
  }, [mine]);

  async function createList() {
    const name = prompt("Name your picklist:", "My Picklist");
    if (!name) return;
    const p = await api<Picklist>("/api/picklists", { method: "POST", body: { name, items: [] } });
    toast("Picklist created", "ok");
    setMine((x) => [...x, p]);
    setActive(p);
  }

  async function send(p: Picklist) {
    try {
      const updated = await api<Picklist>(`/api/picklists/${p.id}`, { method: "PUT", body: { name: p.name, items: p.items } });
      toast("Picklist sent", "ok");
      setMine((x) => x.map((m) => (m.id === updated.id ? updated : m)));
      setActive(updated);
    } catch (e: any) { toast(e.message || "Send failed", "err"); }
  }

  async function remove(p: Picklist) {
    if (!confirm(`Delete "${p.name}"?`)) return;
    await api(`/api/picklists/${p.id}`, { method: "DELETE" });
    setMine((x) => x.filter((m) => m.id !== p.id));
    setActive(null);
    toast("Deleted", "ok");
  }

  if (loading) return <Loading />;
  if (!unlocked) {
    return (
      <div>
        <div className="page-title"><h1>📝 Picklists</h1></div>
        <div className="card" style={{ maxWidth: 420 }}>
          <h3>Picklist Password</h3>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && password === PICKLIST_PASSWORD) {
                  sessionStorage.setItem("hazehub.picklist.unlocked", "1");
                  setUnlocked(true);
                }
              }}
            />
          </label>
          <button
            className="btn primary block"
            onClick={() => {
              if (password !== PICKLIST_PASSWORD) return toast("Incorrect picklist password", "err");
              sessionStorage.setItem("hazehub.picklist.unlocked", "1");
              setUnlocked(true);
            }}
          >
            Unlock Picklists
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-title"><h1>📝 Picklists</h1></div>
      <p className="page-sub">Create a strategy list, fill the four default team slots, add more teams if needed, then send it to admin.</p>

      <div className="row" style={{ gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        {mine.map((p) => (
          <button key={p.id} className={"chip" + (active?.id === p.id ? " on" : "")} onClick={() => setActive(p)}>{p.name}</button>
        ))}
        <button className="btn sm primary" onClick={createList}>+ Create Picklist</button>
      </div>

      {active ? (
        <Editor key={active.id} list={active} canEdit={active.owner_id === session?.scout_id || !!session?.is_admin} onSend={send} onDelete={!active.is_master ? remove : undefined} />
      ) : (
        <Empty icon="📋" title="No picklists yet" sub="Create one to start ranking teams." />
      )}
    </div>
  );
}

function Editor({ list, canEdit, onSend, onDelete }: { list: Picklist; canEdit: boolean; onSend: (p: Picklist) => void; onDelete?: (p: Picklist) => void }) {
  const [slots, setSlots] = useState<string[]>(() => toSlots(list.items || []));
  const [teams, setTeams] = useState<Record<number, Team>>({});
  const [dirty, setDirty] = useState(false);

  useEffect(() => { setSlots(toSlots(list.items || [])); setDirty(false); }, [list.id, list.updated_at]);
  useEffect(() => {
    const nums = Array.from(new Set(slots.map((slot) => parseInt(slot.replace(/[^0-9]/g, ""), 10)))).filter((n) => n && !teams[n]);
    if (!nums.length) return;
    api<Team[]>("/api/teams/batch", { method: "POST", body: { teams: nums } })
      .then((rows) => setTeams((cur) => ({ ...cur, ...Object.fromEntries(rows.map((t) => [t.team_number, t])) })))
      .catch(() => {});
  }, [slots, teams]);

  const upd = (next: string[]) => { setSlots(next); setDirty(true); };
  const sentItems = toItems(slots);

  return (
    <div className="card">
      <div className="card-h">
        <div>
          <h3 style={{ margin: 0 }}>{list.name} {list.is_master && <span className="badge haze">master</span>}</h3>
          <div className="faint" style={{ fontSize: "0.75rem" }}>by {list.owner_name} · updated {timeAgo(list.updated_at)}</div>
        </div>
        <div className="btn-row">
          {onDelete && canEdit && <button className="btn sm danger" onClick={() => onDelete(list)}>Delete</button>}
          {canEdit && <button className="btn sm primary" onClick={() => onSend({ ...list, items: sentItems })}>{dirty ? "Send Picklist" : "Send Picklist Again"}</button>}
        </div>
      </div>

      <div className="grid" style={{ gap: 8 }}>
        {slots.map((slot, i) => {
          const n = parseInt(slot.replace(/[^0-9]/g, ""), 10);
          return (
            <div key={i} className="card tight pick-slot">
              <span className="rank-chip">{i + 1}</span>
              {n ? <TeamIdentity team={teams[n] || { team_number: n, nickname: "" }} /> : <span className="faint">Blank team slot</span>}
              {canEdit && (
                <input
                  value={slot}
                  onChange={(e) => upd(slots.map((x, k) => k === i ? e.target.value : x))}
                  placeholder="Team number"
                  inputMode="numeric"
                />
              )}
              {canEdit && slots.length > 4 && (
                <button className="btn sm ghost" onClick={() => upd(slots.filter((_, k) => k !== i))}>Remove</button>
              )}
            </div>
          );
        })}
      </div>
      {canEdit && <button className="btn" style={{ marginTop: 12 }} onClick={() => upd([...slots, ""])}>+ Add Team</button>}
      <p className="faint" style={{ fontSize: "0.75rem" }}>{sentItems.length} teams will be sent. You can send this picklist again after edits.</p>
    </div>
  );
}

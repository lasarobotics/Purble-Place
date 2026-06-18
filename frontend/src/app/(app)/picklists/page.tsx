"use client";
import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { onBus } from "@/lib/bus";
import { timeAgo } from "@/lib/format";
import type { Picklist, PicklistItem, Team } from "@/lib/types";
import { Loading, Empty, TeamIdentity } from "@/components/ui";

const TIERS: { value: PicklistItem["tier"]; label: string; cls: string }[] = [
  { value: "first", label: "1st pick", cls: "green" },
  { value: "second", label: "2nd pick", cls: "haze" },
  { value: "third", label: "Bench", cls: "blue" },
  { value: "dnp", label: "Do Not Pick", cls: "red" },
];

export default function PicklistsPage() {
  const { session } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<"master" | "mine">("master");
  const [master, setMaster] = useState<Picklist | null>(null);
  const [mine, setMine] = useState<Picklist[]>([]);
  const [active, setActive] = useState<Picklist | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [m, list] = await Promise.all([
        api<Picklist>("/api/picklists/master"),
        api<Picklist[]>("/api/picklists/mine"),
      ]);
      setMaster(m);
      setMine(list);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    return onBus((e) => { if (e === "picklist_changed") load(); });
  }, [load]);

  useEffect(() => {
    if (tab === "master") setActive(master);
    else setActive(mine[0] || null);
  }, [tab, master, mine]);

  async function createList() {
    const name = prompt("Name your picklist:", "My Picklist");
    if (!name) return;
    const p = await api<Picklist>("/api/picklists", { method: "POST", body: { name, items: [] } });
    toast("Picklist created", "ok");
    setMine((x) => [...x, p]);
    setTab("mine");
    setActive(p);
  }

  async function save(p: Picklist) {
    try {
      const updated = await api<Picklist>(`/api/picklists/${p.id}`, { method: "PUT", body: { name: p.name, items: p.items } });
      toast("Saved", "ok");
      if (updated.is_master) setMaster(updated);
      else setMine((x) => x.map((m) => (m.id === updated.id ? updated : m)));
      setActive(updated);
    } catch (e: any) { toast(e.message || "Save failed", "err"); }
  }

  async function remove(p: Picklist) {
    if (!confirm(`Delete "${p.name}"?`)) return;
    await api(`/api/picklists/${p.id}`, { method: "DELETE" });
    setMine((x) => x.filter((m) => m.id !== p.id));
    setActive(null);
    toast("Deleted", "ok");
  }

  if (loading) return <Loading />;

  return (
    <div>
      <div className="page-title"><h1>📝 Picklists</h1></div>
      <p className="page-sub">Build the collaborative master list together, or draft your own — everyone can follow along.</p>

      <div className="seg" style={{ marginBottom: 16 }}>
        <button className={tab === "master" ? "on" : ""} onClick={() => setTab("master")}>🤝 Master (collaborative)</button>
        <button className={tab === "mine" ? "on" : ""} onClick={() => setTab("mine")}>👤 Mine ({mine.length})</button>
      </div>

      {tab === "mine" && (
        <div className="row" style={{ gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
          {mine.map((p) => (
            <button key={p.id} className={"chip" + (active?.id === p.id ? " on" : "")} onClick={() => setActive(p)}>{p.name}</button>
          ))}
          <button className="btn sm" onClick={createList}>+ New list</button>
        </div>
      )}

      {active ? (
        <Editor key={active.id} list={active} canEdit={active.is_master || active.owner_id === session?.scout_id || !!session?.is_admin} onSave={save} onDelete={!active.is_master ? remove : undefined} />
      ) : (
        <Empty icon="📋" title={tab === "mine" ? "No personal lists yet" : "Master list unavailable"} sub={tab === "mine" ? "Create one to start ranking." : undefined} />
      )}
    </div>
  );
}

function Editor({ list, canEdit, onSave, onDelete }: { list: Picklist; canEdit: boolean; onSave: (p: Picklist) => void; onDelete?: (p: Picklist) => void }) {
  const [items, setItems] = useState<PicklistItem[]>(list.items || []);
  const [teams, setTeams] = useState<Record<number, Team>>({});
  const [team, setTeam] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => { setItems(list.items || []); setDirty(false); }, [list.id, list.updated_at]);
  useEffect(() => {
    const nums = Array.from(new Set(items.map((it) => it.team))).filter((n) => n && !teams[n]);
    if (!nums.length) return;
    api<Team[]>("/api/teams/batch", { method: "POST", body: { teams: nums } })
      .then((rows) => setTeams((cur) => ({ ...cur, ...Object.fromEntries(rows.map((t) => [t.team_number, t])) })))
      .catch(() => {});
  }, [items, teams]);

  const upd = (next: PicklistItem[]) => { setItems(next); setDirty(true); };
  const add = () => {
    const n = parseInt(team.replace(/[^0-9]/g, ""), 10);
    if (!n) return;
    if (items.some((i) => i.team === n)) return;
    upd([...items, { team: n, tier: "first", note: "" }]);
    setTeam("");
  };
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    upd(next);
  };

  return (
    <div className="card">
      <div className="card-h">
        <div>
          <h3 style={{ margin: 0 }}>{list.name} {list.is_master && <span className="badge haze">master</span>}</h3>
          <div className="faint" style={{ fontSize: "0.75rem" }}>by {list.owner_name} · updated {timeAgo(list.updated_at)}</div>
        </div>
        <div className="btn-row">
          {onDelete && canEdit && <button className="btn sm danger" onClick={() => onDelete(list)}>Delete</button>}
          {canEdit && <button className="btn sm primary" disabled={!dirty} onClick={() => onSave({ ...list, items })}>{dirty ? "Save" : "Saved"}</button>}
        </div>
      </div>

      {canEdit && (
        <div className="row" style={{ gap: 8, marginBottom: 14 }}>
          <input value={team} onChange={(e) => setTeam(e.target.value)} placeholder="Add team #" style={{ maxWidth: 160 }} onKeyDown={(e) => e.key === "Enter" && add()} />
          <button className="btn" onClick={add}>+ Add</button>
        </div>
      )}

      {items.length === 0 ? <Empty icon="🤖" title="No teams ranked yet" /> : (
        <div className="grid" style={{ gap: 8 }}>
          {items.map((it, i) => (
            <div key={it.team} className="card tight" style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <span className="rank-chip">{i + 1}</span>
              <TeamIdentity team={teams[it.team] || { team_number: it.team, nickname: "" }} />
              {canEdit ? (
                <>
                  <select value={it.tier} onChange={(e) => upd(items.map((x, k) => k === i ? { ...x, tier: e.target.value as any } : x))} style={{ width: "auto" }}>
                    {TIERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                  <input value={it.note || ""} onChange={(e) => upd(items.map((x, k) => k === i ? { ...x, note: e.target.value } : x))} placeholder="note…" style={{ flex: 1, minWidth: 100 }} />
                  <div className="row" style={{ gap: 4 }}>
                    <button className="btn sm ghost" onClick={() => move(i, -1)}>↑</button>
                    <button className="btn sm ghost" onClick={() => move(i, 1)}>↓</button>
                    <button className="btn sm ghost" onClick={() => upd(items.filter((_, k) => k !== i))}>✕</button>
                  </div>
                </>
              ) : (
                <>
                  <span className={`badge ${TIERS.find((t) => t.value === it.tier)?.cls}`}>{TIERS.find((t) => t.value === it.tier)?.label}</span>
                  {it.note && <span className="muted" style={{ fontSize: "0.85rem" }}>{it.note}</span>}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

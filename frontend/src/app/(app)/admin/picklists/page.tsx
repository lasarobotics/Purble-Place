"use client";
import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { onBus } from "@/lib/bus";
import { timeAgo } from "@/lib/format";
import { useToast } from "@/lib/toast";
import type { Picklist, PicklistItem, Team } from "@/lib/types";
import { Loading, Empty } from "@/components/ui";
import { ClickableTeam } from "@/components/TeamDetailModal";

const TIER_CLS: Record<string, string> = { first: "green", second: "haze", third: "blue", dnp: "red" };
const TIER_LABEL: Record<string, string> = { first: "1st", second: "2nd", third: "Bench", dnp: "DNP" };
const PICKLIST_PASSWORD = "PickListSTRAT";
const FINAL_DIVISIONS = ["418", "436"] as const;

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
const isFinalList = (p: Picklist) => p.owner_id === "final-418" || p.owner_id === "final-436";
const finalDivision = (p: Picklist) => p.owner_id.replace("final-", "");

export default function AllPicklistsPage() {
  const toast = useToast();
  const [lists, setLists] = useState<Picklist[]>([]);
  const [teams, setTeams] = useState<Record<number, Team>>({});
  const [loading, setLoading] = useState(true);
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState("");
  const [active, setActive] = useState<Picklist | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = await api<Picklist[]>("/api/picklists/all");
      setLists(rows);
      setActive((cur) => cur ? rows.find((p) => p.id === cur.id) || cur : rows.find(isFinalList) || null);
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
    const nums = Array.from(new Set(lists.flatMap((list) => list.items.map((it) => it.team)))).filter((n) => n && !teams[n]);
    if (!nums.length) return;
    api<Team[]>("/api/teams/batch", { method: "POST", body: { teams: nums } })
      .then((rows) => setTeams((cur) => ({ ...cur, ...Object.fromEntries(rows.map((t) => [t.team_number, t])) })))
      .catch(() => {});
  }, [lists, teams]);

  async function makeFinal(division: "418" | "436", source?: Picklist) {
    try {
      const updated = await api<Picklist>(`/api/picklists/finals/${division}`, {
        method: "POST",
        body: source ? { source_id: source.id } : { name: `Final Picklist ${division}`, items: [] },
      });
      toast(source ? `Set ${source.name} as final ${division}` : `Created final ${division}`, "ok");
      setLists((cur) => [updated, ...cur.filter((p) => p.id !== updated.id)]);
      setActive(updated);
      load();
    } catch (e: any) {
      toast(e.message || "Could not update final picklist", "err");
    }
  }

  async function saveMaster(p: Picklist) {
    try {
      const updated = await api<Picklist>(`/api/picklists/${p.id}`, { method: "PUT", body: { name: p.name, items: p.items } });
      toast("Master picklist saved", "ok");
      setLists((cur) => cur.map((x) => x.id === updated.id ? updated : x));
      setActive(updated);
    } catch (e: any) {
      toast(e.message || "Save failed", "err");
    }
  }

  if (loading) return <Loading />;
  if (!unlocked) {
    return (
      <div>
        <div className="page-title"><h1>All Pick Lists</h1></div>
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
              if (password !== PICKLIST_PASSWORD) return;
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

  const visible = lists.filter((p) => p.items.length > 0 || p.is_master);
  const masterLists = visible.filter((p) => p.is_master);

  return (
    <div>
      <div className="page-title">
        <h1>All Pick Lists</h1>
        <span className="badge muted">{visible.length} lists</span>
      </div>
      <p className="page-sub">Review submitted lists, choose a final list for 418 or 436, or build a new final list from scratch.</p>

      <div className="card tight" style={{ marginBottom: 14 }}>
        <div className="card-h">
          <div>
            <h3 style={{ margin: 0 }}>Master Finals</h3>
            <div className="faint" style={{ fontSize: "0.78rem" }}>Final lists are saved as master picklists for the selected group.</div>
          </div>
          <div className="btn-row">
            {FINAL_DIVISIONS.map((division) => (
              <button key={division} className="btn sm primary" onClick={() => makeFinal(division)}>New Final {division}</button>
            ))}
          </div>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {masterLists.map((p) => (
            <button key={p.id} className={"chip" + (active?.id === p.id ? " on" : "")} onClick={() => setActive(p)}>
              {p.name}{isFinalList(p) ? ` (${finalDivision(p)})` : ""}
            </button>
          ))}
        </div>
      </div>

      {active && active.is_master && (
        <MasterEditor key={`${active.id}-${active.updated_at}`} list={active} onSave={saveMaster} />
      )}

      {visible.length === 0 ? <Empty icon="List" title="No sent picklists yet" /> : (
        <div className="grid auto" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px,1fr))", marginTop: 14 }}>
          {visible.map((p) => (
            <div key={p.id} className="card tight" style={p.is_master ? { borderColor: "var(--haze-glow)" } : {}}>
              <div className="card-h">
                <div>
                  <h3 style={{ fontSize: "1rem", margin: 0 }}>
                    {p.name} {p.is_master && <span className="badge haze">{isFinalList(p) ? `final ${finalDivision(p)}` : "master"}</span>}
                  </h3>
                  <div className="faint" style={{ fontSize: "0.72rem" }}>{p.owner_name} · {timeAgo(p.updated_at)}</div>
                </div>
                <span className="badge muted">{p.items.length}</span>
              </div>
              {p.items.length === 0 ? <p className="faint" style={{ fontSize: "0.8rem" }}>Empty</p> : (
                <ol style={{ margin: 0, paddingLeft: 22, display: "grid", gap: 6 }}>
                  {p.items.slice(0, 12).map((it) => (
                    <li key={it.team}>
                      <span className="row" style={{ gap: 8 }}>
                        <ClickableTeam team={teams[it.team] || { team_number: it.team, nickname: "" }} showNickname={false} />
                        <span className={`badge ${TIER_CLS[it.tier] || "muted"}`}>{TIER_LABEL[it.tier] || it.tier}</span>
                        {it.note && <span className="faint" style={{ fontSize: "0.75rem" }}>{it.note}</span>}
                      </span>
                    </li>
                  ))}
                  {p.items.length > 12 && <li className="faint">+{p.items.length - 12} more...</li>}
                </ol>
              )}
              <div className="btn-row" style={{ marginTop: 12 }}>
                {FINAL_DIVISIONS.map((division) => (
                  <button key={division} className="btn sm" onClick={() => makeFinal(division, p)}>Final {division}</button>
                ))}
                {p.is_master && <button className="btn sm ghost" onClick={() => setActive(p)}>Edit</button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MasterEditor({ list, onSave }: { list: Picklist; onSave: (p: Picklist) => void }) {
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
          <h3 style={{ margin: 0 }}>{list.name} {isFinalList(list) && <span className="badge haze">final {finalDivision(list)}</span>}</h3>
          <div className="faint" style={{ fontSize: "0.75rem" }}>updated {timeAgo(list.updated_at)}</div>
        </div>
        <button className="btn sm primary" onClick={() => onSave({ ...list, items: sentItems })}>
          {dirty ? "Save Final" : "Save Again"}
        </button>
      </div>

      <div className="grid" style={{ gap: 8 }}>
        {slots.map((slot, i) => {
          const n = parseInt(slot.replace(/[^0-9]/g, ""), 10);
          return (
            <div key={i} className="card tight pick-slot">
              <span className="rank-chip">{i + 1}</span>
              {n ? <ClickableTeam team={teams[n] || { team_number: n, nickname: "" }} /> : <span className="faint">Blank team slot</span>}
              <input
                value={slot}
                onChange={(e) => upd(slots.map((x, k) => k === i ? e.target.value : x))}
                placeholder="Team number"
                inputMode="numeric"
              />
              {slots.length > 4 && (
                <button className="btn sm ghost" onClick={() => upd(slots.filter((_, k) => k !== i))}>Remove</button>
              )}
            </div>
          );
        })}
      </div>
      <button className="btn" style={{ marginTop: 12 }} onClick={() => upd([...slots, ""])}>+ Add Team</button>
      <p className="faint" style={{ fontSize: "0.75rem" }}>{sentItems.length} teams will be saved in this master list.</p>
    </div>
  );
}

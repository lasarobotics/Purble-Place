"use client";
import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { onBus } from "@/lib/bus";
import { timeAgo } from "@/lib/format";
import type { Picklist, Team } from "@/lib/types";
import { Loading, Empty, TeamIdentity } from "@/components/ui";

const TIER_CLS: Record<string, string> = { first: "green", second: "haze", third: "blue", dnp: "red" };
const TIER_LABEL: Record<string, string> = { first: "1st", second: "2nd", third: "Bench", dnp: "DNP" };
const PICKLIST_PASSWORD = "PickListSTRAT";

export default function AllPicklistsPage() {
  const [lists, setLists] = useState<Picklist[]>([]);
  const [teams, setTeams] = useState<Record<number, Team>>({});
  const [loading, setLoading] = useState(true);
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState("");

  const load = useCallback(async () => {
    try { setLists(await api<Picklist[]>("/api/picklists/all")); } catch {}
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

  if (loading) return <Loading />;
  if (!unlocked) {
    return (
      <div>
        <div className="page-title"><h1>🗂️ All Pick Lists</h1></div>
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

  return (
    <div>
      <div className="page-title"><h1>🗂️ All Pick Lists</h1>
        <span className="badge muted">{lists.length} lists</span>
      </div>
      <p className="page-sub">Every picklist made across the team — follow each scout's strategy in one place.</p>

      {lists.filter((p) => p.items.length > 0 || p.is_master).length === 0 ? <Empty icon="🗂️" title="No sent picklists yet" /> : (
        <div className="grid auto" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px,1fr))" }}>
          {lists.filter((p) => p.items.length > 0 || p.is_master).map((p) => (
            <div key={p.id} className="card tight" style={p.is_master ? { borderColor: "var(--haze-glow)" } : {}}>
              <div className="card-h">
                <div>
                  <h3 style={{ fontSize: "1rem", margin: 0 }}>{p.name} {p.is_master && <span className="badge haze">master</span>}</h3>
                  <div className="faint" style={{ fontSize: "0.72rem" }}>{p.owner_name} · {timeAgo(p.updated_at)}</div>
                </div>
                <span className="badge muted">{p.items.length}</span>
              </div>
              {p.items.length === 0 ? <p className="faint" style={{ fontSize: "0.8rem" }}>Empty</p> : (
                <ol style={{ margin: 0, paddingLeft: 22, display: "grid", gap: 6 }}>
                  {p.items.slice(0, 12).map((it) => (
                    <li key={it.team}>
                      <span className="row" style={{ gap: 8 }}>
                        <TeamIdentity team={teams[it.team] || { team_number: it.team, nickname: "" }} showNickname={false} />
                        <span className={`badge ${TIER_CLS[it.tier] || "muted"}`}>{TIER_LABEL[it.tier] || it.tier}</span>
                        {it.note && <span className="faint" style={{ fontSize: "0.75rem" }}>{it.note}</span>}
                      </span>
                    </li>
                  ))}
                  {p.items.length > 12 && <li className="faint">+{p.items.length - 12} more…</li>}
                </ol>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

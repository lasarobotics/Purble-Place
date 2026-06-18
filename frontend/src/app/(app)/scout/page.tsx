"use client";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { queueScout, uuid } from "@/lib/db";
import { flushQueue } from "@/lib/sync";
import type { HeatPoint, MatchRec, ScoutEntry } from "@/lib/types";
import { FieldInput } from "@/components/Field";
import { Segmented, Stepper, Rating, TeamIdentity } from "@/components/ui";
import { matchLabel } from "@/lib/format";

const STATION_KEY = "hazehub.station";
const CLIMB_OPTS = [
  { value: "none", label: "None" },
  { value: "l1", label: "L1" },
  { value: "l2", label: "L2" },
  { value: "l3", label: "L3" },
];

const blank = (): ScoutEntry => ({
  match_number: 1,
  comp_level: "qm",
  team_number: 0,
  alliance: "red",
  station: 1,
  auto_leave: false,
  auto_climb: false,
  heatmap: [],
  climb: "none",
  played_defense: false,
  defense_rating: 0,
  defense_on: "",
  successful_stops: 0,
  driver_skill: 3,
  speed_rating: 3,
  fouls: 0,
  failure: false,
  failure_details: "",
  notes: "",
});

export default function ScoutPage() {
  const toast = useToast();
  const { session } = useAuth();
  const [f, setF] = useState<ScoutEntry>(blank());
  const [matches, setMatches] = useState<MatchRec[]>([]);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof ScoutEntry>(k: K, v: ScoutEntry[K]) => setF((p) => ({ ...p, [k]: v }));

  // Restore remembered alliance/station, then refine from the server.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STATION_KEY) || "null");
      if (saved) setF((p) => ({ ...p, alliance: saved.alliance, station: saved.station }));
    } catch {}
    api<{ alliance: "red" | "blue"; station: number }>("/api/scout/last-assignment")
      .then((a) => setF((p) => ({ ...p, alliance: a.alliance, station: a.station })))
      .catch(() => {});
    api<{ matches: MatchRec[] }>("/api/matches?include_teams=true").then((r) => setMatches(r.matches)).catch(() => {});
  }, []);

  const points = useMemo(() => f.points ?? 0, [f]);

  const scheduledTeam = useMemo(() => {
    const m = matches.find((x) => x.comp_level === "qm" && x.match_number === f.match_number);
    if (!m) return 0;
    const arr = f.alliance === "red" ? m.red : m.blue;
    return arr[f.station - 1] || 0;
  }, [matches, f.match_number, f.alliance, f.station]);

  const scheduledTeamProfile = useMemo(() => {
    if (!scheduledTeam) return null;
    const m = matches.find((x) => x.comp_level === "qm" && x.match_number === f.match_number);
    const teams = f.alliance === "red" ? m?.red_teams : m?.blue_teams;
    return teams?.find((t) => t.team_number === scheduledTeam) || { team_number: scheduledTeam, nickname: "" };
  }, [matches, f.match_number, f.alliance, scheduledTeam]);

  function autofillTeam() {
    if (scheduledTeam) {
      set("team_number", scheduledTeam);
      toast(`Team ${scheduledTeam} from the schedule`, "ok");
    } else {
      toast("No schedule loaded for that station", "err");
    }
  }

  function rememberStation(alliance: "red" | "blue", station: number) {
    localStorage.setItem(STATION_KEY, JSON.stringify({ alliance, station }));
  }

  async function submit() {
    if (!f.team_number) return toast("Enter or pull the team number", "err");
    setBusy(true);
    const entry: ScoutEntry = { ...f, client_uuid: uuid() };
    rememberStation(f.alliance, f.station);
    try {
      const res = await api<{ entry: ScoutEntry }>("/api/scout", { method: "POST", body: entry });
      toast(`Saved team ${f.team_number} · ${res.entry.points} pts`, "ok");
      resetForNext();
    } catch (err: any) {
      // Offline or server error → keep it locally and sync later.
      await queueScout({ ...entry, client_uuid: entry.client_uuid!, queued_at: Date.now() });
      toast("Saved offline — will sync when connected", "info");
      resetForNext();
      flushQueue();
    } finally {
      setBusy(false);
    }
  }

  function resetForNext() {
    setF((p) => ({
      ...blank(),
      alliance: p.alliance,
      station: p.station,
      comp_level: p.comp_level,
      match_number: p.match_number + 1,
    }));
  }

  return (
    <div>
      <div className="page-title">
        <h1>📋 Match Scouting</h1>
        <span className="badge haze">{session?.display_name}</span>
      </div>
      <p className="page-sub">Tap the field to log scoring. Your alliance & station are remembered between matches.</p>

      {/* Assignment */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-h"><h3>Assignment</h3>
          {scheduledTeamProfile ? <TeamIdentity team={scheduledTeamProfile} /> : <span className="badge muted">no schedule</span>}
        </div>
        <div className="inline-fields">
          <label className="field" style={{ margin: 0 }}>
            <span>Match #</span>
            <input type="number" value={f.match_number} onChange={(e) => set("match_number", parseInt(e.target.value || "0", 10))} />
          </label>
          <div className="field" style={{ margin: 0 }}>
            <span>Alliance</span>
            <Segmented
              options={[{ value: "red", label: "Red" }, { value: "blue", label: "Blue" }]}
              value={f.alliance}
              onChange={(v) => { set("alliance", v); rememberStation(v, f.station); }}
              color={(v) => (v as any)}
            />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <span>Station</span>
            <Segmented
              options={[{ value: "1", label: "1" }, { value: "2", label: "2" }, { value: "3", label: "3" }]}
              value={String(f.station)}
              onChange={(v) => { const s = parseInt(v, 10); set("station", s); rememberStation(f.alliance, s); }}
            />
          </div>
          <label className="field" style={{ margin: 0 }}>
            <span>Team #</span>
            <input type="number" value={f.team_number || ""} onChange={(e) => set("team_number", parseInt(e.target.value || "0", 10))} placeholder="0000" />
          </label>
          <div className="field" style={{ margin: 0, display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
            <span>&nbsp;</span>
            <button className="btn" type="button" onClick={autofillTeam}>⤵ Pull from schedule</button>
          </div>
        </div>
      </div>

      <div className="grid cols-2">
        {/* Field + auto */}
        <div className="card">
          <div className="card-h"><h3>Scoring Map</h3><span className="badge haze">{points} pts</span></div>
          <FieldInput points={f.heatmap} onChange={(pts: HeatPoint[]) => set("heatmap", pts)} />
          <div className="divider" />
          <div className="row" style={{ gap: 10 }}>
            <label className={"pill-check" + (f.auto_leave ? " on" : "")}>
              <input type="checkbox" checked={f.auto_leave} onChange={(e) => set("auto_leave", e.target.checked)} /> Auto Leave
            </label>
            <label className={"pill-check" + (f.auto_climb ? " on" : "")}>
              <input type="checkbox" checked={f.auto_climb} onChange={(e) => set("auto_climb", e.target.checked)} /> Auto Climb
            </label>
          </div>
        </div>

        {/* Qualitative + endgame */}
        <div className="card">
          <h3>Teleop & Endgame</h3>
          <label className={"pill-check" + (f.played_defense ? " on" : "")} style={{ marginBottom: 12 }}>
            <input type="checkbox" checked={f.played_defense} onChange={(e) => set("played_defense", e.target.checked)} /> Played Defense
          </label>
          {f.played_defense && (
            <div style={{ marginBottom: 12 }}>
              <span className="muted" style={{ fontSize: "0.8rem" }}>Defense quality</span>
              <div style={{ marginTop: 6 }}><Rating value={f.defense_rating} onChange={(v) => set("defense_rating", v)} /></div>
              <label className="field" style={{ marginTop: 10 }}>
                <span>Teams they defended</span>
                <input value={f.defense_on} onChange={(e) => set("defense_on", e.target.value)} placeholder="e.g. 254, 1678" />
              </label>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="muted" style={{ fontSize: "0.8rem" }}>Successful stops</span>
                <Stepper value={f.successful_stops} onChange={(v) => set("successful_stops", v)} />
              </div>
            </div>
          )}
          <div className="divider" />
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
            <span className="muted" style={{ fontSize: "0.85rem" }}>Driver skill</span>
            <Rating value={f.driver_skill} onChange={(v) => set("driver_skill", v)} />
          </div>
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
            <span className="muted" style={{ fontSize: "0.85rem" }}>Speed / cycling</span>
            <Rating value={f.speed_rating} onChange={(v) => set("speed_rating", v)} />
          </div>
          <label className="field">
            <span>Endgame climb</span>
            <select value={f.climb} onChange={(e) => set("climb", e.target.value)}>
              {CLIMB_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        </div>
      </div>

      {/* Errors + notes */}
      <div className="card" style={{ marginTop: 16 }}>
        <h3>Errors & Notes</h3>
        <div className="inline-fields" style={{ alignItems: "center" }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="muted">Fouls</span>
            <Stepper value={f.fouls} onChange={(v) => set("fouls", v)} />
          </div>
          <label className={"pill-check" + (f.failure ? " on" : "")}>
            <input type="checkbox" checked={f.failure} onChange={(e) => set("failure", e.target.checked)} /> Robot failure / died
          </label>
        </div>
        {f.failure && (
          <label className="field" style={{ marginTop: 12 }}>
            <span>What failed?</span>
            <input value={f.failure_details} onChange={(e) => set("failure_details", e.target.value)} placeholder="e.g. lost comms, drivetrain" />
          </label>
        )}
        <label className="field" style={{ marginTop: 12 }}>
          <span>Notes (qualitative insight)</span>
          <textarea value={f.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Strategy, partner compatibility, what numbers miss…" />
        </label>
      </div>

      <div className="btn-row" style={{ marginTop: 18, justifyContent: "flex-end" }}>
        <button className="btn ghost" type="button" onClick={() => setF(blank())}>Reset</button>
        <button className="btn primary" type="button" onClick={submit} disabled={busy}>
          {busy ? "Saving…" : `Submit ${matchLabel(f.comp_level, f.match_number)} →`}
        </button>
      </div>
    </div>
  );
}

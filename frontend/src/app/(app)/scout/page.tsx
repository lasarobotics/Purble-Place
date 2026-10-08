"use client";
import { useEffect, useMemo, useState, useRef } from "react";
import { HotkeySettings } from "@/components/HotkeySettings";
import { DEFAULT_HOTKEYS, Hotkeys, validHotkeys, ignoreHotkey } from "@/lib/hotkeys";
import { localOwner } from "@/lib/identity";
import { emitBus } from "@/lib/bus";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { db, queueScout, uuid, pendingScouts, legacyScouts, PendingScout } from "@/lib/db";
import { flushQueue } from "@/lib/sync";
import type { HeatPoint, MatchRec, ScoutEntry } from "@/lib/types";
import { FieldInput } from "@/components/Field";
import { Segmented, Stepper, Rating, TeamIdentity } from "@/components/ui";
import { matchLabel } from "@/lib/format";

const STATION_KEY = "hazehub.station";

// Structured qualitative tags — one tap each, aggregated per team so picklist
// meetings see *what kind* of robot this is (TideScout-style qual insights).
const QUICK_TAGS: { tag: string; tone: "good" | "bad" }[] = [
  { tag: "Fast cycles", tone: "good" },
  { tag: "Strong auto", tone: "good" },
  { tag: "Clutch climb", tone: "good" },
  { tag: "Great defense", tone: "good" },
  { tag: "Smart driver", tone: "good" },
  { tag: "Consistent", tone: "good" },
  { tag: "Good under pressure", tone: "good" },
  { tag: "Great partner", tone: "good" },
  { tag: "Died on field", tone: "bad" },
  { tag: "Dropped pieces", tone: "bad" },
  { tag: "Slow cycles", tone: "bad" },
  { tag: "Tippy / unstable", tone: "bad" },
  { tag: "Penalty prone", tone: "bad" },
  { tag: "Struggled vs defense", tone: "bad" },
  { tag: "Comms issues", tone: "bad" },
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
  tags: [],
  played_defense: false,
  defense_rating: 0,
  defense_on: "",
  successful_stops: 0,
  driver_skill: 3,
  speed_rating: 3,
  fouls: 0,
  failure: false,
  failure_details: "",
  no_show: false,
  notes: "",
});

function Step({ n, title, hint, children }: { n: number; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="card step-card">
      <header className="step-head">
        <span className="step-num">{n}</span>
        <div>
          <h3>{title}</h3>
          {hint && <p className="step-hint">{hint}</p>}
        </div>
      </header>
      {children}
    </section>
  );
}

export default function ScoutPage() {
  const toast = useToast();
  const [f, setF] = useState<ScoutEntry>(blank());
  const [matches, setMatches] = useState<MatchRec[]>([]);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [hotkeys, setHotkeys] = useState<Hotkeys>(DEFAULT_HOTKEYS);
  const [editingKeys, setEditingKeys] = useState(false);
  const [restored, setRestored] = useState(false);
  const [rejected, setRejected] = useState<PendingScout[]>([]);
  const currentDraft = useRef({ f, started });
  currentDraft.current = { f, started };
  const submitLock = useRef(false);
  const draftKey = () => `hazehub.draft.${localOwner()}`;
  const hotkeyKey = () => `hazehub.hotkeys.${localOwner()}`;
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey()) || "null");
      if (saved?.f) { setF(saved.f); setStarted(!!saved.started); }
      const keys = JSON.parse(localStorage.getItem(hotkeyKey()) || "null");
      if (keys && validHotkeys(keys)) setHotkeys(keys);
    } catch {}
    setRestored(true);
    const loadRejected = () => Promise.all([pendingScouts(), legacyScouts()]).then(([rows, legacy]) => setRejected([...rows.filter(r => r.last_error), ...legacy.map(r => ({ ...r, last_error: "Older offline report: verify ownership and event before submitting." }))]));
    loadRejected();
    window.addEventListener("scout-queue-changed", loadRejected);
    return () => window.removeEventListener("scout-queue-changed", loadRejected);
  }, []);
  useEffect(() => {
    if (!restored) return;
    const save = () => { try { localStorage.setItem(draftKey(), JSON.stringify(currentDraft.current)); } catch {} };
    const timer = setTimeout(save, 400);
    window.addEventListener("pagehide", save);
    return () => { clearTimeout(timer); window.removeEventListener("pagehide", save); };
  }, [f, started, restored]);
  useEffect(() => () => { try { localStorage.setItem(draftKey(), JSON.stringify(currentDraft.current)); } catch {} }, []);
  useEffect(() => {
    if (!started || editingKeys || busy || f.no_show) return;
    const handle = (e: KeyboardEvent) => {
      if (ignoreHotkey(e)) return;
      const key = e.key.toLowerCase();
      if (key === hotkeys.foul) setF(p => ({ ...p, fouls: p.fouls + 1 }));
      else if (key === hotkeys.stop) setF(p => ({ ...p, successful_stops: p.successful_stops + 1 }));
      else if (key === hotkeys.leave) setF(p => ({ ...p, auto_leave: !p.auto_leave }));
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [started, editingKeys, busy, hotkeys, f.no_show]);
  const set = <K extends keyof ScoutEntry>(k: K, v: ScoutEntry[K]) => {
    if (!["event_key", "match_number", "comp_level", "team_number", "alliance", "station"].includes(k)) { setStarted(true); setEditingKeys(false); }
    setF((p) => ({ ...p, [k]: v }));
  };

  // Restore remembered alliance/station, then refine from the server.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STATION_KEY) || "null");
      if (saved && !localStorage.getItem(draftKey())) setF((p) => ({ ...p, alliance: saved.alliance, station: saved.station }));
    } catch {}
    api<{ alliance: "red" | "blue"; station: number }>("/api/scout/last-assignment")
      .then((a) => { if (!currentDraft.current.started) setF((p) => ({ ...p, alliance: a.alliance, station: a.station })); })
      .catch(() => {});
    api<{ event: string; matches: MatchRec[] }>("/api/matches?include_teams=true").then((r) => { setMatches(r.matches); setF(p => ({ ...p, event_key: p.event_key || r.event })); }).catch(() => {});
  }, []);

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

  // Auto-fill the team from the schedule whenever the slot changes and the
  // scouter hasn't typed their own number.
  useEffect(() => {
    if (scheduledTeam && !currentDraft.current.started) setF((p) => (p.team_number === 0 || p.team_number !== scheduledTeam ? { ...p, team_number: scheduledTeam } : p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduledTeam]);

  function rememberStation(alliance: "red" | "blue", station: number) {
    localStorage.setItem(STATION_KEY, JSON.stringify({ alliance, station }));
  }

  async function submit() {
    if (submitLock.current) return;
    if (!f.team_number) return toast("Enter the team number first", "err");
    if (!f.event_key) return toast("Load an event online before scouting offline", "err");
    submitLock.current = true;
    setBusy(true);
    const entry: ScoutEntry = { ...f, client_uuid: f.client_uuid || uuid() };
    setF(entry);
    try {
      rememberStation(f.alliance, f.station);
      // Persist before sending: a closed tab or lost acknowledgement cannot lose a report.
      await queueScout({ ...entry, client_uuid: entry.client_uuid!, queued_at: Date.now() });
      await flushQueue();
      const pending = await db().pendingScouts.get(entry.client_uuid!);
      if (pending?.last_error) { toast(pending.last_error, "err"); return; }
      toast(pending ? "Saved on this device — waiting to sync" : `Saved team ${f.team_number}`, pending ? "info" : "ok");
      resetForNext();
    } catch {
      toast("Could not save locally. Keep this form open and retry.", "err");
    } finally {
      submitLock.current = false;
      setBusy(false);
    }
  }

  function resetForNext() {
    setStarted(false);
    setF((p) => ({
      ...blank(),
      event_key: p.event_key,
      alliance: p.alliance,
      station: p.station,
      comp_level: p.comp_level,
      match_number: p.match_number + 1,
    }));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div className="scout-flow">
      <div className="page-title"><h1>Scout a Match</h1></div>
      <p className="page-sub">Top to bottom, done in a minute.</p>
      <div className="btn-row" style={{ marginBottom: 16 }}>
        <button className="btn ghost" disabled={started || busy} onClick={() => setEditingKeys(true)}>Change hotkeys</button>
        {!started ? <button className="btn primary" disabled={editingKeys} onClick={() => setStarted(true)}>Start scouting</button> : <span className="badge haze">Match in progress · hotkeys locked</span>}
      </div>
      {editingKeys && <HotkeySettings keys={hotkeys} onClose={() => setEditingKeys(false)} onSave={keys => {
        if (started) return;
        try { localStorage.setItem(hotkeyKey(), JSON.stringify(keys)); setHotkeys(keys); setEditingKeys(false); }
        catch { toast("Could not save hotkeys on this device", "err"); }
      }} />}
      {rejected.map(row => <div className="card" key={row.client_uuid} style={{ marginBottom: 12 }}>
        <b>Team {row.team_number} / match {row.match_number} needs correction</b><p>{row.last_error}</p>
        <button className="btn ghost" disabled={started} onClick={() => { const { owner_id, queued_at, last_error, ...entry } = row; setF(entry); setStarted(true); }}>Edit saved report</button>
      </div>)}

      {/* 1 — who are you watching */}
      <Step n={1} title="Your robot" hint="The team number fills in from the schedule.">
        <label className="field"><span>Event</span><input value={f.event_key || ""} onChange={e => set("event_key", e.target.value.trim().toLowerCase())} placeholder="e.g. 2026txaus" /></label>
        <div className="slot-grid">
          <label className="field" style={{ margin: 0 }}>
            <span>Match #</span>
            <input
              type="number"
              inputMode="numeric"
              value={f.match_number}
              onChange={(e) => set("match_number", parseInt(e.target.value || "0", 10))}
            />
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
        </div>

        <div className="watching">
          {scheduledTeamProfile && f.team_number === scheduledTeam ? (
            <div className="watching-team">
              <span className="step-hint" style={{ margin: "0 0 6px" }}>You're watching</span>
              <TeamIdentity team={scheduledTeamProfile} size="lg" />
            </div>
          ) : (
            <label className="field" style={{ margin: 0, flex: 1 }}>
              <span>Team #{scheduledTeam ? ` (schedule says ${scheduledTeam})` : " (no schedule loaded)"}</span>
              <input
                type="number"
                inputMode="numeric"
                value={f.team_number || ""}
                onChange={(e) => set("team_number", parseInt(e.target.value || "0", 10))}
                placeholder="0000"
              />
            </label>
          )}
          <div className="watching-actions">
            {scheduledTeamProfile && f.team_number === scheduledTeam && (
              <button className="btn sm ghost" type="button" onClick={() => set("team_number", 0)}>
                Wrong team?
              </button>
            )}
            <label className={"pill-check no-show" + (f.no_show ? " on" : "")}>
              <input type="checkbox" checked={f.no_show} onChange={(e) => set("no_show", e.target.checked)} />
              Robot never showed up
            </label>
          </div>
        </div>
      </Step>

      {f.no_show ? (
        <div className="card step-card noshow-note">
          <p style={{ margin: 0 }}>
            That's all we need — hit <b>Submit</b> below. The no-show is tracked as a
            reliability flag and won't drag down the team's scoring averages.
          </p>
        </div>
      ) : (
        <>
          {/* 2 — score the match */}
          <Step n={2} title="Score the match" hint="Tap the field where each attempt happened. Switch Auto/Teleop and Made/Missed as you go.">
            <FieldInput hotkeys={hotkeys} active={started && !editingKeys && !busy} points={f.heatmap} onChange={(pts: HeatPoint[]) => set("heatmap", pts)} />
            <div className="row" style={{ gap: 10, marginTop: 14 }}>
              <label className={"pill-check" + (f.auto_leave ? " on" : "")}>
                <input type="checkbox" checked={f.auto_leave} onChange={(e) => set("auto_leave", e.target.checked)} /> Left start zone in Auto
              </label>
              <label className={"pill-check" + (f.auto_climb ? " on" : "")}>
                <input type="checkbox" checked={f.auto_climb} onChange={(e) => set("auto_climb", e.target.checked)} /> Auto climb
              </label>
            </div>
          </Step>

          {/* 3 — endgame */}
          <Step n={3} title="Endgame climb">
            <Segmented
              options={[
                { value: "none", label: "No climb" },
                { value: "l1", label: "L1" },
                { value: "l2", label: "L2" },
                { value: "l3", label: "L3" },
              ]}
              value={f.climb}
              onChange={(v) => set("climb", v)}
            />
          </Step>

          {/* 4 — how did they look */}
          <Step n={4} title="How did they look?" hint="Gut ratings — 3 is average.">
            <div className="rate-row">
              <span>Driver skill</span>
              <Rating value={f.driver_skill} onChange={(v) => set("driver_skill", v)} />
            </div>
            <div className="rate-row">
              <span>Speed / cycling</span>
              <Rating value={f.speed_rating} onChange={(v) => set("speed_rating", v)} />
            </div>
            <label className={"pill-check" + (f.played_defense ? " on" : "")} style={{ marginTop: 4 }}>
              <input type="checkbox" checked={f.played_defense} onChange={(e) => set("played_defense", e.target.checked)} /> Played defense
            </label>
            {f.played_defense && (
              <div className="defense-extra">
                <div className="rate-row">
                  <span>Defense quality</span>
                  <Rating value={f.defense_rating} onChange={(v) => set("defense_rating", v)} />
                </div>
                <div className="rate-row">
                  <span>Successful stops</span>
                  <Stepper value={f.successful_stops} onChange={(v) => set("successful_stops", v)} />
                </div>
                <label className="field" style={{ margin: 0 }}>
                  <span>Who did they defend?</span>
                  <input value={f.defense_on} onChange={(e) => set("defense_on", e.target.value)} placeholder="e.g. 254, 1678" />
                </label>
              </div>
            )}
          </Step>

          {/* 5 — quick tags */}
          <Step n={5} title="Quick tags" hint="Tap anything you saw — these build the team's profile.">
            <div className="tag-list">
              {QUICK_TAGS.map(({ tag, tone }) => {
                const on = f.tags.includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    className={"chip " + tone + (on ? " on" : "")}
                    onClick={() => set("tags", on ? f.tags.filter((t) => t !== tag) : [...f.tags, tag])}
                  >
                    {tag}
                  </button>
                );
              })}
            </div>
          </Step>

          {/* 6 — problems + notes */}
          <Step n={6} title="Problems &amp; notes" hint="Only if something happened — otherwise skip straight to Submit.">
            <div className="rate-row">
              <span>Fouls</span>
              <Stepper value={f.fouls} onChange={(v) => set("fouls", v)} />
            </div>
            <label className={"pill-check" + (f.failure ? " on" : "")} style={{ margin: "4px 0 10px" }}>
              <input type="checkbox" checked={f.failure} onChange={(e) => set("failure", e.target.checked)} /> Robot broke / died
            </label>
            {f.failure && (
              <label className="field">
                <span>What failed?</span>
                <input value={f.failure_details} onChange={(e) => set("failure_details", e.target.value)} placeholder="e.g. lost comms, drivetrain" />
              </label>
            )}
            <label className="field" style={{ margin: 0 }}>
              <span>Anything the numbers miss?</span>
              <textarea value={f.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Strategy, partner compatibility, driver decisions…" />
            </label>
          </Step>
        </>
      )}

      {/* sticky submit bar */}
      <div className="submit-bar">
        <div className="submit-info">
          <b>{matchLabel(f.comp_level, f.match_number)}</b>
          <span>{f.team_number ? `Team ${f.team_number}` : "No team yet"}{f.no_show ? " · NO SHOW" : ""}</span>
        </div>
        <button className="btn ghost" type="button" disabled={busy} onClick={() => setF((p) => ({ ...blank(), event_key: p.event_key, alliance: p.alliance, station: p.station, match_number: p.match_number }))}>
          Clear
        </button>
        <button className="btn primary submit-cta" type="button" onClick={submit} disabled={busy}>
          {busy ? "Saving…" : "Submit →"}
        </button>
      </div>
    </div>
  );
}

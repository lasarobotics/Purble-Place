"use client";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { loadSchedule, type ScheduleSource } from "@/lib/schedule";
import { useToast } from "@/lib/toast";
import { markAcknowledged, markStatus, queueScout, uuid } from "@/lib/db";
import { flushQueue, payloadHash } from "@/lib/sync";
import type { HeatPoint, MatchRec, ScoutEntry } from "@/lib/types";
import { FieldInput } from "@/components/Field";
import { Segmented, Stepper, Rating, TeamIdentity } from "@/components/ui";
import { matchLabel } from "@/lib/format";

const STATION_KEY = "hazehub.station";

// Structured qualitative tags, one tap each, aggregated per team so picklist
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
  const [scheduleSource, setScheduleSource] = useState<ScheduleSource>("none");
  const [scheduleSavedAt, setScheduleSavedAt] = useState<number | null>(null);
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
    // The schedule comes from the network when it can, and from IndexedDB
    // when it cannot. A scout who lost wifi still needs to know which robot
    // they are watching, which is the whole job.
    loadSchedule()
      .then((r) => {
        setMatches(r.matches);
        setScheduleSource(r.source);
        setScheduleSavedAt(r.savedAt);
      })
      .catch(() => {});
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
    if (scheduledTeam) setF((p) => (p.team_number === 0 || p.team_number !== scheduledTeam ? { ...p, team_number: scheduledTeam } : p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduledTeam]);

  function rememberStation(alliance: "red" | "blue", station: number) {
    localStorage.setItem(STATION_KEY, JSON.stringify({ alliance, station }));
  }

  async function submit() {
    if (!f.team_number) return toast("Enter the team number first", "err");
    setBusy(true);
    // Direct-to-cloud envelope: the UUID + hash are assigned on the device
    // and stay with this observation through retries, recovery, and the cloud.
    const submissionId = uuid();
    const entry: ScoutEntry = {
      ...f,
      client_uuid: submissionId,
      submission_id: submissionId,
      client_ts: new Date().toISOString(),
      payload_hash: await payloadHash(f as any),
    };
    rememberStation(f.alliance, f.station);
    // Save locally FIRST, the record must survive even if the request dies.
    await queueScout({ ...entry, client_uuid: submissionId, queued_at: Date.now() });
    try {
      const res = await api<{ entry: ScoutEntry }>("/api/scout", { method: "POST", body: entry });
      await markAcknowledged([submissionId], res.entry.azure_received_at || undefined);
      toast(f.no_show ? `No-show recorded for ${f.team_number}` : `Confirmed · team ${f.team_number} · ${res.entry.points} pts`, "ok");
      resetForNext();
    } catch (err: any) {
      if (err?.status === 409) {
        await markStatus(submissionId, "conflict", err.message);
        toast("Conflict, this submission UUID already exists with different data", "err");
      } else {
        // Offline or server error → already saved locally, sync later.
        toast("Saved locally, will sync when connected", "info");
        flushQueue();
      }
      resetForNext();
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
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div className="scout-flow">
      <div className="page-title"><h1>Scout a Match</h1></div>
      <p className="page-sub">Top to bottom, done in a minute.</p>

      {scheduleSource === "cache" && (
        <div className="card tight" style={{ borderColor: "var(--amber)", marginBottom: 12 }}>
          <span className="dot amber" style={{ marginRight: 8 }} />
          Using the schedule saved on this device
          {scheduleSavedAt ? ` from ${new Date(scheduleSavedAt).toLocaleTimeString()}` : ""}.
          Team numbers still fill in. It will refresh when the connection returns.
        </div>
      )}
      {scheduleSource === "none" && (
        <div className="card tight" style={{ borderColor: "var(--red)", marginBottom: 12 }}>
          <span className="dot red" style={{ marginRight: 8 }} />
          No schedule on this device yet. Type the team number in by hand, and open
          this page once while online so the schedule is saved for later.
        </div>
      )}

      {/* 1, who are you watching */}
      <Step n={1} title="Your robot" hint="The team number fills in from the schedule.">
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
            That's all we need, hit <b>Submit</b> below. The no-show is tracked as a
            reliability flag and won't drag down the team's scoring averages.
          </p>
        </div>
      ) : (
        <>
          {/* 2, score the match */}
          <Step n={2} title="Score the match" hint="Tap the field where each attempt happened. Switch Auto/Teleop and Made/Missed as you go.">
            <FieldInput points={f.heatmap} onChange={(pts: HeatPoint[]) => set("heatmap", pts)} />
            <div className="row" style={{ gap: 10, marginTop: 14 }}>
              <label className={"pill-check" + (f.auto_leave ? " on" : "")}>
                <input type="checkbox" checked={f.auto_leave} onChange={(e) => set("auto_leave", e.target.checked)} /> Left start zone in Auto
              </label>
              <label className={"pill-check" + (f.auto_climb ? " on" : "")}>
                <input type="checkbox" checked={f.auto_climb} onChange={(e) => set("auto_climb", e.target.checked)} /> Auto climb
              </label>
            </div>
          </Step>

          {/* 3, endgame */}
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

          {/* 4, how did they look */}
          <Step n={4} title="How did they look?" hint="Gut ratings. 3 is average.">
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

          {/* 5, quick tags */}
          <Step n={5} title="Quick tags" hint="Tap anything you saw, these build the team's profile.">
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

          {/* 6, problems + notes */}
          <Step n={6} title="Problems &amp; notes" hint="Only if something happened, otherwise skip straight to Submit.">
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
        <button className="btn ghost" type="button" onClick={() => setF((p) => ({ ...blank(), alliance: p.alliance, station: p.station, match_number: p.match_number }))}>
          Clear
        </button>
        <button className="btn primary submit-cta" type="button" onClick={submit} disabled={busy}>
          {busy ? "Saving…" : "Submit →"}
        </button>
      </div>
    </div>
  );
}

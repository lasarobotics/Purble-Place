"use client";
import { useEffect, useMemo, useState, useRef } from "react";
import { HotkeySettings } from "@/components/HotkeySettings";
import { DEFAULT_HOTKEYS, Hotkeys, validHotkeys } from "@/lib/hotkeys";
import { localOwner } from "@/lib/identity";
import { db } from "@/lib/db";
import { api } from "@/lib/api";
import { loadSchedule, type ScheduleSource } from "@/lib/schedule";
import { useToast } from "@/lib/toast";
import { markAcknowledged, markStatus, queueScout, uuid } from "@/lib/db";
import { PineappleCelebration } from "@/components/PineappleCelebration";
import { flushQueue, payloadHash } from "@/lib/sync";
import type { HeatPoint, MatchRec, ScoutEntry } from "@/lib/types";
import { useAuth } from "@/lib/auth";
import { FieldInput } from "@/components/Field";
import { Confirm, Segmented, Stepper, Rating, TeamIdentity } from "@/components/ui";
import { BettingPanel } from "@/components/BettingPanel";
import { matchLabel } from "@/lib/format";
import { useGame } from "@/lib/game";

const STATION_KEY = "hazehub.station";

const blank = (endgameNone = "none"): ScoutEntry => ({
  match_number: 1,
  comp_level: "qm",
  team_number: 0,
  alliance: "red",
  station: 1,
  auto_leave: false,
  auto_climb: false,
  heatmap: [],
  auto_missed: 0,
  teleop_missed: 0,
  climb: endgameNone,
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

/** A pending alliance/station switch, held until the scout confirms it. */
type SlotChange =
  | { kind: "alliance"; value: "red" | "blue" }
  | { kind: "station"; value: number };

function Step({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card step-card">
      <header className="step-head"><h3>{title}</h3></header>
      {children}
    </section>
  );
}

export default function ScoutPage() {
  const toast = useToast();
  const { session } = useAuth();
  // Endgame levels come from backend/app/game.py, so a new
  // season changes the form without a frontend change.
  const game = useGame();
  const [f, setF] = useState<ScoutEntry>(() => blank());
  const [started, setStarted] = useState(false);
  const [editingKeys, setEditingKeys] = useState(false);
  const [hotkeys, setHotkeys] = useState<Hotkeys>(DEFAULT_HOTKEYS);
  const restored = useRef(false);
  const draftKey = `hazehub.draft.${localOwner()}`;
  const hotkeyKey = `hazehub.hotkeys.${localOwner()}`;
  useEffect(() => {
    try {
      const keys = JSON.parse(localStorage.getItem(hotkeyKey) || "null");
      if (keys && validHotkeys(keys)) setHotkeys(keys);
      const draft = JSON.parse(localStorage.getItem(draftKey) || "null");
      if (draft?.f) { restored.current = true; setF({ ...draft.f, heatmap: (draft.f.heatmap || []).map((p: HeatPoint) => ({ ...p, result: "made" })) }); setStarted(!!draft.started); }
    } catch {}
  }, [draftKey, hotkeyKey]);
  useEffect(() => {
    const save = () => { try { localStorage.setItem(draftKey, JSON.stringify({f, started})); } catch {} };
    const timer = setTimeout(save, 400);
    window.addEventListener("pagehide", save);
    return () => { clearTimeout(timer); window.removeEventListener("pagehide", save); };
  }, [f, started, draftKey]);
  const [matches, setMatches] = useState<MatchRec[]>([]);
  const [scheduleSource, setScheduleSource] = useState<ScheduleSource>("none");
  const [busy, setBusy] = useState(false);
  const [pendingSlot, setPendingSlot] = useState<SlotChange | null>(null);
  const [pendingTeamEdit, setPendingTeamEdit] = useState(false);
  const [editingTeam, setEditingTeam] = useState(true);
  // A submitted report leaves the screen instantly (the form resets for the
  // next match), so without this a scout has no idea whether the tap landed.
  // The stamp is the receipt: it names the team and says where the record is.
  const [receipt, setReceipt] = useState<{ team: number; detail: string; queued: boolean } | null>(null);
  const [celebration, setCelebration] = useState<number | null>(null);
  const set = <K extends keyof ScoutEntry>(k: K, v: ScoutEntry[K]) => {
    if (!["match_number", "comp_level", "team_number", "alliance", "station", "event_key"].includes(k)) setStarted(true);
    setF((p) => ({ ...p, season_id: p.season_id || game.season_id, game_version: p.game_version || game.game_version, [k]: v }));
  };

  // Restore remembered alliance/station, then refine from the server.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STATION_KEY) || "null");
      if (saved && !restored.current) setF((p) => ({ ...p, alliance: saved.alliance, station: saved.station }));
    } catch {}
    api<{ alliance: "red" | "blue"; station: number }>("/api/scout/last-assignment")
      .then((a) => { if (!restored.current) setF((p) => ({ ...p, alliance: a.alliance, station: a.station })); })
      .catch(() => {});
    // The schedule comes from the network when it can, and from IndexedDB
    // when it cannot. A scout who lost wifi still needs to know which robot
    // they are watching, which is the whole job.
    loadSchedule()
      .then((r) => {
        setMatches(r.matches);
        setF(p => ({...p, event_key: p.event_key || r.event}));
        setScheduleSource(r.source);
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
    if (scheduledTeam) {
      setF((p) => (p.team_number === 0 || p.team_number !== scheduledTeam ? { ...p, team_number: scheduledTeam } : p));
      setEditingTeam(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduledTeam, f.match_number]);

  function rememberStation(alliance: "red" | "blue", station: number) {
    localStorage.setItem(STATION_KEY, JSON.stringify({ alliance, station }));
  }

  /**
   * Alliance and station decide which robot every following submission is
   * about, and they are remembered across matches precisely so nobody has to
   * think about them. A thumb brushing one of these on a phone would silently
   * re-point the rest of the day's scouting at the wrong team, so the switch
   * is held here until it is confirmed.
   */
  function applySlotChange(change: SlotChange) {
    if (change.kind === "alliance") {
      set("alliance", change.value);
      rememberStation(change.value, f.station);
    } else {
      set("station", change.value);
      rememberStation(f.alliance, change.value);
    }
    setPendingSlot(null);
  }

  async function submit() {
    if (f.match_number < 1) return toast("Match number must be at least 1", "err");
    if (f.team_number < 1) return toast("Team number must be at least 1", "err");
    setBusy(true);
    const submissionId = f.client_uuid || uuid();
    try {
      const entry = {...f, client_uuid: submissionId, submission_id: submissionId,
        client_ts: new Date().toISOString(), payload_hash: await payloadHash(f as any)};
      await queueScout({...entry, queued_at: Date.now()});
      rememberStation(f.alliance, f.station);
      const result = await flushQueue();
      const saved = await db().pendingScouts.get(submissionId);
      if (saved?.sync_status === "invalid" || saved?.sync_status === "conflict") {
        setF(p => ({...p, client_uuid: submissionId}));
        toast(saved.last_error || "Review this report before submitting again", "err");
        return;
      }
      showReceipt(f.team_number, saved?.sync_status === "acknowledged" ? "Saved to cloud" : "Saved on this device", saved?.sync_status !== "acknowledged");
      if (sessionStorage.getItem(`hazehub.celebrated:${submissionId}`) !== "1") {
        sessionStorage.setItem(`hazehub.celebrated:${submissionId}`, "1");
        setCelebration(Math.floor(Math.random() * 5));
      }
      resetForNext();
    } catch (err: any) {
      toast(err?.message || "Could not save on this device. Your report is still here.", "err");
    } finally { setBusy(false); }
  }

  function showReceipt(team: number, detail: string, queued: boolean) {
    setReceipt({ team, detail, queued });
    window.setTimeout(() => setReceipt(null), 2200);
  }

  function resetForNext() {
    setStarted(false);
    localStorage.removeItem(draftKey);
    setF((p) => ({
      ...blank(game.endgame_none),
      event_key: p.event_key,
      alliance: p.alliance,
      station: p.station,
      comp_level: p.comp_level,
      match_number: p.match_number + 1,
    }));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const stationLabel = `${f.alliance === "red" ? "Red" : "Blue"} ${f.station}`;
  const canStartMatch = !!session?.is_admin;

  return (
    <div className="scout-flow">
      <div className="scout-head">
        <div className="page-title" style={{ margin: 0 }}>
          <h1>Scout</h1>
          <span className="badge alliance-tag">{stationLabel}</span>
        </div>
      </div>

      <div className="btn-row" style={{marginBottom: 16}}>
        <button className="btn" disabled={started || busy} onClick={() => setEditingKeys(true)}>Change hotkeys</button>
        <button className="btn primary" disabled={!canStartMatch || started || busy} onClick={() => { setStarted(true); setF(p => ({...p, season_id: p.season_id || game.season_id, game_version: p.game_version || game.game_version})); }}>{started ? "Match in progress" : "Start match"}</button>
        {started && <span className="faint">Hotkeys lock until this report is saved.</span>}
      </div>
      {editingKeys && <HotkeySettings keys={hotkeys} onClose={() => setEditingKeys(false)} onSave={keys => {
        if (started) return;
        localStorage.setItem(hotkeyKey, JSON.stringify(keys)); setHotkeys(keys); setEditingKeys(false);
      }} />}
      {scheduleSource === "cache" && (
        <div className="scout-banner" role="status">Offline schedule</div>
      )}
      {scheduleSource === "none" && (
        <div className="scout-banner" role="status">No schedule</div>
      )}

      {/* Two columns on anything wider than a phone: the field map and the
          slot pickers need the width, the ratings and notes do not, and the
          page used to run to three screens of scrolling because everything
          was stacked in one narrow strip. */}
      <div className="scout-cols">
        <div className="scout-col">
          {/* 1, who are you watching */}
          <Step title="Match">
            <div className="slot-grid">
              <label className="field" style={{ margin: 0 }}>
                <span>Match #</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={f.match_number}
                  onChange={(e) => set("match_number", Math.max(1, parseInt(e.target.value || "1", 10)))}
                />
              </label>
              <div className="field" style={{ margin: 0 }}>
                <span>Alliance</span>
                <Segmented
                  options={[{ value: "red", label: "Red" }, { value: "blue", label: "Blue" }]}
                  value={f.alliance}
                  onChange={(v) => { if (v !== f.alliance) setPendingSlot({ kind: "alliance", value: v }); }}
                />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <span>Station</span>
                <Segmented
                  options={[{ value: "1", label: "1" }, { value: "2", label: "2" }, { value: "3", label: "3" }]}
                  value={String(f.station)}
                  onChange={(v) => {
                    const s = parseInt(v, 10);
                    if (s !== f.station) setPendingSlot({ kind: "station", value: s });
                  }}
                />
              </div>
            </div>

            <div className="watching">
              {scheduledTeamProfile && f.team_number === scheduledTeam ? (
                <div className="watching-team">
                  <TeamIdentity team={scheduledTeamProfile} size="lg" />
                </div>
              ) : (
                <label className="field" style={{ margin: 0, flex: 1 }}>
                  <span>Team #</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    disabled={f.team_number > 0 && !editingTeam}
                    value={f.team_number || ""}
                    onChange={(e) => set("team_number", Math.max(0, parseInt(e.target.value || "0", 10)))}
                    onBlur={() => { if (f.team_number > 0) setEditingTeam(false); }}
                    placeholder="0000"
                  />
                </label>
              )}
              <div className="watching-actions">
                {f.team_number > 0 && !editingTeam && (
                  <button className="btn sm ghost" type="button" onClick={() => setPendingTeamEdit(true)}>
                    Change team number
                  </button>
                )}
                <label className={"pill-check no-show" + (f.no_show ? " on" : "")}>
                  <input type="checkbox" checked={f.no_show} onChange={(e) => set("no_show", e.target.checked)} />
                  No show
                </label>
              </div>
            </div>
          </Step>

          {f.no_show ? (
            <div className="card step-card noshow-note">
              <p style={{ margin: 0 }}>No show</p>
            </div>
          ) : (
            /* 2, score the match */
            <Step title="Scoring">
              <FieldInput key={`${f.comp_level}-${f.match_number}`} hotkeys={hotkeys} active={started && !editingKeys && !busy} points={f.heatmap} onChange={(pts: HeatPoint[]) => set("heatmap", pts)} />
              <div className="row" style={{ gap: 10, marginTop: 14 }}>
                <label className={"pill-check" + (f.auto_leave ? " on" : "")}>
                  <input type="checkbox" checked={f.auto_leave} onChange={(e) => set("auto_leave", e.target.checked)} /> Auto leave
                </label>
                <label className={"pill-check" + (f.auto_climb ? " on" : "")}>
                  <input type="checkbox" checked={f.auto_climb} onChange={(e) => set("auto_climb", e.target.checked)} /> Auto climb
                </label>
              </div>
            </Step>
          )}
        </div>

        <div className="scout-col">
          {!f.no_show && (
            <>
              {/* 3, endgame */}
              <Step title="Endgame">
                <Segmented
                  options={game.endgame.map((l) => ({ value: l.key, label: l.label }))}
                  value={f.climb}
                  onChange={(v) => set("climb", v)}
                />
              </Step>

              {/* 4, how did they look */}
              <Step title="Ratings">
                <div className="rate-row">
                  <span>Driver</span>
                  <Rating value={f.driver_skill} onChange={(v) => set("driver_skill", v)} />
                </div>
                <div className="rate-row">
                  <span>Speed</span>
                  <Rating value={f.speed_rating} onChange={(v) => set("speed_rating", v)} />
                </div>
                <label className={"pill-check" + (f.played_defense ? " on" : "")} style={{ marginTop: 4 }}>
                  <input type="checkbox" checked={f.played_defense} onChange={(e) => set("played_defense", e.target.checked)} /> Defense
                </label>
                {f.played_defense && (
                  <div className="defense-extra">
                    <div className="rate-row">
                      <span>Defense rating</span>
                      <Rating value={f.defense_rating} onChange={(v) => set("defense_rating", v)} />
                    </div>
                    <div className="rate-row inline">
                      <span>Stops</span>
                      <Stepper value={f.successful_stops} onChange={(v) => set("successful_stops", v)} />
                    </div>
                    <label className="field" style={{ margin: 0 }}>
                      <span>Defended teams</span>
                      <input value={f.defense_on} onChange={(e) => set("defense_on", e.target.value)} placeholder="e.g. 254, 1678" />
                    </label>
                  </div>
                )}
              </Step>


              {/* Problems and notes */}
              <Step title="Notes">
                {/* The counter sits against its label rather than pushed to
                    the far edge, so the two read as one control. */}
                <div className="rate-row inline">
                  <span>Fouls</span>
                  <Stepper value={f.fouls} onChange={(v) => set("fouls", v)} />
                </div>
                <label className={"pill-check" + (f.failure ? " on" : "")} style={{ margin: "4px 0 10px" }}>
                  <input type="checkbox" checked={f.failure} onChange={(e) => set("failure", e.target.checked)} /> Failure
                </label>
                {f.failure && (
                  <label className="field">
                    <span>Failure details</span>
                    <input value={f.failure_details} onChange={(e) => set("failure_details", e.target.value)} placeholder="e.g. lost comms, drivetrain" />
                  </label>
                )}
                <label className="field" style={{ margin: 0 }}>
                  <span>Notes</span>
                  <textarea value={f.notes} onChange={(e) => set("notes", e.target.value)} placeholder="" />
                </label>
              </Step>
            </>
          )}

          {/* Betting lives here now instead of behind its own tab: the match
              you are about to scout is the one you want to bet on. */}
          <BettingPanel matchNumber={f.match_number} />
        </div>
      </div>

      {/* sticky submit bar */}
      <div className="submit-bar">
        <div className="submit-info">
          <b>{matchLabel(f.comp_level, f.match_number)}</b>
          <span>{f.team_number ? `Team ${f.team_number}` : "No team yet"}{f.no_show ? " · NO SHOW" : ""}</span>
        </div>
        <button className="btn ghost" type="button" onClick={() => setF((p) => ({ ...blank(game.endgame_none), alliance: p.alliance, station: p.station, match_number: p.match_number }))}>
          Clear
        </button>
        <button className="btn primary submit-cta" type="button" onClick={submit} disabled={busy}>
          {busy ? "Saving..." : "Submit"}
        </button>
      </div>

      {receipt && (
        <div className={"submit-receipt" + (receipt.queued ? " queued" : "")} role="status">
          <span className="submit-receipt-mark" aria-hidden />
          <span className="submit-receipt-text">
            <b>Team {receipt.team}</b>
            <span>{receipt.detail}</span>
          </span>
        </div>
      )}
      {celebration !== null && <PineappleCelebration variant={celebration} onClose={() => setCelebration(null)} />}

      {pendingSlot && (
        <Confirm
          title={pendingSlot.kind === "alliance" ? "Change your alliance?" : "Change your driver station?"}
          body={
            <>{stationLabel} → {pendingSlot.kind === "alliance"
              ? (pendingSlot.value === "red" ? "Red" : "Blue") + " " + f.station
              : (f.alliance === "red" ? "Red" : "Blue") + " " + pendingSlot.value}</>
          }
          confirmLabel="Change"
          cancelLabel="Cancel"
          onConfirm={() => applySlotChange(pendingSlot)}
          onCancel={() => setPendingSlot(null)}
        />
      )}
      {pendingTeamEdit && (
        <Confirm
          title="Change the team number?"
          body={<>This report is currently assigned to Team {f.team_number}. Confirm before changing which robot the report belongs to.</>}
          confirmLabel="Change team"
          cancelLabel="Keep team"
          onConfirm={() => { setPendingTeamEdit(false); setEditingTeam(true); if (f.team_number === scheduledTeam) set("team_number", 0); }}
          onCancel={() => setPendingTeamEdit(false)}
        />
      )}
    </div>
  );
}

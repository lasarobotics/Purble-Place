"use client";
// Pit scouting: walk the pits, fill this in once per robot.
//
// The questions are not written here. They come from the "pit" form in the
// Form Builder, so a strategy lead can change what gets asked in the pits
// without anybody deploying anything. This page owns only the parts that are
// true of pit scouting whatever the game: one report per team, typing a number
// you have already done loads that report, and a list of who is finished.
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { db, queuePit } from "@/lib/db";
import { flushPitQueue } from "@/lib/pit-sync";
import { loadSchedule } from "@/lib/schedule";
import { useToast } from "@/lib/toast";
import { onBus } from "@/lib/bus";
import { blankAnswers, useActiveForm } from "@/lib/formdef";
import type { PitEntry } from "@/lib/types";
import { Empty, Loading, TeamIdentity } from "@/components/ui";
import { FormRenderer } from "@/components/FormRenderer";
import { Icon } from "@/components/icons";
import { PineappleCelebration } from "@/components/PineappleCelebration";

/** The field key the form uses for the robot number. */
const TEAM_KEY = "team_number";

/** Columns on a stored report that map straight back onto a form key. */
const REUSABLE_COLUMNS = [
  "drivetrain", "archetype", "weight_lbs", "can_climb",
  "auto_routine", "robot_photo", "notes",
];

export default function PitScoutPage() {
  const toast = useToast();
  const { form, loading, fromCache } = useActiveForm("pit");
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [done, setDone] = useState<PitEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadedTeam, setLoadedTeam] = useState(0);
  const [eventKey, setEventKey] = useState("");
  const [scheduledTeams, setScheduledTeams] = useState<Set<number>>(new Set());
  const [scheduleReady, setScheduleReady] = useState(false);
  const [online, setOnline] = useState(true);
  const [celebration, setCelebration] = useState<number | null>(null);

  const definition = form?.definition;
  const teamNumber = Number(answers[TEAM_KEY]) || 0;
  const publishedVersion = form?.published_version;
  const game = form?.game ?? null;
  const teamValid = teamNumber > 0 && scheduledTeams.has(teamNumber);

  useEffect(() => {
    loadSchedule().then(result => {
      setEventKey(result.event);
      setScheduledTeams(new Set(result.matches.flatMap(match => [...match.red, ...match.blue])));
      setScheduleReady(result.matches.length > 0);
    }).catch(() => setScheduleReady(false));
  }, []);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);

  // Reset whenever the published form changes underneath, so an edit does not
  // leave a half-filled form from the old questions.
  useEffect(() => {
    if (definition) setAnswers(blankAnswers(definition));
  }, [definition, publishedVersion]);

  const loadDone = useCallback(async () => {
    try {
      setDone(await api<PitEntry[]>("/api/pit"));
    } catch {}
  }, []);

  useEffect(() => {
    loadDone();
    return onBus((e) => { if (e === "pit_submitted" || e === "settings_changed") loadDone(); });
  }, [loadDone]);

  // Pull an existing report in as soon as a complete-looking number is typed,
  // so a second visit to the same pit edits rather than overwrites blindly.
  useEffect(() => {
    if (!teamNumber || teamNumber === loadedTeam || !definition) return;
    let alive = true;
    const id = setTimeout(async () => {
      try {
        const row = await api<PitEntry | null>(`/api/pit/${teamNumber}`);
        if (!alive || !row) return;
        setLoadedTeam(teamNumber);
        setAnswers((cur) => ({
          ...cur,
          // Columns first, then whatever the form asked that has no column.
          ...pick(row as Record<string, any>, REUSABLE_COLUMNS),
          ...(row.responses || {}),
          robot_photo: row.robot_photos || (row.robot_photo ? [row.robot_photo] : []),
          [TEAM_KEY]: teamNumber,
        }));
        toast(`Loaded the existing report for ${teamNumber}`, "info");
      } catch {}
    }, 600);
    return () => { alive = false; clearTimeout(id); };
  }, [teamNumber, loadedTeam, definition, toast]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!teamNumber) return toast("Enter the robot number first", "err");
    if (!scheduleReady) return toast("Load or import this event's schedule before pit scouting", "err");
    if (!teamValid) return toast(`Team ${teamNumber} is not at ${eventKey}`, "err");
    setBusy(true);
    try {
      const body = {
          event_key: eventKey,
          team_number: teamNumber,
          answers,
          // Provenance: which form, which version, which season. Pinned here
          // so this report can always be read against the questions it was
          // actually collected with.
          form_id: form?.form_id ?? "",
          form_version: publishedVersion ?? 0,
          season_id: form?.season_id ?? "",
      };
      const queued = await queuePit(body);
      await flushPitQueue();
      const saved = await db().pendingPits.get(queued.id);
      if (saved?.sync_status === "invalid") throw new Error(saved.last_error || "Review this pit report");
      toast(
        saved?.sync_status === "acknowledged"
          ? `Pit report saved for ${teamNumber}`
          : `Pit report for ${teamNumber} saved on this device and queued`,
        "ok",
      );
      if (sessionStorage.getItem(`hazehub.celebrated:pit:${queued.id}`) !== "1") {
        sessionStorage.setItem(`hazehub.celebrated:pit:${queued.id}`, "1");
        setCelebration(Math.floor(Math.random() * 5));
      }
      if (definition) setAnswers(blankAnswers(definition));
      setLoadedTeam(0);
      loadDone();
    } catch (err: any) {
      toast(err?.message || "Could not save the pit report", "err");
    } finally {
      setBusy(false);
    }
  }

  if (loading && !definition) return <Loading label="Loading the pit form" />;

  if (!definition) {
    return (
      <div>
        <div className="page-title"><h1>Pit Scout</h1></div>
        <Empty
          icon="wrench"
          title="No pit form yet"
          sub="An admin builds it in Form Builder. Open this page once while online and it is saved on this device."
        />
      </div>
    );
  }

  return (
    <div className="pit-page">
      <div className="page-title">
        <h1>{definition.name || "Pit Scout"}</h1>
        <span className="badge muted">{done.length} robot{done.length === 1 ? "" : "s"} done</span>
        {fromCache && <span className="badge amber">saved copy</span>}
        {!online && <span className="badge amber">offline</span>}
      </div>


      <div className="pit-cols">
        <form className="pit-form-stack" onSubmit={submit}>
          <FormRenderer
            definition={definition}
            answers={answers}
            game={game}
            onChange={(key, value) => setAnswers((cur) => ({ ...cur, [key]: value }))}
          />
          {teamNumber > 0 && (
            <p className={teamValid ? "faint" : "form-error"} role="status">
              {!scheduleReady
                ? "No event schedule is available to verify this team."
                : teamValid
                  ? `Team ${teamNumber} is scheduled at ${eventKey}.`
                  : `Team ${teamNumber} is not listed at ${eventKey}.`}
            </p>
          )}
          <button className="btn primary block" type="submit" disabled={busy || !teamValid}>
            {busy ? "Saving..." : teamNumber ? `Save pit report for ${teamNumber}` : "Save pit report"}
          </button>
        </form>

        <section className="card pit-done">
          <div className="card-h">
            <h3>Already scouted</h3>
            <span className="badge muted">{done.length}</span>
          </div>
          {done.length === 0 ? (
            <Empty icon="wrench" title="No pit reports yet" sub="The first one you save shows up here." />
          ) : (
            <ul className="pit-done-list">
              {done.map((row) => (
                <li key={row.team_number}>
                  <button
                    type="button"
                    className="team-click grow"
                    onClick={() => setAnswers((cur) => ({ ...cur, [TEAM_KEY]: row.team_number }))}
                  >
                    <TeamIdentity team={{ team_number: row.team_number, nickname: "" }} />
                  </button>
                  {row.archetype && <span className="badge muted">{row.archetype}</span>}
                  {row.has_photo && <span className="badge haze"><Icon name="camera" size={11} /></span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      {celebration !== null && <PineappleCelebration variant={celebration} onClose={() => setCelebration(null)} />}
    </div>
  );
}

/** Copy only the keys that have a value, so blanks do not wipe the form. */
function pick(row: Record<string, any>, keys: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const key of keys) {
    const value = row[key];
    if (value !== null && value !== undefined && value !== "") out[key] = value;
  }
  return out;
}

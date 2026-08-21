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
import { useToast } from "@/lib/toast";
import { onBus } from "@/lib/bus";
import { blankAnswers, useFormDefinition } from "@/lib/formdef";
import type { PitEntry } from "@/lib/types";
import { Empty, Loading, TeamIdentity } from "@/components/ui";
import { FormRenderer } from "@/components/FormRenderer";
import { Icon } from "@/components/icons";

/** The field key the form uses for the robot number. */
const TEAM_KEY = "team_number";

/** Columns on a stored report that map straight back onto a form key. */
const REUSABLE_COLUMNS = [
  "drivetrain", "archetype", "weight_lbs", "can_climb",
  "auto_routine", "robot_photo", "notes",
];

export default function PitScoutPage() {
  const toast = useToast();
  const { form, loading, fromCache } = useFormDefinition("pit");
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [done, setDone] = useState<PitEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadedTeam, setLoadedTeam] = useState(0);

  const definition = form?.definition;
  const teamNumber = Number(answers[TEAM_KEY]) || 0;
  const publishedVersion = form?.published_version;

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
    setBusy(true);
    try {
      await api("/api/pit", {
        method: "POST",
        body: {
          team_number: teamNumber,
          answers,
          form_version: publishedVersion ?? 0,
        },
      });
      toast(`Pit report saved for ${teamNumber}`, "ok");
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
      </div>
      <p className="page-sub">
        {definition.description ||
          "One report per robot. Typing a number you have already done loads that report."}
      </p>

      <div className="pit-cols">
        <form className="pit-form-stack" onSubmit={submit}>
          <FormRenderer
            definition={definition}
            answers={answers}
            onChange={(key, value) => setAnswers((cur) => ({ ...cur, [key]: value }))}
          />
          <button className="btn primary block" type="submit" disabled={busy}>
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

"use client";
// Pit scouting: walk the pits, fill this in once per robot.
//
// One report per team per event, keyed on the team number, so coming back to
// a robot edits the existing report rather than creating a second one. The
// form loads whatever is already on file for the number that gets typed,
// which is what makes "go finish 254" work.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { onBus } from "@/lib/bus";
import type { PitEntry } from "@/lib/types";
import { Empty, TeamIdentity } from "@/components/ui";
import { Icon } from "@/components/icons";

/** Longest edge of the stored photo, in pixels.
 *
 *  A phone camera hands back a 4000px JPEG that base64-encodes to several
 *  megabytes, and a Firestore document is capped at 1 MiB. Downscaling on the
 *  device keeps the write inside the limit and keeps the upload quick on
 *  event wifi; 1280px is still plenty to see an intake or a climber. */
const MAX_PHOTO_EDGE = 1280;
const PHOTO_QUALITY = 0.72;

const blank = () => ({
  team_number: "",
  weight: "",
  archetype: "",
  notes: "",
  photo: "",
});

/** Read a camera file into a downscaled JPEG data URL. */
function readPhoto(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that image"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That file is not an image"));
      img.onload = () => {
        const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Canvas unavailable"));
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", PHOTO_QUALITY));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export default function PitScoutPage() {
  const toast = useToast();
  const [form, setForm] = useState(blank());
  const [done, setDone] = useState<PitEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadedTeam, setLoadedTeam] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const teamNumber = parseInt(form.team_number.replace(/[^0-9]/g, ""), 10) || 0;

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
    if (!teamNumber || teamNumber === loadedTeam) return;
    let alive = true;
    const id = setTimeout(async () => {
      try {
        const row = await api<PitEntry | null>(`/api/pit/${teamNumber}`);
        if (!alive || !row) return;
        setLoadedTeam(teamNumber);
        setForm((cur) => ({
          ...cur,
          weight: row.weight_lbs != null ? String(row.weight_lbs) : cur.weight,
          archetype: row.archetype || cur.archetype,
          notes: row.notes || cur.notes,
          photo: row.robot_photo || cur.photo,
        }));
        toast(`Loaded the existing report for ${teamNumber}`, "info");
      } catch {}
    }, 600);
    return () => { alive = false; clearTimeout(id); };
  }, [teamNumber, loadedTeam, toast]);

  async function onPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const photo = await readPhoto(file);
      setForm((cur) => ({ ...cur, photo }));
    } catch (err: any) {
      toast(err?.message || "Could not use that photo", "err");
    } finally {
      // Clear the input so retaking the same shot fires change again.
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!teamNumber) return toast("Enter the robot number first", "err");
    setBusy(true);
    try {
      await api("/api/pit", {
        method: "POST",
        body: {
          team_number: teamNumber,
          archetype: form.archetype.trim(),
          weight_lbs: form.weight.trim() ? parseFloat(form.weight.replace(/[^0-9.]/g, "")) || null : null,
          robot_photo: form.photo,
          notes: form.notes.trim(),
        },
      });
      toast(`Pit report saved for ${teamNumber}`, "ok");
      setForm(blank());
      setLoadedTeam(0);
      loadDone();
    } catch (err: any) {
      toast(err?.message || "Could not save the pit report", "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pit-page">
      <div className="page-title">
        <h1>Pit Scout</h1>
        <span className="badge muted">{done.length} robot{done.length === 1 ? "" : "s"} done</span>
      </div>
      <p className="page-sub">One report per robot. Typing a number you have already done loads that report so you can add to it.</p>

      <div className="pit-cols">
        <form className="card pit-form" onSubmit={submit}>
          <label className="field">
            <span>Robot number</span>
            <input
              value={form.team_number}
              onChange={(e) => setForm((c) => ({ ...c, team_number: e.target.value }))}
              inputMode="numeric"
              placeholder="e.g. 418"
              autoComplete="off"
            />
          </label>

          <label className="field">
            <span>Robot weight</span>
            <input
              value={form.weight}
              onChange={(e) => setForm((c) => ({ ...c, weight: e.target.value }))}
              inputMode="decimal"
              placeholder="e.g. 118 lbs"
            />
          </label>

          <label className="field">
            <span>Archetype</span>
            <input
              value={form.archetype}
              onChange={(e) => setForm((c) => ({ ...c, archetype: e.target.value }))}
              placeholder="e.g. fast cycler, defense bot, climber"
            />
          </label>

          <div className="field">
            <span>Photo of the robot</span>
            {/* capture="environment" opens the rear camera straight away on a
                phone, and falls back to a normal file picker on a laptop. */}
            <input
              ref={fileRef}
              className="pit-file"
              type="file"
              accept="image/*"
              capture="environment"
              onChange={onPhoto}
            />
            <div className="pit-photo">
              {form.photo ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={form.photo} alt={`Robot ${teamNumber || ""}`} />
                  <div className="btn-row">
                    <button type="button" className="btn sm" onClick={() => fileRef.current?.click()}>Retake</button>
                    <button type="button" className="btn sm ghost" onClick={() => setForm((c) => ({ ...c, photo: "" }))}>Remove</button>
                  </div>
                </>
              ) : (
                <button type="button" className="pit-photo-btn" onClick={() => fileRef.current?.click()}>
                  <Icon name="camera" size={26} />
                  <b>Take a photo</b>
                  <span className="faint">Opens the camera on a phone</span>
                </button>
              )}
            </div>
          </div>

          <label className="field">
            <span>Other notes</span>
            <textarea
              value={form.notes}
              onChange={(e) => setForm((c) => ({ ...c, notes: e.target.value }))}
              rows={5}
              placeholder="Drivetrain, intake, climber, auto routines, anything they told you..."
            />
          </label>

          <button className="btn primary block" type="submit" disabled={busy}>
            {busy ? "Saving..." : teamNumber ? `Save pit report for ${teamNumber}` : "Save pit report"}
          </button>
        </form>

        <section className="card pit-done">
          <div className="card-h">
            <h3 style={{ margin: 0 }}>Already scouted</h3>
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
                    onClick={() => setForm((c) => ({ ...c, team_number: String(row.team_number) }))}
                  >
                    <TeamIdentity team={{ team_number: row.team_number, nickname: "" }} />
                  </button>
                  {row.archetype && <span className="badge muted">{row.archetype}</span>}
                  {row.has_photo && <span className="badge haze"><Icon name="camera" size={12} /></span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

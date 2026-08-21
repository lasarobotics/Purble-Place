"use client";
// Turn a form definition into a form somebody can actually fill in.
//
// One component renders every kind of form the builder can produce, so a
// question added in the builder appears on the scouting device without any
// code change. That is the whole point of the exercise: the shape of a
// scouting form is data, not a page.
//
// It is also what the builder previews with, which means what an admin sees
// while designing is the same component the scout uses, not an approximation
// of it.
import { useRef, useState } from "react";
import type { FormDefinition, FormField, FormSection } from "@/lib/formdef";
import { isVisible } from "@/lib/formdef";
import { Rating, Segmented, Stepper, TeamIdentity } from "@/components/ui";
import { FieldInput } from "@/components/Field";
import { Icon } from "@/components/icons";
import type { HeatPoint } from "@/lib/types";

export interface RendererProps {
  definition: FormDefinition;
  answers: Record<string, any>;
  onChange: (key: string, value: any) => void;
  /** Preview mode: the controls render but do not accept input. */
  disabled?: boolean;
  /** Fields the caller draws itself (the scouting page owns match and slot). */
  skipKeys?: string[];
}

export function FormRenderer({
  definition,
  answers,
  onChange,
  disabled,
  skipKeys = [],
}: RendererProps) {
  const skip = new Set(skipKeys);
  return (
    <>
      {(definition.sections || []).map((section, i) => (
        <FormSectionCard
          key={`${section.title}-${i}`}
          index={i + 1}
          section={section}
          answers={answers}
          onChange={onChange}
          disabled={disabled}
          skip={skip}
        />
      ))}
    </>
  );
}

function FormSectionCard({
  index,
  section,
  answers,
  onChange,
  disabled,
  skip,
}: {
  index: number;
  section: FormSection;
  answers: Record<string, any>;
  onChange: (key: string, value: any) => void;
  disabled?: boolean;
  skip: Set<string>;
}) {
  const fields = (section.fields || []).filter(
    (f) => !skip.has(f.key) && isVisible(f, answers)
  );
  // A section whose every field is conditionally hidden should not leave an
  // empty card behind.
  if (!fields.length) return null;

  return (
    <section className="card step-card">
      <header className="step-head">
        <span className="step-num">{index}</span>
        <div>
          <h3>{section.title}</h3>
          {section.hint && <p className="step-hint">{section.hint}</p>}
        </div>
      </header>
      <div className="form-fields">
        {fields.map((field) => (
          <FieldControl
            key={field.key || field.label}
            field={field}
            value={answers[field.key]}
            onChange={(v) => onChange(field.key, v)}
            disabled={disabled}
          />
        ))}
      </div>
    </section>
  );
}

export function FieldControl({
  field,
  value,
  onChange,
  disabled,
}: {
  field: FormField;
  value: any;
  onChange: (v: any) => void;
  disabled?: boolean;
}) {
  const set = disabled ? () => {} : onChange;

  switch (field.type) {
    case "note":
      return (
        <p className="form-note">
          {field.label}
          {field.hint && <span>{field.hint}</span>}
        </p>
      );

    case "toggle":
      return (
        <label className={"pill-check" + (value ? " on" : "")}>
          <input
            type="checkbox"
            checked={!!value}
            disabled={disabled}
            onChange={(e) => set(e.target.checked)}
          />
          {field.label}
        </label>
      );

    case "rating":
      return (
        <div className="rate-row">
          <span>{field.label}</span>
          <Rating value={Number(value) || 0} onChange={set} max={field.max ?? 5} />
        </div>
      );

    case "counter":
      return (
        <div className="rate-row inline">
          <span>{field.label}</span>
          <Stepper
            value={Number(value) || 0}
            onChange={set}
            min={field.min ?? 0}
            max={field.max ?? 999}
          />
        </div>
      );

    case "timer":
      return <TimerField field={field} value={Number(value) || 0} onChange={set} disabled={disabled} />;

    case "select":
      return (
        <div className="field" style={{ margin: 0 }}>
          <span>{field.label}</span>
          <Segmented
            options={(field.options || []).map((o) => ({
              value: o.value,
              label: o.label || o.value,
            }))}
            value={String(value ?? "")}
            onChange={set}
          />
          {field.hint && <p className="step-hint">{field.hint}</p>}
        </div>
      );

    case "multiselect":
    case "tags": {
      const chosen: string[] = Array.isArray(value) ? value : [];
      return (
        <div className="field" style={{ margin: 0 }}>
          <span>{field.label}</span>
          <div className="tag-list">
            {(field.options || []).map((o) => {
              const on = chosen.includes(o.value);
              const tone = o.tone ? ` ${o.tone}` : "";
              return (
                <button
                  key={o.value}
                  type="button"
                  disabled={disabled}
                  className={`chip${tone}` + (on ? " on" : "")}
                  onClick={() =>
                    set(on ? chosen.filter((c) => c !== o.value) : [...chosen, o.value])
                  }
                >
                  {o.label || o.value}
                </button>
              );
            })}
            {!(field.options || []).length && (
              <span className="faint">No options yet.</span>
            )}
          </div>
        </div>
      );
    }

    case "heatmap":
      return (
        <FieldInput
          points={(Array.isArray(value) ? value : []) as HeatPoint[]}
          onChange={(pts: HeatPoint[]) => set(pts)}
        />
      );

    case "photo":
      return <PhotoField field={field} value={String(value || "")} onChange={set} disabled={disabled} />;

    case "textarea":
      return (
        <label className="field" style={{ margin: 0 }}>
          <span>{field.label}</span>
          <textarea
            value={String(value ?? "")}
            disabled={disabled}
            placeholder={field.hint}
            onChange={(e) => set(e.target.value)}
          />
        </label>
      );

    case "number":
    case "team":
      return (
        <label className="field" style={{ margin: 0 }}>
          <span>{field.label}</span>
          <input
            type="number"
            inputMode="numeric"
            value={value === 0 && field.type === "team" ? "" : String(value ?? "")}
            disabled={disabled}
            min={field.min}
            max={field.max}
            placeholder={field.hint}
            onChange={(e) => set(e.target.value === "" ? 0 : Number(e.target.value))}
          />
        </label>
      );

    default:
      return (
        <label className="field" style={{ margin: 0 }}>
          <span>{field.label}</span>
          <input
            value={String(value ?? "")}
            disabled={disabled}
            placeholder={field.hint}
            onChange={(e) => set(e.target.value)}
          />
        </label>
      );
  }
}

/**
 * A stopwatch, for the "how long did the endgame take" question that turns up
 * in most games. Tap to start, tap to stop; the number stays editable because
 * a scout who forgot to start it should not have to fake a run.
 */
function TimerField({
  field,
  value,
  onChange,
  disabled,
}: {
  field: FormField;
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const [running, setRunning] = useState(false);
  const started = useRef(0);
  const tick = useRef<number | null>(null);

  function toggle() {
    if (disabled) return;
    if (running) {
      if (tick.current) window.clearInterval(tick.current);
      tick.current = null;
      setRunning(false);
      return;
    }
    started.current = Date.now() - value * 1000;
    setRunning(true);
    tick.current = window.setInterval(() => {
      onChange(Math.round((Date.now() - started.current) / 100) / 10);
    }, 100);
  }

  return (
    <div className="rate-row inline">
      <span>{field.label}</span>
      <div className="timer-field">
        <button type="button" className={"btn sm" + (running ? " primary" : "")} onClick={toggle} disabled={disabled}>
          {running ? "Stop" : "Start"}
        </button>
        <input
          type="number"
          step="0.1"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value) || 0)}
        />
        <span className="faint">s</span>
        {value > 0 && !running && (
          <button type="button" className="btn sm ghost" onClick={() => onChange(0)} disabled={disabled}>
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

/** Longest edge of a stored photo. See the note in the pit page. */
const MAX_PHOTO_EDGE = 1280;
const PHOTO_QUALITY = 0.72;

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

function PhotoField({
  field,
  value,
  onChange,
  disabled,
}: {
  field: FormField;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      onChange(await readPhoto(file));
      setError("");
    } catch (err: any) {
      setError(err?.message || "Could not use that photo");
    } finally {
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="field" style={{ margin: 0 }}>
      <span>{field.label}</span>
      <input
        ref={input}
        className="pit-file"
        type="file"
        accept="image/*"
        capture="environment"
        disabled={disabled}
        onChange={pick}
      />
      <div className="pit-photo">
        {value ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={value} alt={field.label} />
            <div className="btn-row">
              <button type="button" className="btn sm" disabled={disabled} onClick={() => input.current?.click()}>Retake</button>
              <button type="button" className="btn sm ghost" disabled={disabled} onClick={() => onChange("")}>Remove</button>
            </div>
          </>
        ) : (
          <button type="button" className="pit-photo-btn" disabled={disabled} onClick={() => input.current?.click()}>
            <Icon name="camera" size={22} />
            <b>Take a photo</b>
            <span>Opens the camera on a phone</span>
          </button>
        )}
      </div>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

/** Read-only rendering of a team answer, used by previews. */
export function TeamAnswer({ team }: { team: number }) {
  return <TeamIdentity team={{ team_number: team, nickname: "" }} />;
}

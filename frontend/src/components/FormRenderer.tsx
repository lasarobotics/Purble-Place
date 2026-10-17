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
import type {
  ActionRecord, FormDefinition, FormField, FormSection, GameDefinition,
} from "@/lib/formdef";
import { isVisible } from "@/lib/formdef";
import { Rating, Segmented, Stepper, TeamIdentity } from "@/components/ui";
import { FieldInput } from "@/components/Field";
import { Icon } from "@/components/icons";
import type { HeatPoint } from "@/lib/types";

export interface RendererProps {
  definition: FormDefinition;
  answers: Record<string, any>;
  onChange: (key: string, value: any) => void;
  /** The season's game. Phase, piece and location fields read their
   *  choices from it, which is what keeps the form itself game agnostic. */
  game?: GameDefinition | null;
  /** Preview mode: the controls render but do not accept input. */
  disabled?: boolean;
  /** Fields the caller draws itself (the scouting page owns match and slot). */
  skipKeys?: string[];
}

export function FormRenderer({
  definition,
  answers,
  onChange,
  game,
  disabled,
  skipKeys = [],
}: RendererProps) {
  const skip = new Set(skipKeys);
  return (
    <>
      {(definition.sections || []).map((section, i) => (
        <FormSectionCard
          key={`${section.title}-${i}`}
          section={section}
          answers={answers}
          onChange={onChange}
          game={game}
          disabled={disabled}
          skip={skip}
        />
      ))}
    </>
  );
}

function FormSectionCard({
  section,
  answers,
  onChange,
  game,
  disabled,
  skip,
}: {
  section: FormSection;
  answers: Record<string, any>;
  onChange: (key: string, value: any) => void;
  game?: GameDefinition | null;
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
        <div>
          <h3>{section.title}</h3>

        </div>
      </header>
      <div className="form-fields">
        {fields.map((field) => (
          <FieldControl
            key={field.key || field.label}
            field={field}
            value={answers[field.key]}
            onChange={(v) => onChange(field.key, v)}
            game={game}
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
  game,
  disabled,
}: {
  field: FormField;
  value: any;
  onChange: (v: any) => void;
  game?: GameDefinition | null;
  disabled?: boolean;
}) {
  const set = disabled ? () => {} : onChange;

  // Three field types take their choices from the season's game rather than
  // from options typed into the builder. That is the seam that lets one form
  // engine serve any game: the form says "ask which game piece", and the
  // season says which pieces there are.
  const fromGame = gameChoices(field, game);
  if (fromGame) {
    return (
      <div className="field" style={{ margin: 0 }}>
        <span>{field.label}</span>
        {fromGame.length ? (
          <Segmented options={fromGame} value={String(value ?? "")} onChange={set} />
        ) : (
          <></>
        )}

      </div>
    );
  }

  switch (field.type) {
    case "divider":
      return <hr className="form-divider" />;

    case "actions":
      return (
        <ActionGroup
          field={field}
          value={Array.isArray(value) ? value : []}
          onChange={set}
          game={game}
          disabled={disabled}
        />
      );

    case "slider":
      return (
        <div className="rate-row">
          <span>{field.label}</span>
          <div className="slider-field">
            <input
              type="range"
              min={field.min ?? 0}
              max={field.max ?? 10}
              step={field.step ?? 1}
              value={Number(value) || 0}
              disabled={disabled}
              onChange={(e) => set(Number(e.target.value))}
            />
            <b className="mono">{Number(value) || 0}</b>
          </div>
        </div>
      );

    case "datetime":
      return (
        <label className="field" style={{ margin: 0 }}>
          <span>{field.label}</span>
          <input
            type="datetime-local"
            value={String(value ?? "")}
            disabled={disabled}
            onChange={(e) => set(e.target.value)}
          />
        </label>
      );

    case "alliance":
      return (
        <div className="field" style={{ margin: 0 }}>
          <span>{field.label}</span>
          <Segmented
            options={[{ value: "red", label: "Red" }, { value: "blue", label: "Blue" }]}
            value={String(value ?? "red")}
            onChange={set}
            color={(v) => v as any}
          />
        </div>
      );

    case "station":
      return (
        <div className="field" style={{ margin: 0 }}>
          <span>{field.label}</span>
          <Segmented
            options={[1, 2, 3].map((n) => ({ value: String(n), label: String(n) }))}
            value={String(value ?? 1)}
            onChange={(v) => set(Number(v))}
          />
        </div>
      );

    case "dropdown":
      return (
        <label className="field" style={{ margin: 0 }}>
          <span>{field.label}</span>
          <select value={String(value ?? "")} disabled={disabled}
                  onChange={(e) => set(e.target.value)}>
            {(field.options || []).map((o) => (
              <option key={o.value} value={o.value}>{o.label || o.value}</option>
            ))}
          </select>
        </label>
      );

    case "ranking":
      return (
        <RankingField field={field} value={Array.isArray(value) ? value : []}
                      onChange={set} disabled={disabled} />
      );

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
      return <PhotoField field={field} value={Array.isArray(value) ? value : value ? [String(value)] : []} onChange={set} disabled={disabled} />;

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
    case "decimal":
    case "team":
    case "match":
      return (
        <label className="field" style={{ margin: 0 }}>
          <span>{field.label}</span>
          <input
            type="number"
            inputMode="numeric"
            value={value === 0 && (field.type === "team" || field.type === "match") ? "" : String(value ?? "")}
            disabled={disabled}
            min={field.type === "team" || field.type === "match" ? Math.max(1, field.min ?? 1) : field.min}
            max={field.max}
            step={field.type === "decimal" ? (field.step ?? 0.1) : field.step}
            placeholder={field.hint}
            onChange={(e) => {
              const next = e.target.value === "" ? 0 : Number(e.target.value);
              set(field.type === "team" || field.type === "match" ? Math.max(0, next) : next);
            }}
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
  value: string[];
  onChange: (v: string[]) => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    try {
      const added = await Promise.all(files.map(readPhoto));
      onChange([...value, ...added]);
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
        multiple
        disabled={disabled}
        onChange={pick}
      />
      <div className="pit-photo">
        {value.length ? (
          <>
            <div className="pit-photo-grid">
              {value.map((photo, index) => (
                <figure key={`${photo.slice(-32)}-${index}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={photo} alt={`${field.label} ${index + 1}`} />
                  <button type="button" className="btn sm ghost" disabled={disabled}
                    onClick={() => onChange(value.filter((_, i) => i !== index))}>Remove</button>
                </figure>
              ))}
            </div>
            <div className="btn-row">
              <button type="button" className="btn sm" disabled={disabled} onClick={() => input.current?.click()}>Add more photos</button>
              <span className="faint">{value.length} saved with this report</span>
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

// --------------------------------------------------------------------------
// Choices that come from the season's game
// --------------------------------------------------------------------------

/**
 * Options for a field whose choices belong to the game, not to the form.
 *
 * Returns null for every other field type, so the caller can tell "this is
 * not a game-sourced field" apart from "it is, and the season has none".
 */
function gameChoices(
  field: FormField,
  game?: GameDefinition | null
): { value: string; label: string }[] | null {
  const source =
    field.type === "phase" ? game?.phases
    : field.type === "piece" ? game?.pieces
    : field.type === "location" ? game?.locations
    : null;
  if (source === null) return null;
  return (source || []).map((o: any) => ({ value: o.key, label: o.label || o.key }));
}

// --------------------------------------------------------------------------
// Repeatable actions
// --------------------------------------------------------------------------

/**
 * The generic answer to "this game involves doing a thing over and over".
 *
 * Every FRC game has some repeated act at its centre: a shot, a placement, a
 * stack, a delivery. Building one component per game would mean a new
 * component every January, so this is one component whose columns come from
 * the season: the phases it offers, the pieces, the locations and the results
 * are all the game's own.
 *
 * Recording is two taps for the common case. The picker at the top holds the
 * current phase, piece and location, and each result button adds a row with
 * those values, because a scout in the stands cannot fill in four dropdowns
 * per cycle.
 */
function ActionGroup({
  field,
  value,
  onChange,
  game,
  disabled,
}: {
  field: FormField;
  value: ActionRecord[];
  onChange: (v: ActionRecord[]) => void;
  game?: GameDefinition | null;
  disabled?: boolean;
}) {
  const label = (list: any[] | undefined, key: string) =>
    (list || []).find((x: any) => x.key === key)?.label || key;

  const phases = (field.phases || []).map((k) => ({ value: k, label: label(game?.phases, k) }));
  const pieces = (field.objects || []).map((k) => ({ value: k, label: label(game?.pieces, k) }));
  const places = (field.locations || []).map((k) => ({ value: k, label: label(game?.locations, k) }));
  const results = field.results || ["made", "missed"];

  const [phase, setPhase] = useState(phases[0]?.value || "");
  const [piece, setPiece] = useState(pieces[0]?.value || "");
  const [place, setPlace] = useState(places[0]?.value || "");

  function add(result: string) {
    if (disabled) return;
    onChange([
      ...value,
      {
        action: field.action || "action",
        ...(phase ? { phase } : {}),
        ...(piece ? { object: piece } : {}),
        ...(place ? { location: place } : {}),
        result,
        t: Date.now(),
      },
    ]);
  }

  function undo() {
    if (disabled) return;
    onChange(value.slice(0, -1));
  }

  const tally = results.map((r) => ({
    result: r,
    count: value.filter((v) => v.result === r).length,
  }));

  return (
    <div className="action-group">
      <div className="action-group-head">
        <span>{field.label}</span>
        <span className="action-tally">
          {tally.map((t) => (
            <span key={t.result}>
              <b className="mono">{t.count}</b> {t.result}
            </span>
          ))}
        </span>
      </div>


      {phases.length > 1 && (
        <div className="action-picker">
          <span>Phase</span>
          <Segmented options={phases} value={phase} onChange={setPhase} />
        </div>
      )}
      {pieces.length > 1 && (
        <div className="action-picker">
          <span>Piece</span>
          <Segmented options={pieces} value={piece} onChange={setPiece} />
        </div>
      )}
      {places.length > 1 && (
        <div className="action-picker">
          <span>Where</span>
          <Segmented options={places} value={place} onChange={setPlace} />
        </div>
      )}

      <div className="action-buttons">
        {results.map((r) => (
          <button
            key={r}
            type="button"
            className={"btn" + (r === "made" ? " primary" : "")}
            disabled={disabled}
            onClick={() => add(r)}
          >
            + {r}
          </button>
        ))}
        <button type="button" className="btn ghost" disabled={disabled || !value.length}
                onClick={undo}>
          Undo
        </button>
      </div>

      {value.length > 0 && (
        <ol className="action-log">
          {value.slice(-6).reverse().map((rec, i) => (
            <li key={value.length - i}>
              <span className="mono">{value.length - i}</span>
              <span>
                {[rec.phase && label(game?.phases, rec.phase),
                  rec.object && label(game?.pieces, rec.object),
                  rec.location && label(game?.locations, rec.location)]
                  .filter(Boolean).join(" / ")}
              </span>
              <span className={"badge " + (rec.result === "made" ? "green" : "muted")}>
                {rec.result}
              </span>
            </li>
          ))}
          {value.length > 6 && (
            <li className="faint">and {value.length - 6} earlier</li>
          )}
        </ol>
      )}
    </div>
  );
}

/** Put options in order. Tap to add to the ranking, tap again to remove. */
function RankingField({
  field,
  value,
  onChange,
  disabled,
}: {
  field: FormField;
  value: string[];
  onChange: (v: string[]) => void;
  disabled?: boolean;
}) {
  const options = field.options || [];
  const remaining = options.filter((o) => !value.includes(o.value));
  const labelOf = (v: string) => options.find((o) => o.value === v)?.label || v;

  return (
    <div className="field" style={{ margin: 0 }}>
      <span>{field.label}</span>
      <ol className="ranking-list">
        {value.map((v, i) => (
          <li key={v}>
            <span className="rank-chip sm">{i + 1}</span>
            <span className="grow">{labelOf(v)}</span>
            <button type="button" className="btn sm ghost" disabled={disabled}
                    onClick={() => onChange(value.filter((x) => x !== v))}>
              Remove
            </button>
          </li>
        ))}
        {!value.length && <li className="faint">Nothing ranked yet.</li>}
      </ol>
      {remaining.length > 0 && (
        <div className="tag-list" style={{ marginTop: 6 }}>
          {remaining.map((o) => (
            <button key={o.value} type="button" className="chip" disabled={disabled}
                    onClick={() => onChange([...value, o.value])}>
              {o.label || o.value}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

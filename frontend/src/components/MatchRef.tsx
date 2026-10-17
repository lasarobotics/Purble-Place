"use client";
// Rendering and editing the `@match` references described in lib/matchref.ts.
//
// Three pieces: a read-only renderer that turns the references into tappable
// chips, the popup those chips open, and a textarea that offers the field
// picker while you type. They are together because they share one idea and
// changing the token format should mean changing one file.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import {
  ALL_MATCHES,
  activeRefAt,
  completeRef,
  fieldLabel,
  fieldsFor,
  hasRefs,
  parseNote,
  refLabel,
  type ActiveRef,
  type RefTarget,
} from "@/lib/matchref";
import type { MatchReport } from "@/lib/types";
import { Modal } from "@/components/ui";

// --------------------------------------------------------------------------
// Read-only note
// --------------------------------------------------------------------------

/**
 * A justification with its match references turned into chips.
 *
 * `team` is the team the note is about, which is what decides whose report
 * gets pulled out of the match.
 */
export function NoteText({ note, team }: { note: string; team: number }) {
  const [open, setOpen] = useState<{ match: RefTarget; field: string } | null>(null);
  const segments = useMemo(() => parseNote(note || ""), [note]);
  if (!note) return null;

  return (
    <>
      <span className="note-text">
        {segments.map((seg, i) =>
          seg.type === "text" ? (
            <span key={i}>{seg.text}</span>
          ) : (
            <button
              key={i}
              type="button"
              className="match-ref"
              title={
                seg.match === ALL_MATCHES
                  ? `${fieldLabel(seg.field)} across every match for team ${team}`
                  : `Qual ${seg.match} report for team ${team}`
              }
              onClick={(e) => {
                // These sit inside cards that open a team modal of their own.
                e.stopPropagation();
                const shared = new CustomEvent("hazehub-match-ref-open", { cancelable: true, detail: { team, match: seg.match, field: seg.field } });
                if (!window.dispatchEvent(shared)) return;
                setOpen({ match: seg.match, field: seg.field });
              }}
            >
              {refLabel(seg.match)}
              {seg.field !== "all" && <span className="match-ref-field">{fieldLabel(seg.field)}</span>}
            </button>
          )
        )}
      </span>
      {open && (
        <MatchRefModal
          match={open.match}
          field={open.field}
          team={team}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

// --------------------------------------------------------------------------
// Reading a report
// --------------------------------------------------------------------------

const NA = "-";

function climbLabel(v: string) {
  return v && v !== "none" ? v.toUpperCase() : "No climb";
}

function heatCounts(report: MatchReport) {
  const c = { autoMade: 0, autoMiss: 0, teleMade: 0, teleMiss: 0 };
  for (const p of report.heatmap || []) {
    const made = p.result === "made";
    if (p.phase === "auto") made ? c.autoMade++ : c.autoMiss++;
    else made ? c.teleMade++ : c.teleMiss++;
  }
  return c;
}

interface Row {
  key: string;
  label: string;
  value: React.ReactNode;
}

/** Every row of one report, in a fixed order. */
function reportRows(r: MatchReport): Row[] {
  const c = heatCounts(r);
  return [
    { key: "points", label: "Points", value: r.points ?? NA },
    {
      key: "auto",
      label: "Auto",
      value: `${r.auto_leave ? "left the zone" : "stayed put"}${r.auto_climb ? ", auto climb" : ""}, ${c.autoMade}/${c.autoMade + c.autoMiss} scored`,
    },
    { key: "climb", label: "Climb", value: climbLabel(r.climb) },
    {
      key: "defense",
      label: "Defense",
      value: r.played_defense
        ? `${r.defense_rating}/5, ${r.successful_stops} stop${r.successful_stops === 1 ? "" : "s"}${r.defense_on ? ` on ${r.defense_on}` : ""}`
        : "Did not play defense",
    },
    { key: "driver", label: "Driver skill", value: `${r.driver_skill}/5` },
    {
      key: "speed",
      label: "Speed / cycling",
      value: `${r.speed_rating}/5, ${c.teleMade}/${c.teleMade + c.teleMiss} scored in teleop`,
    },
    { key: "fouls", label: "Fouls", value: r.fouls },
    {
      key: "tags",
      label: "Quick tags",
      value: r.tags?.length ? (
        <span className="tag-list">
          {r.tags.map((t) => <span key={t} className="chip static sm">{t}</span>)}
        </span>
      ) : "None tapped",
    },
    { key: "notes", label: "Scout comments", value: r.notes || "Nothing written" },
    {
      key: "reliability",
      label: "Reliability",
      value: r.no_show
        ? "Never showed up"
        : r.failure
          ? `Broke down${r.failure_details ? `: ${r.failure_details}` : ""}`
          : "No problems reported",
    },
  ];
}

function rowFor(field: string, r: MatchReport): Row | undefined {
  return reportRows(r).find((row) => row.key === field);
}

// --------------------------------------------------------------------------
// The popup
// --------------------------------------------------------------------------

export function MatchRefModal({
  match,
  field,
  team,
  onClose,
}: {
  match: RefTarget;
  field: string;
  team: number;
  onClose: () => void;
}) {
  const [reports, setReports] = useState<MatchReport[] | null>(null);
  const [error, setError] = useState("");
  const everyMatch = match === ALL_MATCHES;

  useEffect(() => {
    let alive = true;
    const path = everyMatch ? `/api/scout/team/${team}` : `/api/scout/match/${match}`;
    api<MatchReport[]>(path)
      .then((rows) => {
        if (!alive) return;
        setReports(everyMatch ? rows : rows.filter((r) => r.team_number === team));
      })
      .catch((e) => alive && setError(e?.message || "Could not load that scouting"));
    return () => { alive = false; };
  }, [match, team, everyMatch]);

  const subtitle = everyMatch
    ? `${fieldLabel(field)}, every match`
    : field === "all"
      ? "Full scouting report"
      : `Full report, ${fieldLabel(field)} highlighted`;

  return (
    <Modal onClose={onClose}>
      <div className="ref-modal">
        <div className="card-h">
          <div>
            <h3>{everyMatch ? `Team ${team}` : `Qual ${match}, team ${team}`}</h3>
            <span className="ref-modal-sub">{subtitle}</span>
          </div>
          <button className="btn sm ghost" onClick={onClose}>Close</button>
        </div>

        {error && <p className="muted">{error}</p>}
        {!error && reports === null && <RefSkeleton />}

        {reports?.length === 0 && (
          <p className="muted empty-line">
            {everyMatch
              ? `Nobody has scouted team ${team} at this event yet.`
              : `Nobody scouted team ${team} in qual ${match}, so there is nothing to show.`}
          </p>
        )}

        {reports && reports.length > 0 && (
          everyMatch
            ? <AcrossMatches reports={reports} field={field} />
            : <SingleMatch reports={reports} field={field} />
        )}
      </div>
    </Modal>
  );
}

/**
 * One match, whole report.
 *
 * A field on the reference narrows attention rather than hiding context: a
 * fouls count on its own says nothing, but a fouls count next to the points,
 * the defense rating and the scout's comments from that same match is an
 * argument. So the row is marked and the rest stays.
 */
function SingleMatch({ reports, field }: { reports: MatchReport[]; field: string }) {
  return (
    <>
      {reports.map((r, i) => (
        <div key={r.submission_id || r.client_uuid || i} className="ref-report">
          {reports.length > 1 && (
            <div className="ref-report-who">
              Reported by {r.scout_id || "unknown scout"}
            </div>
          )}
          <dl className="ref-rows">
            {reportRows(r).map((row) => (
              <div key={row.key} className={row.key === field ? "ref-row-marked" : undefined}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      {reports.length > 1 && (
        <></>
      )}
    </>
  );
}

/**
 * One measurement, every match.
 *
 * The opposite question to a single match: not "what happened in qual 42" but
 * "does this robot climb". So it shows only the asked-for field, once per
 * match, in match order, and nothing else.
 */
function AcrossMatches({ reports, field }: { reports: MatchReport[]; field: string }) {
  const rows = reports
    .map((r) => ({ report: r, row: rowFor(field, r) }))
    .filter((x) => x.row);
  const matches = new Set(reports.map((r) => r.match_number)).size;

  return (
    <>
      <ul className="ref-across">
        {rows.map(({ report, row }, i) => (
          <li key={report.submission_id || report.client_uuid || i}>
            <span className="ref-across-match">Q{report.match_number}</span>
            <span className="ref-across-value">{row!.value}</span>
            <span className="ref-across-scout">{report.scout_id || ""}</span>
          </li>
        ))}
      </ul>

    </>
  );
}

function RefSkeleton() {
  return (
    <div className="skeleton-rows" aria-label="Loading">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="skeleton-row">
          <span className="skeleton skeleton-label" />
          <span className="skeleton skeleton-value" />
        </div>
      ))}
    </div>
  );
}

// --------------------------------------------------------------------------
// The editor
// --------------------------------------------------------------------------

/**
 * A justification textarea that offers the field picker after `@42`.
 *
 * The picker is a plain list under the textarea rather than a floating popup
 * anchored to the caret: caret coordinates in a textarea can only be measured
 * with a mirrored element, and on the phones this runs on a full-width list
 * is easier to hit anyway.
 */
export function NoteEditor({
  value,
  onChange,
  team,
  readOnly,
  placeholder,
  rows = 2,
}: {
  value: string;
  onChange: (v: string) => void;
  /** The team the note is about; decides whose report a reference pulls. */
  team: number;
  readOnly?: boolean;
  placeholder?: string;
  rows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [active, setActive] = useState<ActiveRef | null>(null);
  const [caret, setCaret] = useState(0);
  // A note with references is shown as chips whenever it is not being typed
  // in, so the person who wrote it can open their own evidence too. Clicking
  // anywhere else in the box puts the cursor back and returns to plain text.
  const [editing, setEditing] = useState(false);

  const sync = useCallback((el: HTMLTextAreaElement) => {
    const pos = el.selectionStart ?? el.value.length;
    setCaret(pos);
    setActive(readOnly ? null : activeRefAt(el.value, pos));
  }, [readOnly]);

  const options = useMemo(
    () =>
      active
        ? fieldsFor(active.match).filter((f) => !active.query || f.key.startsWith(active.query))
        : [],
    [active]
  );

  function choose(fieldKey: string) {
    if (!active) return;
    const next = completeRef(value, active, caret, fieldKey);
    onChange(next.text);
    setActive(null);
    // Put the caret back after the token so typing carries on naturally.
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  }

  // Focus once the textarea actually exists. Doing it inside the click
  // handler raced the render and left the note stuck open in edit mode with
  // nothing focused, so no blur ever came to switch it back.
  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  const showPreview = !editing && hasRefs(value);
  if (showPreview) {
    return (
      <div
        className={"note-editor note-preview" + (readOnly ? " read-only" : "")}
        onClick={readOnly ? undefined : () => setEditing(true)}
        title={readOnly ? undefined : "Click to edit"}
      >
        <NoteText note={value} team={team} />
      </div>
    );
  }

  return (
    <div className="note-editor">
      <textarea
        ref={ref}
        className="pick-note"
        value={value}
        rows={rows}
        maxLength={1000}
        readOnly={readOnly}
        placeholder={placeholder}
        onChange={(e) => { onChange(e.target.value); sync(e.target); }}
        onKeyUp={(e) => sync(e.currentTarget)}
        onClick={(e) => sync(e.currentTarget)}
        onBlur={() => {
          // Delayed so a click on an option still lands before the list goes.
          setTimeout(() => { setActive(null); setEditing(false); }, 150);
        }}
      />
      {active && options.length > 0 && (
        <div className="ref-picker">
          <div className="ref-picker-head">
            {active.match === ALL_MATCHES
              ? "Pull from every match"
              : `Pull from qual ${active.match}`}
          </div>
          {options.map((f) => (
            <button
              key={f.key}
              type="button"
              className="ref-picker-item"
              // onMouseDown so the choice registers before the textarea blurs.
              onMouseDown={(e) => { e.preventDefault(); choose(f.key); }}
            >
              <b>{f.label}</b>
              <span>
                {active.match === ALL_MATCHES ? `${f.hint}, every match` : f.hint}
              </span>
            </button>
          ))}
        </div>
      )}
      {!readOnly && !active && (
        <></>
      )}
    </div>
  );
}

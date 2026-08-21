// Match references inside picklist justifications.
//
// A justification is only as convincing as the evidence behind it, and during
// a picklist meeting nobody has time to go and look the evidence up. Typing
// "@42" while writing why a team deserves a spot pins that team's scouting
// report from qual 42 to the sentence; the reader taps it and sees the
// numbers without leaving the list.
//
// The stored form is plain text -- `@42` or `@42:climb` -- so a note written
// with references is still perfectly readable in the database, in an export,
// or by an older build that knows nothing about this file.

export interface RefField {
  key: string;
  label: string;
  /** Shown in the picker, one line, says what gets pulled in. */
  hint: string;
}

/** What a reference can point at. `all` is the whole report. */
export const REF_FIELDS: RefField[] = [
  { key: "all", label: "Full report", hint: "Everything the scout recorded" },
  { key: "points", label: "Points", hint: "Points scored in the match" },
  { key: "auto", label: "Auto", hint: "Leave, auto climb, auto accuracy" },
  { key: "climb", label: "Climb", hint: "Endgame climb level" },
  { key: "defense", label: "Defense", hint: "Defense rating and stops" },
  { key: "driver", label: "Driver skill", hint: "Driver rating out of 5" },
  { key: "speed", label: "Speed", hint: "Cycle speed rating out of 5" },
  { key: "fouls", label: "Fouls", hint: "Fouls charged" },
  { key: "tags", label: "Quick tags", hint: "The tags the scout tapped" },
  { key: "notes", label: "Scout comments", hint: "What the scout typed" },
  { key: "reliability", label: "Reliability", hint: "Breakdowns and no-shows" },
];

export const DEFAULT_REF_FIELD = "all";

export function fieldLabel(key: string): string {
  return REF_FIELDS.find((f) => f.key === key)?.label ?? key;
}

/** `@42` and `@42:climb`. Case-insensitive on the field name. */
const REF_PATTERN = /@(\d{1,3})(?::([a-z]+))?/gi;

export type NoteSegment =
  | { type: "text"; text: string }
  | { type: "ref"; text: string; match: number; field: string };

/** Split a justification into plain runs and match references. */
export function parseNote(note: string): NoteSegment[] {
  const out: NoteSegment[] = [];
  if (!note) return out;
  let last = 0;
  REF_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REF_PATTERN.exec(note)) !== null) {
    const field = (m[2] || DEFAULT_REF_FIELD).toLowerCase();
    // An unknown field name is almost certainly a word that happened to
    // follow a number, so leave it as text rather than inventing a chip.
    if (!REF_FIELDS.some((f) => f.key === field)) continue;
    if (m.index > last) out.push({ type: "text", text: note.slice(last, m.index) });
    out.push({ type: "ref", text: m[0], match: parseInt(m[1], 10), field });
    last = m.index + m[0].length;
  }
  if (last < note.length) out.push({ type: "text", text: note.slice(last) });
  return out;
}

export function hasRefs(note: string): boolean {
  return parseNote(note).some((s) => s.type === "ref");
}

/** The `@…` the caret is currently sitting in, if any. */
export interface ActiveRef {
  /** Index in the text where the `@` is. */
  start: number;
  match: number;
  /** What has been typed after the colon so far, for filtering. */
  query: string;
}

export function activeRefAt(text: string, caret: number): ActiveRef | null {
  const before = text.slice(0, caret);
  // Only fires while the caret is still inside the token, so typing "@42 is
  // great" dismisses the picker as soon as the space lands.
  const m = /@(\d{1,3})(?::([a-z]*))?$/i.exec(before);
  if (!m) return null;
  return {
    start: caret - m[0].length,
    match: parseInt(m[1], 10),
    query: (m[2] || "").toLowerCase(),
  };
}

/** Replace the token the caret is in with a complete `@match:field`. */
export function completeRef(
  text: string,
  active: ActiveRef,
  caret: number,
  field: string
): { text: string; caret: number } {
  const token = `@${active.match}:${field} `;
  const next = text.slice(0, active.start) + token + text.slice(caret);
  return { text: next, caret: active.start + token.length };
}

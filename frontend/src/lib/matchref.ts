// Match references inside picklist justifications.
//
// A justification is only as convincing as the evidence behind it, and during
// a picklist meeting nobody has time to go and look the evidence up. Typing
// "@42" while writing why a team deserves a spot pins that team's scouting
// report from qual 42 to the sentence; the reader taps it and sees the
// numbers without leaving the list.
//
// Two forms:
//
//   @42          the whole qual 42 report
//   @42:climb    the whole qual 42 report, with the climb row called out
//   @all:climb   just the climb, from every report on that team this event
//
// A field on a single match narrows what the reader should look at, it does
// not hide the rest: the number only means something next to the match it
// came from, so the row is highlighted in place. "@all" is the opposite
// question, one measurement across the event, so there the field is all you
// get and every match is listed under it.
//
// The stored form is plain text, so a note written with references is still
// readable in the database, in an export, or by a build that knows nothing
// about this file.

export interface RefField {
  key: string;
  label: string;
  /** Shown in the picker, one line, says what gets pulled in. */
  hint: string;
}

/** What a reference can point at. `all` means the whole report. */
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

/** The match part of a reference: a qual number, or every match. */
export type RefTarget = number | "all";

export const ALL_MATCHES: RefTarget = "all";

export function fieldLabel(key: string): string {
  return REF_FIELDS.find((f) => f.key === key)?.label ?? key;
}

export function isKnownField(key: string): boolean {
  return REF_FIELDS.some((f) => f.key === key);
}

/** `@42`, `@42:climb`, `@all:climb`. Case-insensitive on the names. */
const REF_PATTERN = /@(\d{1,3}|all)(?::([a-z]+))?/gi;

export type NoteSegment =
  | { type: "text"; text: string }
  | { type: "ref"; text: string; match: RefTarget; field: string };

function parseTarget(raw: string): RefTarget {
  return raw.toLowerCase() === "all" ? ALL_MATCHES : parseInt(raw, 10);
}

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
    if (!isKnownField(field)) continue;
    // "@all" on its own has no measurement to show, so it is not a reference.
    const target = parseTarget(m[1]);
    if (target === ALL_MATCHES && field === DEFAULT_REF_FIELD) continue;
    if (m.index > last) out.push({ type: "text", text: note.slice(last, m.index) });
    out.push({ type: "ref", text: m[0], match: target, field });
    last = m.index + m[0].length;
  }
  if (last < note.length) out.push({ type: "text", text: note.slice(last) });
  return out;
}

export function hasRefs(note: string): boolean {
  return parseNote(note).some((s) => s.type === "ref");
}

/** Short label for the chip, e.g. "Q12" or "All". */
export function refLabel(target: RefTarget): string {
  return target === ALL_MATCHES ? "All" : `Q${target}`;
}

/** The `@...` the caret is currently sitting in, if any. */
export interface ActiveRef {
  /** Index in the text where the `@` is. */
  start: number;
  match: RefTarget;
  /** What has been typed after the colon so far, for filtering. */
  query: string;
}

export function activeRefAt(text: string, caret: number): ActiveRef | null {
  const before = text.slice(0, caret);
  // Only fires while the caret is still inside the token, so typing "@42 is
  // great" dismisses the picker as soon as the space lands.
  const m = /@(\d{1,3}|all|al|a)(?::([a-z]*))?$/i.exec(before);
  if (!m) return null;
  const word = m[1].toLowerCase();
  // "a" and "al" are the way to "all", but they are also the start of a
  // number-less typo. Only offer the picker once it is unambiguous.
  if (/^[a-z]+$/.test(word) && word !== "all") return null;
  return {
    start: caret - m[0].length,
    match: parseTarget(m[1]),
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
  const target = active.match === ALL_MATCHES ? "all" : String(active.match);
  const token = `@${target}:${field} `;
  const next = text.slice(0, active.start) + token + text.slice(caret);
  return { text: next, caret: active.start + token.length };
}

/** The fields offerable for a target. "@all" has no whole-report option. */
export function fieldsFor(target: RefTarget): RefField[] {
  return target === ALL_MATCHES
    ? REF_FIELDS.filter((f) => f.key !== DEFAULT_REF_FIELD)
    : REF_FIELDS;
}

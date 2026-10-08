"use client";
// Form definitions: the shape of a scouting form, and the API around it.
//
// The server owns the vocabulary (backend/app/forms.py). These types mirror
// it, and the builder fetches the catalogue of field types from /api/forms/meta
// rather than hardcoding a second copy, so adding a control is one edit on the
// server and not two that drift apart.
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

export type FieldType =
  // Basic
  | "text" | "textarea" | "number" | "decimal" | "toggle" | "rating"
  | "slider" | "datetime"
  // Choice
  | "select" | "dropdown" | "multiselect" | "tags" | "ranking"
  // Scouting primitives
  | "counter" | "timer" | "team" | "match" | "alliance" | "station"
  | "phase" | "piece" | "location" | "heatmap" | "photo"
  // Repeated data
  | "actions"
  // Structure
  | "note" | "divider";

export interface FieldOption {
  value: string;
  label?: string;
  /** Points this option is worth, for scoring. */
  points?: number;
  /** "good" or "bad", used by tag chips. */
  tone?: "good" | "bad";
}

/** Show this field only when another field has a given value. */
export interface VisibleIf {
  field: string;
  equals: unknown;
}

export interface FormField {
  /** Stable. The answer is stored under this name forever. */
  key: string;
  type: FieldType;
  label: string;
  hint?: string;
  required?: boolean;
  options?: FieldOption[];
  min?: number;
  max?: number;
  step?: number;
  default?: unknown;
  /** Feeds one of the columns the built-in analytics read. */
  maps_to?: string;
  /** Points per unit (counter, number) or flat (toggle). */
  points?: number;
  visible_if?: VisibleIf;

  // Repeatable action groups. Which action they record, and what the scout
  // may pick for each row. The lists come from the season's game, so a form
  // never names a game element itself.
  action?: string;
  phases?: string[];
  objects?: string[];
  locations?: string[];
  results?: string[];
}

/** One recorded action inside a repeatable group. */
export interface ActionRecord {
  action: string;
  phase?: string;
  object?: string;
  location?: string;
  result?: string;
  quantity?: number;
  t?: number;
}

export interface FormSection {
  title: string;
  hint?: string;
  fields: FormField[];
}

export interface FormDefinition {
  name: string;
  description?: string;
  sections: FormSection[];
}

export interface FormSummary {
  form_id: string;
  kind: "match" | "pit" | "custom";
  season_id: string;
  name: string;
  description: string;
  published_version: number;
  latest_version: number;
  archived: boolean;
  updated_at: string;
  updated_by: string;
}

export interface FormWithDefinition extends FormSummary {
  definition: FormDefinition;
  /** Present on the active-form lookup: the season's game, which is what
   *  phase, piece and location fields draw their choices from. */
  game?: GameDefinition;
  game_version?: number;
}

// --------------------------------------------------------------------------
// The season's game
// --------------------------------------------------------------------------
export interface GamePhase { key: string; label: string; order?: number; seconds?: number }
export interface GamePieceDef { key: string; label: string; color?: string }
export interface GameLocation { key: string; label: string; group?: string; x?: number | null; y?: number | null }
export interface GameAction {
  key: string; label: string;
  phases?: string[]; objects?: string[]; locations?: string[]; results?: string[];
}
export interface GameEndgameState { key: string; label: string; points?: number }
export interface GameScoringRule {
  rule_id: string; label: string; points: number;
  per: "each" | "once"; when: Record<string, any>;
}
export interface GameFieldMap {
  image?: string;
  zones?: { location: string; x: number; y: number; w: number; h: number }[];
  mode?: "point" | "zone";
  orientation?: string;
}
export interface GameDefinition {
  name: string;
  year: number;
  phases: GamePhase[];
  pieces: GamePieceDef[];
  locations: GameLocation[];
  actions: GameAction[];
  rules: GameScoringRule[];
  endgame: GameEndgameState[];
  endgame_label: string;
  endgame_none?: string;
  tags: { tag: string; tone: "good" | "bad" }[];
  field_map: GameFieldMap;
  extras?: Record<string, any>;
  season_id?: string;
  game_version?: number;
}

export interface RevisionSummary {
  version: number;
  parent_version: number;
  message: string;
  author_id: string;
  author_name: string;
  created_at: string;
  reverted_from: number;
  summary: string;
  published: boolean;
  latest: boolean;
}

export interface CoreWarning {
  field: string;
  consequence: string;
}

export interface FieldTypeMeta {
  type: FieldType;
  label: string;
  hint: string;
  needs_options: boolean;
  collects_answer: boolean;
}

export interface BuilderMeta {
  field_types: FieldTypeMeta[];
  core_fields: { key: string; description: string }[];
  kinds: string[];
}

export interface DiffChange {
  key: string;
  label?: string;
  changes: { property: string; from: unknown; to: unknown }[];
}

export interface FormDiff {
  from: number;
  to: number;
  added: { key: string; label?: string; type?: string }[];
  removed: { key: string; label?: string; type?: string }[];
  changed: DiffChange[];
  moved: { key: string; label?: string; from?: string; to?: string }[];
  sections: { from: (string | undefined)[]; to: (string | undefined)[] };
  total: number;
}

// --------------------------------------------------------------------------
// API
// --------------------------------------------------------------------------
export const listForms = (includeArchived = false, season = "") =>
  api<FormSummary[]>(
    `/api/forms?include_archived=${includeArchived}` +
      (season ? `&season=${encodeURIComponent(season)}` : "")
  );

/** The published form of a kind for a season, plus that season's game.
 *
 *  Scouting pages use this rather than a form ID: IDs are season scoped, so
 *  hardcoding one in the frontend would defeat the point of having seasons. */
export const activeForm = (kind: string, season = "") =>
  api<FormWithDefinition>(
    `/api/forms/active/${kind}` + (season ? `?season=${encodeURIComponent(season)}` : "")
  );

export const getForm = (formId: string) =>
  api<FormWithDefinition>(`/api/forms/${formId}`);

export const getHistory = (formId: string) =>
  api<RevisionSummary[]>(`/api/forms/${formId}/history`);

export const getRevision = (formId: string, version: number) =>
  api<{ definition: FormDefinition; warnings: CoreWarning[] } & RevisionSummary>(
    `/api/forms/${formId}/revisions/${version}`
  );

export const getDiff = (formId: string, from: number, to: number) =>
  api<FormDiff>(`/api/forms/${formId}/diff?from_version=${from}&to_version=${to}`);

export const getBuilderMeta = () => api<BuilderMeta>("/api/forms/meta");

export const validateDefinition = (definition: FormDefinition) =>
  api<{ problems: string[]; warnings: CoreWarning[] }>("/api/forms/validate", {
    method: "POST",
    body: { definition },
  });

export const saveRevision = (
  formId: string,
  definition: FormDefinition,
  message: string,
  expectedVersion: number | null,
  publish = true
) =>
  api<{ version: number; summary: string; warnings: CoreWarning[] }>(
    `/api/forms/${formId}/revisions`,
    { method: "POST", body: { definition, message, publish, expected_version: expectedVersion } }
  );

export const publishVersion = (formId: string, version: number) =>
  api<FormSummary>(`/api/forms/${formId}/publish`, { method: "POST", body: { version } });

export const revertTo = (formId: string, version: number, message = "") =>
  api<{ version: number; reverted_from: number; summary: string }>(
    `/api/forms/${formId}/revert`,
    { method: "POST", body: { version, message } }
  );

export const createForm = (
  formId: string,
  kind: string,
  definition: FormDefinition,
  message = "Create form",
  seasonId = ""
) =>
  api<{ form_id: string; version: number }>("/api/forms", {
    method: "POST",
    body: { form_id: formId, kind, definition, message, season_id: seasonId },
  });

export const archiveForm = (formId: string) =>
  api<FormSummary>(`/api/forms/${formId}`, { method: "DELETE" });

export const restoreForm = (formId: string) =>
  api<FormSummary>(`/api/forms/${formId}/restore`, { method: "POST" });

// --------------------------------------------------------------------------
// Offline-tolerant read of a published form
// --------------------------------------------------------------------------
const cacheKey = (formId: string) => `hazehub.form.${formId}`;

/**
 * The published definition, cached per device.
 *
 * A scout who opens the app with no signal still has to get the right form,
 * so every successful fetch is written to localStorage and every read falls
 * back to it. Returns null only on a device that has never been online.
 */
export function useActiveForm(kind: string, season = ""): {
  form: FormWithDefinition | null;
  loading: boolean;
  fromCache: boolean;
  reload: () => void;
} {
  return useCachedForm(`kind:${kind}:${season}`, () => activeForm(kind, season));
}

export function useFormDefinition(formId: string) {
  return useCachedForm(`id:${formId}`, () => getForm(formId));
}

/**
 * A published form, cached per device, refreshed in the background.
 *
 * A scout who opens the app with no signal still has to get the right form,
 * so every successful fetch is written to localStorage and every read falls
 * back to it. Returns null only on a device that has never been online.
 *
 * The cache key includes what was asked for, so switching season does not
 * hand somebody last season's form out of the cache.
 */
function useCachedForm(
  cacheId: string,
  fetcher: () => Promise<FormWithDefinition>
): {
  form: FormWithDefinition | null;
  loading: boolean;
  fromCache: boolean;
  reload: () => void;
} {
  const [form, setForm] = useState<FormWithDefinition | null>(null);
  const [loading, setLoading] = useState(true);
  const [fromCache, setFromCache] = useState(false);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    const key = cacheKey(cacheId);

    // Show the cached copy immediately, then correct it from the network.
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) {
        setForm(JSON.parse(raw));
        setFromCache(true);
        setLoading(false);
      }
    } catch {}

    fetcher()
      .then((fresh) => {
        if (!alive) return;
        setForm(fresh);
        setFromCache(false);
        try {
          window.localStorage.setItem(key, JSON.stringify(fresh));
        } catch {}
      })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false); });

    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheId, nonce]);

  return { form, loading, fromCache, reload };
}

// --------------------------------------------------------------------------
// Working with a definition
// --------------------------------------------------------------------------
export function allFields(definition: FormDefinition): FormField[] {
  return (definition.sections || []).flatMap((s) => s.fields || []);
}

/** A field is shown unless its condition says otherwise. */
export function isVisible(field: FormField, answers: Record<string, any>): boolean {
  if (!field.visible_if) return true;
  return answers[field.visible_if.field] === field.visible_if.equals;
}

/** The value a field starts at, by type. */
export function blankValue(field: FormField): any {
  if (field.default !== undefined) return field.default;
  switch (field.type) {
    case "counter":
    case "number":
    case "decimal":
    case "timer":
    case "slider":
    case "match":
    case "station":
      return field.min ?? 0;
    case "rating":
      return Math.ceil((field.max ?? 5) / 2);
    case "toggle":
      return false;
    case "multiselect":
    case "tags":
    case "heatmap":
    case "ranking":
    case "actions":
      return [];
    case "team":
      return 0;
    case "select":
    case "dropdown":
    case "alliance":
    case "phase":
    case "piece":
    case "location":
      return field.options?.[0]?.value ?? "";
    default:
      return "";
  }
}

export function blankAnswers(definition: FormDefinition): Record<string, any> {
  const out: Record<string, any> = {};
  for (const field of allFields(definition)) {
    if (field.type === "note" || field.type === "divider") continue;
    out[field.key] = blankValue(field);
  }
  return out;
}

/** A stable, unused key suggestion from a label. */
export function suggestKey(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^([0-9])/, "f$1")
      .slice(0, 34) || "field";
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}_${Date.now() % 1000}`;
}

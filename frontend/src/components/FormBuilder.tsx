"use client";
// The form builder: design a scouting form without writing any code.
//
// Three columns on a desktop, stacked on anything narrower. Sections and
// fields on the left, the selected field's settings in the middle, a live
// preview on the right rendered by the same component the scouts use, so what
// you are looking at is the form and not a drawing of it.
//
// Two things it refuses to let you do quietly:
//
//   A field's key is write-once. Answers are stored under it forever, so
//   renaming one orphans every report already collected. The label is free to
//   change; the key is shown but locked once the field has been saved.
//
//   Removing a field the analytics read is allowed but never silent. The
//   warning names the screen that goes blank, because "where did the climb
//   rate go" is a question somebody asks three weeks later.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  allFields,
  blankAnswers,
  suggestKey,
  type BuilderMeta,
  type CoreWarning,
  type FieldOption,
  type FieldType,
  type FormDefinition,
  type FormField,
  type FormSection,
} from "@/lib/formdef";
import { FormRenderer } from "@/components/FormRenderer";
import { Confirm } from "@/components/ui";
import { Icon } from "@/components/icons";

interface Selection {
  section: number;
  field: number | null;
}

export interface BuilderProps {
  definition: FormDefinition;
  onChange: (next: FormDefinition) => void;
  meta: BuilderMeta | null;
  problems: string[];
  warnings: CoreWarning[];
  /** Keys already saved at least once, so their key is locked. */
  lockedKeys: Set<string>;
  readOnly?: boolean;
}

export function FormBuilder({
  definition,
  onChange,
  meta,
  problems,
  warnings,
  lockedKeys,
  readOnly,
}: BuilderProps) {
  const [sel, setSel] = useState<Selection>({ section: 0, field: null });
  const [adding, setAdding] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<Selection | null>(null);

  const sections = definition.sections || [];
  const takenKeys = useMemo(
    () => new Set(allFields(definition).map((f) => f.key)),
    [definition]
  );

  // Preview answers live here so toggling a checkbox in the preview reveals
  // the fields that depend on it, which is the only way to check a condition.
  const [preview, setPreview] = useState<Record<string, any>>({});
  useEffect(() => {
    setPreview((cur) => ({ ...blankAnswers(definition), ...cur }));
  }, [definition]);

  const update = useCallback(
    (mutate: (draft: FormDefinition) => void) => {
      if (readOnly) return;
      const draft: FormDefinition = JSON.parse(JSON.stringify(definition));
      mutate(draft);
      onChange(draft);
    },
    [definition, onChange, readOnly]
  );

  const current = sections[sel.section];
  const currentField =
    current && sel.field != null ? current.fields?.[sel.field] : undefined;

  // ---- section operations -------------------------------------------------
  function addSection() {
    update((d) => {
      d.sections.push({ title: `Section ${d.sections.length + 1}`, fields: [] });
    });
    setSel({ section: sections.length, field: null });
  }

  function moveSection(index: number, by: number) {
    const to = index + by;
    if (to < 0 || to >= sections.length) return;
    update((d) => {
      const [moved] = d.sections.splice(index, 1);
      d.sections.splice(to, 0, moved);
    });
    setSel({ section: to, field: null });
  }

  function removeSection(index: number) {
    update((d) => { d.sections.splice(index, 1); });
    setSel({ section: Math.max(0, index - 1), field: null });
  }

  // ---- field operations ---------------------------------------------------
  function addField(type: FieldType) {
    const typeMeta = meta?.field_types.find((t) => t.type === type);
    const label = typeMeta?.label || "New field";
    const field: FormField = {
      key: type === "note" ? "" : suggestKey(label, takenKeys),
      type,
      label,
    };
    if (type === "select" || type === "multiselect") {
      field.options = [{ value: "option_1", label: "Option 1" }];
    }
    if (type === "rating") field.max = 5;
    if (type === "counter") field.min = 0;

    update((d) => {
      d.sections[sel.section].fields = d.sections[sel.section].fields || [];
      d.sections[sel.section].fields.push(field);
    });
    setSel({ section: sel.section, field: (current?.fields?.length ?? 0) });
    setAdding(false);
  }

  function patchField(patch: Partial<FormField>) {
    if (sel.field == null) return;
    update((d) => {
      const field = d.sections[sel.section].fields[sel.field!];

      // While a field is new, its key follows the label. Without this every
      // counter on a form ends up called "counter", "counter_2", and the
      // stored answers are unreadable. It stops the moment somebody edits the
      // key themselves, and stops for good once the field has been saved.
      const renaming = patch.label !== undefined && patch.key === undefined;
      const autoNamed =
        !lockedKeys.has(field.key) &&
        field.type !== "note" &&
        field.key === suggestKey(field.label || "", new Set());
      if (renaming && autoNamed) {
        const others = new Set(
          allFields(d).filter((f) => f !== field).map((f) => f.key)
        );
        patch = { ...patch, key: suggestKey(patch.label || "", others) };
      }

      Object.assign(field, patch);
    });
  }

  function moveField(index: number, by: number) {
    const fields = current?.fields || [];
    const to = index + by;
    if (to < 0 || to >= fields.length) return;
    update((d) => {
      const list = d.sections[sel.section].fields;
      const [moved] = list.splice(index, 1);
      list.splice(to, 0, moved);
    });
    setSel({ section: sel.section, field: to });
  }

  function moveFieldToSection(index: number, sectionIndex: number) {
    update((d) => {
      const list = d.sections[sel.section].fields;
      const [moved] = list.splice(index, 1);
      d.sections[sectionIndex].fields = d.sections[sectionIndex].fields || [];
      d.sections[sectionIndex].fields.push(moved);
    });
    setSel({ section: sectionIndex, field: null });
  }

  function removeField(where: Selection) {
    update((d) => { d.sections[where.section].fields.splice(where.field!, 1); });
    setSel({ section: where.section, field: null });
    setConfirmRemove(null);
  }

  return (
    <div className="builder">
      {/* ---- outline ---- */}
      <aside className="builder-outline">
        <div className="card-h">
          <h3>Sections</h3>
          {!readOnly && (
            <button className="btn sm ghost" onClick={addSection}>Add section</button>
          )}
        </div>

        {sections.map((section, si) => (
          <div key={si} className={"builder-section" + (si === sel.section ? " on" : "")}>
            <div className="builder-section-head">
              <button
                type="button"
                className="builder-section-title"
                onClick={() => setSel({ section: si, field: null })}
              >
                <b>{section.title || "Untitled section"}</b>
                <span>{(section.fields || []).length} fields</span>
              </button>
              {!readOnly && si === sel.section && (
                <div className="btn-row">
                  <button className="btn sm ghost" onClick={() => moveSection(si, -1)} disabled={si === 0} aria-label="Move section up">^</button>
                  <button className="btn sm ghost" onClick={() => moveSection(si, 1)} disabled={si === sections.length - 1} aria-label="Move section down">v</button>
                  <button className="btn sm ghost" onClick={() => removeSection(si)} disabled={sections.length <= 1} aria-label="Remove section">x</button>
                </div>
              )}
            </div>

            {si === sel.section && (
              <ol className="builder-fields">
                {(section.fields || []).map((field, fi) => (
                  <li key={field.key || `${field.type}-${fi}`}>
                    <button
                      type="button"
                      className={"builder-field" + (sel.field === fi ? " on" : "")}
                      onClick={() => setSel({ section: si, field: fi })}
                    >
                      <span className="builder-field-type">{field.type}</span>
                      <span className="builder-field-label">{field.label || "Untitled"}</span>
                      {field.maps_to && <span className="badge haze">core</span>}
                      {field.visible_if && <span className="badge muted">if</span>}
                    </button>
                  </li>
                ))}
                {!(section.fields || []).length && (
                  <li className="faint builder-empty">No fields yet.</li>
                )}
                {!readOnly && (
                  <li>
                    <button className="btn sm block" onClick={() => setAdding(true)}>
                      <Icon name="sparkles" size={12} /> Add a field
                    </button>
                  </li>
                )}
              </ol>
            )}
          </div>
        ))}
      </aside>

      {/* ---- settings ---- */}
      <div className="builder-settings">
        {(problems.length > 0 || warnings.length > 0) && (
          <div className="builder-messages">
            {problems.map((p) => (
              <p key={p} className="form-error">{p}</p>
            ))}
            {warnings.map((w) => (
              <p key={w.field} className="form-warning">
                This form no longer collects <b>{w.field}</b>, so {w.consequence}.
              </p>
            ))}
          </div>
        )}

        {currentField ? (
          <FieldSettings
            field={currentField}
            meta={meta}
            locked={lockedKeys.has(currentField.key)}
            readOnly={readOnly}
            siblings={allFields(definition).filter((f) => f.key !== currentField.key)}
            sections={sections}
            currentSection={sel.section}
            onPatch={patchField}
            onMove={(by) => moveField(sel.field!, by)}
            onMoveToSection={(i) => moveFieldToSection(sel.field!, i)}
            onRemove={() => setConfirmRemove(sel)}
          />
        ) : current ? (
          <SectionSettings
            section={current}
            readOnly={readOnly}
            onPatch={(patch) =>
              update((d) => { Object.assign(d.sections[sel.section], patch); })
            }
          />
        ) : (
          <p className="muted">Add a section to start.</p>
        )}
      </div>

      {/* ---- live preview ---- */}
      <div className="builder-preview">
        <div className="card-h">
          <h3>Preview</h3>
          <span className="badge muted">what a scout sees</span>
        </div>
        <div className="builder-preview-body">
          <FormRenderer
            definition={definition}
            answers={preview}
            onChange={(k, v) => setPreview((cur) => ({ ...cur, [k]: v }))}
          />
        </div>
      </div>

      {adding && meta && (
        <AddFieldSheet
          meta={meta}
          onPick={addField}
          onClose={() => setAdding(false)}
        />
      )}

      {confirmRemove && (
        <Confirm
          title="Remove this field?"
          body={
            <>
              Answers already collected under{" "}
              <b>{sections[confirmRemove.section].fields[confirmRemove.field!].key}</b>{" "}
              are retained.
            </>
          }
          confirmLabel="Remove it"
          onConfirm={() => removeField(confirmRemove)}
          onCancel={() => setConfirmRemove(null)}
        />
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// Settings panels
// --------------------------------------------------------------------------
function SectionSettings({
  section,
  readOnly,
  onPatch,
}: {
  section: FormSection;
  readOnly?: boolean;
  onPatch: (patch: Partial<FormSection>) => void;
}) {
  return (
    <>
      <div className="card-h"><h3>Section</h3></div>
      <label className="field">
        <span>Title</span>
        <input
          value={section.title || ""}
          readOnly={readOnly}
          onChange={(e) => onPatch({ title: e.target.value })}
        />
      </label>
      <label className="field">
        <span>Hint</span>
        <input
          value={section.hint || ""}
          readOnly={readOnly}
          placeholder="Shown under the title, optional"
          onChange={(e) => onPatch({ hint: e.target.value })}
        />
      </label>
      <p className="faint">Pick a field on the left to edit it.</p>
    </>
  );
}

function FieldSettings({
  field,
  meta,
  locked,
  readOnly,
  siblings,
  sections,
  currentSection,
  onPatch,
  onMove,
  onMoveToSection,
  onRemove,
}: {
  field: FormField;
  meta: BuilderMeta | null;
  locked: boolean;
  readOnly?: boolean;
  siblings: FormField[];
  sections: FormSection[];
  currentSection: number;
  onPatch: (patch: Partial<FormField>) => void;
  onMove: (by: number) => void;
  onMoveToSection: (index: number) => void;
  onRemove: () => void;
}) {
  const typeMeta = meta?.field_types.find((t) => t.type === field.type);
  const needsOptions = !!typeMeta?.needs_options || field.type === "tags";
  const isNumeric = field.type === "counter" || field.type === "number";

  return (
    <>
      <div className="card-h">
        <h3>Field</h3>
        {!readOnly && (
          <div className="btn-row">
            <button className="btn sm ghost" onClick={() => onMove(-1)}>Up</button>
            <button className="btn sm ghost" onClick={() => onMove(1)}>Down</button>
            <button className="btn sm danger" onClick={onRemove}>Remove</button>
          </div>
        )}
      </div>

      <label className="field">
        <span>Label</span>
        <input
          value={field.label || ""}
          readOnly={readOnly}
          onChange={(e) => onPatch({ label: e.target.value })}
        />
      </label>

      {field.type !== "note" && (
        <label className="field">
          <span>Answer key {locked && "(locked)"}</span>
          <input
            className="mono"
            value={field.key || ""}
            readOnly={readOnly || locked}
            onChange={(e) => onPatch({ key: e.target.value })}
          />

        </label>
      )}

      <label className="field">
        <span>Hint</span>
        <input
          value={field.hint || ""}
          readOnly={readOnly}
          placeholder="Optional help text"
          onChange={(e) => onPatch({ hint: e.target.value })}
        />
      </label>

      {isNumeric && (
        <div className="builder-pair">
          <label className="field">
            <span>Minimum</span>
            <input type="number" value={field.min ?? 0} readOnly={readOnly}
              onChange={(e) => onPatch({ min: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>Maximum</span>
            <input type="number" value={field.max ?? ""} readOnly={readOnly}
              placeholder="none"
              onChange={(e) => onPatch({ max: e.target.value === "" ? undefined : Number(e.target.value) })} />
          </label>
        </div>
      )}

      {field.type === "rating" && (
        <label className="field">
          <span>Scale</span>
          <input type="number" min={2} max={10} value={field.max ?? 5} readOnly={readOnly}
            onChange={(e) => onPatch({ max: Number(e.target.value) })} />
        </label>
      )}

      {needsOptions && (
        <OptionEditor
          field={field}
          readOnly={readOnly}
          onPatch={onPatch}
          withTone={field.type === "tags"}
        />
      )}

      {/* Scoring. A form that defines its own points is a form that can score
          a game this build has never heard of. */}
      {(isNumeric || field.type === "toggle") && (
        <label className="field">
          <span>Points {field.type === "toggle" ? "when yes" : "each"}</span>
          <input
            type="number" step="0.5"
            value={field.points ?? ""}
            readOnly={readOnly}
            placeholder="none"
            onChange={(e) => onPatch({ points: e.target.value === "" ? undefined : Number(e.target.value) })}
          />

        </label>
      )}

      <label className="field">
        <span>Feeds analytics</span>
        <select
          value={field.maps_to || ""}
          disabled={readOnly}
          onChange={(e) => onPatch({ maps_to: e.target.value || undefined })}
        >
          <option value="">Store as a plain answer</option>
          {(meta?.core_fields || []).map((c) => (
            <option key={c.key} value={c.key}>{c.key}: {c.description}</option>
          ))}
        </select>

      </label>

      <ConditionEditor field={field} siblings={siblings} readOnly={readOnly} onPatch={onPatch} />

      {sections.length > 1 && !readOnly && (
        <label className="field">
          <span>Move to section</span>
          <select
            value=""
            onChange={(e) => e.target.value !== "" && onMoveToSection(Number(e.target.value))}
          >
            <option value="">Pick a section</option>
            {sections.map((s, i) =>
              i === currentSection ? null : (
                <option key={i} value={i}>{s.title || `Section ${i + 1}`}</option>
              )
            )}
          </select>
        </label>
      )}
    </>
  );
}

function OptionEditor({
  field,
  readOnly,
  onPatch,
  withTone,
}: {
  field: FormField;
  readOnly?: boolean;
  onPatch: (patch: Partial<FormField>) => void;
  withTone?: boolean;
}) {
  const options = field.options || [];

  function patchOption(index: number, patch: Partial<FieldOption>) {
    const next = options.map((o, i) => (i === index ? { ...o, ...patch } : o));
    onPatch({ options: next });
  }

  return (
    <div className="field">
      <span>Options</span>
      <div className="builder-options">
        {options.map((option, i) => (
          <div key={i} className="builder-option">
            <input
              value={option.label ?? option.value}
              readOnly={readOnly}
              placeholder="Shown to the scout"
              onChange={(e) => patchOption(i, { label: e.target.value })}
            />
            <input
              className="mono"
              value={option.value}
              readOnly={readOnly}
              placeholder="stored value"
              onChange={(e) => patchOption(i, { value: e.target.value })}
            />
            {withTone ? (
              <select
                value={option.tone || "good"}
                disabled={readOnly}
                onChange={(e) => patchOption(i, { tone: e.target.value as "good" | "bad" })}
              >
                <option value="good">good</option>
                <option value="bad">bad</option>
              </select>
            ) : (
              <input
                type="number" step="0.5"
                value={option.points ?? ""}
                readOnly={readOnly}
                placeholder="pts"
                onChange={(e) =>
                  patchOption(i, { points: e.target.value === "" ? undefined : Number(e.target.value) })
                }
              />
            )}
            {!readOnly && (
              <button
                className="btn sm ghost"
                onClick={() => onPatch({ options: options.filter((_, x) => x !== i) })}
                aria-label="Remove option"
              >
                x
              </button>
            )}
          </div>
        ))}
        {!readOnly && (
          <button
            className="btn sm"
            onClick={() =>
              onPatch({
                options: [
                  ...options,
                  { value: `option_${options.length + 1}`, label: `Option ${options.length + 1}` },
                ],
              })
            }
          >
            Add option
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * "Only ask this when..." Conditions are one level deep on purpose: every real
 * scouting form needs "show the defense rating only if they played defense",
 * and none of them need a boolean expression tree.
 */
function ConditionEditor({
  field,
  siblings,
  readOnly,
  onPatch,
}: {
  field: FormField;
  siblings: FormField[];
  readOnly?: boolean;
  onPatch: (patch: Partial<FormField>) => void;
}) {
  const candidates = siblings.filter(
    (f) => f.type === "toggle" || f.type === "select"
  );
  const chosen = candidates.find((c) => c.key === field.visible_if?.field);

  return (
    <div className="field">
      <span>Only ask this when</span>
      <div className="builder-pair">
        <select
          value={field.visible_if?.field || ""}
          disabled={readOnly}
          onChange={(e) => {
            const key = e.target.value;
            if (!key) return onPatch({ visible_if: undefined });
            const target = candidates.find((c) => c.key === key);
            onPatch({
              visible_if: {
                field: key,
                equals: target?.type === "toggle" ? true : target?.options?.[0]?.value ?? "",
              },
            });
          }}
        >
          <option value="">Always ask it</option>
          {candidates.map((c) => (
            <option key={c.key} value={c.key}>{c.label || c.key}</option>
          ))}
        </select>

        {chosen && chosen.type === "toggle" && (
          <select
            value={String(field.visible_if?.equals)}
            disabled={readOnly}
            onChange={(e) => onPatch({ visible_if: { field: chosen.key, equals: e.target.value === "true" } })}
          >
            <option value="true">is yes</option>
            <option value="false">is no</option>
          </select>
        )}
        {chosen && chosen.type === "select" && (
          <select
            value={String(field.visible_if?.equals ?? "")}
            disabled={readOnly}
            onChange={(e) => onPatch({ visible_if: { field: chosen.key, equals: e.target.value } })}
          >
            {(chosen.options || []).map((o) => (
              <option key={o.value} value={o.value}>is {o.label || o.value}</option>
            ))}
          </select>
        )}
      </div>
      {!candidates.length && (
        <></>
      )}
    </div>
  );
}

function AddFieldSheet({
  meta,
  onPick,
  onClose,
}: {
  meta: BuilderMeta;
  onPick: (type: FieldType) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal add-field" onClick={(e) => e.stopPropagation()}>
        <div className="card-h">
          <h3>Add a field</h3>
          <button className="btn sm ghost" onClick={onClose}>Close</button>
        </div>
        <div className="add-field-grid">
          {meta.field_types.map((t) => (
            <button key={t.type} type="button" className="add-field-item" onClick={() => onPick(t.type)}>
              <b>{t.label}</b>
              <span>{t.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

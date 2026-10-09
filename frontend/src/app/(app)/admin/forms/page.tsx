"use client";
// Form Builder: design the scouting forms without touching the code.
//
// One page rather than a route per form, because the whole app is also built
// as a static export and a dynamic route would need pre-rendering for form IDs
// that do not exist until somebody invents them.
//
// The unsaved definition lives here rather than in the builder, so switching
// to the history panel and back does not lose an edit, and so "save" has one
// obvious owner.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  allFields,
  archiveForm,
  createForm,
  getBuilderMeta,
  getForm,
  getHistory,
  getRevision,
  listForms,
  restoreForm,
  saveRevision,
  validateDefinition,
  type BuilderMeta,
  type CoreWarning,
  type FormDefinition,
  type FormSummary,
  type RevisionSummary,
} from "@/lib/formdef";
import { timeAgo } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { onBus } from "@/lib/bus";
import { Confirm, Empty, Loading, Modal } from "@/components/ui";
import { FormBuilder } from "@/components/FormBuilder";
import { FormHistory } from "@/components/FormHistory";
import { Icon } from "@/components/icons";

type Tab = "build" | "history";

const KIND_LABEL: Record<string, string> = {
  match: "Match scouting",
  pit: "Pit scouting",
  custom: "Custom",
};

function emptyDefinition(name: string): FormDefinition {
  return {
    name,
    description: "",
    sections: [{ title: "Section 1", fields: [] }],
  };
}

function PreservedFormsPage() {
  const toast = useToast();
  const [forms, setForms] = useState<FormSummary[]>([]);
  const [meta, setMeta] = useState<BuilderMeta | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [tab, setTab] = useState<Tab>("build");
  const [loading, setLoading] = useState(true);

  // The form being edited.
  const [definition, setDefinition] = useState<FormDefinition | null>(null);
  const [baseVersion, setBaseVersion] = useState<number>(0);
  const [dirty, setDirty] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<CoreWarning[]>([]);
  const [lockedKeys, setLockedKeys] = useState<Set<string>>(new Set());
  const [revisions, setRevisions] = useState<RevisionSummary[]>([]);
  //: A version opened from the history, shown read-only.
  const [viewing, setViewing] = useState<number | null>(null);

  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [showSave, setShowSave] = useState(false);
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState<FormSummary | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const current = forms.find((f) => f.form_id === selected);

  const loadForms = useCallback(async (keep?: string) => {
    try {
      const rows = await listForms(true);
      setForms(rows);
      setSelected((cur) => keep || cur || rows.find((r) => !r.archived)?.form_id || "");
    } catch (e: any) {
      toast(e?.message || "Could not load forms", "err");
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    loadForms();
    getBuilderMeta().then(setMeta).catch(() => {});
    return onBus((e) => { if (e === "form_changed") loadForms(); });
  }, [loadForms]);

  const openForm = useCallback(async (formId: string) => {
    if (!formId) return;
    try {
      const full = await getForm(formId);
      setDefinition(full.definition);
      setBaseVersion(full.latest_version);
      // Every key that has ever been saved is locked, so renaming one cannot
      // orphan answers already collected under it.
      setLockedKeys(new Set(allFields(full.definition).map((f) => f.key)));
      setDirty(false);
      setViewing(null);
      setRevisions(await getHistory(formId).catch(() => []));
    } catch (e: any) {
      toast(e?.message || "Could not open that form", "err");
    }
  }, [toast]);

  useEffect(() => { openForm(selected); }, [selected, openForm]);

  // Validate as you edit, so a problem shows up beside the field that caused
  // it rather than on the way out.
  useEffect(() => {
    if (!definition) return;
    let alive = true;
    const id = setTimeout(async () => {
      try {
        const res = await validateDefinition(definition);
        if (!alive) return;
        setProblems(res.problems);
        setWarnings(res.warnings);
      } catch {}
    }, 400);
    return () => { alive = false; clearTimeout(id); };
  }, [definition]);

  async function save() {
    if (!definition || !selected) return;
    setSaving(true);
    try {
      const res = await saveRevision(selected, definition, message.trim(), baseVersion, true);
      toast(`Saved version ${res.version}: ${res.summary}`, "ok");
      setMessage("");
      setShowSave(false);
      await loadForms(selected);
      await openForm(selected);
    } catch (e: any) {
      if (e?.status === 409) {
        toast(e.message, "err");
      } else if (e?.status === 422) {
        toast("Fix the problems listed before saving", "err");
      } else {
        toast(e?.message || "Could not save", "err");
      }
    } finally {
      setSaving(false);
    }
  }

  async function viewVersion(version: number) {
    try {
      const rev = await getRevision(selected, version);
      setDefinition(rev.definition);
      setViewing(version);
      setTab("build");
      toast(`Showing version ${version}, read only`, "info");
    } catch (e: any) {
      toast(e?.message || "Could not load that version", "err");
    }
  }

  async function doArchive(form: FormSummary) {
    try {
      if (form.archived) {
        await restoreForm(form.form_id);
        toast(`${form.name} restored`, "ok");
      } else {
        await archiveForm(form.form_id);
        toast(`${form.name} archived, its history is kept`, "ok");
      }
      setArchiving(null);
      await loadForms();
    } catch (e: any) {
      toast(e?.message || "Could not do that", "err");
      setArchiving(null);
    }
  }

  const visibleForms = useMemo(
    () => forms.filter((f) => showArchived || !f.archived),
    [forms, showArchived]
  );

  if (loading) return <Loading />;

  return (
    <div className="forms-page">
      <div className="page-title">
        <h1>Form Builder</h1>
        <span className="badge muted">{forms.filter((f) => !f.archived).length} forms</span>
      </div>


      <div className="forms-layout">
        <aside className="forms-list">
          <div className="card-h">
            <h3>Forms</h3>
            <button className="btn sm" onClick={() => setCreating(true)}>New</button>
          </div>
          {visibleForms.map((f) => (
            <button
              key={f.form_id}
              type="button"
              className={"forms-list-item" + (f.form_id === selected ? " on" : "") + (f.archived ? " archived" : "")}
              onClick={() => setSelected(f.form_id)}
            >
              <span className="forms-list-name">
                <b>{f.name}</b>
                {f.archived && <span className="badge muted">archived</span>}
              </span>
              <span className="forms-list-meta">
                {KIND_LABEL[f.kind] || f.kind} - v{f.published_version} - {timeAgo(f.updated_at)}
              </span>
            </button>
          ))}
          {!visibleForms.length && <p className="faint">No forms yet.</p>}
          <label className="pill-check" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Show archived
          </label>
        </aside>

        <div className="forms-main">
          {!current || !definition ? (
            <Empty icon="clipboard" title="Pick a form" sub="Or create a new one." />
          ) : (
            <>
              <div className="forms-toolbar">
                <div className="seg">
                  <button className={tab === "build" ? "on" : ""} onClick={() => setTab("build")}>Build</button>
                  <button className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>
                    History ({revisions.length})
                  </button>
                </div>

                <span className="forms-status">
                  {viewing != null ? (
                    <span className="badge amber">viewing v{viewing}, read only</span>
                  ) : dirty ? (
                    <span className="badge amber">unsaved changes</span>
                  ) : (
                    <span className="badge muted">
                      live: v{current.published_version} by {current.updated_by}
                    </span>
                  )}
                </span>

                <div className="btn-row">
                  {viewing != null && (
                    <button className="btn sm" onClick={() => openForm(selected)}>
                      Back to current
                    </button>
                  )}
                  {viewing == null && (
                    <>
                      <button
                        className="btn sm primary"
                        disabled={!dirty || problems.length > 0}
                        onClick={() => setShowSave(true)}
                        title={problems.length ? "Fix the problems first" : undefined}
                      >
                        Save version
                      </button>
                      <button
                        className="btn sm ghost"
                        disabled={!dirty}
                        onClick={() => openForm(selected)}
                      >
                        Discard
                      </button>
                    </>
                  )}
                  <button className="btn sm ghost" onClick={() => setArchiving(current)}>
                    {current.archived ? "Restore" : "Delete"}
                  </button>
                </div>
              </div>

              {tab === "build" ? (
                <FormBuilder
                  definition={definition}
                  onChange={(next) => { setDefinition(next); setDirty(true); }}
                  meta={meta}
                  problems={problems}
                  warnings={warnings}
                  lockedKeys={lockedKeys}
                  readOnly={viewing != null}
                />
              ) : (
                <FormHistory
                  formId={selected}
                  revisions={revisions}
                  onChanged={async () => { await loadForms(selected); await openForm(selected); }}
                  onPreview={viewVersion}
                />
              )}
            </>
          )}
        </div>
      </div>

      {showSave && (
        <Modal onClose={() => setShowSave(false)}>
          <div className="confirm">
            <h3>Save a new version</h3>
            <div className="confirm-body">

              <label className="field">
                <span>What changed?</span>
                <input
                  autoFocus
                  value={message}
                  placeholder="e.g. Added algae counters, dropped defense detail"
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") save(); }}
                />
              </label>
              {warnings.length > 0 && (
                <div className="builder-messages">
                  {warnings.map((w) => (
                    <p key={w.field} className="form-warning">
                      No field feeds <b>{w.field}</b>, so {w.consequence}.
                    </p>
                  ))}
                </div>
              )}
            </div>
            <div className="confirm-actions">
              <button className="btn ghost" onClick={() => setShowSave(false)}>Cancel</button>
              <button className="btn primary" disabled={saving} onClick={save}>
                {saving ? "Saving..." : "Save and publish"}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {creating && (
        <NewFormDialog
          onClose={() => setCreating(false)}
          onCreated={async (formId) => {
            setCreating(false);
            await loadForms(formId);
            setSelected(formId);
          }}
        />
      )}

      {archiving && (
        <Confirm
          title={archiving.archived ? `Restore ${archiving.name}?` : `Delete ${archiving.name}?`}
          body={
            archiving.archived ? (
              <>It goes back in the list, at the version it was on.</>
            ) : (
              <>
                Archive this form? History is retained.
              </>
            )
          }
          confirmLabel={archiving.archived ? "Restore" : "Delete"}
          onConfirm={() => doArchive(archiving)}
          onCancel={() => setArchiving(null)}
        />
      )}
    </div>
  );
}

function NewFormDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (formId: string) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [formId, setFormId] = useState("");
  const [busy, setBusy] = useState(false);

  const suggested = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const id = formId || suggested;

  async function create() {
    if (!id) return toast("Give the form a name", "err");
    setBusy(true);
    try {
      await createForm(id, "custom", emptyDefinition(name || id), "Create form");
      toast(`Created ${name || id}`, "ok");
      onCreated(id);
    } catch (e: any) {
      toast(e?.message || "Could not create the form", "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <div className="confirm">
        <h3>New form</h3>
        <div className="confirm-body">
          <label className="field">
            <span>Name</span>
            <input
              autoFocus
              value={name}
              placeholder="e.g. Drive team debrief"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="field">
            <span>ID</span>
            <input
              className="mono"
              value={id}
              placeholder="drive_team_debrief"
              onChange={(e) => setFormId(e.target.value)}
            />

          </label>

        </div>
        <div className="confirm-actions">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={create}>
            {busy ? "Creating..." : "Create"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// Temporarily disabled for all roles; the implementation and API remain intact.
export default function DisabledTool() { return <section className="card"><h1>Tool unavailable</h1><p>This tool is temporarily disabled.</p></section>; }

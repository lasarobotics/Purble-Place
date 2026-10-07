"use client";
// A form's history: who changed what, when, and how to get back.
//
// Reads like a commit log because it is one. Every save is a version with an
// author and a message, nothing is ever edited in place, and reverting writes
// a new version rather than deleting the ones in between, so the record of
// what was tried survives the decision to undo it.
import { useCallback, useEffect, useState } from "react";
import {
  getDiff,
  publishVersion,
  revertTo,
  type FormDiff,
  type RevisionSummary,
} from "@/lib/formdef";
import { timeAgo } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { Confirm } from "@/components/ui";

export function FormHistory({
  formId,
  revisions,
  onChanged,
  onPreview,
}: {
  formId: string;
  revisions: RevisionSummary[];
  onChanged: () => void;
  /** Open an old version in the builder, read only. */
  onPreview: (version: number) => void;
}) {
  const toast = useToast();
  const [openVersion, setOpenVersion] = useState<number | null>(null);
  const [diff, setDiff] = useState<FormDiff | null>(null);
  const [reverting, setReverting] = useState<RevisionSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const loadDiff = useCallback(
    async (revision: RevisionSummary) => {
      setDiff(null);
      try {
        setDiff(await getDiff(formId, revision.parent_version, revision.version));
      } catch {
        setDiff(null);
      }
    },
    [formId]
  );

  useEffect(() => {
    const open = revisions.find((r) => r.version === openVersion);
    if (open) loadDiff(open);
  }, [openVersion, revisions, loadDiff]);

  async function doRevert(revision: RevisionSummary) {
    setBusy(true);
    try {
      const res = await revertTo(formId, revision.version);
      toast(`Reverted to version ${revision.version}, saved as version ${res.version}`, "ok");
      setReverting(null);
      onChanged();
    } catch (e: any) {
      toast(e?.message || "Could not revert", "err");
    } finally {
      setBusy(false);
    }
  }

  async function doPublish(revision: RevisionSummary) {
    setBusy(true);
    try {
      await publishVersion(formId, revision.version);
      toast(`Version ${revision.version} is now live for scouts`, "ok");
      onChanged();
    } catch (e: any) {
      toast(e?.message || "Could not publish", "err");
    } finally {
      setBusy(false);
    }
  }

  if (!revisions.length) {
    return <p className="faint">No history yet.</p>;
  }

  return (
    <div className="history">
      <ol className="history-list">
        {revisions.map((r) => {
          const open = openVersion === r.version;
          return (
            <li key={r.version} className={"history-item" + (open ? " open" : "")}>
              <button
                type="button"
                className="history-head"
                onClick={() => setOpenVersion(open ? null : r.version)}
              >
                <span className="history-version mono">v{r.version}</span>
                <span className="history-body">
                  <span className="history-message">
                    {r.message || "(no message)"}
                    {r.reverted_from > 0 && (
                      <span className="badge muted">revert of v{r.reverted_from}</span>
                    )}
                  </span>
                  <span className="history-meta">
                    {r.author_name} - {timeAgo(r.created_at)} - {r.summary}
                  </span>
                </span>
                {r.published && <span className="badge green">live</span>}
                {r.latest && !r.published && <span className="badge amber">newest</span>}
              </button>

              {open && (
                <div className="history-detail">
                  <DiffView diff={diff} />
                  <div className="btn-row">
                    <button className="btn sm ghost" onClick={() => onPreview(r.version)}>
                      View this version
                    </button>
                    {!r.published && (
                      <button className="btn sm" disabled={busy} onClick={() => doPublish(r)}>
                        Make it live
                      </button>
                    )}
                    {!r.latest && (
                      <button className="btn sm" disabled={busy} onClick={() => setReverting(r)}>
                        Revert to this
                      </button>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {reverting && (
        <Confirm
          title={`Revert to version ${reverting.version}?`}
          body={
            <>
              Publish <b>v{reverting.version}</b> as a new version?
            </>
          }
          confirmLabel="Revert"
          onConfirm={() => doRevert(reverting)}
          onCancel={() => setReverting(null)}
        />
      )}
    </div>
  );
}

function DiffView({ diff }: { diff: FormDiff | null }) {
  if (!diff) return <p className="faint">Loading changes...</p>;
  if (!diff.total) return <p className="faint">No field changes in this version.</p>;

  return (
    <div className="diff">
      {diff.added.map((f) => (
        <div key={`a-${f.key}`} className="diff-row add">
          <span className="diff-mark">+</span>
          <span>{f.label} <span className="faint mono">{f.key}</span> <span className="faint">({f.type})</span></span>
        </div>
      ))}
      {diff.removed.map((f) => (
        <div key={`r-${f.key}`} className="diff-row remove">
          <span className="diff-mark">-</span>
          <span>{f.label} <span className="faint mono">{f.key}</span> <span className="faint">({f.type})</span></span>
        </div>
      ))}
      {diff.moved.map((f) => (
        <div key={`m-${f.key}`} className="diff-row move">
          <span className="diff-mark">&gt;</span>
          <span>{f.label} moved from {f.from || "?"} to {f.to || "?"}</span>
        </div>
      ))}
      {diff.changed.map((f) => (
        <div key={`c-${f.key}`} className="diff-row change">
          <span className="diff-mark">~</span>
          <span>
            <b>{f.label}</b>
            {f.changes.map((c) => (
              <span key={c.property} className="diff-prop">
                {c.property}: <s>{format(c.from)}</s> {format(c.to)}
              </span>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

function format(value: unknown): string {
  if (value === undefined || value === null || value === "") return "none";
  if (Array.isArray(value)) return `${value.length} items`;
  if (typeof value === "object") return "changed";
  return String(value);
}

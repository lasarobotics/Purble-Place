"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { getDeviceId, queueStats, requestPersistentStorage, type QueueStats } from "@/lib/db";
import { useOffline } from "@/lib/offline";
import { exportJSONL, importJSONL, retryNow } from "@/lib/sync";
import { useLiveRefetch } from "@/lib/bus";
import { useToast } from "@/lib/toast";
import { Loading, Stat } from "@/components/ui";

function downloadText(name: string, text: string) {
  const blob = new Blob([text], { type: "application/x-ndjson" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export default function DeviceStatusPage() {
  const { session } = useAuth();
  const toast = useToast();
  const [deviceId, setDeviceId] = useState("");
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const offline = useOffline();
  const [stats, setStats] = useState<QueueStats | null>(null);
  const [apiStatus, setApiStatus] = useState<"unknown" | "ok" | "down">("unknown");
  const [busy, setBusy] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setStats(await queueStats());
  }, []);

  useEffect(() => {
    getDeviceId().then(setDeviceId);
    requestPersistentStorage().then(setPersisted);
  }, []);
  useLiveRefetch(load, ["scout_submitted", "submission_ack"]);
  useEffect(() => {
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [load]);

  async function connectionTest() {
    setBusy("test");
    try {
      const h = await api<any>("/api/health");
      setApiStatus(h.ok ? "ok" : "down");
      toast(h.ok ? "Cloud API reachable" : "API responded but the database is unreachable", h.ok ? "ok" : "err");
    } catch {
      setApiStatus("down");
      toast("Cloud API unreachable, records stay queued locally", "err");
    } finally {
      setBusy("");
    }
  }

  async function doRetry() {
    setBusy("retry");
    try {
      const r = await retryNow();
      toast(r.synced ? `Synced ${r.synced} record(s) · ${r.remaining} left` : `Nothing synced · ${r.remaining} still queued`, r.synced ? "ok" : "info");
      load();
    } finally {
      setBusy("");
    }
  }

  async function doExport(onlyQueued: boolean) {
    const { text, count } = await exportJSONL(onlyQueued);
    if (!count) return toast("No records to export", "info");
    const scope = onlyQueued ? "queued" : "all";
    downloadText(`hazehub_${scope}_${session?.scout_id || "scout"}_${stamp()}.jsonl`, text);
    toast(`Exported ${count} record(s)`, "ok");
  }

  async function doImport(file: File) {
    setBusy("import");
    try {
      const { imported, skipped } = await importJSONL(await file.text());
      toast(`Imported ${imported} record(s)${skipped ? ` · ${skipped} skipped` : ""}, syncing`, "ok");
      load();
    } finally {
      setBusy("");
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  if (!stats) return <Loading label="Reading local database..." />;

  return (
    <div>
      <div className="page-title"><h1>Device Status</h1></div>
      <p className="page-sub">
        This device's local database and sync queue. Every submission is saved
        here first and stays for the whole event, even after the cloud
        confirms it, so a failed device can always be recovered.
      </p>

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Stat label="Local records" value={stats.total} />
        <Stat label="Queued for cloud" value={stats.queued} accent={stats.queued > 0} />
        <Stat label="Acknowledged" value={stats.acknowledged} />
        <Stat label="Needs attention" value={stats.invalid + stats.conflict} accent={stats.invalid + stats.conflict > 0} />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>Device</h3>
          <div className="report-grid" style={{ marginTop: 0 }}>
            <div><div className="faint">Scout</div><p>{session?.display_name || "-"}</p></div>
            <div><div className="faint">Device ID</div><p className="mono" style={{ fontSize: "0.78rem" }}>{deviceId || "..."}</p></div>
            <div>
              <div className="faint">Persistent storage</div>
              <p>{persisted === null ? "Checking..." : persisted ? "Enabled" : "Not guaranteed, avoid clearing browser data"}</p>
            </div>
            <div>
              <div className="faint">Cloud API</div>
              <p>{apiStatus === "unknown" ? "Not tested yet" : apiStatus === "ok" ? "Reachable" : "Unreachable"}</p>
            </div>
            <div>
              <div className="faint">Offline app</div>
              <p>
                {!offline.supported
                  ? "Not available in this browser"
                  : offline.ready
                    ? "Cached, this device can scout with no signal"
                    : "Caching, keep this page open for a moment"}
              </p>
            </div>
          </div>
        </div>

        <div className="card">
          <h3>Sync Queue</h3>
          {stats.queued === 0 ? (
            <p style={{ margin: 0 }}><span className="dot green" style={{ marginRight: 8 }} /><b>All local records are in the cloud.</b></p>
          ) : (
            <>
              <p style={{ margin: "0 0 8px" }}>
                <span className="dot red" style={{ marginRight: 8 }} />
                <b>{stats.queued} record(s) waiting for the cloud</b>
              </p>
              {stats.oldestQueued && (
                <p className="faint" style={{ margin: 0 }}>
                  Oldest: Q{stats.oldestQueued.match_number} · team {stats.oldestQueued.team_number}
                  {stats.oldestQueued.last_error ? ` · ${stats.oldestQueued.last_error}` : ""}
                </p>
              )}
            </>
          )}
          {stats.lastAcknowledgedAt && (
            <p className="faint" style={{ marginTop: 8, marginBottom: 0 }}>
              Last cloud acknowledgement: {new Date(stats.lastAcknowledgedAt).toLocaleTimeString()}
            </p>
          )}
          {(stats.invalid > 0 || stats.conflict > 0) && (
            <p className="faint" style={{ marginTop: 8, marginBottom: 0 }}>
              {stats.invalid > 0 && <>{stats.invalid} invalid (needs correction) </>}
              {stats.conflict > 0 && <>{stats.conflict} conflicted (UUID reused with different data)</>}
            </p>
          )}
        </div>

        <div className="card" style={{ gridColumn: "1 / -1" }}>
          <h3>Recovery</h3>
          <p style={{ marginTop: 0 }}>
            Export recovery files at checkpoints. If this device dies, a spare
            imports the file and uploads through the same idempotent sync, the
            submission UUIDs guarantee nothing double-counts.
          </p>
          <div className="btn-row">
            <button className="btn primary" disabled={!!busy} onClick={doRetry}>
              {busy === "retry" ? "Retrying..." : "Retry queued records"}
            </button>
            <button className="btn" onClick={() => doExport(true)}>Export queued</button>
            <button className="btn" onClick={() => doExport(false)}>Export all records</button>
            <button className="btn" disabled={!!busy} onClick={() => fileRef.current?.click()}>
              {busy === "import" ? "Importing..." : "Import recovery file"}
            </button>
            <button className="btn ghost" disabled={!!busy} onClick={connectionTest}>
              {busy === "test" ? "Testing..." : "Run connection test"}
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".jsonl,.txt,application/x-ndjson"
            style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) doImport(f); }}
          />
        </div>
      </div>
    </div>
  );
}

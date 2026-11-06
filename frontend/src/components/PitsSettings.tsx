"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { defaultPitsConfig, PitsConfig, PitsBoard } from "@/lib/pits";

export function PitsSettings() {
  const [config, setConfig] = useState<PitsConfig>(defaultPitsConfig);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { api<PitsConfig>("/api/admin/pits-sheet").then(c => { setConfig(c); setReady(true); }).catch(() => setMessage("Could not load the saved sheet settings. Reload to try again.")); }, []);
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const result = await api<PitsBoard>("/api/admin/pits-sheet", { method: "POST", body: config });
      setMessage(`Published ${result.rotations.length} rotations and ${result.matches.length} matches. Everyone can now see this schedule in Pits.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Import failed. Your previous schedule is unchanged."); }
    finally { setBusy(false); }
  }
  return <section className="card pits-settings">
    <h2>Pits · event sheet</h2>
    <p>Replace the Google Sheet for each event. Your wide roster layout is supported: Matches / Time, 418 Pit Lead, 418 Pit, 436 Pit Lead, 436 Pit. Blank rows and day headings are allowed. The sheet must allow anyone with the link to view it.</p>
    <form onSubmit={save}>
      <label>Google Sheet link<input type="url" required value={config.url} placeholder="https://docs.google.com/spreadsheets/d/…" onChange={e => setConfig({ ...config, url: e.target.value })} /></label>
      <div className="grid cols-2">
        <label>Pit rotations tab<input required value={config.rotations_tab} onChange={e => setConfig({ ...config, rotations_tab: e.target.value })} /></label>
        <label>Match schedule tab (optional)<input value={config.matches_tab} onChange={e => setConfig({ ...config, matches_tab: e.target.value })} /></label>
      </div>
      <details><summary>Column mappings · match your sheet’s headers</summary>
        <p>Wide rosters are detected automatically. Put up to five names in each Pit cell, separated by commas, slashes or line breaks, or use columns such as 418 Pit 1 through 418 Pit 5. Mentor and other departments are ignored. These mappings apply only to the alternative row-per-team format and the optional match schedule.</p>
        <div className="grid cols-2">{(["rotation_columns", "match_columns"] as const).map(group => <fieldset key={group}><legend>{group === "rotation_columns" ? "Pit rotations" : "Match schedule"}</legend>{Object.entries(config[group]).map(([key, value]) => <label key={key}>{key}<input value={value} onChange={e => setConfig({ ...config, [group]: { ...config[group], [key]: e.target.value } })} /></label>)}</fieldset>)}</div>
      </details>
      <p>Leave the match tab blank for rotations only. Match ranges do not supply individual match times. Save &amp; import publishes a snapshot. Use it again after editing the sheet. If an import fails, the previous schedule stays available.</p>
      <button className="btn primary" disabled={busy || !ready}>{busy ? "Importing…" : "Save & import"}</button>
      <p role="status">{message}</p>
    </form>
  </section>;
}

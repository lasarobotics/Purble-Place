"use client";
import React, { useEffect, useId, useRef, useState } from "react";
import type { HeatPoint } from "@/lib/types";
import { Hotkeys, ignoreHotkey } from "@/lib/hotkeys";
import { MetricLabel } from "./MetricLabel";

const FIELD_SRC = "/field.png";

function colorFor(p: HeatPoint): string {
  if (p.result === "missed") return "#f59e0b";
  return p.phase === "auto" ? "#22d3ee" : "#a855f7";
}

/** Interactive scoring map used on the scout form. Each tap logs an attempt. */
export function FieldInput({
  points,
  onChange,
  hotkeys,
  active,
}: {
  points: HeatPoint[];
  onChange: (pts: HeatPoint[]) => void;
  hotkeys?: Hotkeys;
  active?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<"auto" | "teleop">("teleop");
  const [result, setResult] = useState<"made" | "missed">("made");

  useEffect(() => {
    if (!hotkeys || !active) return;
    const handle = (e: KeyboardEvent) => {
      if (ignoreHotkey(e)) return;
      const key = e.key.toLowerCase();
      if (key === hotkeys.auto) setPhase("auto");
      else if (key === hotkeys.teleop) setPhase("teleop");
      else if (key === hotkeys.made) setResult("made");
      else if (key === hotkeys.missed) setResult("missed");
      else if (key === hotkeys.undo) onChange(points.slice(0, -1));
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [hotkeys, active, points, onChange]);

  function add(e: React.MouseEvent) {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    onChange([...points, { x, y, phase, result }]);
  }

  const counts = {
    autoMade: points.filter((p) => p.phase === "auto" && p.result === "made").length,
    autoMiss: points.filter((p) => p.phase === "auto" && p.result === "missed").length,
    teleMade: points.filter((p) => p.phase === "teleop" && p.result === "made").length,
    teleMiss: points.filter((p) => p.phase === "teleop" && p.result === "missed").length,
  };

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
        <div className="seg">
          <button type="button" className={phase === "auto" ? "on" : ""} onClick={() => setPhase("auto")}>
            Auto
          </button>
          <button type="button" className={phase === "teleop" ? "on" : ""} onClick={() => setPhase("teleop")}>
            Teleop
          </button>
        </div>
        <div className="seg">
          <button type="button" className={result === "made" ? "on" : ""} onClick={() => setResult("made")}>
            ✓ Made
          </button>
          <button type="button" className={result === "missed" ? "on" : ""} onClick={() => setResult("missed")}>
            ✗ Missed
          </button>
        </div>
      </div>

      <div className="field-wrap" ref={ref} onClick={add} style={{ cursor: "crosshair" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="field-bg" src={FIELD_SRC} alt="field" draggable={false} />
        <svg className="field-svg" viewBox="0 0 100 50" preserveAspectRatio="none">
          {points.map((p, i) => (
            <circle
              key={i}
              cx={p.x * 100}
              cy={p.y * 50}
              r={p.result === "made" ? 1.4 : 1.1}
              fill={colorFor(p)}
              stroke="white"
              strokeWidth={0.25}
              opacity={0.92}
            />
          ))}
        </svg>
      </div>

      <div className="row" style={{ justifyContent: "space-between", marginTop: 10 }}>
        <div className="row" style={{ gap: 8, fontSize: "0.8rem" }}>
          <span className="badge" style={{ color: "#22d3ee" }}>Auto {counts.autoMade}/{counts.autoMade + counts.autoMiss}</span>
          <span className="badge" style={{ color: "#a855f7" }}>Teleop {counts.teleMade}/{counts.teleMade + counts.teleMiss}</span>
        </div>
        <div className="btn-row">
          <button type="button" className="btn sm ghost" onClick={() => onChange(points.slice(0, -1))} disabled={!points.length}>
            Undo
          </button>
          <button type="button" className="btn sm ghost" onClick={() => onChange([])} disabled={!points.length}>
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}

/** Read-only aggregated heatmap overlay (team search / analysis). */
export function FieldHeatmap({
  points,
  height = 300,
  stats,
}: {
  points: HeatPoint[];
  height?: number;
  stats?: { total: number; made: number; accuracy: number | null };
}) {
  const [showShots, setShowShots] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId().replace(/:/g, "");
  useEffect(() => {
    if (expanded && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [expanded]);
  const map = (large = false) => (
    <div className="field-wrap analysis-field" style={{ maxWidth: large ? "100%" : height * 2, margin: "0 auto" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="field-bg" src={FIELD_SRC} alt="Scoring positions on the field" style={{ opacity: 0.52 }} />
      <svg className="field-svg" viewBox="0 0 1000 500" aria-label="Shot locations and density">
        <defs>
          <filter id={`${id}-${large}-blur`} x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="14" /></filter>
        </defs>
        <g filter={`url(#${id}-${large}-blur)`}>
          {points.map((p, i) => (
            <circle
              key={i}
              cx={p.x * 1000}
              cy={p.y * 500}
              r={30}
              fill="#b56dff"
              opacity={0.24}
            />
          ))}
        </g>
        {showShots && points.map((p, i) => (
          <g key={i} className="shot-dot">
            <circle cx={p.x * 1000} cy={p.y * 500} r={12} fill={colorFor(p)} opacity=".15" />
            <circle cx={p.x * 1000} cy={p.y * 500} r={5} fill={p.result === "made" ? colorFor(p) : "#21132f"} stroke={p.result === "made" ? "#f7efff" : "#fbbf24"} strokeWidth="1.6" />
            <title>{p.phase === "auto" ? "Auto" : "Teleop"} · {p.result}{p.match ? ` · match ${p.match}` : ""}</title>
          </g>
        ))}
      </svg>
    </div>
  );
  return <div className="heatmap-panel">
    <div className="heatmap-tools">
      <label className="shot-toggle"><input type="checkbox" checked={showShots} onChange={e => setShowShots(e.target.checked)} /> Show each shot</label>
      <button className="btn sm ghost" onClick={() => setExpanded(true)} aria-label="Open scoring heatmap full size">Open full size <span aria-hidden>↗</span></button>
    </div>
    {map()}
    {stats && <div className="heatmap-stats">
      <div><strong>{stats.total}</strong><span><MetricLabel metric="attempts">attempts</MetricLabel></span></div>
      <div><strong className="made-text">{stats.made}</strong><span><MetricLabel metric="made">made</MetricLabel></span></div>
      <div><strong className="haze-text">{stats.accuracy == null ? "—" : `${Math.round(stats.accuracy * 100)}%`}</strong><span><MetricLabel metric="accuracy">accuracy</MetricLabel></span></div>
    </div>}
    <div className="heatmap-legend"><span>Shots from here</span><span>a few</span><i className="density-ramp" /><span>a lot</span></div>
    {showShots && <div className="shot-key"><span><i className="auto-dot" />Auto made</span><span><i className="tele-dot" />Teleop made</span><span><i className="miss-dot" />Missed</span></div>}
    {expanded && <dialog ref={dialog} className="heatmap-dialog" onCancel={() => setExpanded(false)} onClick={e => { if (e.target === e.currentTarget) setExpanded(false); }}>
      <div className="card-h"><div><h3>Scoring Heatmap</h3><p className="muted">Every recorded location, in detail.</p></div><button className="btn ghost" onClick={() => setExpanded(false)}>Close</button></div>
      {map(true)}
      <div className="heatmap-legend"><span>Shots from here</span><span>a few</span><i className="density-ramp" /><span>a lot</span></div>
    </dialog>}
  </div>;
}

"use client";
import React, { useRef, useState } from "react";
import type { HeatPoint } from "@/lib/types";

const FIELD_SRC = "/field.png";

function colorFor(p: HeatPoint): string {
  if (p.result === "missed") return "#f59e0b";
  return p.phase === "auto" ? "#22d3ee" : "#a855f7";
}

/** Interactive scoring map used on the scout form. Each tap logs an attempt. */
export function FieldInput({
  points,
  onChange,
}: {
  points: HeatPoint[];
  onChange: (pts: HeatPoint[]) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<"auto" | "teleop">("teleop");
  const [result, setResult] = useState<"made" | "missed">("made");

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
}: {
  points: HeatPoint[];
  height?: number;
}) {
  return (
    <div className="field-wrap" style={{ maxHeight: height }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="field-bg" src={FIELD_SRC} alt="field" style={{ opacity: 0.55 }} />
      <svg className="field-svg" viewBox="0 0 100 50" preserveAspectRatio="none">
        <defs>
          <filter id="blur"><feGaussianBlur stdDeviation="1.1" /></filter>
        </defs>
        <g filter="url(#blur)">
          {points.map((p, i) => (
            <circle
              key={i}
              cx={p.x * 100}
              cy={p.y * 50}
              r={p.result === "made" ? 2.6 : 2.0}
              fill={p.result === "made" ? "#a855f7" : "#f59e0b"}
              opacity={0.32}
            />
          ))}
        </g>
        {points.map((p, i) => (
          <circle key={"c" + i} cx={p.x * 100} cy={p.y * 50} r={0.6} fill={colorFor(p)} opacity={0.9} />
        ))}
      </svg>
    </div>
  );
}

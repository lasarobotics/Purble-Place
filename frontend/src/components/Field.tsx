"use client";
import React, { useEffect, useRef, useState } from "react";
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

// --------------------------------------------------------------------------- #
// Read-only heatmap                                                            #
// --------------------------------------------------------------------------- #
// Two problems with the old version: every shot was one translucent dot, so a
// team with 80 attempts read as purple soup, and there was no way to tell a
// robot that only scores from its own side from one that scores anywhere.
//
// This version bins attempts into a grid and sizes each cell by volume and
// colours it by accuracy, which is the question people actually ask. It can
// be filtered by phase and by the driver station the robot started from, and
// it opens full screen with pinch or scroll zoom.

export type StationFilter = "all" | "red1" | "red2" | "red3" | "blue1" | "blue2" | "blue3";

const GRID_X = 20;
const GRID_Y = 10;

interface Cell {
  x: number;
  y: number;
  made: number;
  total: number;
}

function bin(points: HeatPoint[]): Cell[] {
  const cells = new Map<string, Cell>();
  for (const p of points) {
    const gx = Math.min(GRID_X - 1, Math.max(0, Math.floor(p.x * GRID_X)));
    const gy = Math.min(GRID_Y - 1, Math.max(0, Math.floor(p.y * GRID_Y)));
    const key = `${gx}:${gy}`;
    const cell = cells.get(key) || { x: gx, y: gy, made: 0, total: 0 };
    cell.total += 1;
    if (p.result === "made") cell.made += 1;
    cells.set(key, cell);
  }
  return [...cells.values()];
}

/** Green when they make it from here, amber when they mostly miss. */
function accuracyColor(made: number, total: number): string {
  const acc = total ? made / total : 0;
  if (acc >= 0.75) return "#22c55e";
  if (acc >= 0.5) return "#a855f7";
  if (acc >= 0.25) return "#f59e0b";
  return "#ef4444";
}

export function FieldHeatmap({
  points,
  height = 300,
  expandable = true,
  showControls = true,
}: {
  points: HeatPoint[];
  height?: number;
  expandable?: boolean;
  showControls?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<"all" | "auto" | "teleop">("all");
  const [station, setStation] = useState<StationFilter>("all");

  const stationsPresent = Array.from(
    new Set(points.map((p) => stationKey(p)).filter(Boolean))
  ) as StationFilter[];

  const filtered = points.filter(
    (p) =>
      (phase === "all" || p.phase === phase) &&
      (station === "all" || stationKey(p) === station)
  );
  const cells = bin(filtered);
  const busiest = Math.max(1, ...cells.map((c) => c.total));
  const made = filtered.filter((p) => p.result === "made").length;

  const map = (
    <div
      className="field-wrap"
      style={{ maxHeight: open ? undefined : height, cursor: expandable && !open ? "zoom-in" : undefined }}
      onClick={expandable && !open ? () => setOpen(true) : undefined}
      title={expandable && !open ? "Click to expand" : undefined}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="field-bg" src={FIELD_SRC} alt="field" style={{ opacity: 0.5 }} />
      <svg className="field-svg" viewBox="0 0 100 50" preserveAspectRatio="none">
        {cells.map((c) => {
          const share = c.total / busiest;
          const cx = ((c.x + 0.5) / GRID_X) * 100;
          const cy = ((c.y + 0.5) / GRID_Y) * 50;
          return (
            <g key={`${c.x}:${c.y}`}>
              <rect
                x={(c.x / GRID_X) * 100}
                y={(c.y / GRID_Y) * 50}
                width={100 / GRID_X}
                height={50 / GRID_Y}
                fill={accuracyColor(c.made, c.total)}
                opacity={0.12 + share * 0.5}
              />
              <circle
                cx={cx}
                cy={cy}
                r={0.8 + share * 1.9}
                fill={accuracyColor(c.made, c.total)}
                opacity={0.95}
              />
              {open && c.total > 1 && (
                <text
                  x={cx}
                  y={cy + 0.5}
                  textAnchor="middle"
                  fontSize={1.5}
                  fill="#0b0713"
                  fontWeight={700}
                >
                  {c.total}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );

  const controls = showControls && (
    <div className="row heatmap-controls" style={{ gap: 8, flexWrap: "wrap", marginTop: 10 }}>
      <div className="seg">
        {(["all", "auto", "teleop"] as const).map((p) => (
          <button key={p} type="button" className={phase === p ? "on" : ""} onClick={() => setPhase(p)}>
            {p === "all" ? "Both" : p === "auto" ? "Auto" : "Teleop"}
          </button>
        ))}
      </div>
      {stationsPresent.length > 1 && (
        <div className="seg">
          <button type="button" className={station === "all" ? "on" : ""} onClick={() => setStation("all")}>
            All stations
          </button>
          {stationsPresent.sort().map((s) => (
            <button key={s} type="button" className={station === s ? "on" : ""} onClick={() => setStation(s)}>
              {s.replace("red", "R").replace("blue", "B")}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const legend = (
    <div className="row heatmap-legend" style={{ gap: 10, flexWrap: "wrap", marginTop: 8, fontSize: "0.75rem" }}>
      <span className="faint">Bigger dot means more attempts from that spot. Colour is how often they made it:</span>
      <span className="badge" style={{ color: "#22c55e" }}>75% and up</span>
      <span className="badge" style={{ color: "#a855f7" }}>50 to 74%</span>
      <span className="badge" style={{ color: "#f59e0b" }}>25 to 49%</span>
      <span className="badge" style={{ color: "#ef4444" }}>under 25%</span>
    </div>
  );

  if (!points.length) {
    return <p className="faint" style={{ margin: 0 }}>No scoring positions recorded yet.</p>;
  }

  return (
    <>
      {map}
      {controls}
      <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
        <span className="badge muted">{filtered.length} attempts</span>
        <span className="badge green">{made} made</span>
        <span className="badge haze">
          {filtered.length ? Math.round((made / filtered.length) * 100) : 0}% accuracy
        </span>
        {expandable && (
          <button type="button" className="btn sm ghost" onClick={() => setOpen(true)}>
            Expand and zoom
          </button>
        )}
      </div>
      {legend}
      {open && (
        <ZoomableField onClose={() => setOpen(false)} title={`${filtered.length} attempts`}>
          {map}
          {controls}
          {legend}
        </ZoomableField>
      )}
    </>
  );
}

/** Which driver station the scout was watching, if the report carried it. */
function stationKey(p: HeatPoint): StationFilter | "" {
  if (!p.alliance || !p.station) return "";
  return `${p.alliance}${p.station}` as StationFilter;
}

/**
 * Full-screen field with scroll and pinch zoom plus drag to pan.
 *
 * Built on a plain transform rather than a library: the whole interaction is
 * "scale about the pointer, translate on drag", and pulling in a pan-zoom
 * dependency for that would be more code to ship to a Chromebook, not less.
 */
function ZoomableField({
  children,
  onClose,
  title,
}: {
  children: React.ReactNode;
  onClose: () => void;
  title?: string;
}) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const pinch = useRef<number | null>(null);

  const clampScale = (s: number) => Math.min(6, Math.max(1, s));

  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    setScale((s) => {
      const next = clampScale(s * (e.deltaY < 0 ? 1.15 : 0.87));
      if (next === 1) setOffset({ x: 0, y: 0 });
      return next;
    });
  }

  function onPointerDown(e: React.PointerEvent) {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current || scale === 1) return;
    setOffset({
      x: drag.current.ox + (e.clientX - drag.current.x),
      y: drag.current.oy + (e.clientY - drag.current.y),
    });
  }
  function onPointerUp() {
    drag.current = null;
  }

  function onTouchMove(e: React.TouchEvent) {
    if (e.touches.length !== 2) return;
    const [a, b] = [e.touches[0], e.touches[1]];
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (pinch.current != null) {
      setScale((s) => clampScale(s * (dist / pinch.current!)));
    }
    pinch.current = dist;
  }
  function onTouchEnd() {
    pinch.current = null;
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div className="field-zoom-backdrop" onClick={onClose}>
      <div className="field-zoom" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3 style={{ margin: 0 }}>Scoring map {title ? <span className="faint">· {title}</span> : null}</h3>
          <div className="btn-row">
            <button className="btn sm ghost" onClick={() => { setScale(1); setOffset({ x: 0, y: 0 }); }}>
              Reset zoom
            </button>
            <button className="btn sm ghost" onClick={onClose}>Close</button>
          </div>
        </div>
        <div
          className="field-zoom-stage"
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          style={{ cursor: scale > 1 ? "grab" : "default" }}
        >
          <div
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              transformOrigin: "center center",
              transition: drag.current ? "none" : "transform 0.08s linear",
            }}
          >
            {children}
          </div>
        </div>
        <p className="faint" style={{ margin: "10px 0 0", fontSize: "0.75rem" }}>
          Scroll or pinch to zoom, drag to pan. Press Escape to close.
        </p>
      </div>
    </div>
  );
}

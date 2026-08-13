"use client";
import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
// The original drew one translucent dot per shot, so a team with 80 attempts
// read as purple soup. Binning into coloured squares fixed the readability but
// looked like a spreadsheet rather than a heatmap.
//
// This draws a real density field: every attempt is a soft blob, the blobs are
// blurred into each other, and the resulting intensity is mapped through a
// colour ramp inside the SVG filter. Busy areas glow hot, one-off shots fade
// away. Individual made and missed markers can be layered on top, and the
// whole thing filters by phase and by driver station, because where a robot
// starts changes which parts of the field it can reach.

export type StationFilter = "all" | "red1" | "red2" | "red3" | "blue1" | "blue2" | "blue3";

/** Which driver station the scout was watching, if the report carried it. */
function stationKey(p: HeatPoint): StationFilter | "" {
  if (!p.alliance || !p.station) return "";
  return `${p.alliance}${p.station}` as StationFilter;
}

function stationLabel(s: StationFilter): string {
  if (s === "all") return "All stations";
  return s.replace("red", "Red ").replace("blue", "Blue ");
}

/**
 * The density field.
 *
 * Each attempt is a soft radial blob. feGaussianBlur melts them together, the
 * first feColorMatrix copies the accumulated alpha into the colour channels,
 * and feComponentTransfer maps that intensity through the ramp. The copy step
 * is the part that is easy to miss: without it the colour tables would be
 * reading channels that are all zero, and every pixel would come out the
 * same shade.
 */
function DensityLayer({
  id,
  points,
  blobRadius,
}: {
  id: string;
  points: HeatPoint[];
  blobRadius: number;
}) {
  return (
    <>
      <defs>
        <radialGradient id={`${id}-blob`}>
          <stop offset="0%" stopColor="#fff" stopOpacity="0.85" />
          <stop offset="55%" stopColor="#fff" stopOpacity="0.30" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <filter
          id={`${id}-heat`}
          x="-15%"
          y="-15%"
          width="130%"
          height="130%"
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur in="SourceGraphic" stdDeviation="1.6" result="blurred" />
          <feColorMatrix
            in="blurred"
            type="matrix"
            values="0 0 0 1 0
                    0 0 0 1 0
                    0 0 0 1 0
                    0 0 0 1 0"
            result="intensity"
          />
          <feComponentTransfer in="intensity">
            <feFuncR type="table" tableValues="0.10 0.13 0.35 0.85 0.97 0.99" />
            <feFuncG type="table" tableValues="0.20 0.60 0.80 0.75 0.45 0.15" />
            <feFuncB type="table" tableValues="0.55 0.85 0.45 0.20 0.12 0.20" />
            <feFuncA type="table" tableValues="0 0.35 0.60 0.75 0.85 0.92" />
          </feComponentTransfer>
        </filter>
      </defs>
      <g filter={`url(#${id}-heat)`}>
        {points.map((p, i) => (
          <circle key={i} cx={p.x * 100} cy={p.y * 50} r={blobRadius} fill={`url(#${id}-blob)`} />
        ))}
      </g>
    </>
  );
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
  // Filter and gradient ids must be unique, or two heatmaps on one page will
  // both render with whichever definition happened to win.
  const uid = useId().replace(/:/g, "");
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<"all" | "auto" | "teleop">("all");
  const [station, setStation] = useState<StationFilter>("all");
  const [markers, setMarkers] = useState(false);

  const stationsPresent = Array.from(
    new Set(points.map((p) => stationKey(p)).filter(Boolean))
  ).sort() as StationFilter[];

  const filtered = points.filter(
    (p) =>
      (phase === "all" || p.phase === phase) &&
      (station === "all" || stationKey(p) === station)
  );
  const made = filtered.filter((p) => p.result === "made").length;

  // Three attempts need fatter blobs to register at all; two hundred need
  // thinner ones or the whole field saturates into one red smear.
  const blobRadius = filtered.length > 120 ? 3.2 : filtered.length > 40 ? 4.2 : 5.4;

  function map(large: boolean) {
    return (
      <div
        className="field-wrap"
        style={{
          maxHeight: large ? undefined : height,
          cursor: expandable && !large ? "zoom-in" : undefined,
        }}
        onClick={expandable && !large ? () => setOpen(true) : undefined}
        title={expandable && !large ? "Click to open the full size map" : undefined}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="field-bg" src={FIELD_SRC} alt="field" style={{ opacity: 0.45 }} />
        <svg className="field-svg" viewBox="0 0 100 50" preserveAspectRatio="none">
          <DensityLayer
            id={`${uid}${large ? "-lg" : ""}`}
            points={filtered}
            blobRadius={blobRadius}
          />
          {markers &&
            filtered.map((p, i) => (
              <circle
                key={`m${i}`}
                cx={p.x * 100}
                cy={p.y * 50}
                r={p.result === "made" ? 0.8 : 0.6}
                fill={p.result === "made" ? "#eafff2" : "#1b0b0b"}
                stroke={p.result === "made" ? "#0f2d1c" : "#ffd9d9"}
                strokeWidth={0.18}
                opacity={0.9}
              />
            ))}
        </svg>
      </div>
    );
  }

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
          {stationsPresent.map((s) => (
            <button key={s} type="button" className={station === s ? "on" : ""} onClick={() => setStation(s)}>
              {stationLabel(s)}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        className={"btn sm " + (markers ? "primary" : "ghost")}
        onClick={() => setMarkers((v) => !v)}
      >
        {markers ? "Hide" : "Show"} each shot
      </button>
    </div>
  );

  const stats = (
    <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
      <span className="badge muted">{filtered.length} attempts</span>
      <span className="badge green">{made} made</span>
      <span className="badge haze">
        {filtered.length ? Math.round((made / filtered.length) * 100) : 0}% accuracy
      </span>
    </div>
  );

  const legend = (
    <div className="heatmap-legend">
      <span className="faint">Shots from here:</span>
      <span className="heat-ramp" aria-hidden />
      <span className="faint">a few</span>
      <span className="faint">a lot</span>
      {markers && <span className="faint">Light dots are makes, dark dots are misses.</span>}
    </div>
  );

  if (!points.length) {
    return <p className="faint" style={{ margin: 0 }}>No scoring positions recorded yet.</p>;
  }

  return (
    <>
      {map(false)}
      {controls}
      {stats}
      {expandable && (
        <button type="button" className="btn sm ghost" style={{ marginTop: 8 }} onClick={() => setOpen(true)}>
          Open full size
        </button>
      )}
      {legend}
      {open && (
        <ZoomableField onClose={() => setOpen(false)} title={`${filtered.length} attempts`}>
          {map(true)}
          {controls}
          {stats}
          {legend}
        </ZoomableField>
      )}
    </>
  );
}

/**
 * Full-screen field with scroll and pinch zoom plus drag to pan.
 *
 * Portalled to <body> deliberately. .card sets a backdrop-filter, which makes
 * it a containing block for position:fixed, so rendering this inline pinned
 * the overlay to the card rather than the viewport and it opened far below
 * the fold. The Modal component in ui.tsx portals for exactly this reason.
 *
 * Pan and zoom is a plain CSS transform rather than a library: the whole
 * interaction is scale, then translate on drag, and these are borrowed
 * Chromebooks, so the right answer is thirty lines and no extra bundle.
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
  const [mounted, setMounted] = useState(false);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const pinch = useRef<number | null>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const clampScale = (s: number) => Math.min(6, Math.max(1, s));

  function onWheel(e: React.WheelEvent) {
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
    const a = e.touches[0];
    const b = e.touches[1];
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (pinch.current != null) setScale((s) => clampScale(s * (dist / pinch.current!)));
    pinch.current = dist;
  }

  if (!mounted) return null;

  return createPortal(
    <div className="field-zoom-backdrop" onClick={onClose}>
      <div className="field-zoom" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3 style={{ margin: 0 }}>
            Scoring map {title ? <span className="faint">· {title}</span> : null}
          </h3>
          <div className="btn-row">
            <button
              className="btn sm ghost"
              onClick={() => {
                setScale(1);
                setOffset({ x: 0, y: 0 });
              }}
            >
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
          onTouchEnd={() => {
            pinch.current = null;
          }}
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
    </div>,
    document.body,
  );
}

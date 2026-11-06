"use client";
import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { HeatPoint } from "@/lib/types";

import { DEFAULT_HOTKEYS, Hotkeys, ignoreHotkey } from "@/lib/hotkeys";
import { MetricLabel } from "./MetricLabel";

const FIELD_SRC = "/field.png";

function colorFor(p: HeatPoint): string {
  return p.phase === "auto" ? "#f8efff" : "#A87fc9";
}

/** Interactive scoring map used on the scout form. Each tap logs an attempt. */
export function FieldInput({
  points,
  onChange, hotkeys = DEFAULT_HOTKEYS, active = true,
}: {
  hotkeys?: Hotkeys; active?: boolean;
  points: HeatPoint[];
  onChange: (pts: HeatPoint[]) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<"auto" | "teleop">("auto");

  const latest = useRef({ points, onChange, active });
  latest.current = { points, onChange, active };
  const pending = useRef<{ point: HeatPoint; phase: "auto" | "teleop"; timer: ReturnType<typeof setTimeout> } | null>(null);
  const cancelPending = () => { if (pending.current) clearTimeout(pending.current.timer); pending.current = null; };
  useEffect(() => () => cancelPending(), []);
  useEffect(() => { if (!active) cancelPending(); }, [active]);

  function undo() {
    cancelPending();
    onChange(points.slice(0, -1));
  }

  function clear() {
    cancelPending();
    onChange([]);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!active || ignoreHotkey(e)) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (target?.isContentEditable || tag === "input" || tag === "textarea" || tag === "select") return;

      switch (e.key.toLowerCase()) {
        case hotkeys.auto:
          e.preventDefault();
          setPhase("auto");
          break;
        case hotkeys.teleop:
          e.preventDefault();
          setPhase("teleop");
          break;
        case hotkeys.undo:
          e.preventDefault();
          undo();
          break;
        case hotkeys.clear:
          e.preventDefault();
          clear();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [points, onChange, hotkeys, active]);

  function add(e: React.MouseEvent) {
    const el = ref.current;
    if (!el || !active) return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    onChange([...points, { x, y, phase, result: "made" }]);
  }

  function dotClick(point: HeatPoint, e: React.MouseEvent<SVGCircleElement>) {
    e.stopPropagation();
    if (!active) return;
    if (pending.current?.point === point) {
      cancelPending();
      const index = latest.current.points.indexOf(point);
      latest.current.onChange(latest.current.points.filter((_, i) => i !== index));
      return;
    }
    // Flush a pending single click on a different dot before starting another.
    if (pending.current) {
      const previous = pending.current.point;
      const previousPhase = pending.current.phase;
      cancelPending();
      const next = [...latest.current.points, { x: previous.x, y: previous.y, phase: previousPhase, result: "made" as const }];
      latest.current = { ...latest.current, points: next };
      onChange(next);
    }
    const selectedPhase = phase;
    pending.current = { point, phase, timer: setTimeout(() => {
      pending.current = null;
      if (latest.current.active) latest.current.onChange([...latest.current.points, { x: point.x, y: point.y, phase: selectedPhase, result: "made" }]);
    }, 300) };
  }

  const counts = {
    autoMade: points.filter((p) => p.phase === "auto" && p.result !== "missed").length,
    teleMade: points.filter((p) => p.phase === "teleop" && p.result !== "missed").length,
  };

  return (
    <div className="field-input">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
        <div className="seg">
          <button type="button" className={phase === "auto" ? "on" : ""} aria-pressed={phase === "auto"} onClick={() => setPhase("auto")} title={hotkeys.auto.toUpperCase()}>
            Auto
          </button>
          <button type="button" className={phase === "teleop" ? "on" : ""} aria-pressed={phase === "teleop"} onClick={() => setPhase("teleop")} title={hotkeys.teleop.toUpperCase()}>
            Teleop
          </button>
        </div>
        <span className="badge green">Count made shots</span>
      </div>

      <div className="field-wrap" ref={ref} onClick={add} style={{ cursor: "crosshair" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="field-bg" src={FIELD_SRC} alt="field" draggable={false} />
        <svg className="field-svg" viewBox="0 0 100 50" preserveAspectRatio="none">
          {points.map((p, i) => p.result === "missed" ? null : (
            <g key={i}>
              <circle cx={p.x * 100} cy={p.y * 50} r={p.result === "made" ? 1.4 : 1.1}
                fill={colorFor(p)} stroke="white" strokeWidth={0.25} opacity={0.92} pointerEvents="none" />
              <circle cx={p.x * 100} cy={p.y * 50} r={3.2} fill="transparent"
                className="heatmap-remove-target" onClick={(event) => dotClick(p, event)}
                aria-label={`Remove ${p.phase} heatmap dot ${i + 1}`}>
                <title>Double-click to remove one dot; single-click to add a shot</title>
              </circle>
            </g>
          ))}
        </svg>
      </div>

      <div className="heatmap-keybinds" aria-label="Heatmap keyboard shortcuts">
        <span>Single-click to add · Double-click a dot to remove one</span>
        <span><kbd>{hotkeys.auto.toUpperCase()}</kbd> Auto</span>
        <span><kbd>{hotkeys.teleop.toUpperCase()}</kbd> Teleop</span>
        <span><kbd>{hotkeys.undo.toUpperCase()}</kbd> Undo</span>
        <span><kbd>{hotkeys.clear.toUpperCase()}</kbd> Clear</span>
      </div>

      <div className="row" style={{ justifyContent: "space-between", marginTop: 10 }}>
        <div className="row" style={{ gap: 8, fontSize: "0.8rem" }}>
          <span className="badge">Auto made {counts.autoMade}</span>
          <span className="badge">Teleop made {counts.teleMade}</span>
        </div>
        <div className="btn-row">
          <button type="button" className="btn sm ghost" onClick={undo} disabled={!points.length} title={hotkeys.undo.toUpperCase()}>
            Undo
          </button>
          <button type="button" className="btn sm ghost" onClick={clear} disabled={!points.length} title={hotkeys.clear.toUpperCase()}>
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
type HeatPhase = "all" | "auto" | "teleop";

/** Which driver station the scout was watching, if the report carried it. */
function stationKey(p: HeatPoint): StationFilter | "" {
  if (!p.alliance || !p.station) return "";
  return `${p.alliance}${p.station}` as StationFilter;
}

function stationLabel(s: StationFilter): string {
  if (s === "all") return "All stations";
  return s.replace("red", "Red ").replace("blue", "Blue ");
}

/** Distinct hue per overlaid team so stacked density clouds stay separable. */
const OVERLAY_COLORS = ["#22d3ee", "#d946ef", "#fbbf24", "#34d399", "#fb7185", "#60a5fa"];
const OVERLAY_MAX = 6;

export function OverlayHeatmap({
  series,
}: {
  series: { team: number; label: string; points: HeatPoint[] }[];
}) {
  const uid = useId().replace(/:/g, "");
  const [phase, setPhase] = useState<HeatPhase>("all");
  const [station, setStation] = useState<StationFilter>("all");
  const [active, setActive] = useState<number[]>([]);
  const signature = series.map((item) => item.team).join(",");

  useEffect(() => {
    setActive((current) => {
      const available = new Set(series.map((item) => item.team));
      const kept = current.filter((team) => available.has(team));
      const added = series.map((item) => item.team).filter((team) => !kept.includes(team));
      return [...kept, ...added].slice(0, OVERLAY_MAX);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const colors = new Map(active.map((team, index) => [team, OVERLAY_COLORS[index]]));
  const visible = series
    .filter((item) => active.includes(item.team))
    .map((item) => ({
      ...item,
      color: colors.get(item.team)!,
      filtered: item.points.filter(
        (point) =>
          point.result !== "missed" && (phase === "all" || point.phase === phase) &&
          (station === "all" || stationKey(point) === station)
      ),
    }));
  const total = visible.reduce((sum, item) => sum + item.filtered.length, 0);
  const radius = total > 180 ? 2.8 : total > 70 ? 3.8 : 5;

  function toggle(team: number) {
    setActive((current) =>
      current.includes(team)
        ? current.filter((value) => value !== team)
        : current.length < OVERLAY_MAX
          ? [...current, team]
          : current
    );
  }

  return (
    <div className="overlay-heatmap">
      <div className="overlay-heatmap-controls">
        <div className="seg" aria-label="Overlay phase">
          {(["all", "auto", "teleop"] as const).map((value) => (
            <button
              type="button"
              key={value}
              className={phase === value ? "on" : ""}
              aria-pressed={phase === value}
              onClick={() => setPhase(value)}
            >
              {value === "all" ? "Both" : value === "auto" ? "Auto" : "Teleop"}
            </button>
          ))}
        </div>
        <label>
          Driver station
          <select
            aria-label="Overlay driver station"
            value={station}
            onChange={(event) => setStation(event.target.value as StationFilter)}
          >
            <option value="all">All stations</option>
            {(["red1", "red2", "red3", "blue1", "blue2", "blue3"] as StationFilter[]).map((value) => (
              <option key={value} value={value}>
                {stationLabel(value)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="overlay-team-toggles" aria-label="Teams shown on overlay">
        {series.map((item) => {
          const on = active.includes(item.team);
          const disabled = !on && active.length >= OVERLAY_MAX;
          return (
            <button
              type="button"
              key={item.team}
              className={`overlay-team-toggle${on ? " on" : ""}`}
              aria-pressed={on}
              disabled={disabled}
              onClick={() => toggle(item.team)}
            >
              <i style={{ background: colors.get(item.team) || "#6b6471" }} />
              <span>{item.label}</span>
              <small>{item.points.length} shots</small>
            </button>
          );
        })}
      </div>

      <div className="field-wrap overlay-field">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="field-bg" src={FIELD_SRC} alt="field" style={{ opacity: 0.38 }} />
        <svg className="field-svg" viewBox="0 0 100 50" preserveAspectRatio="none">
          {visible.map((item) => (
            <g key={item.team} style={{ mixBlendMode: "screen" }}>
              <defs>
                <radialGradient id={`${uid}-${item.team}-gradient`}>
                  <stop offset="0%" stopColor={item.color} stopOpacity="0.95" />
                  <stop offset="52%" stopColor={item.color} stopOpacity="0.38" />
                  <stop offset="100%" stopColor={item.color} stopOpacity="0" />
                </radialGradient>
                <filter id={`${uid}-${item.team}-blur`} x="-15%" y="-15%" width="130%" height="130%">
                  <feGaussianBlur stdDeviation="1.25" />
                </filter>
              </defs>
              <g filter={`url(#${uid}-${item.team}-blur)`}>
                {item.filtered.map((point, index) => (
                  <circle
                    key={index}
                    cx={point.x * 100}
                    cy={point.y * 50}
                    r={radius}
                    fill={`url(#${uid}-${item.team}-gradient)`}
                  />
                ))}
              </g>
            </g>
          ))}
        </svg>
        {!total && <div className="overlay-empty">No shots match these filters.</div>}
      </div>

      <div className="overlay-gradient-legends">
        {visible.map((item) => (
          <div key={item.team}>
            <span>{item.label}</span>
            <i style={{ background: `linear-gradient(90deg, transparent, ${item.color})` }} />
            <small>{item.filtered.length} shots</small>
          </div>
        ))}
      </div>
      <p className="faint overlay-help">
        Brighter areas mean more shots from that location. When team colors overlap, the colors blend so shared scoring zones stay visible.
      </p>
    </div>
  );
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
  showControls = true, stats: cloudStats,
}: {
  points: HeatPoint[];
  height?: number;
  expandable?: boolean;
  showControls?: boolean;
  stats?: { total: number; made: number; accuracy: number | null; filters?: Record<string, {total: number; made: number; accuracy: number | null}> };
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
      p.result !== "missed" && (phase === "all" || p.phase === phase) &&
      (station === "all" || stationKey(p) === station)
  );
  const selectedStats = cloudStats?.filters?.[`${phase}|${station}`] || (phase === "all" && station === "all" ? cloudStats : undefined);

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
                className="shot-dot" key={`m${i}`}
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
    <div className="row heatmap-stats" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
      <span className="badge muted">{selectedStats?.total ?? "—"} <MetricLabel metric="attempts">attempts</MetricLabel></span>
      <span className="badge green">{selectedStats?.made ?? "—"} <MetricLabel metric="made">made</MetricLabel></span>
      <span className="badge haze">
        {selectedStats?.accuracy == null ? "—" : `${Math.round(selectedStats.accuracy * 100)}%`} <MetricLabel metric="accuracy">accuracy</MetricLabel>
      </span>
    </div>
  );

  const legend = (
    <div className="heatmap-legend">
      <span className="faint">Made shots from here:</span>
      <span className="heat-ramp" aria-hidden />
      <span className="faint">a few</span>
      <span className="faint">a lot</span>
      {markers && <span className="faint">Each dot is a made shot.</span>}
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
        <button type="button" className="btn sm ghost" style={{ marginTop: 8 }} onClick={() => setOpen(true)} aria-label="Open scoring heatmap full size">
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
      <div className="field-zoom" role="dialog" aria-modal="true" aria-label="Scoring map" onClick={(e) => e.stopPropagation()}>
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

      </div>
    </div>,
    document.body,
  );
}

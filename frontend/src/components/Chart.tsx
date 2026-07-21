"use client";
import React, { useState } from "react";

interface Pt { x: number | string; y: number; }

export function LineChart({ data, height = 180, color = "#a78bfa", label }: { data: Pt[]; height?: number; color?: string; label?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!data.length) return <div className="empty" style={{ padding: 24 }}>No data yet</div>;
  const W = 100, H = 50, pad = 4;
  const ys = data.map((d) => d.y);
  const maxY = Math.max(...ys, 1);
  const minY = Math.min(...ys, 0);
  const span = maxY - minY || 1;
  const px = (i: number) => pad + (i / Math.max(1, data.length - 1)) * (W - pad * 2);
  const py = (y: number) => H - pad - ((y - minY) / span) * (H - pad * 2);
  const path = data.map((d, i) => `${i === 0 ? "M" : "L"}${px(i).toFixed(2)},${py(d.y).toFixed(2)}`).join(" ");
  const area = `${path} L${px(data.length - 1).toFixed(2)},${H - pad} L${px(0).toFixed(2)},${H - pad} Z`;
  const active = hover == null ? null : data[hover];
  const setNearest = (clientX: number, rect: DOMRect) => {
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    setHover(Math.round(ratio * Math.max(0, data.length - 1)));
  };
  return (
    <div className="chart-wrap">
      {label && <div className="muted" style={{ fontSize: "0.8rem", marginBottom: 6 }}>{label}</div>}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height }}
        onMouseMove={(e) => setNearest(e.clientX, e.currentTarget.getBoundingClientRect())}
        onMouseLeave={() => setHover(null)}
        onTouchMove={(e) => {
          const touch = e.touches[0];
          if (touch) setNearest(touch.clientX, e.currentTarget.getBoundingClientRect());
        }}
      >
        <defs>
          <linearGradient id="lcfill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#lcfill)" />
        <path d={path} fill="none" stroke={color} strokeWidth="0.8" strokeLinejoin="round" strokeLinecap="round" />
        {data.map((d, i) => (
          <circle key={i} cx={px(i)} cy={py(d.y)} r={hover === i ? "1.8" : "0.9"} fill={color}>
            <title>{`${d.x}: ${d.y}`}</title>
          </circle>
        ))}
        {hover != null && (
          <>
            <line x1={px(hover)} x2={px(hover)} y1={pad} y2={H - pad} stroke={color} strokeOpacity="0.35" strokeWidth="0.45" />
            <circle cx={px(hover)} cy={py(data[hover].y)} r="2.4" fill="none" stroke={color} strokeWidth="0.7" />
          </>
        )}
      </svg>
      {active && (
        <div
          className="chart-tip"
          style={{ left: `${px(hover ?? 0)}%` }}
        >
          <b>{active.x}</b>
          <span>{active.y}</span>
        </div>
      )}
      <div className="row" style={{ justifyContent: "space-between", fontSize: "0.7rem", color: "var(--faint)" }}>
        <span>{data[0].x}</span>
        <span>{data[data.length - 1].x}</span>
      </div>
    </div>
  );
}

export function MiniBars({ data, color = "#a78bfa", height = 120 }: { data: Pt[]; color?: string; height?: number }) {
  if (!data.length) return null;
  const max = Math.max(...data.map((d) => d.y), 1);
  return (
    <div className="row" style={{ alignItems: "flex-end", gap: 4, height }}>
      {data.map((d, i) => (
        <div key={i} style={{ flex: 1, textAlign: "center" }} title={`${d.x}: ${d.y}`}>
          <div
            style={{
              height: `${(d.y / max) * (height - 18)}px`,
              background: `linear-gradient(180deg, ${color}, ${color}55)`,
              borderRadius: 4,
              minHeight: 2,
            }}
          />
          <div style={{ fontSize: "0.6rem", color: "var(--faint)", marginTop: 3 }}>{d.x}</div>
        </div>
      ))}
    </div>
  );
}

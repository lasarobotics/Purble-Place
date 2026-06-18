"use client";
import React from "react";

interface Pt { x: number | string; y: number; }

export function LineChart({ data, height = 180, color = "#a855f7", label }: { data: Pt[]; height?: number; color?: string; label?: string }) {
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
  return (
    <div>
      {label && <div className="muted" style={{ fontSize: "0.8rem", marginBottom: 6 }}>{label}</div>}
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height }}>
        <defs>
          <linearGradient id="lcfill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#lcfill)" />
        <path d={path} fill="none" stroke={color} strokeWidth="0.8" strokeLinejoin="round" strokeLinecap="round" />
        {data.map((d, i) => (
          <circle key={i} cx={px(i)} cy={py(d.y)} r="0.9" fill={color} />
        ))}
      </svg>
      <div className="row" style={{ justifyContent: "space-between", fontSize: "0.7rem", color: "var(--faint)" }}>
        <span>{data[0].x}</span>
        <span>{data[data.length - 1].x}</span>
      </div>
    </div>
  );
}

export function MiniBars({ data, color = "#8b5cf6", height = 120 }: { data: Pt[]; color?: string; height?: number }) {
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

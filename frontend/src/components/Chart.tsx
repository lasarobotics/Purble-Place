"use client";
import React, { useEffect, useId, useRef, useState } from "react";

import { MetricLabel } from "./MetricLabel";

interface Pt { x: number | string; y: number; }

export function LineChart({ data, height = 220, color = "#bd8cff", label }: { data: Pt[]; height?: number; color?: string; label?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [width, setWidth] = useState(520);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId().replace(/:/g, "");
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, entry.contentRect.width)));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [data.length > 0]);
  useEffect(() => setHover(null), [data]);
  if (!data.length) return <div className="empty" style={{ padding: 24 }}>No data yet</div>;
  const H = Math.max(190, height), left = 40, right = 18, top = 22, bottom = H - 32;
  const min = Math.min(0, ...data.map(d => d.y));
  const max = Math.max(...data.map(d => d.y), 1);
  const ceiling = max + (max - min) * .16;
  const px = (i: number) => data.length === 1 ? (width + left - right) / 2 : left + i / (data.length - 1) * (width - left - right);
  const py = (value: number) => bottom - (value - min) / (ceiling - min) * (bottom - top);
  // Horizontal Bezier controls keep each segment inside its endpoint range.
  const path = data.map((d, i) => {
    if (!i) return `M ${px(i)} ${py(d.y)}`;
    const mid = (px(i - 1) + px(i)) / 2;
    return `C ${mid} ${py(data[i - 1].y)}, ${mid} ${py(d.y)}, ${px(i)} ${py(d.y)}`;
  }).join(" ");
  const area = `${path} L ${px(data.length - 1)} ${bottom} L ${px(0)} ${bottom} Z`;
  const activeIndex = hover != null && data[hover] ? hover : null;
  const active = activeIndex == null ? null : data[activeIndex];
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(width / 70))));
  return <div ref={ref} className="chart-wrap trend-chart">
    <div className="trend-caption"><span><i style={{ background: color }} /><MetricLabel>{label || "Performance"}</MetricLabel></span><small>Hover or tap a dot</small></div>
    <svg viewBox={`0 0 ${width} ${H}`} width="100%" height={H} aria-label={label || "Performance trend"} role="img" onMouseLeave={() => setHover(null)}>
      <defs><linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={color} stopOpacity=".25" /><stop offset="100%" stopColor={color} stopOpacity=".015" />
      </linearGradient></defs>
      {[0, 1, 2, 3].map(i => {
        const value = min + (ceiling - min) * i / 3;
        return <g key={i} className="trend-grid"><line x1={left} x2={width - right} y1={py(value)} y2={py(value)} />
          <text x={left - 10} y={py(value) + 4} textAnchor="end">{Math.round(value)}</text></g>;
      })}
      {data.length > 1 && <path d={area} fill={`url(#${id}-fill)`} />}
      <path d={path} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {activeIndex != null && <line x1={px(activeIndex)} x2={px(activeIndex)} y1={top} y2={bottom} stroke={color} strokeOpacity=".4" strokeDasharray="3 5" />}
      {data.map((d, i) => <g key={`${d.x}-${i}`}>
        <circle cx={px(i)} cy={py(d.y)} r={activeIndex === i ? 11 : 7} fill={color} opacity={activeIndex === i ? .2 : .08} />
        <circle className="trend-dot" cx={px(i)} cy={py(d.y)} r={activeIndex === i ? 5 : 3.5} fill="#21132f" stroke={color} strokeWidth="2" />
        <circle cx={px(i)} cy={py(d.y)} r="14" fill="transparent" tabIndex={0} role="button" aria-label={`${d.x}: ${d.y} points`}
          onMouseEnter={() => setHover(i)} onClick={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
          onKeyDown={e => { if (e.key === "Escape") setHover(null); }}><title>{d.x}: {d.y} points</title></circle>
        {(i % labelEvery === 0 || i === data.length - 1) && <text className="trend-axis" x={px(i)} y={H - 8} textAnchor="middle">{d.x}</text>}
      </g>)}
    </svg>
    {active && activeIndex != null && <div className="trend-tip" role="status" style={{ left: Math.max(62, Math.min(width - 62, px(activeIndex))), top: Math.max(24, py(active.y) - 24) }}>
      <span>{active.x}</span><b>{active.y.toLocaleString(undefined, { maximumFractionDigits: 2 })}<small> pts</small></b>
    </div>}
  </div>;
}

export function MiniBars({ data, color = "#6d28d9", height = 120 }: { data: Pt[]; color?: string; height?: number }) {
  if (!data.length) return null;
  const max = Math.max(...data.map(d => d.y), 1);
  return <div className="row" style={{ alignItems: "flex-end", gap: 4, height }}>
    {data.map((d, i) => <div key={i} style={{ flex: 1, textAlign: "center" }} title={`${d.x}: ${d.y}`}>
      <div style={{ height: `${d.y / max * (height - 18)}px`, background: `linear-gradient(180deg, ${color}, ${color}55)`, borderRadius: 4, minHeight: 2 }} />
      <div style={{ fontSize: ".6rem", color: "var(--faint)", marginTop: 3 }}>{d.x}</div>
    </div>)}
  </div>;
}

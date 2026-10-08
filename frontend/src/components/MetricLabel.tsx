"use client";
import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { METRICS, metricKey } from "@/lib/metrics";

export function MetricLabel({ metric, children }: { metric?: string; children?: string }) {
  const definition = METRICS[metric || metricKey(children || "") || ""];
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  if (!definition) return <>{children}</>;
  function show() {
    const r = ref.current!.getBoundingClientRect();
    setPosition({ left: Math.max(12, Math.min(r.left, window.innerWidth - 372)), top: r.bottom + 8 });
  }
  const fraction = definition.formula.split(" ÷ ");
  return <span ref={ref} className="metric-label" tabIndex={0} aria-describedby={position ? id : undefined}
    onMouseEnter={show} onMouseLeave={() => setPosition(null)} onFocus={show} onBlur={() => setPosition(null)}
    onClick={() => position ? setPosition(null) : show()} onKeyDown={e => { if (e.key === "Escape") setPosition(null); }}>
    {children || definition.label}
    {position && createPortal(<span id={id} role="tooltip" className="metric-tooltip" style={{ left: position.left, top: Math.min(position.top, window.innerHeight - 230) }}>
      <span>{definition.description}</span>
      <span className="metric-formula" aria-label={definition.formula}>
        {fraction.length === 2 ? <span className="metric-fraction"><span>{fraction[0]}</span><span>{fraction[1]}</span></span> : definition.formula}
      </span>
      <small>Computed on the server. No-shows excluded unless stated. Percentages = ratio × 100.</small>
    </span>, document.body)}
  </span>;
}

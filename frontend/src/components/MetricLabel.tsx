"use client";
import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/api";
import { METRICS, metricKey } from "@/lib/metrics";

let lastDataEntryPromise: Promise<string | null> | null = null;
let lastDataEntryLoadedAt = 0;

function formatLastDataEntry(iso: string | null): string {
  if (!iso) return "No entries yet";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

function loadLastDataEntry(): Promise<string | null> {
  if (!lastDataEntryPromise || Date.now() - lastDataEntryLoadedAt > 15000) {
    lastDataEntryLoadedAt = Date.now();
    lastDataEntryPromise = api<{ last_data_entry: string | null }>("/api/scout/last-data-entry")
      .then((r) => r.last_data_entry || null)
      .catch(() => null);
  }
  return lastDataEntryPromise;
}

export function MetricLabel({ metric, children }: { metric?: string; children?: string }) {
  const definition = METRICS[metric || metricKey(children || "") || ""];
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [lastDataEntry, setLastDataEntry] = useState<string | null>(null);
  if (!definition) return <>{children}</>;
  function show() {
    const r = ref.current!.getBoundingClientRect();
    setPosition({ left: Math.max(12, Math.min(r.left, window.innerWidth - 372)), top: r.bottom + 8 });
    void loadLastDataEntry().then(setLastDataEntry);
  }
  const formulaLines = definition.formula.split(" ; ");
  return <span ref={ref} className="metric-label" tabIndex={0} aria-describedby={position ? id : undefined}
    onMouseEnter={show} onMouseLeave={() => setPosition(null)} onFocus={show} onBlur={() => setPosition(null)}
    onClick={() => position ? setPosition(null) : show()} onKeyDown={e => { if (e.key === "Escape") setPosition(null); }}>
    {children || definition.label}
    {position && createPortal(<span id={id} role="tooltip" className="metric-tooltip" style={{ left: position.left, top: Math.min(position.top, window.innerHeight - 230) }}>
      <span>{definition.description}</span>
      <span className="metric-formula" aria-label={definition.formula}>
        {formulaLines.map((line, index) => {
          const fraction = line.split(" ÷ ");
          return <span key={index} style={{ display: "block" }}>{fraction.length === 2 ? <span className="metric-fraction"><span>{fraction[0]}</span><span>{fraction[1]}</span></span> : line}</span>;
        })}
      </span>
      <small>Last data entry: {formatLastDataEntry(lastDataEntry)}</small>
    </span>, document.body)}
  </span>;
}

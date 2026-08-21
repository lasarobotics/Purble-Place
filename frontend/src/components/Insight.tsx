"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { TeamInsight } from "@/lib/types";
import { Icon } from "./icons";

const VERDICT_META: Record<TeamInsight["verdict"], { label: string; cls: string }> = {
  "first-pick": { label: "First-pick material", cls: "green" },
  "second-pick": { label: "Second-pick candidate", cls: "haze" },
  "third-pick": { label: "Situational pick", cls: "amber" },
  avoid: { label: "Pass on data", cls: "red" },
  unknown: { label: "Not enough data", cls: "muted" },
};

/** Haze Intel. AI-assisted summary where every bullet carries its evidence. */
export function HazeIntel({ teamNumber }: { teamNumber: number }) {
  const [insight, setInsight] = useState<TeamInsight | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    setInsight(null);
    setError(false);
    api<TeamInsight>(`/api/teams/${teamNumber}/insight`)
      .then((i) => alive && setInsight(i))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [teamNumber]);

  if (error) return null;
  if (!insight) {
    return (
      <div className="card tight intel-card">
        <div className="intel-loading">
          <span className="intel-spark"><Icon name="sparkles" size={16} /></span>
          Reading the scouting record...
        </div>
      </div>
    );
  }

  const verdict = VERDICT_META[insight.verdict] ?? VERDICT_META.unknown;
  return (
    <div className="card tight intel-card">
      <div className="card-h" style={{ marginBottom: 10 }}>
        <h3 className="intel-title">
          <span className="intel-spark"><Icon name="sparkles" size={16} /></span>
          Haze Intel
        </h3>
        <div className="row" style={{ gap: 6 }}>
          <span className="badge muted">{insight.role}</span>
          <span className={`badge ${verdict.cls}`}>{verdict.label}</span>
        </div>
      </div>
      <p className="intel-headline">{insight.headline}</p>

      {(insight.strengths.length > 0 || insight.concerns.length > 0) && (
        <div className="intel-cols">
          {insight.strengths.length > 0 && (
            <div>
              <div className="intel-label up">Strengths</div>
              {insight.strengths.map((b, i) => (
                <div key={i} className="intel-bullet">
                  <b>{b.text}</b>
                  <span>{b.evidence}</span>
                </div>
              ))}
            </div>
          )}
          {insight.concerns.length > 0 && (
            <div>
              <div className="intel-label down">Concerns</div>
              {insight.concerns.map((b, i) => (
                <div key={i} className="intel-bullet">
                  <b>{b.text}</b>
                  <span>{b.evidence}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {insight.watch.length > 0 && (
        <div className="intel-watch">
          <div className="intel-label film">Check on film</div>
          {insight.watch.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </div>
      )}
      <div className="intel-foot">
        {insight.source === "claude" ? "Written by Claude" : "Rules engine"} · grounded in{" "}
        {insight.matches} scouted {insight.matches === 1 ? "match" : "matches"}
      </div>
    </div>
  );
}

/** Aggregated quick-tag chips with counts. */
export function TagCloud({ tags }: { tags?: { tag: string; count: number }[] }) {
  if (!tags || tags.length === 0) return null;
  return (
    <div className="tag-list" style={{ marginTop: 2 }}>
      {tags.map(({ tag, count }) => (
        <span key={tag} className="chip static">
          {tag} <b className="chip-count">×{count}</b>
        </span>
      ))}
    </div>
  );
}

"""Haze Intel: AI-assisted team summaries grounded in scouting evidence.

Every claim in an insight is backed by a number, tag count, or scout note
pulled straight from the database, so the output is auditable in picklist
meetings (the TideScout "AI summaries grounded in raw scouting evidence"
idea).

Two engines:

* **rules** (always available): a deterministic narrative generator that
  ranks the team against the rest of the event and writes strengths /
  concerns / verdict with the supporting evidence attached.
* **claude** (optional): if the `anthropic` package is installed and
  ``ANTHROPIC_API_KEY`` is set, the same evidence pack is handed to Claude
  to write the narrative. Falls back to rules on any failure, so the
  feature works offline at competitions.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any

from .analytics import (
    negative_tags,
    positive_tags,
    all_summaries,
    team_entries,
    team_summary,
)

AI_MODEL = os.getenv("HAZEHUB_AI_MODEL", "claude-opus-4-8")


# --------------------------------------------------------------------------- #
# Evidence pack                                                                #
# --------------------------------------------------------------------------- #
def _percentile(vals: list[float], v: float) -> float:
    vals = sorted(vals)
    if len(vals) < 2:
        return 0.5
    below = sum(1 for x in vals if x < v)
    return below / (len(vals) - 1)


def _evidence(event_key: str, team: int) -> dict[str, Any]:
    s = team_summary(event_key, team)
    entries = team_entries(event_key, team)
    # all_summaries is memoised, so ranking a team against the field costs one
    # dict lookup rather than re-aggregating every team on every request.
    field = [f for f in all_summaries(event_key).values() if f["matches"] > 0]

    def pct(key: str) -> float:
        values = [f[key] for f in field if f.get(key) is not None]
        return round(_percentile(values, s[key]), 2) if s.get(key) is not None else 0.5

    notes = [
        {"match": e.match_number, "scout": e.scout_id, "note": e.notes.strip()}
        for e in entries
        if e.notes and e.notes.strip()
    ]
    failures = [
        {"match": e.match_number, "detail": e.failure_details or "unspecified failure"}
        for e in entries
        if e.failure
    ]
    return {
        "summary": {**s, "avg_points": s.get("avg_points") or 0.0},
        "pct": {
            "avg_points": pct("avg_points"),
            "consistency": pct("consistency"),
            "climb_rate": pct("climb_rate"),
            "avg_driver": pct("avg_driver"),
            "avg_speed": pct("avg_speed"),
            "defense_rate": pct("defense_rate"),
        },
        "notes": notes[-10:],
        "failures": failures,
        "field_size": len(field),
    }


# --------------------------------------------------------------------------- #
# Rule-based narrative                                                         #
# --------------------------------------------------------------------------- #
def _tier_word(p: float) -> str:
    if p >= 0.85:
        return "elite"
    if p >= 0.65:
        return "strong"
    if p >= 0.4:
        return "mid-pack"
    if p >= 0.2:
        return "below average"
    return "weak"


def _rules_insight(ev: dict[str, Any]) -> dict[str, Any]:
    s, p = ev["summary"], ev["pct"]
    n = s["matches"]
    strengths: list[dict[str, str]] = []
    concerns: list[dict[str, str]] = []
    watch: list[str] = []

    def add(bucket: list, text: str, evidence: str) -> None:
        bucket.append({"text": text, "evidence": evidence})

    # --- Scoring ---
    acc_att = s["counts"]["teleop_made"] + s["counts"]["teleop_missed"]
    acc = s["counts"]["teleop_made"] / acc_att if acc_att else 0.0
    if p["avg_points"] >= 0.65:
        add(strengths, f"{_tier_word(p['avg_points']).capitalize()} scorer for this event.",
            f"{s['avg_points']} avg pts (top {round((1 - p['avg_points']) * 100)}% of {ev['field_size']} teams), peak {s['max_points']}")
    elif p["avg_points"] <= 0.3:
        add(concerns, "Low scoring output relative to the field.",
            f"{s['avg_points']} avg pts across {n} matches (bottom {round(p['avg_points'] * 100)}%)")
    if acc_att >= 8:
        if acc >= 0.72:
            add(strengths, "Efficient shooter: makes what it attempts.",
                f"{s['counts']['teleop_made']}/{acc_att} teleop attempts made ({round(acc * 100)}%)")
        elif acc <= 0.45:
            add(concerns, "Wastes cycles on missed attempts.",
                f"only {s['counts']['teleop_made']}/{acc_att} teleop attempts made ({round(acc * 100)}%)")

    # --- Reliability ---
    if n >= 3 and p["consistency"] >= 0.65:
        add(strengths, "Repeats its performance match after match.",
            f"consistency {s['consistency']} (σ {s['std_points']} pts), {n} matches")
    elif n >= 3 and s["consistency"] <= 0.5:
        add(concerns, "Boom-or-bust: output swings hard between matches.",
            f"range {s['min_points']}-{s['max_points']} pts, σ {s['std_points']}")
    if s["failure_rate"] >= 0.25:
        details = "; ".join(f"Q{f['match']}: {f['detail']}" for f in ev["failures"][:3])
        add(concerns, "Reliability risk: has died or broken on the field.",
            f"failed in {round(s['failure_rate'] * 100)}% of matches ({details})")
    if s.get("no_shows"):
        add(concerns, "Has no-showed a match: verify they can field the robot.",
            f"{s['no_shows']} no-show{'s' if s['no_shows'] != 1 else ''} recorded")
    elif n >= 4 and s["failure_rate"] == 0:
        add(strengths, "Zero recorded failures.", f"{n} clean matches")

    # --- Endgame ---
    if s["climb_rate"] >= 0.7:
        add(strengths, "Endgame climb is close to automatic.",
            f"climbed in {round(s['climb_rate'] * 100)}% of matches")
    elif s["climb_rate"] <= 0.25 and n >= 3:
        add(concerns, "Rarely converts the endgame climb.",
            f"climbed in {round(s['climb_rate'] * 100)}% of matches")

    # --- Defense / driver ---
    if s["defense_rate"] >= 0.4:
        add(strengths, "Willing and practiced defender.",
            f"played defense in {round(s['defense_rate'] * 100)}% of matches, {s['total_stops']} recorded stops")
    if p["avg_driver"] >= 0.75:
        add(strengths, "Drive team stands out.",
            f"driver skill {s['avg_driver']}/5, speed {s['avg_speed']}/5 (top quartile)")
    elif p["avg_driver"] <= 0.2 and n >= 3:
        add(concerns, "Scouts rate the driving poorly.",
            f"driver skill {s['avg_driver']}/5 across {n} reports")
    if s["total_fouls"] >= max(3, n):
        add(concerns, "Foul-prone: could gift points in playoffs.",
            f"{s['total_fouls']} fouls in {n} matches")

    # --- Tags ---
    for row in s["tags"][:6]:
        share = row["count"] / max(1, n)
        if row["tag"] in positive_tags() and share >= 0.4:
            add(strengths, f'Scouts keep tagging it "{row["tag"]}".',
                f"{row['count']} of {n} reports")
        elif row["tag"] in negative_tags() and share >= 0.3:
            add(concerns, f'Recurring "{row["tag"]}" tag from the stands.',
                f"{row['count']} of {n} reports")

    # --- Film-check suggestions ---
    if s["max_points"] >= s["avg_points"] * 1.6 and n >= 3:
        watch.append(
            f"Peak of {s['max_points']} pts is {round(s['max_points'] / max(0.1, s['avg_points']), 1)}× its average: "
            "check film whether that ceiling is real or a soft schedule."
        )
    if ev["failures"]:
        watch.append(f"Re-watch Q{ev['failures'][-1]['match']}: most recent failure ({ev['failures'][-1]['detail']}).")
    if s["defense_rate"] > 0 and s["defense_rate"] < 0.4:
        watch.append("Has flashed defense: verify on film whether it holds up before slotting as a defense pick.")

    # --- Verdict ---
    blend = 0.5 * p["avg_points"] + 0.3 * p["consistency"] + 0.2 * p["climb_rate"]
    penalty = 0.25 * s["failure_rate"]
    v = blend - penalty
    if n == 0:
        verdict, headline = "unknown", "No scouting data yet: send a scout or pull pit data."
    elif v >= 0.7:
        verdict = "first-pick"
        headline = f"{_tier_word(p['avg_points']).capitalize()} scorer with {_tier_word(p['consistency'])} consistency: first-pick material."
    elif v >= 0.45:
        verdict = "second-pick"
        headline = "Solid contributor: a dependable second-pick candidate."
    elif v >= 0.25:
        verdict = "third-pick"
        headline = "Situational pick: value depends on what your alliance is missing."
    else:
        verdict = "avoid"
        headline = "Data says pass unless film shows something the numbers miss."
    if s["failure_rate"] >= 0.25 and verdict in ("first-pick", "second-pick"):
        headline += " Reliability is the asterisk."

    role = "Offense carry" if p["avg_points"] >= 0.7 else \
        "Two-way robot" if s["defense_rate"] >= 0.3 and p["avg_points"] >= 0.4 else \
        "Defense / support" if s["defense_rate"] >= 0.35 else \
        "Support scorer"

    return {
        "headline": headline,
        "role": role,
        "verdict": verdict,
        "strengths": strengths[:5],
        "concerns": concerns[:5],
        "watch": watch[:3],
        "source": "rules",
    }


# --------------------------------------------------------------------------- #
# Optional Claude upgrade                                                      #
# --------------------------------------------------------------------------- #
def _claude_insight(ev: dict[str, Any]) -> dict[str, Any] | None:
    if not os.getenv("ANTHROPIC_API_KEY"):
        return None
    try:
        import anthropic
    except ImportError:
        return None
    try:
        client = anthropic.Anthropic()
        response = client.messages.create(
            model=AI_MODEL,
            max_tokens=1200,
            system=(
                "You are the strategy analyst for an FRC scouting app. Write a team "
                "insight grounded ONLY in the evidence JSON provided: every claim "
                "must cite a number, tag count, or scout note from it. Be direct and "
                "picklist-oriented."
            ),
            messages=[{
                "role": "user",
                "content": (
                    "Evidence pack for team "
                    f"{ev['summary']['team']}:\n{json.dumps(ev, default=str)}"
                ),
            }],
            output_config={
                "format": {
                    "type": "json_schema",
                    "schema": {
                        "type": "object",
                        "properties": {
                            "headline": {"type": "string"},
                            "role": {"type": "string"},
                            "verdict": {"type": "string", "enum": ["first-pick", "second-pick", "third-pick", "avoid", "unknown"]},
                            "strengths": {"type": "array", "items": {
                                "type": "object",
                                "properties": {"text": {"type": "string"}, "evidence": {"type": "string"}},
                                "required": ["text", "evidence"], "additionalProperties": False}},
                            "concerns": {"type": "array", "items": {
                                "type": "object",
                                "properties": {"text": {"type": "string"}, "evidence": {"type": "string"}},
                                "required": ["text", "evidence"], "additionalProperties": False}},
                            "watch": {"type": "array", "items": {"type": "string"}},
                        },
                        "required": ["headline", "role", "verdict", "strengths", "concerns", "watch"],
                        "additionalProperties": False,
                    },
                }
            },
        )
        if response.stop_reason == "refusal":
            return None
        text = next(b.text for b in response.content if b.type == "text")
        out = json.loads(text)
        out["source"] = "claude"
        return out
    except Exception:
        return None


# --------------------------------------------------------------------------- #
# Public API                                                                   #
# --------------------------------------------------------------------------- #
def team_insight(event_key: str, team: int) -> dict[str, Any]:
    ev = _evidence(event_key, team)
    insight = _claude_insight(ev) or _rules_insight(ev)
    return {
        "team": team,
        "event": event_key,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "matches": ev["summary"]["matches"],
        **insight,
    }

"""Team analytics: summaries, rankings, strength-of-schedule, compare.

These power the admin Team Search / Team Rank / Data Picklist / Compare tabs.
"""
from __future__ import annotations

import statistics
from typing import Any, Optional

from sqlmodel import Session, select

from .models import MatchRecord, ScoutEntry, TeamCache
from .scoring import phase_counts


# --------------------------------------------------------------------------- #
# Per-team aggregation                                                         #
# --------------------------------------------------------------------------- #
def team_entries(session: Session, event_key: str, team: int) -> list[ScoutEntry]:
    stmt = (
        select(ScoutEntry)
        .where(ScoutEntry.event_key == event_key, ScoutEntry.team_number == team)
        .order_by(ScoutEntry.match_number)
    )
    return list(session.exec(stmt).all())


def _coeff_var(values: list[float]) -> float:
    """Coefficient of variation (std/mean). Lower = more consistent."""
    if len(values) < 2:
        return 0.0
    mean = statistics.fmean(values)
    if mean <= 0:
        return 0.0
    return statistics.pstdev(values) / mean


def team_summary(session: Session, event_key: str, team: int) -> dict[str, Any]:
    all_entries = team_entries(session, event_key, team)
    # No-shows are a reliability signal, not a performance sample.
    entries = [e for e in all_entries if not e.no_show]
    no_shows = len(all_entries) - len(entries)
    pts = [e.points for e in entries]
    n = len(entries)

    per_match: dict[int, list[float]] = {}
    for e in entries:
        per_match.setdefault(e.match_number, []).append(e.points)
    match_points = [
        {"match": m, "points": round(statistics.fmean(v), 2)}
        for m, v in sorted(per_match.items())
    ]

    counts = {"auto_made": 0, "auto_missed": 0, "teleop_made": 0, "teleop_missed": 0}
    for e in entries:
        c = phase_counts({"heatmap": e.heatmap})
        for k in counts:
            counts[k] += c[k]

    climb_levels = [e.climb for e in entries if e.climb and e.climb != "none"]
    consistency = max(0.0, 1.0 - _coeff_var(pts)) if n >= 2 else (1.0 if n == 1 else 0.0)

    # Structured qualitative tags, counted across every report on this team.
    tag_counts: dict[str, int] = {}
    for e in entries:
        for t in e.tags or []:
            tag_counts[t] = tag_counts.get(t, 0) + 1
    top_tags = sorted(tag_counts.items(), key=lambda kv: -kv[1])

    tc = session.get(TeamCache, team)
    return {
        "team": team,
        "nickname": tc.nickname if tc else "",
        "avatar": tc.avatar if tc else "",
        "epa": tc.epa if tc else None,
        "matches": n,
        "avg_points": round(statistics.fmean(pts), 2) if pts else 0.0,
        "max_points": round(max(pts), 2) if pts else 0.0,
        "min_points": round(min(pts), 2) if pts else 0.0,
        "std_points": round(statistics.pstdev(pts), 2) if n >= 2 else 0.0,
        "consistency": round(consistency, 3),
        "climb_rate": round(len(climb_levels) / n, 3) if n else 0.0,
        "defense_rate": round(sum(e.played_defense for e in entries) / n, 3) if n else 0.0,
        "failure_rate": round(sum(e.failure for e in entries) / n, 3) if n else 0.0,
        "no_shows": no_shows,
        "avg_driver": round(statistics.fmean([e.driver_skill for e in entries]), 2) if n else 0.0,
        "avg_speed": round(statistics.fmean([e.speed_rating for e in entries]), 2) if n else 0.0,
        "total_fouls": sum(e.fouls for e in entries),
        "total_stops": sum(e.successful_stops for e in entries),
        "counts": counts,
        "match_points": match_points,
        "tags": [{"tag": t, "count": c} for t, c in top_tags],
    }


def event_teams(session: Session, event_key: str) -> list[int]:
    """All team numbers seen in scouting for this event."""
    rows = session.exec(
        select(ScoutEntry.team_number).where(ScoutEntry.event_key == event_key)
    ).all()
    return sorted({int(t) for t in rows})


# --------------------------------------------------------------------------- #
# Ranking                                                                      #
# --------------------------------------------------------------------------- #
RANK_METRICS = {
    "avg_points": "Avg points",
    "max_points": "Peak points",
    "consistency": "Consistency",
    "climb_rate": "Climb rate",
    "defense_rate": "Defense rate",
    "avg_driver": "Driver skill",
    "avg_speed": "Speed",
    "epa": "Statbotics EPA",
    "total_stops": "Defensive stops",
}


def rank_teams(session: Session, event_key: str, metric: str = "avg_points") -> list[dict[str, Any]]:
    metric = metric if metric in RANK_METRICS else "avg_points"
    rows = [team_summary(session, event_key, t) for t in event_teams(session, event_key)]
    rows = [r for r in rows if r["matches"] > 0 or metric == "epa"]
    rows.sort(key=lambda r: (r.get(metric) or 0), reverse=True)
    for i, r in enumerate(rows, 1):
        r["rank"] = i
    return rows


# --------------------------------------------------------------------------- #
# Heatmap aggregation                                                          #
# --------------------------------------------------------------------------- #
def team_heatmap(
    session: Session, event_key: str, team: int, phase: Optional[str] = None
) -> dict[str, Any]:
    points: list[dict[str, Any]] = []
    for e in team_entries(session, event_key, team):
        for a in e.heatmap or []:
            if phase and a.get("phase") != phase:
                continue
            points.append(
                {
                    "x": a.get("x"),
                    "y": a.get("y"),
                    "phase": a.get("phase"),
                    "result": a.get("result"),
                    "match": e.match_number,
                }
            )
    made = sum(1 for p in points if p["result"] == "made")
    return {
        "team": team,
        "points": points,
        "total": len(points),
        "made": made,
        "accuracy": round(made / len(points), 3) if points else 0.0,
    }


# --------------------------------------------------------------------------- #
# Strength-of-schedule "Data Picklist"                                         #
# --------------------------------------------------------------------------- #
def _event_epa_map(session: Session, event_key: str) -> dict[int, float]:
    out: dict[int, float] = {}
    for t in event_teams(session, event_key):
        tc = session.get(TeamCache, t)
        if tc and tc.epa is not None:
            out[t] = float(tc.epa)
    return out


def data_picklist(session: Session, event_key: str) -> dict[str, Any]:
    """Auto-rank robots by *true* strength.

    A team can look good simply because it keeps drawing weak opponents and
    strong partners.  We discount that:

      base        = avg scouted performance
      reliability = consistency (1 - coeff. of variation), weighted in
      sos         = mean(opponent EPA) - mean(partner EPA)   (per team)
                    > 0  -> hard schedule / carried itself
                    < 0  -> easy schedule / got carried

    true_score = base * (0.65 + 0.35*reliability) + SOS_WEIGHT * sos_z
    where sos_z is the schedule term normalised across the event so the
    adjustment is comparable to point swings.
    """
    teams = event_teams(session, event_key)
    epa_map = _event_epa_map(session, event_key)
    matches = list(
        session.exec(select(MatchRecord).where(MatchRecord.event_key == event_key)).all()
    )
    event_avg_epa = (sum(epa_map.values()) / len(epa_map)) if epa_map else 0.0

    # Gather opponents/partners faced per team from the schedule.
    opp: dict[int, list[float]] = {t: [] for t in teams}
    partner: dict[int, list[float]] = {t: [] for t in teams}
    for m in matches:
        for alliance, foes in (("red", m.blue), ("blue", m.red)):
            mates = m.red if alliance == "red" else m.blue
            for t in mates:
                if t not in opp:
                    continue
                for f in foes:
                    opp[t].append(epa_map.get(f, event_avg_epa))
                for p in mates:
                    if p != t:
                        partner[t].append(epa_map.get(p, event_avg_epa))

    rows: list[dict[str, Any]] = []
    for t in teams:
        s = team_summary(session, event_key, t)
        if s["matches"] == 0:
            continue
        opp_strength = (sum(opp[t]) / len(opp[t])) if opp[t] else event_avg_epa
        partner_help = (sum(partner[t]) / len(partner[t])) if partner[t] else event_avg_epa
        sos = opp_strength - partner_help
        rows.append(
            {
                **s,
                "opp_strength": round(opp_strength, 1),
                "partner_help": round(partner_help, 1),
                "sos": round(sos, 1),
                "base": s["avg_points"],
                "reliability": s["consistency"],
            }
        )

    # Normalise SOS into a points-scale adjustment.
    sos_vals = [r["sos"] for r in rows]
    sos_sd = statistics.pstdev(sos_vals) if len(sos_vals) >= 2 else 0.0
    base_sd = statistics.pstdev([r["base"] for r in rows]) if len(rows) >= 2 else 1.0
    SOS_WEIGHT = (base_sd or 1.0) * 0.5  # schedule worth up to ~half a "spread"

    for r in rows:
        sos_z = (r["sos"] / sos_sd) if sos_sd else 0.0
        adj = SOS_WEIGHT * sos_z
        r["sos_adjust"] = round(adj, 2)
        r["true_score"] = round(
            r["base"] * (0.65 + 0.35 * r["reliability"]) + adj, 2
        )

    rows.sort(key=lambda r: r["true_score"], reverse=True)
    for i, r in enumerate(rows, 1):
        r["rank"] = i
    return {
        "event": event_key,
        "event_avg_epa": round(event_avg_epa, 1),
        "explanation": (
            "true_score = base × (0.65 + 0.35×reliability) + schedule adjust. "
            "Schedule adjust rewards teams that faced tougher opponents with "
            "weaker partners, and penalises teams carried by strong partners "
            "against weak opponents."
        ),
        "teams": rows,
    }


# --------------------------------------------------------------------------- #
# Scout disagreement detection ("Consensus Radar")                             #
# --------------------------------------------------------------------------- #
NEGATIVE_TAGS = {
    "Died on field", "Dropped pieces", "Slow cycles", "Tippy / unstable",
    "Penalty prone", "Struggled vs defense", "Comms issues",
}
POSITIVE_TAGS = {
    "Fast cycles", "Strong auto", "Clutch climb", "Great defense",
    "Smart driver", "Consistent", "Good under pressure", "Great partner",
}


def scout_disagreements(session: Session, event_key: str) -> dict[str, Any]:
    """Flag teams where the scouting record doesn't agree with itself.

    Two signals, per the TideScout-style "separate individual judgment from
    consensus" idea:

      1. **Numeric spread** — the same team+match scouted by 2+ scouts with a
         big point gap means someone missed cycles (or padded them).
      2. **Quant vs qual gap** — a team whose scored output ranks high while
         its qualitative signals (driver/speed ratings, negative tags,
         failures) rank low — or vice versa. Those are exactly the teams to
         re-watch on film before locking a picklist.
    """
    teams = event_teams(session, event_key)
    summaries = {t: team_summary(session, event_key, t) for t in teams}
    summaries = {t: s for t, s in summaries.items() if s["matches"] > 0}
    if not summaries:
        return {"event": event_key, "teams": []}

    # Percentile helpers across the event.
    def _pct(values: dict[int, float], team: int) -> float:
        vals = sorted(values.values())
        if len(vals) < 2:
            return 0.5
        below = sum(1 for v in vals if v < values[team])
        return below / (len(vals) - 1)

    quant = {t: s["avg_points"] for t, s in summaries.items()}
    qual: dict[int, float] = {}
    for t, s in summaries.items():
        tag_bal = 0.0
        total_reports = max(1, s["matches"])
        for row in s["tags"]:
            if row["tag"] in POSITIVE_TAGS:
                tag_bal += row["count"] / total_reports
            elif row["tag"] in NEGATIVE_TAGS:
                tag_bal -= row["count"] / total_reports
        # Blend ratings (1-5 → 0-1), failure rate and tag balance.
        ratings = ((s["avg_driver"] + s["avg_speed"]) / 2 - 1) / 4
        qual[t] = ratings - 0.35 * s["failure_rate"] + 0.15 * tag_bal

    rows: list[dict[str, Any]] = []
    for t, s in summaries.items():
        entries = team_entries(session, event_key, t)

        # Signal 1: same match, multiple scouts.
        by_match: dict[int, list[Any]] = {}
        for e in entries:
            by_match.setdefault(e.match_number, []).append(e)
        conflicts = []
        for mn, group in sorted(by_match.items()):
            if len(group) < 2:
                continue
            pts = [e.points for e in group]
            spread = max(pts) - min(pts)
            conflicts.append(
                {
                    "match": mn,
                    "spread": round(spread, 1),
                    "reports": [
                        {"scout_id": e.scout_id, "points": e.points} for e in group
                    ],
                }
            )
        conflicts.sort(key=lambda c: -c["spread"])
        max_spread = conflicts[0]["spread"] if conflicts else 0.0
        avg_pts = s["avg_points"] or 1.0
        spread_score = min(1.0, max_spread / max(6.0, avg_pts))

        # Signal 2: quantitative rank vs qualitative rank.
        qp, ql = _pct(quant, t), _pct(qual, t)
        gap = qp - ql
        gap_score = abs(gap)

        score = round(0.55 * spread_score + 0.45 * gap_score, 3)
        flags = []
        if max_spread > 0 and spread_score >= 0.3:
            flags.append("scouts_disagree")
        if gap >= 0.35:
            flags.append("numbers_look_better_than_eyes")
        elif gap <= -0.35:
            flags.append("eyes_look_better_than_numbers")

        rows.append(
            {
                "team": t,
                "nickname": s["nickname"],
                "avatar": s["avatar"],
                "matches": s["matches"],
                "avg_points": s["avg_points"],
                "quant_pct": round(qp, 2),
                "qual_pct": round(ql, 2),
                "gap": round(gap, 2),
                "max_spread": max_spread,
                "conflicts": conflicts[:4],
                "score": score,
                "flags": flags,
            }
        )

    rows.sort(key=lambda r: -r["score"])
    return {
        "event": event_key,
        "explanation": (
            "Score blends (1) how far apart scouts landed when covering the "
            "same team in the same match, and (2) how far the team's scored "
            "output percentile sits from its qualitative percentile (ratings, "
            "tags, failures). High scores = watch film before picking."
        ),
        "teams": rows,
    }


# --------------------------------------------------------------------------- #
# Compare                                                                      #
# --------------------------------------------------------------------------- #
def compare_teams(session: Session, event_key: str, teams: list[int]) -> dict[str, Any]:
    summaries = [team_summary(session, event_key, t) for t in teams]
    metrics = [
        ("avg_points", "Avg points", "high"),
        ("max_points", "Peak points", "high"),
        ("consistency", "Consistency", "high"),
        ("climb_rate", "Climb rate", "high"),
        ("defense_rate", "Defense rate", "high"),
        ("avg_driver", "Driver skill", "high"),
        ("avg_speed", "Speed", "high"),
        ("failure_rate", "Failure rate", "low"),
        ("total_fouls", "Total fouls", "low"),
        ("epa", "EPA", "high"),
    ]
    rows = []
    for key, label, better in metrics:
        vals = [s.get(key) or 0 for s in summaries]
        best = max(vals) if better == "high" else min(vals)
        rows.append(
            {
                "key": key,
                "label": label,
                "better": better,
                "values": [
                    {"team": s["team"], "value": s.get(key) or 0, "best": (s.get(key) or 0) == best}
                    for s in summaries
                ],
            }
        )
    return {"teams": summaries, "metrics": rows}

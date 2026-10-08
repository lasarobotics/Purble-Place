"""Team analytics: summaries, rankings, strength-of-schedule, compare.

These power the admin Team Search / Team Rank / Data Picklist / Compare tabs.
The math is identical to the original SQL implementation; only the data access
(MongoDB views) changed.
"""

from __future__ import annotations

import statistics
from datetime import UTC, datetime
from contextvars import ContextVar
from functools import wraps
from typing import Any, Optional

from pymongo.database import Database

from .scoring import phase_counts, attempt_value, AUTO_LEAVE, AUTO_CLIMB_BONUS, CLIMB_POINTS
from .views import EntryView, get_team_cache, get_teams_cache, list_entries, list_matches

# One consistent input set per analytics request; no per-team database queries,
# stale process caches, or summary writes. Each subsequent request sees new data.
_snapshot: ContextVar = ContextVar("analytics_snapshot", default=None)

def event_snapshot(fn):
    @wraps(fn)
    def wrapped(db, event_key, *args, **kwargs):
        if _snapshot.get() is not None:
            return fn(db, event_key, *args, **kwargs)
        entries = list_entries(db, event_key)
        matches = list_matches(db, event_key)
        teams = {e.team_number for e in entries}
        for m in matches:
            teams.update(m.red + m.blue)
        grouped = {t: [] for t in teams}
        for e in entries:
            grouped[e.team_number].append(e)
        token = _snapshot.set(dict(entries=grouped, matches=matches,
                                   teams=sorted(teams), profiles=get_teams_cache(db, teams), summaries={}))
        try:
            return fn(db, event_key, *args, **kwargs)
        finally:
            _snapshot.reset(token)
    return wrapped


# --------------------------------------------------------------------------- #
# Per-team aggregation                                                         #
# --------------------------------------------------------------------------- #
def team_entries(db: Database, event_key: str, team: int) -> list[EntryView]:
    if _snapshot.get() is not None:
        return _snapshot.get()["entries"].get(team, [])
    return list_entries(db, event_key, team=team)


def _coeff_var(values: list[float]) -> float:
    """Coefficient of variation (std/mean). Lower = more consistent."""
    if len(values) < 2:
        return 0.0
    mean = statistics.fmean(values)
    if mean <= 0:
        return 0.0
    return statistics.pstdev(values) / mean


def team_summary(db: Database, event_key: str, team: int, all_entries: list[EntryView] | None = None) -> dict[str, Any]:
    snapshot = _snapshot.get()
    if snapshot is not None and team in snapshot["summaries"]:
        return snapshot["summaries"][team]
    if all_entries is None:
        all_entries = team_entries(db, event_key, team)
    # No-shows are a reliability signal, not a performance sample.
    entries = [e for e in all_entries if not e.no_show]
    no_shows = len(all_entries) - len(entries)
    pts = [e.points for e in entries]
    n = len(entries)

    per_match: dict[tuple[str, int], list[float]] = {}
    for e in entries:
        per_match.setdefault((e.comp_level, e.match_number), []).append(e.points)
    match_points = [
        {"comp_level": level, "match": m, "points": round(statistics.fmean(v), 2)}
        for (level, m), v in sorted(per_match.items(), key=lambda item: ({"qm": 0, "ef": 1, "qf": 2, "sf": 3, "f": 4}.get(item[0][0], 9), item[0][1]))
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

    tc = _snapshot.get()["profiles"].get(team) if _snapshot.get() is not None else get_team_cache(db, team)
    def ratio(a, b):
        return round(a / b, 3) if b else None
    auto_attempts = counts["auto_made"] + counts["auto_missed"]
    tele_attempts = counts["teleop_made"] + counts["teleop_missed"]
    auto_points = [sum(attempt_value(a) for a in e.heatmap if a.get("phase") == "auto")
                   + AUTO_LEAVE * e.auto_leave + AUTO_CLIMB_BONUS * e.auto_climb for e in entries]
    tele_points = [sum(attempt_value(a) for a in e.heatmap if a.get("phase") != "auto") for e in entries]
    # Use chronological, per-match means so duplicate observers do not weight trend.
    grouped_points = {}
    for e in sorted(entries, key=lambda e: (e.created_at, e.comp_level, e.match_number)):
        grouped_points.setdefault((e.comp_level, e.match_number), []).append(e.points)
    series = [statistics.fmean(v) for v in grouped_points.values()]
    k = len(series)
    xbar = (k - 1) / 2
    denom = sum((i - xbar) ** 2 for i in range(k))
    trend = sum((i - xbar) * (p - statistics.fmean(series)) for i, p in enumerate(series)) / denom if denom else None
    extra = {
        "accuracy": ratio(counts["auto_made"] + counts["teleop_made"], auto_attempts + tele_attempts),
        "auto_accuracy": ratio(counts["auto_made"], auto_attempts),
        "teleop_accuracy": ratio(counts["teleop_made"], tele_attempts),
        "avg_auto_points": round(statistics.fmean(auto_points), 2) if n else None,
        "avg_teleop_points": round(statistics.fmean(tele_points), 2) if n else None,
        "avg_endgame_points": round(statistics.fmean(CLIMB_POINTS.get(e.climb, 0) for e in entries), 2) if n else None,
        "median_points": statistics.median(pts) if n else None,
        "recent_points": round(statistics.fmean(series[-3:]), 2) if series else None,
        "trend": round(trend, 2) if trend is not None else None,
        "attendance_rate": ratio(n, len(all_entries)),
        "operational_rate": ratio(sum(not e.failure for e in entries), len(all_entries)),
        "auto_leave_rate": ratio(sum(e.auto_leave for e in entries), n),
        "avg_fouls": ratio(sum(e.fouls for e in entries), n),
        "avg_stops": ratio(sum(e.successful_stops for e in entries), n),
    }
    summary = {
        **extra,
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
    if snapshot is not None:
        snapshot["summaries"][team] = summary
    return summary


def event_teams(db: Database, event_key: str) -> list[int]:
    """All team numbers at this event — the match schedule plus anything
    scouted (covers offline/pit teams the schedule doesn't know yet)."""
    if _snapshot.get() is not None:
        return _snapshot.get()["teams"]
    teams: set[int] = set(
        int(t)
        for t in db.match_scouting.distinct("team_num", {"event_key": event_key})
    )
    for m in list_matches(db, event_key):
        teams.update(m.red)
        teams.update(m.blue)
    return sorted(teams)


# --------------------------------------------------------------------------- #
# Ranking                                                                      #
# --------------------------------------------------------------------------- #
RANK_METRICS = {
    "accuracy": "Scoring accuracy",
    "auto_accuracy": "Auto accuracy",
    "teleop_accuracy": "Teleop accuracy",
    "avg_auto_points": "Avg auto points",
    "avg_teleop_points": "Avg teleop points",
    "avg_endgame_points": "Avg endgame points",
    "median_points": "Median points",
    "recent_points": "Recent form",
    "trend": "Scoring trend",
    "attendance_rate": "Attendance rate",
    "operational_rate": "Operational reliability",
    "auto_leave_rate": "Auto leave rate",
    "avg_fouls": "Fouls per report",
    "avg_stops": "Stops per report",
    "failure_rate": "Failure rate",
    "std_points": "Scoring deviation",
    "total_fouls": "Total fouls",
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


LOWER_BETTER = {"failure_rate", "avg_fouls", "std_points", "total_fouls"}

@event_snapshot
def rank_teams(db: Database, event_key: str, metric: str = "avg_points") -> list[dict[str, Any]]:
    metric = metric if metric in RANK_METRICS else "avg_points"
    rows = [dict(team_summary(db, event_key, t)) for t in event_teams(db, event_key)]
    rows = [r for r in rows if r["matches"] > 0 or metric == "epa"]
    rows.sort(key=lambda r: (r.get(metric) is None, (r.get(metric) or 0) * (1 if metric in LOWER_BETTER else -1), r["team"]))
    for i, r in enumerate(rows, 1):
        r["rank"] = i
    return rows


# --------------------------------------------------------------------------- #
# Heatmap aggregation                                                          #
# --------------------------------------------------------------------------- #
def team_heatmap(
    db: Database, event_key: str, team: int, phase: Optional[str] = None, entries: list[EntryView] | None = None
) -> dict[str, Any]:
    points: list[dict[str, Any]] = []
    for e in (entries if entries is not None else team_entries(db, event_key, team)):
        if e.no_show:
            continue
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
        "accuracy": round(made / len(points), 3) if points else None,
    }


# --------------------------------------------------------------------------- #
# Strength-of-schedule "Data Picklist"                                         #
# --------------------------------------------------------------------------- #
def _event_epa_map(db: Database, event_key: str) -> dict[int, float]:
    out: dict[int, float] = {}
    for t in event_teams(db, event_key):
        tc = _snapshot.get()["profiles"].get(t) if _snapshot.get() is not None else get_team_cache(db, t)
        if tc and tc.epa is not None:
            out[t] = float(tc.epa)
    return out


@event_snapshot
def data_picklist(db: Database, event_key: str) -> dict[str, Any]:
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
    teams = event_teams(db, event_key)
    epa_map = _event_epa_map(db, event_key)
    matches = _snapshot.get()["matches"]
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
        s = team_summary(db, event_key, t)
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
        sos_z = ((r["sos"] - statistics.fmean(sos_vals)) / sos_sd) if sos_sd else 0.0
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


@event_snapshot
def scout_disagreements(db: Database, event_key: str) -> dict[str, Any]:
    """Flag teams where the scouting record doesn't agree with itself.

    Two signals:

      1. **Numeric spread** — the same team+match scouted by 2+ scouts with a
         big point gap means someone missed cycles (or padded them).
      2. **Quant vs qual gap** — a team whose scored output ranks high while
         its qualitative signals (driver/speed ratings, negative tags,
         failures) rank low — or vice versa. Those are exactly the teams to
         re-watch on film before locking a picklist.
    """
    teams = event_teams(db, event_key)
    summaries = {t: team_summary(db, event_key, t) for t in teams}
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
        entries = team_entries(db, event_key, t)

        # Signal 1: same match, multiple scouts.
        by_match: dict[tuple[str, int], list[Any]] = {}
        for e in entries:
            by_match.setdefault((e.comp_level, e.match_number), []).append(e)
        conflicts = []
        for (level, mn), group in sorted(by_match.items()):
            if len(group) < 2:
                continue
            pts = [e.points for e in group]
            spread = max(pts) - min(pts)
            conflicts.append(
                {
                    "match": mn,
                    "comp_level": level,
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
@event_snapshot
def compare_teams(db: Database, event_key: str, teams: list[int]) -> dict[str, Any]:
    summaries = [team_summary(db, event_key, t) for t in teams]
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
    existing = {key for key, _, _ in metrics}
    metrics += [(key, label, "low" if key in LOWER_BETTER else "high")
                for key, label in RANK_METRICS.items() if key not in existing]
    rows = []
    for key, label, better in metrics:
        vals = [s[key] for s in summaries if s.get(key) is not None]
        best = (max(vals) if better == "high" else min(vals)) if vals else None
        rows.append(
            {
                "key": key,
                "label": label,
                "better": better,
                "values": [
                    {"team": s["team"], "value": s.get(key), "best": best is not None and s.get(key) == best}
                    for s in summaries
                ],
            }
        )
    return {"teams": summaries, "metrics": rows}


@event_snapshot
def analysis_bundle(db: Database, event_key: str) -> dict[str, Any]:
    """One cloud calculation/read pass for all analysis screens and offline use.

    Rankings are shipped as team-number orders instead of duplicating full
    summaries for every metric. No analytics are computed by the offline client.
    """
    from .views import scouter_names
    from .routers.teams import entry_report, _team_dict

    teams = event_teams(db, event_key)
    summaries = [team_summary(db, event_key, t) for t in teams]
    names = scouter_names(db, (e.scout_id for group in _snapshot.get()["entries"].values() for e in group))
    scouting = {}
    for team in teams:
        entries = team_entries(db, event_key, team)
        scouting[str(team)] = {
            "summary": team_summary(db, event_key, team),
            "heatmap": team_heatmap(db, event_key, team),
            "heatmaps": {phase: team_heatmap(db, event_key, team, None if phase == "all" else phase) for phase in ("all", "auto", "teleop")},
            "reports": [entry_report(e, names.get(e.scout_id, e.scout_id)) for e in entries],
        }
    return {
        "event": event_key,
        "generated_at": datetime.now(UTC).isoformat(),
        "teams": summaries,
        "profiles": [_team_dict(_snapshot.get()["profiles"].get(t), t) for t in teams],
        "metrics": [{"key": k, "label": v, "better": "low" if k in LOWER_BETTER else "high"} for k, v in RANK_METRICS.items()],
        "orders": {key: [r["team"] for r in rank_teams(db, event_key, key)] for key in RANK_METRICS},
        "picklist": data_picklist(db, event_key),
        "consensus": scout_disagreements(db, event_key),
        "scouting": scouting,
    }

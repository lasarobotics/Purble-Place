"""Team analytics: summaries, rankings, strength-of-schedule, compare.

These power the admin Team Search / Team Rank / Data Picklist / Compare tabs.

Every aggregation here is memoised against the revision counters of the
collections it reads (see ``repo.memoized``). That matters at an event: with
60 people refreshing dashboards, ``rank_teams`` was recomputing a full
per-team pass over every submission on every request. Now it is computed once
per new submission and served from memory until the next one lands: the CPU
equivalent of the read-cache, and the reason the single Cloud Run instance
keeps up.
"""
from __future__ import annotations

import statistics
from datetime import datetime, timezone
from typing import Any, Optional

from . import repo, schema
from . import seasons
from .models import ScoutEntry
from .scoring import attempt_value, compute_points, phase_counts
from .expected_points import estimate_avg_points, prepare_event

#: Revision keys for the memoiser: any change to scouting or team data
#: invalidates every derived aggregate below.
_DEPS = (schema.MATCH_SCOUTING, schema.SCOUTING_AUDIT, schema.TEAM_CACHE, schema.MATCHES, schema.SEASONS, schema.SEASON_REVISIONS, schema.APP_SETTINGS)


def expected_team_points(event_key: str, team: int) -> float | None:
    def build():
        context = repo.memoized(f"expected-priors:{event_key}", _DEPS,
                                lambda: prepare_event(repo.scouting_for_event(event_key)))
        return estimate_avg_points(team_entries(event_key, team), [], event_context=context)
    return repo.memoized(f"expected-points:{event_key}:{team}", _DEPS, build)


# --------------------------------------------------------------------------- #
# Per-team aggregation                                                         #
# --------------------------------------------------------------------------- #
def team_entries(event_key: str, team: int) -> list[ScoutEntry]:
    """This team's submissions at this event, ordered by match."""
    return repo.scouting_for_team(event_key, team)


def _coeff_var(values: list[float]) -> float:
    """Coefficient of variation (std/mean). Lower = more consistent."""
    if len(values) < 2:
        return 0.0
    mean = statistics.fmean(values)
    if mean <= 0:
        return 0.0
    return statistics.pstdev(values) / mean


def _skew(values: list[float]) -> float | None:
    """Adjusted sample skewness from the scouting algorithm overview."""
    n = len(values)
    if n < 3:
        return None
    mean = statistics.fmean(values)
    sigma = statistics.stdev(values)
    if sigma <= 0:
        return 0.0
    total = sum(((v - mean) / sigma) ** 3 for v in values)
    return n / ((n - 1) * (n - 2)) * total


def _last_four_entries(entries: list[ScoutEntry]) -> list[ScoutEntry]:
    """Entries whose match number is in the team's four latest scouted matches."""
    order = {"qm": 0, "ef": 1, "qf": 2, "sf": 3, "f": 4}
    latest = sorted({(e.comp_level, e.match_number) for e in entries}, key=lambda key: (order.get(key[0], 9), key[1]), reverse=True)[:4]
    keep = set(latest)
    return [e for e in entries if (e.comp_level, e.match_number) in keep]


def scoring_benchmark(event_key: str) -> dict[str, Any]:
    """The event's highest average-scoring robot, shared by relative metrics.

    Use all attended reports, independently of the selected comparison robots.
    Equal scores select the lower team number, so the reference is stable.
    """
    def build():
        best_team = None
        best_score = 0.0
        for team in sorted(event_teams(event_key)):
            reports = team_entries(event_key, team)
            if not reports:
                continue
            score = expected_team_points(event_key, team)
            if score is not None and score > best_score:
                best_team, best_score = team, score
        return {"team": best_team, "avg_points": best_score if best_team is not None else None}
    return repo.memoized(f"scoring-benchmark:{event_key}", _DEPS, build)


def _defense_capability(entries: list[ScoutEntry], benchmark_points: float | None) -> float | None:
    """Season-scored defensive-stop proxy relative to the event scoring leader.

    This is not measured opponent points prevented. Missing/nonpositive
    reference scores are unavailable. Non-defense and failed reports count
    toward attendance but contribute no defensive-stop points.
    """
    if not entries or benchmark_points is None or benchmark_points <= 0:
        return None
    total = 0.0
    for e in entries:
        if not e.played_defense or e.failure:
            continue
        provenance = {"season_id": e.season_id, "game_version": e.game_version}
        # Keep the independent defense proxy; stops no longer add report points.
        from .gamedef import score
        from .scoring import definition_for
        game = definition_for(provenance)
        baseline = score({"successful_stops": 0}, [], game)
        stopped = score({"successful_stops": max(0, e.successful_stops)}, [], game)
        total += max(0.0, stopped - baseline)
    return round(100 * total / len(entries) / benchmark_points, 2)


def _percentile(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    vals = sorted(values)
    if len(vals) == 1:
        return vals[0]
    pos = (len(vals) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(vals) - 1)
    frac = pos - lo
    return vals[lo] * (1 - frac) + vals[hi] * frac


def _mode(items: list[str]) -> str:
    counts: dict[str, int] = {}
    for item in items:
        counts[item] = counts.get(item, 0) + 1
    return max(counts.items(), key=lambda kv: (kv[1], kv[0]))[0] if counts else ""


def _entry_scoring_points(entry: ScoutEntry) -> float:
    """Points from scored game pieces only, the whitepaper's "fuel" bucket."""
    game = seasons.definition_at(
        entry.season_id or seasons.current_season_id(),
        int(entry.game_version or 0),
    )
    from .epa_scoring import flat_report
    total = max(0.0, entry.points - compute_points(flat_report(entry), heatmap_value=0)) if not entry.no_show else 0.0
    records = list(entry.actions or []) if not entry.no_show else []
    for record in records:
        if not isinstance(record, dict):
            continue
        if record.get("result") and record.get("result") != "made":
            continue
        attempt = {
            "action": record.get("action") or "score",
            "phase": record.get("phase") or "teleop",
            "result": record.get("result") or "made",
            "object": record.get("object"),
            "location": record.get("location"),
            "quantity": record.get("quantity", 1),
            "value": record.get("value"),
        }
        total += max(0.0, attempt_value(attempt, game))
    return total


def _rp_thresholds(fuel_totals: list[float], climb_totals: list[float]) -> tuple[float, float]:
    """RP thresholds for the whitepaper's 90% check.

    Prefer explicit season configuration. Older/local seasons do not store
    those thresholds, so use the event's upper-quartile alliance projection as
    a stable fallback rather than inventing constants in code.
    """
    extras = seasons.definition().extras or {}
    raw = (
        extras.get("ranking_point_thresholds")
        or extras.get("rp_thresholds")
        or extras.get("ranking_points")
        or {}
    )
    fuel = float(raw.get("fuel") or raw.get("scoring") or 0)
    climb = float(raw.get("climb") or raw.get("endgame") or 0)
    if fuel <= 0:
        fuel = _percentile([v for v in fuel_totals if v > 0], 0.75)
    if climb <= 0:
        climb = _percentile([v for v in climb_totals if v > 0], 0.75)
    return fuel, climb


def _ranking_point_predictions(event_key: str) -> dict[int, float]:
    """Predicted team RPs using the 2026 whitepaper's Predicted AIM flow."""
    matches = [m for m in repo.matches_for_event(event_key) if m.comp_level == "qm"]
    if not matches:
        return {}

    game = seasons.definition()
    profiles: dict[int, dict[str, float]] = {}
    for team in event_teams(event_key):
        entries = [e for e in team_entries(event_key, team) if not e.no_show]
        if not entries:
            profiles[team] = {"fuel": 0.0, "climb": 0.0}
            continue
        fuels = [_entry_scoring_points(e) for e in entries]
        climbs = [e.climb for e in entries if e.climb and e.climb != "none"]
        common_climb = _mode(climbs)
        climb_points = game.endgame_points(common_climb) if common_climb else 0.0
        profiles[team] = {
            "fuel": statistics.fmean(fuels) if fuels else 0.0,
            "climb": (len(climbs) / len(entries)) * climb_points if entries else 0.0,
        }

    alliance_rows: list[dict[str, Any]] = []
    for match in matches:
        for alliance, teams in (("red", match.red), ("blue", match.blue)):
            fuel = sum(profiles.get(t, {}).get("fuel", 0.0) for t in teams)
            climb = sum(profiles.get(t, {}).get("climb", 0.0) for t in teams)
            alliance_rows.append(
                {
                    "match": match,
                    "alliance": alliance,
                    "teams": teams,
                    "fuel": fuel,
                    "climb": climb,
                    "score": fuel + climb,
                }
            )

    fuel_threshold, climb_threshold = _rp_thresholds(
        [r["fuel"] for r in alliance_rows],
        [r["climb"] for r in alliance_rows],
    )
    fuel_cutoff = fuel_threshold * 0.9 if fuel_threshold > 0 else float("inf")
    climb_cutoff = climb_threshold * 0.9 if climb_threshold > 0 else float("inf")

    totals = {team: 0.0 for team in profiles}
    by_match = {(r["match"].match_key, r["alliance"]): r for r in alliance_rows}
    for match in matches:
        red = by_match.get((match.match_key, "red"))
        blue = by_match.get((match.match_key, "blue"))
        if not red or not blue:
            continue

        win_rp = {"red": 0.0, "blue": 0.0}
        if match.winner in ("red", "blue"):
            win_rp[match.winner] = 2.0
        elif match.winner == "tie":
            win_rp["red"] = win_rp["blue"] = 1.0
        elif red["score"] > blue["score"]:
            win_rp["red"] = 2.0
        elif blue["score"] > red["score"]:
            win_rp["blue"] = 2.0
        else:
            win_rp["red"] = win_rp["blue"] = 1.0

        for row in (red, blue):
            rp = win_rp[row["alliance"]]
            if row["fuel"] >= fuel_cutoff:
                rp += 1.0
            if row["climb"] >= climb_cutoff:
                rp += 1.0
            for team in row["teams"]:
                totals[team] = totals.get(team, 0.0) + rp

    return {team: round(value, 2) for team, value in totals.items()}


def _build_team_summary(event_key: str, team: int) -> dict[str, Any]:
    all_entries = team_entries(event_key, team)
    # No-shows are a reliability signal, not a performance sample.
    entries = [e for e in all_entries if not e.no_show]
    no_shows = len(all_entries) - len(entries)
    pts = [e.points for e in entries]
    expected_points = expected_team_points(event_key, team)
    n = len(entries)

    per_match: dict[tuple[str, int], list[float]] = {}
    for e in entries:
        per_match.setdefault((e.comp_level, e.match_number), []).append(e.points)
    match_points = [
        {"match": m[1], "comp_level": m[0], "points": round(statistics.fmean(v), 2)}
        for m, v in sorted(per_match.items(), key=lambda item: ({"qm": 0, "ef": 1, "qf": 2, "sf": 3, "f": 4}.get(item[0][0], 9), item[0][1]))
    ]

    counts = {"auto_made": 0, "auto_missed": 0, "teleop_made": 0, "teleop_missed": 0}
    for e in entries:
        c = phase_counts({**e.data, "heatmap": e.heatmap, "actions": e.actions})
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

    tc = repo.team(team)
    benchmark = scoring_benchmark(event_key)
    def ratio(a, b):
        return round(a / b, 3) if b else None
    auto_n = counts["auto_made"] + counts["auto_missed"]
    tele_n = counts["teleop_made"] + counts["teleop_missed"]
    series = [row["points"] for row in match_points]
    k = len(series)
    xbar = (k - 1) / 2
    denominator = sum((i - xbar) ** 2 for i in range(k))
    trend = sum((i - xbar) * (p - statistics.fmean(series)) for i, p in enumerate(series)) / denominator if denominator else None
    return {
        "scoring_benchmark": benchmark,
        "relative_scoring": ratio(expected_points, benchmark["avg_points"]) if expected_points is not None else None,
        "accuracy": ratio(counts["auto_made"] + counts["teleop_made"], auto_n + tele_n),
        "auto_accuracy": ratio(counts["auto_made"], auto_n),
        "teleop_accuracy": ratio(counts["teleop_made"], tele_n),
        "median_points": statistics.median(pts) if pts else None,
        "recent_points": round(statistics.fmean(series[-3:]), 2) if series else None,
        "trend": round(trend, 2) if trend is not None else None,
        "attendance_rate": ratio(n, len(all_entries)),
        "operational_rate": ratio(sum(not e.failure for e in entries), len(all_entries)),
        "auto_leave_rate": ratio(sum(e.auto_leave for e in entries), n),
        "avg_fouls": ratio(sum(e.fouls for e in entries), n),
        "avg_stops": ratio(sum(e.successful_stops for e in entries), n),
        "defense_capability": _defense_capability(entries, benchmark["avg_points"]),
        "team": team,
        "nickname": tc.nickname if tc else "",
        "avatar": tc.avatar if tc else "",
        "epa": tc.epa if tc else None,
        "matches": n,
        "avg_points": expected_points,
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


def team_summary(event_key: str, team: int) -> dict[str, Any]:
    return repo.memoized(
        f"summary:{event_key}:{team}", _DEPS, lambda: _build_team_summary(event_key, team)
    )


def all_summaries(event_key: str) -> dict[int, dict[str, Any]]:
    """Every scouted team's summary, computed in one memoised pass.

    ``rank_teams``, ``data_picklist`` and ``scout_disagreements`` all need the
    full set; sharing one memo entry means they cost a single pass between
    submissions instead of three.
    """

    def build() -> dict[int, dict[str, Any]]:
        return {t: team_summary(event_key, t) for t in event_teams(event_key)}

    return repo.memoized(f"summaries:{event_key}", _DEPS, build)


def event_teams(event_key: str) -> list[int]:
    """All team numbers seen in scouting for this event."""
    return repo.event_teams(event_key)


# --------------------------------------------------------------------------- #
# Ranking                                                                      #
# --------------------------------------------------------------------------- #
RANK_METRICS = {
    "relative_scoring": "Scoring vs event leader",
    "defense_capability": "Defense capability",
    "accuracy": "Scoring accuracy",
    "auto_accuracy": "Auto accuracy",
    "teleop_accuracy": "Teleop accuracy",
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
    "avg_points": "Haze Power Rating",
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


def rank_teams(event_key: str, metric: str = "avg_points") -> list[dict[str, Any]]:
    metric = metric if metric in RANK_METRICS else "avg_points"

    def build() -> list[dict[str, Any]]:
        rows = [dict(s) for s in all_summaries(event_key).values()]
        rows = [r for r in rows if r["matches"] > 0 or metric == "epa"]
        rows.sort(key=lambda r: (r.get(metric) is None, (r.get(metric) or 0) * (1 if metric in LOWER_BETTER else -1), r["team"]))
        for i, r in enumerate(rows, 1):
            r["rank"] = i
        return rows

    return repo.memoized(f"rank:{event_key}:{metric}", _DEPS, build)


def data_analysis(event_key: str) -> list[dict[str, Any]]:
    """Per-team analysis table used by Team Rank's Data Analysis tab.

    Skew follows the adjusted sample skew equation in the scouting algorithm
    overview. Ranking point prediction follows the 2026 whitepaper: project
    alliance scoring/climb totals, award bonus RPs at 90% of threshold, then
    aggregate those match predictions back to teams.
    """

    def _rate(entries: list[ScoutEntry], pred) -> float:
        return sum(1 for e in entries if pred(e)) / len(entries) if entries else 0.0

    def _consistency(entries: list[ScoutEntry]) -> float:
        pts = [e.points for e in entries]
        if len(pts) == 1:
            return 1.0
        return max(0.0, 1.0 - _coeff_var(pts)) if len(pts) >= 2 else 0.0

    def build() -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        summaries = all_summaries(event_key)
        rp_predictions = _ranking_point_predictions(event_key)
        benchmark = scoring_benchmark(event_key)
        for team in event_teams(event_key):
            summary = summaries[team]
            entries = [e for e in team_entries(event_key, team) if not e.no_show]
            if not entries:
                continue
            l4m = _last_four_entries(entries)
            rows.append(
                {
                    "team": team,
                    "nickname": summary["nickname"],
                    "avatar": summary["avatar"],
                    "matches": summary["matches"],
                    "avg_points": summary["avg_points"],
                    "defense_capability": summary["defense_capability"],
                    "l4m_defense_capability": _defense_capability(l4m, benchmark["avg_points"]),
                    "scoring_benchmark": benchmark,
                    "consistency": summary["consistency"],
                    "l4m_consistency": round(_consistency(l4m), 3),
                    "skew_distribution": round(_skew([e.points for e in entries]), 3) if len(entries) >= 3 else None,
                    "l4m_skew_distribution": round(_skew([e.points for e in l4m]), 3) if len(l4m) >= 3 else None,
                    "failure_rate": summary["failure_rate"],
                    "l4m_failure_rate": round(_rate(l4m, lambda e: e.failure), 3),
                    "foul_match_rate": round(_rate(entries, lambda e: e.fouls > 0), 3),
                    "climb_success_rate": summary["climb_rate"],
                    "l4m_climb_success_rate": round(
                        _rate(l4m, lambda e: bool(e.climb and e.climb != "none")), 3
                    ),
                    "ranking_point_prediction": rp_predictions.get(team),
                }
            )
        rows.sort(key=lambda r: (r["skew_distribution"] is None, -(r["skew_distribution"] or 0), r["team"]))
        return rows

    return repo.memoized(f"data_analysis:{event_key}", _DEPS, build)


# --------------------------------------------------------------------------- #
# Heatmap aggregation                                                          #
# --------------------------------------------------------------------------- #
def team_heatmap(
    event_key: str, team: int, phase: Optional[str] = None
) -> dict[str, Any]:
    def build() -> dict[str, Any]:
        points: list[dict[str, Any]] = []
        misses: list[dict[str, Any]] = []
        by_station: dict[str, dict[str, int]] = {}
        for e in team_entries(event_key, team):
            if e.no_show:
                continue
            slot = f"{e.alliance}{e.station}"
            for missed_phase in ("auto", "teleop"):
                if phase and missed_phase != phase:
                    continue
                count = int(e.data.get(f"{missed_phase}_missed") or 0)
                if count:
                    misses.append({"phase": missed_phase, "station": slot, "count": count})
                    bucket = by_station.setdefault(slot, {"total": 0, "made": 0})
                    bucket["total"] += count
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
                        # Carried through so the map can be split by driver
                        # station: where a robot starts changes which side of
                        # the field it can reach.
                        "alliance": e.alliance,
                        "station": e.station,
                    }
                )
                bucket = by_station.setdefault(slot, {"total": 0, "made": 0})
                bucket["total"] += 1
                if a.get("result") == "made":
                    bucket["made"] += 1
        filters = {}
        for phase_key in ("all", "auto", "teleop"):
            for station_key in ("all", "red1", "red2", "red3", "blue1", "blue2", "blue3"):
                selected = [p for p in points if (phase_key == "all" or p["phase"] == phase_key) and (station_key == "all" or f'{p["alliance"]}{p["station"]}' == station_key)]
                successes = sum(p["result"] == "made" for p in selected)
                missed = sum(m["count"] for m in misses if (phase_key == "all" or m["phase"] == phase_key) and (station_key == "all" or m["station"] == station_key))
                total = len(selected) + missed
                filters[f"{phase_key}|{station_key}"] = {"total": total, "made": successes, "missed": missed, "accuracy": round(successes / total, 3) if total else None}
        made = sum(1 for p in points if p["result"] == "made")
        missed = sum(m["count"] for m in misses)
        total = len(points) + missed
        return {
            "team": team,
            "points": points,
            "total": total,
            "made": made,
            "missed": missed,
            "accuracy": round(made / total, 3) if total else None,
            "filters": filters,
            "by_station": [
                {
                    "station": slot,
                    "total": v["total"],
                    "made": v["made"],
                    "accuracy": round(v["made"] / v["total"], 3) if v["total"] else 0.0,
                }
                for slot, v in sorted(by_station.items())
            ],
        }

    return repo.memoized(f"heatmap:{event_key}:{team}:{phase or 'all'}", _DEPS, build)


# --------------------------------------------------------------------------- #
# Strength-of-schedule "Data Picklist"                                         #
# --------------------------------------------------------------------------- #
def data_picklist(event_key: str) -> dict[str, Any]:
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

    def build() -> dict[str, Any]:
        teams = event_teams(event_key)
        epa_map = repo.epa_map(event_key)
        matches = repo.matches_for_event(event_key)
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

        summaries = all_summaries(event_key)
        rows: list[dict[str, Any]] = []
        for t in teams:
            s = summaries[t]
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
                    "base": s["avg_points"] or 0.0,
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

    return repo.memoized(f"data_picklist:{event_key}", _DEPS, build)


# --------------------------------------------------------------------------- #
# Scout disagreement detection ("Consensus Radar")                             #
# --------------------------------------------------------------------------- #
# Which tags read as praise and which as criticism comes from the season's game
# definition, so a new game's tags are picked up without a second list to keep
# in step. Resolved per call rather than at import: the definition lives in the
# datastore, which is not up yet when this module is first imported.
def negative_tags() -> set[str]:
    return set(seasons.definition().negative_tags)


def positive_tags() -> set[str]:
    return set(seasons.definition().positive_tags)


def scout_disagreements(event_key: str) -> dict[str, Any]:
    """Flag teams where the scouting record doesn't agree with itself.

    Two signals, per the TideScout-style "separate individual judgment from
    consensus" idea:

      1. **Numeric spread**: the same team+match scouted by 2+ scouts with a
         big point gap means someone missed cycles (or padded them).
      2. **Quant vs qual gap**: a team whose scored output ranks high while
         its qualitative signals (driver/speed ratings, negative tags,
         failures) rank low: or vice versa. Those are exactly the teams to
         re-watch on film before locking a picklist.
    """

    def build() -> dict[str, Any]:
        summaries = {
            t: s for t, s in all_summaries(event_key).items() if s["matches"] > 0
        }
        if not summaries:
            return {"event": event_key, "teams": []}

        # Percentile helpers across the event.
        def _pct(values: dict[int, float | None], team: int) -> float:
            target = values.get(team)
            vals = sorted(v for v in values.values() if v is not None)
            if target is None:
                return 0.5
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
                if row["tag"] in positive_tags():
                    tag_bal += row["count"] / total_reports
                elif row["tag"] in negative_tags():
                    tag_bal -= row["count"] / total_reports
            # Blend ratings (1-5 → 0-1), failure rate and tag balance.
            ratings = ((s["avg_driver"] + s["avg_speed"]) / 2 - 1) / 4
            qual[t] = ratings - 0.35 * s["failure_rate"] + 0.15 * tag_bal

        rows: list[dict[str, Any]] = []
        for t, s in summaries.items():
            entries = team_entries(event_key, t)

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

    return repo.memoized(f"disagreements:{event_key}", _DEPS, build)


# --------------------------------------------------------------------------- #
# Compare                                                                      #
# --------------------------------------------------------------------------- #
def compare_teams(event_key: str, teams: list[int]) -> dict[str, Any]:
    summaries = [team_summary(event_key, t) for t in teams]
    metrics = [(k, label, "low" if k in LOWER_BETTER else "high") for k, label in RANK_METRICS.items()]
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


def analysis_bundle(event_key: str) -> dict[str, Any]:
    """One revision-cached cloud snapshot shared by all analysis views."""
    def build():
        from .routers.teams import _team_dict, report_dict, scout_name
        teams = list(all_summaries(event_key).values())
        scouting = {}
        for summary in teams:
            team = summary["team"]
            heatmaps = {phase: team_heatmap(event_key, team, None if phase == "all" else phase) for phase in ("all", "auto", "teleop")}
            scouting[str(team)] = {"summary": summary, "heatmap": heatmaps["all"], "heatmaps": heatmaps,
                "reports": [report_dict(e, scout_name(e.scout_id)) for e in team_entries(event_key, team)]}
        return {"event": event_key, "generated_at": datetime.now(timezone.utc).isoformat(),
            "teams": teams, "analysis": data_analysis(event_key),
            "metrics": [{"key": k, "label": v, "better": "low" if k in LOWER_BETTER else "high"} for k, v in RANK_METRICS.items()],
            "orders": {k: [s["team"] for s in rank_teams(event_key, k)] for k in RANK_METRICS},
            "profiles": [_team_dict(repo.team(s["team"]), s["team"]) for s in teams],
            "scouting": scouting, "picklist": data_picklist(event_key), "consensus": scout_disagreements(event_key)}
    return repo.memoized(f"analysis-bundle:{event_key}", (*_DEPS, schema.SCOUTERS), build)

"""Event-local EPA calibration. These are estimates, not official shot values."""
from collections import defaultdict
from dataclasses import replace
from math import isfinite
from statistics import mean

from .scoring import compute_points


def flat_report(row):
    return {**row.data, "event_key": row.event_key, "team_number": row.team_number,
            "match_number": row.match_number, "comp_level": row.comp_level,
            "submission_id": row.submission_id, "season_id": row.season_id,
            "game_version": row.game_version, "responses": row.responses,
            "actions": row.actions, "no_show": row.no_show,
            "fouls": row.data.get("foul_count", 0)}


def click_values(reports, matches, teams):
    epa = {t.team_number: float(t.epa) for t in teams
           if isinstance(t.epa, (float, int)) and isfinite(t.epa) and t.epa >= 0}
    residuals = defaultdict(list)
    for match in matches:
        for alliance, score in ((match.red, match.red_score), (match.blue, match.blue_score)):
            if score is None or not isfinite(score) or score < 0:
                continue
            unknown = [team for team in alliance if team not in epa]
            if unknown:
                share = max(0, score - sum(epa.get(t, 0) for t in alliance)) / len(unknown)
                for team in unknown:
                    residuals[match.event_key, team].append(share)
    grouped = defaultdict(lambda: defaultdict(list))
    for report in reports:
        if report.get("no_show"):
            continue
        key = (report["event_key"], int(report["team_number"]))
        match = (report.get("comp_level", "qm"), report.get("match_number", 0))
        grouped[key][match].append((
            sum(isinstance(p, dict) for p in report.get("heatmap") or []),
            compute_points(report, heatmap_value=0),
        ))
    values = {}
    for key, observations in grouped.items():
        target = epa.get(key[1])
        if target is None and residuals[key]:
            target = mean(residuals[key])
        shots = mean(mean(r[0] for r in rows) for rows in observations.values())
        other = mean(mean(r[1] for r in rows) for rows in observations.values())
        if target is not None and shots > 0:
            values[key] = max(0, target - other) / shots
    return values


def rescore_reports(rows, matches, teams):
    reports = [flat_report(row) for row in rows]
    values = click_values(reports, matches, teams)
    scored = []
    for row, report in zip(rows, reports):
        value = values.get((row.event_key, row.team_number))
        if value is None:
            value = _default_value(report)
        scored.append(replace(row, points=compute_points(report, heatmap_value=value)))
    return scored


def _default_value(report):
    from .scoring import definition_for
    from .gamedef import score
    return score({}, [{"action": "score", "phase": "teleop", "result": "made",
                       "quantity": 1}], definition_for(report))

"""Scoring proxy for the 2026 *Rebuilt* game.

The exact field point values are game-specific; this module turns a scouting
entry into a single comparable "performance" number used throughout the
analytics.  Tweak the constants here when the official scoring is confirmed —
everything downstream (rankings, picklists, compare) reads from this.
"""
from __future__ import annotations

from typing import Any

# Per-attempt point values by phase (a "made" scoring action).
AUTO_MADE = 4.0
TELEOP_MADE = 2.5

AUTO_LEAVE = 3.0
AUTO_CLIMB_BONUS = 4.0
CLIMB_POINTS = {"none": 0.0, "l1": 3.0, "l2": 6.0, "l3": 12.0}
STOP_BONUS = 1.5          # defensive stop value (credited to the defender)
FOUL_PENALTY = 2.0


def attempt_value(attempt: dict[str, Any]) -> float:
    if attempt.get("result") != "made":
        return 0.0
    explicit = attempt.get("value")
    if isinstance(explicit, (int, float)) and explicit > 0:
        return float(explicit)
    return AUTO_MADE if attempt.get("phase") == "auto" else TELEOP_MADE


def compute_points(entry: dict[str, Any]) -> float:
    pts = 0.0
    for a in entry.get("heatmap") or []:
        pts += attempt_value(a)
    if entry.get("auto_leave"):
        pts += AUTO_LEAVE
    if entry.get("auto_climb"):
        pts += AUTO_CLIMB_BONUS
    pts += CLIMB_POINTS.get(str(entry.get("climb", "none")).lower(), 0.0)
    pts += STOP_BONUS * int(entry.get("successful_stops") or 0)
    pts -= FOUL_PENALTY * int(entry.get("fouls") or 0)
    return round(max(pts, 0.0), 2)


def phase_counts(entry: dict[str, Any]) -> dict[str, int]:
    auto_made = auto_miss = tele_made = tele_miss = 0
    for a in entry.get("heatmap") or []:
        made = a.get("result") == "made"
        if a.get("phase") == "auto":
            auto_made += made
            auto_miss += not made
        else:
            tele_made += made
            tele_miss += not made
    return {
        "auto_made": auto_made,
        "auto_missed": auto_miss,
        "teleop_made": tele_made,
        "teleop_missed": tele_miss,
    }

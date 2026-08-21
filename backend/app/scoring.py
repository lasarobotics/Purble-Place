"""Turn a scouting entry into one comparable performance number.

Every value this uses comes from :mod:`app.game`, so a new season is edited
there and not here. Everything downstream (rankings, picklists, compare,
insights) reads the number this produces.
"""
from __future__ import annotations

from typing import Any, Optional

from .game import Game, game_for


def attempt_value(attempt: dict[str, Any], game: Optional[Game] = None) -> float:
    """What one scoring attempt was worth.

    An explicit ``value`` on the attempt wins, so a game with several scoring
    heights can record the real number per tap without this module needing to
    know the field layout.
    """
    g = game or game_for()
    if attempt.get("result") != "made":
        return 0.0
    explicit = attempt.get("value")
    if isinstance(explicit, (int, float)) and explicit > 0:
        return float(explicit)
    return g.auto_made if attempt.get("phase") == "auto" else g.teleop_made


def compute_points(entry: dict[str, Any], season: Optional[int] = None) -> float:
    """Score one scouting entry under the rules of its season."""
    g = game_for(season)
    pts = 0.0
    for a in entry.get("heatmap") or []:
        pts += attempt_value(a, g)
    if entry.get("auto_leave"):
        pts += g.auto_leave
    if entry.get("auto_climb"):
        pts += g.auto_endgame_bonus
    pts += g.endgame_points.get(str(entry.get("climb", g.endgame_none)).lower(), 0.0)
    pts += g.stop_bonus * int(entry.get("successful_stops") or 0)
    pts -= g.foul_penalty * int(entry.get("fouls") or 0)
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

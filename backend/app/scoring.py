"""EPA-calibrated heatmap estimates plus pinned game-definition scoring.

Map clicks share one value across phases. Other scoring retains the report's
pinned rules, except leave and defense stops, which are observations only.
"""
from __future__ import annotations

from typing import Any, Optional
from dataclasses import replace

from . import seasons
from .gamedef import GameDefinition
from .gamedef import score as score_with


def definition_for(entry: dict[str, Any]) -> GameDefinition:
    """The game definition a submission should be read against.

    Pinned provenance first; the season's current definition only as a
    fallback, for a report that predates the season model.
    """
    season_id = entry.get("season_id") or seasons.current_season_id()
    version = int(entry.get("game_version") or 0)
    return seasons.definition_at(season_id, version)


def compute_points(
    entry: dict[str, Any],
    season: Optional[int] = None,
    *,
    definition: Optional[GameDefinition] = None,
    heatmap_value: Optional[float] = None,
) -> float:
    """Score one submission.

    ``entry`` is the flat submission shape the API and the offline queue use.
    Plain answers and recorded actions use pinned rules. Heatmap clicks use
    an event-local EPA estimate, recalibrated as reports and results arrive.
    """
    game = definition or definition_for(entry)

    responses = dict(entry.get("responses") or {})
    # Named columns are answers too. They are merged under their own keys so a
    # rule can name either, and the explicit responses win on a clash.
    for key in (
        "auto_leave", "auto_climb", "climb", "fouls", "successful_stops",
        "driver_skill", "speed_rating", "defense_rating", "played_defense",
        "failure", "no_show",
    ):
        if key in entry and key not in responses:
            responses[key] = entry[key]

    actions = list(entry.get("actions") or [])
    # Leave and defense remain observations, never scoring bonuses.
    responses.pop("auto_leave", None)
    responses.pop("successful_stops", None)
    game = replace(game, rules=[r for r in game.rules
        if (r.when or {}).get("field") not in {"auto_leave", "successful_stops"}])

    if entry.get("no_show"):
        # A robot that never appeared scores nothing, whatever stray taps the
        # form collected on the way to submitting.
        return 0.0

    points = entry.get("heatmap") or []
    if heatmap_value is None and points and entry.get("event_key") and entry.get("team_number"):
        from . import repo, schema
        from .epa_scoring import flat_report, click_values
        rows = [flat_report(e) for e in repo.store.all(schema.MATCH_SCOUTING)
                if e.event_key == entry["event_key"]
                and e.submission_id != entry.get("submission_id")]
        rows.append(entry)
        heatmap_value = click_values(rows, repo.store.all(schema.MATCHES),
                                    repo.store.all(schema.TEAM_CACHE)).get(
                                        (entry["event_key"], int(entry["team_number"])))
    if heatmap_value is None:
        heatmap_value = score_with({}, [{"action": "score", "phase": "teleop",
                                         "result": "made", "quantity": 1}], game)
    return round(score_with(responses, actions, game) +
                 sum(isinstance(p, dict) for p in points) * heatmap_value, 2)


def _heatmap_as_actions(points: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Read field-map taps as ordinary recorded actions.

    The map is one way of recording "a robot did something, somewhere, in a
    phase, and it worked or it did not", which is exactly what an action is.
    Treating it as one means scoring has a single path instead of two.
    """
    out = []
    for p in points:
        if not isinstance(p, dict):
            continue
        out.append({
            "action": p.get("action") or "score",
            "phase": p.get("phase") or "teleop",
            "result": "made",
            "object": p.get("object"),
            "location": p.get("location"),
            "quantity": p.get("quantity", 1),
            "x": p.get("x"),
            "y": p.get("y"),
        })
    return out


def phase_counts(entry: dict[str, Any]) -> dict[str, int]:
    """Made and missed per phase, for the summaries that show accuracy.

    Kept under the historic key names because the analytics and several
    screens read them, but computed from whatever phases the game defines.
    """
    auto_made = tele_made = 0
    auto_miss = int(entry.get("auto_missed") or 0)
    tele_miss = int(entry.get("teleop_missed") or 0)
    records = list(entry.get("actions") or []) + _heatmap_as_actions(entry.get("heatmap") or [])
    for a in records:
        if not isinstance(a, dict):
            continue
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


def attempt_value(attempt: dict[str, Any], game: Optional[GameDefinition] = None) -> float:
    """What one recorded attempt is worth on its own.

    Used by the season editor's scoring preview. An explicit ``value`` on the
    attempt wins, so a game with several scoring heights can record the real
    number per tap.
    """
    explicit = attempt.get("value")
    if isinstance(explicit, (int, float)) and explicit > 0:
        return float(explicit)
    definition = game or seasons.definition()
    return score_with({}, [attempt], definition)

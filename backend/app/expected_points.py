"""Scouting-only estimate behind the existing ``avg_points`` metric."""
from __future__ import annotations

import statistics
from collections import Counter, defaultdict
from typing import Any

from .models import ScoutEntry
from .scoring import attempt_value, definition_for


def _median(values: list[float]) -> float:
    return float(statistics.median(values)) if values else 0.0


def _records(entry: ScoutEntry) -> list[dict[str, Any]]:
    records = [dict(a) for a in (entry.actions or []) if isinstance(a, dict)]
    records += [{**p, "action": p.get("action") or "score", "result": p.get("result") or "made"}
                for p in (entry.data.get("heatmap") or []) if isinstance(p, dict)]
    return records


def _category(a: dict[str, Any]) -> tuple[str, str, str, str]:
    return (str(a.get("phase") or "teleop"), str(a.get("action") or "score"),
            str(a.get("object") or ""), str(a.get("location") or ""))


def _consensus(entries: list[ScoutEntry]) -> list[dict[str, Any]]:
    groups: dict[tuple[str, str, int, int], list[ScoutEntry]] = defaultdict(list)
    for e in entries:
        groups[(e.event_key, e.comp_level, e.match_number, e.team_number)].append(e)
    out = []
    for key, reports in sorted(groups.items(), key=lambda item: (item[0][1], item[0][2], item[0][3])):
        category_counts: dict[tuple[str, str, str, str], list[tuple[float, float]]] = defaultdict(list)
        all_categories = {_category(a) for e in reports for a in _records(e)}
        for cat in all_categories:
            for e in reports:
                made = missed = 0.0
                for a in _records(e):
                    if _category(a) != cat: continue
                    qty = max(0.0, float(a.get("quantity") or 1))
                    if a.get("result", "made") == "made": made += qty
                    else: missed += qty
                category_counts[cat].append((made, missed))
        # Older forms store missed counters separately. Keep missing distinct
        # from zero by adding them only when the key exists.
        for phase, field in (("auto", "auto_missed"), ("teleop", "teleop_missed")):
            present = [float(e.data[field]) for e in reports if field in e.data]
            if present:
                cat = (phase, "score", "", "")
                existing = category_counts.setdefault(cat, [(0.0, 0.0) for _ in reports])
                miss = _median(present)
                category_counts[cat] = [(m, x + miss) for m, x in existing]
        counts = {cat: (_median([v[0] for v in vals]), _median([v[1] for v in vals]))
                  for cat, vals in category_counts.items()}
        for phase in ("auto", "teleop"):
            generic = (phase, "score", "", "")
            generic_made, generic_missed = counts.get(generic, (0.0, 0.0))
            specific = [cat for cat, pair in counts.items() if cat[0] == phase and cat != generic and pair[0] > 0]
            if generic_made == 0 and generic_missed > 0 and specific:
                made_total = sum(counts[cat][0] for cat in specific)
                for cat in specific:
                    made, missed = counts[cat]
                    counts[cat] = (made, missed + generic_missed * made / made_total)
                counts.pop(generic, None)
        mode = lambda vals, default: Counter(vals).most_common(1)[0][0] if vals else default
        out.append({"key": key, "reports": reports, "counts": counts,
                    "climb": mode([e.climb for e in reports], "none"),
                    "defense": bool(mode([e.played_defense for e in reports], False)),
                    "failed": bool(mode([e.failure or e.no_show for e in reports], False)),
                    "representative": reports[0]})
    return out


def _typical(values: list[float]) -> float:
    if not values: return 0.0
    med = _median(values)
    if len(values) < 4: return med
    recent = values[-3:]
    weighted = sum(v * w for v, w in zip(recent, range(1, len(recent) + 1))) / sum(range(1, len(recent) + 1))
    return 0.75 * med + 0.25 * weighted


def prepare_event(entries: list[ScoutEntry]) -> dict[str, Any]:
    """Event priors once, retaining the original consensus and summation order."""
    matches = _consensus(entries)
    categories = {cat for match in matches for cat in match["counts"]}
    return {"totals": {cat: (sum(m["counts"].get(cat, (0, 0))[0] for m in matches),
                             sum(m["counts"].get(cat, (0, 0))[1] for m in matches)) for cat in categories},
            "states": Counter(m["climb"] for m in matches), "matches": len(matches)}


def estimate_avg_points(team_entries: list[ScoutEntry], event_entries: list[ScoutEntry],
                        *, event_context: dict[str, Any] | None = None) -> float | None:
    """Estimate a typical future contribution without EPA or match results."""
    matches = _consensus(team_entries)
    if not matches: return None
    context = event_context if event_context is not None else prepare_event(event_entries)
    game = definition_for({"season_id": matches[-1]["representative"].season_id,
                           "game_version": matches[-1]["representative"].game_version})
    k = float((game.extras or {}).get("accuracy_smoothing_k", 20))
    categories = {cat for m in matches for cat in m["counts"]}
    offense = [m for m in matches if not m["defense"]]
    source = offense if len(offense) >= 2 else matches
    assignment_factor = len(offense) / len(matches) if len(offense) >= 2 else 1.0
    total = 0.0
    observed = False
    for cat in categories:
        own_made = sum(m["counts"].get(cat, (0, 0))[0] for m in matches)
        own_miss = sum(m["counts"].get(cat, (0, 0))[1] for m in matches)
        attempts = own_made + own_miss
        event_made, event_miss = context["totals"].get(cat, (0, 0))
        event_attempts = event_made + event_miss
        if attempts <= 0: continue
        prior = event_made / event_attempts if event_attempts else own_made / attempts
        accuracy = (own_made + k * prior) / (attempts + k) if k > 0 else own_made / attempts
        volumes = [sum(m["counts"].get(cat, (0, 0))) for m in source]
        phase, action, obj, location = cat
        value = attempt_value({"phase": phase, "action": action, "object": obj or None,
                               "location": location or None, "result": "made", "quantity": 1}, game)
        volume = _typical(volumes)
        matching = [r for r in game.rules if r.targets_action and all(
            k not in r.when or r.when[k] in (None, {"phase": phase, "action": action, "object": obj, "location": location, "result": "made"}.get(k))
            for k in ("phase", "action", "object", "location", "result"))]
        if matching and all(r.per == "once" for r in matching):
            contribution = (1 - (1 - accuracy) ** volume) * max(0.0, value)
        else:
            contribution = volume * accuracy * max(0.0, value)
        total += contribution * assignment_factor
        observed = True
    # Conservative endgame probabilities: two prior matches distributed by
    # the event, falling back to the configured no-result state.
    states = [m["climb"] for m in matches]
    for state in {s.key for s in game.endgame}:
        event_rate = context["states"][state] / context["matches"] if context["matches"] else (1.0 if state == game.endgame_none else 0.0)
        probability = (states.count(state) + 2 * event_rate) / (len(states) + 2)
        points = game.endgame_points(state)
        total += probability * points
        observed = observed or bool(points and states.count(state))
    observed = observed or bool(game.endgame and states)
    # Attributable field penalties and other configured response scoring.
    for rule in game.rules:
        if not rule.targets_field or (rule.when or {}).get("field") in {"climb", "auto_leave", "successful_stops"}: continue
        field = str(rule.when.get("field"))
        def field_value(entry: ScoutEntry):
            if field in entry.data: return entry.data.get(field)
            if field in entry.responses: return entry.responses.get(field)
            return getattr(entry, field, 0)
        if rule.when.get("equals") is not None:
            values = [Counter([field_value(e) for e in m["reports"]]).most_common(1)[0][0] for m in matches]
            probability = sum(v == rule.when["equals"] for v in values) / len(values)
            total += probability * rule.points
        else:
            values = [_median([float(field_value(e) or 0) for e in m["reports"]]) for m in matches]
            value = _typical(values)
            total += (value if rule.per == "each" else float(value != 0)) * rule.points
        observed = observed or any(values)
    return round(max(0.0, total), 2) if observed else None

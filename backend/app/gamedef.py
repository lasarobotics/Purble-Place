"""A generic model of an FRC game, and the engine that scores one.

Why this exists
---------------
The previous design put the season in a Python module: constants like
``auto_made``, ``teleop_made``, ``endgame`` and ``foul_penalty``, edited every
January. That is fine right up until FIRST announces a game those names do not
describe. A stacking game has no "made"; a delivery game has no endgame level;
a game with two autonomous periods has no single ``auto``. Every one of those
would have meant editing the application.

So a game is described here in terms that outlive any particular game:

    Phase       when something happened          auto, teleop, endgame
    Object      what was handled                 a game piece
    Location    where                            a node, a zone, a level
    Action      what a robot did                 score, deliver, stack, climb
    Result      how it went                      made, missed
    Rule        what that is worth               points, per each or once
    State       a terminal condition             an endgame state

Every FRC game the team has scouted, and every one described in the brief's
test scenarios, is a different arrangement of those seven things. None of them
names a game element, so none of them goes stale.

Where a definition lives
------------------------
In the datastore, attached to a season, versioned (see ``seasons.py``). This
module holds the *shape*, the *scoring engine*, and a bootstrap definition used
to create the first season on a fresh install. It is deliberately not a
registry of games: adding 2027 is creating a season, not editing this file.

Scoring is data
---------------
``score`` walks a list of rules. A rule either reads a plain answer:

    when {"field": "fouls"}                 points -2, per each
    when {"field": "climb", "equals": "l3"} points 12, per once

or counts repeated actions:

    when {"action": "score", "phase": "teleop", "object": "coral",
          "location": "l4", "result": "made"}   points 5, per each

Anything absent from ``when`` is a wildcard, so a rule can be as coarse or as
specific as the game needs.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Iterable, Optional

# --------------------------------------------------------------------------- #
# Vocabulary                                                                   #
# --------------------------------------------------------------------------- #
#: How a rule turns a quantity into points.
PER_EACH = "each"   # multiply by how many times it happened
PER_ONCE = "once"   # award it flat, the first time it applies
PER_MODES = (PER_EACH, PER_ONCE)


@dataclass
class Phase:
    """A period of the match. Games have had one, two, and three of these."""

    key: str
    label: str
    order: int = 0
    seconds: int = 0


@dataclass
class GamePiece:
    """Something a robot handles. Called an object in the brief."""

    key: str
    label: str
    color: str = ""


@dataclass
class Location:
    """Somewhere on the field a thing can happen.

    ``x`` and ``y`` are normalised (0..1) field coordinates when the location
    is a place on the map; they are left unset for abstract locations such as
    "level 3" that have no single position.
    """

    key: str
    label: str
    group: str = ""
    x: Optional[float] = None
    y: Optional[float] = None


@dataclass
class ActionType:
    """Something a robot does.

    The lists narrow what the scouting form should offer for this action.
    Empty means "anything the game defines".
    """

    key: str
    label: str
    phases: list[str] = field(default_factory=list)
    objects: list[str] = field(default_factory=list)
    locations: list[str] = field(default_factory=list)
    results: list[str] = field(default_factory=list)


@dataclass
class ScoringRule:
    """What something is worth.

    ``when`` is a set of equality checks against either a plain answer or a
    recorded action. An absent key matches anything, so one rule can cover a
    whole phase and another can single out one node.
    """

    rule_id: str
    label: str
    points: float
    per: str = PER_EACH
    when: dict[str, Any] = field(default_factory=dict)

    @property
    def targets_action(self) -> bool:
        return "action" in self.when or "object" in self.when or "location" in self.when

    @property
    def targets_field(self) -> bool:
        return "field" in self.when


@dataclass
class EndgameState:
    """A terminal condition. A game may have none, one, or several."""

    key: str
    label: str
    points: float = 0.0


@dataclass
class Tag:
    """A one-tap qualitative observation. ``tone`` is "good" or "bad"."""

    tag: str
    tone: str = "good"


#: How tapping the field map is recorded. "point" keeps the coordinate,
#: "zone" keeps which configured region was hit.
FIELD_MAP_MODES = ("point", "zone")


@dataclass
class FieldMap:
    """The picture a scout taps, and what tapping it means.

    The image is referenced by season-relative path rather than a fixed
    ``field.png``, so last season's submissions can still be drawn on last
    season's field.
    """

    image: str = ""
    #: Rectangular regions, normalised 0..1, mapped to location keys.
    zones: list[dict[str, Any]] = field(default_factory=list)
    #: "point" records a coordinate, "zone" records which region was hit.
    mode: str = "point"
    orientation: str = "landscape"


@dataclass
class GameDefinition:
    """Everything about one FRC game, as data.

    Nothing in the application should read a named constant off this. Read the
    lists, and let the season say what is in them.
    """

    name: str = ""
    year: int = 0
    phases: list[Phase] = field(default_factory=list)
    pieces: list[GamePiece] = field(default_factory=list)
    locations: list[Location] = field(default_factory=list)
    actions: list[ActionType] = field(default_factory=list)
    rules: list[ScoringRule] = field(default_factory=list)
    endgame: list[EndgameState] = field(default_factory=list)
    endgame_label: str = "Endgame"
    tags: list[Tag] = field(default_factory=list)
    field_map: FieldMap = field(default_factory=FieldMap)
    #: Anything a season needs that the platform does not model. Deliberately
    #: open: it is better for an odd mechanic to land here than for someone to
    #: add a field to this class every January.
    extras: dict[str, Any] = field(default_factory=dict)

    # ---- convenience -------------------------------------------------- #
    @property
    def phase_keys(self) -> list[str]:
        return [p.key for p in sorted(self.phases, key=lambda p: p.order)]

    @property
    def endgame_none(self) -> str:
        """The state meaning "did not do it", by convention the first."""
        return self.endgame[0].key if self.endgame else "none"

    @property
    def tag_names(self) -> list[str]:
        return [t.tag for t in self.tags]

    @property
    def positive_tags(self) -> list[str]:
        return [t.tag for t in self.tags if t.tone == "good"]

    @property
    def negative_tags(self) -> list[str]:
        return [t.tag for t in self.tags if t.tone == "bad"]

    def location(self, key: str) -> Optional[Location]:
        return next((l for l in self.locations if l.key == key), None)

    def endgame_points(self, key: str) -> float:
        state = next((s for s in self.endgame if s.key == key), None)
        return state.points if state else 0.0

    # ---- serialisation ------------------------------------------------- #
    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "GameDefinition":
        data = data or {}
        return cls(
            name=data.get("name") or "",
            year=int(data.get("year") or 0),
            phases=[Phase(**p) for p in data.get("phases") or []],
            pieces=[GamePiece(**p) for p in data.get("pieces") or []],
            locations=[Location(**l) for l in data.get("locations") or []],
            actions=[ActionType(**a) for a in data.get("actions") or []],
            rules=[ScoringRule(**r) for r in data.get("rules") or []],
            endgame=[EndgameState(**e) for e in data.get("endgame") or []],
            endgame_label=data.get("endgame_label") or "Endgame",
            tags=[Tag(**t) for t in data.get("tags") or []],
            field_map=FieldMap(**(data.get("field_map") or {})),
            extras=dict(data.get("extras") or {}),
        )


# --------------------------------------------------------------------------- #
# Validation                                                                   #
# --------------------------------------------------------------------------- #
def validate(definition: GameDefinition) -> list[str]:
    """Every problem with a definition. Empty means it is usable."""
    problems: list[str] = []

    if not definition.name.strip():
        problems.append("The game needs a name.")
    if not definition.phases:
        problems.append("A game needs at least one phase, such as Teleop.")

    def dupes(items: Iterable[str], what: str) -> None:
        seen, bad = set(), set()
        for key in items:
            if key in seen:
                bad.add(key)
            seen.add(key)
        for key in sorted(bad):
            problems.append(f"Two {what} share the key {key!r}.")

    dupes([p.key for p in definition.phases], "phases")
    dupes([p.key for p in definition.pieces], "game pieces")
    dupes([l.key for l in definition.locations], "locations")
    dupes([a.key for a in definition.actions], "actions")
    dupes([s.key for s in definition.endgame], "endgame states")
    dupes([r.rule_id for r in definition.rules], "scoring rules")

    phases = {p.key for p in definition.phases}
    pieces = {p.key for p in definition.pieces}
    locations = {l.key for l in definition.locations}
    actions = {a.key for a in definition.actions}

    for action in definition.actions:
        for phase in action.phases:
            if phase not in phases:
                problems.append(f"Action {action.key!r} uses unknown phase {phase!r}.")
        for piece in action.objects:
            if piece not in pieces:
                problems.append(f"Action {action.key!r} uses unknown game piece {piece!r}.")
        for loc in action.locations:
            if loc not in locations:
                problems.append(f"Action {action.key!r} uses unknown location {loc!r}.")

    for rule in definition.rules:
        if rule.per not in PER_MODES:
            problems.append(
                f"Rule {rule.rule_id!r} scores {rule.per!r}; it must be "
                f"{PER_EACH!r} or {PER_ONCE!r}."
            )
        if not rule.when:
            problems.append(f"Rule {rule.rule_id!r} matches nothing.")
        target = rule.when.get("action")
        if target and target not in actions:
            problems.append(f"Rule {rule.rule_id!r} scores unknown action {target!r}.")
        phase = rule.when.get("phase")
        if phase and phase not in phases:
            problems.append(f"Rule {rule.rule_id!r} uses unknown phase {phase!r}.")

    return problems


# --------------------------------------------------------------------------- #
# Scoring                                                                      #
# --------------------------------------------------------------------------- #
def _matches(criteria: dict[str, Any], record: dict[str, Any]) -> bool:
    """Does one recorded action satisfy a rule's ``when``?

    Only the keys the rule names are checked, so an unstated key is a
    wildcard. That is what lets one rule cover a whole phase.
    """
    for key, wanted in criteria.items():
        if key in ("field", "equals"):
            continue
        if record.get(key) != wanted:
            return False
    return True


def _quantity(record: dict[str, Any]) -> float:
    raw = record.get("quantity", 1)
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return 1.0
    return value if value > 0 else 1.0


def _numeric(value: Any) -> float:
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def score(
    responses: dict[str, Any],
    actions: list[dict[str, Any]],
    definition: GameDefinition,
) -> float:
    """What a submission is worth under one game definition.

    ``responses`` is the flat answer map from the form; ``actions`` is the
    list of repeated action records. Both come straight off the submission,
    and the definition passed in should be the version the submission was
    collected under, never today's.
    """
    total = 0.0

    for rule in definition.rules:
        criteria = rule.when or {}

        if "field" in criteria:
            value = responses.get(criteria["field"])
            if "equals" in criteria:
                # A specific answer, e.g. the endgame state that was reached.
                if value == criteria["equals"]:
                    total += rule.points
                continue
            amount = _numeric(value)
            if rule.per == PER_ONCE:
                total += rule.points if amount else 0.0
            else:
                total += rule.points * amount
            continue

        # Otherwise the rule counts recorded actions.
        hits = [a for a in actions if _matches(criteria, a)]
        if not hits:
            continue
        if rule.per == PER_ONCE:
            total += rule.points
        else:
            total += rule.points * sum(_quantity(a) for a in hits)

    return round(total, 2)


def explain(
    responses: dict[str, Any],
    actions: list[dict[str, Any]],
    definition: GameDefinition,
) -> list[dict[str, Any]]:
    """The same calculation, itemised.

    Used by the season editor so somebody configuring a game can see what a
    sample submission would score and why, rather than trusting a total.
    """
    lines = []
    for rule in definition.rules:
        before = score(responses, actions, GameDefinition(rules=[rule]))
        if before:
            lines.append({"rule": rule.rule_id, "label": rule.label, "points": before})
    return lines


# --------------------------------------------------------------------------- #
# Bootstrap                                                                    #
# --------------------------------------------------------------------------- #
def bootstrap_2026() -> GameDefinition:
    """The 2026 game, expressed in the generic model.

    This exists so a fresh install has a working season on first boot, and as
    the worked example of how a real game maps onto the primitives. It is not
    a registry: 2027 is created as a season in the app, not added here.
    """
    return GameDefinition(
        name="Rebuilt",
        year=2026,
        phases=[
            Phase("auto", "Autonomous", order=0, seconds=15),
            Phase("teleop", "Teleop", order=1, seconds=135),
        ],
        pieces=[GamePiece("piece", "Game piece")],
        locations=[Location("field", "Anywhere on the field")],
        actions=[
            ActionType(
                key="score",
                label="Scoring attempt",
                phases=["auto", "teleop"],
                objects=["piece"],
                locations=["field"],
                results=["made", "missed"],
            ),
        ],
        rules=[
            ScoringRule("auto_made", "Scored in auto", 4.0, PER_EACH,
                        {"action": "score", "phase": "auto", "result": "made"}),
            ScoringRule("teleop_made", "Scored in teleop", 2.5, PER_EACH,
                        {"action": "score", "phase": "teleop", "result": "made"}),
            ScoringRule("auto_leave", "Left the starting zone", 3.0, PER_ONCE,
                        {"field": "auto_leave"}),
            ScoringRule("auto_endgame", "Endgame during auto", 4.0, PER_ONCE,
                        {"field": "auto_climb"}),
            ScoringRule("climb_l1", "Climbed L1", 3.0, PER_ONCE,
                        {"field": "climb", "equals": "l1"}),
            ScoringRule("climb_l2", "Climbed L2", 6.0, PER_ONCE,
                        {"field": "climb", "equals": "l2"}),
            ScoringRule("climb_l3", "Climbed L3", 12.0, PER_ONCE,
                        {"field": "climb", "equals": "l3"}),
            ScoringRule("stops", "Defensive stop", 1.5, PER_EACH,
                        {"field": "successful_stops"}),
            ScoringRule("fouls", "Foul", -2.0, PER_EACH, {"field": "fouls"}),
        ],
        endgame_label="Endgame climb",
        endgame=[
            EndgameState("none", "No climb", 0.0),
            EndgameState("l1", "L1", 3.0),
            EndgameState("l2", "L2", 6.0),
            EndgameState("l3", "L3", 12.0),
        ],
        tags=[
            Tag("Fast cycles", "good"),
            Tag("Strong auto", "good"),
            Tag("Clutch climb", "good"),
            Tag("Great defense", "good"),
            Tag("Smart driver", "good"),
            Tag("Consistent", "good"),
            Tag("Good under pressure", "good"),
            Tag("Great partner", "good"),
            Tag("Died on field", "bad"),
            Tag("Dropped pieces", "bad"),
            Tag("Slow cycles", "bad"),
            Tag("Tippy / unstable", "bad"),
            Tag("Penalty prone", "bad"),
            Tag("Struggled vs defense", "bad"),
            Tag("Comms issues", "bad"),
        ],
        field_map=FieldMap(image="field.png", mode="point"),
    )

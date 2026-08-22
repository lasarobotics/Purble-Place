"""Form definitions: what a scouting form asks, decided by humans not code.

The problem this solves
-----------------------
FRC changes the game every year, and the scouting form changes with it. A
stacking game needs counters per level; a shooting game needs made/missed by
zone; an endgame is a climb one year and a docking the next. Hardcoding any of
that means every January is a code change, a deploy, and a strategy lead
waiting on whoever writes TypeScript.

So the form is data. An admin builds it in the app, the scouting page renders
whatever it says, and submissions are stored against it. The season's game
definition (``app/gamedef.py``) says what a game contains; this module says
what the scouts are asked about it.

Why the field types are what they are
-------------------------------------
They were chosen by walking backwards through real FRC seasons and asking what
each one needed. Counters cover every "how many pieces in the X" game.
Select covers ownership, starting position and endgame level. Rating covers
the judgement calls scouts have always made. The heatmap covers anything
positional. Between them these express every scouting form the team has run,
without any of them naming a game element.

Stable keys
-----------
A field's ``key`` is the name its answer is stored under, forever. Renaming a
label is cosmetic; changing a key orphans every answer already collected under
the old one, so the builder treats keys as write-once and the validator
enforces that they are unique and identifier-shaped.

Core fields
-----------
The built-in analytics (rankings, consensus, insights, picklists) read specific
columns off a submission. A field can declare ``maps_to`` to feed one of those
columns; anything else lands in the submission's free-form ``responses`` map.
That is what lets a form be rebuilt from scratch for a new game without taking
the rankings down with it, and it is why the builder warns when a form stops
collecting something the analytics depend on.
"""
from __future__ import annotations

import re
from typing import Any, Optional

from .gamedef import GameDefinition, bootstrap_2026

# --------------------------------------------------------------------------- #
# Field types                                                                  #
# --------------------------------------------------------------------------- #
#: ``key -> (label, what it is for)``. The builder renders this list, so adding
#: a type here is the only place a new control has to be declared on the server.
FIELD_TYPES: dict[str, dict[str, str]] = {
    # Basic
    "text":        {"label": "Short text",    "hint": "One line, e.g. a strategy note"},
    "textarea":    {"label": "Long text",     "hint": "Several lines of comments"},
    "number":      {"label": "Number",        "hint": "Typed number, e.g. a weight"},
    "decimal":     {"label": "Decimal",       "hint": "A number with a fractional part"},
    "toggle":      {"label": "Yes / no",      "hint": "A single checkbox"},
    "rating":      {"label": "Rating",        "hint": "1 to N, e.g. driver skill"},
    "slider":      {"label": "Slider",        "hint": "A value along a range"},
    "datetime":    {"label": "Date and time", "hint": "When something happened"},
    # Choice
    "select":      {"label": "Choose one",    "hint": "e.g. endgame level, start position"},
    "dropdown":    {"label": "Dropdown",      "hint": "Choose one, from a long list"},
    "multiselect": {"label": "Choose many",   "hint": "e.g. capabilities"},
    "tags":        {"label": "Quick tags",    "hint": "One-tap good and bad observations"},
    "ranking":     {"label": "Ranking",       "hint": "Put options in order"},
    # Scouting primitives
    "counter":     {"label": "Counter",       "hint": "Plus and minus, e.g. pieces scored"},
    "timer":       {"label": "Stopwatch",     "hint": "Seconds, e.g. how long an endgame took"},
    "team":        {"label": "Team number",   "hint": "A team picker"},
    "match":       {"label": "Match number",  "hint": "Which match this is about"},
    "alliance":    {"label": "Alliance",      "hint": "Red or blue"},
    "station":     {"label": "Driver station","hint": "1, 2 or 3"},
    "phase":       {"label": "Phase",         "hint": "Which period of the match"},
    "piece":       {"label": "Game piece",    "hint": "Which object, from the season's game"},
    "location":    {"label": "Location",      "hint": "Where, from the season's game"},
    "heatmap":     {"label": "Field map",     "hint": "Tap the field where things happened"},
    "photo":       {"label": "Photo",         "hint": "Camera capture, e.g. the robot"},
    # Repeated data
    "actions":     {"label": "Repeatable actions",
                    "hint": "Add a row per attempt: phase, piece, location, result"},
    # Structure
    "note":        {"label": "Instructions",  "hint": "Static text, collects nothing"},
    "divider":     {"label": "Divider",       "hint": "A visual break, collects nothing"},
}

#: Types that hold no answer, so they are skipped by validation and scoring.
DISPLAY_ONLY = {"note", "divider"}

#: Types whose answer is one of a fixed set, so they need ``options``.
NEEDS_OPTIONS = {"select", "dropdown", "multiselect", "ranking"}

#: Types whose choices come from the season's game definition instead of from
#: options typed into the builder. This is the seam that keeps the form engine
#: game agnostic: the form says "ask which game piece", the season says which
#: pieces exist.
FROM_GAME = {"phase": "phases", "piece": "pieces", "location": "locations"}

#: Types that hold a list of records rather than a single answer.
REPEATABLE = {"actions"}

#: Submission columns a field may feed. Everything here is read by the built-in
#: analytics, which is exactly why they are named rather than inferred.
CORE_FIELDS: dict[str, str] = {
    "team_number": "Which robot this report is about",
    "match_number": "Which match",
    "alliance": "Red or blue",
    "station": "Driver station 1 to 3",
    "no_show": "The robot never appeared",
    "auto_leave": "Left the starting zone in auto",
    "auto_climb": "Completed the endgame action in auto",
    "climb": "Endgame level achieved",
    "climb_seconds": "How long the endgame took",
    "heatmap": "Positional scoring attempts",
    "tags": "Quick tags",
    "played_defense": "Played defense",
    "defense_rating": "How good the defense was",
    "defense_on": "Who they defended",
    "successful_stops": "Defensive stops",
    "driver_skill": "Driver rating",
    "speed_rating": "Cycle speed rating",
    "fouls": "Fouls charged",
    "failure": "Broke down",
    "failure_details": "What failed",
    "notes": "Free-text comments",
}

#: Losing one of these silently breaks a screen, so the builder says so.
#: They are warnings and not errors: a game where nobody plays defense is a
#: real thing, and the team should be allowed to drop the question.
ANALYTICS_CRITICAL = {
    "team_number": "the whole report is unattributable",
    "climb": "climb rate disappears from rankings and insights",
    "driver_skill": "Consensus Radar loses its qualitative half",
    "speed_rating": "Consensus Radar loses its qualitative half",
    "fouls": "penalties stop counting against a team",
    "tags": "team profiles and the picklist tag summary go empty",
}

KEY_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,39}$")

#: Form kinds. ``match`` and ``pit`` drive the two built-in pages; ``custom``
#: is anything else the team invents (drive team debrief, robot inspection).
KIND_MATCH = "match"
KIND_PIT = "pit"
KIND_CUSTOM = "custom"
KINDS = (KIND_MATCH, KIND_PIT, KIND_CUSTOM)


class FormInvalid(ValueError):
    """A form definition that cannot be saved, with every problem listed."""

    def __init__(self, problems: list[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = problems


# --------------------------------------------------------------------------- #
# Validation                                                                   #
# --------------------------------------------------------------------------- #
def validate_definition(definition: dict[str, Any]) -> list[str]:
    """Return every problem with a definition. Empty means it is saveable.

    Every problem is collected rather than raising on the first, because an
    admin editing a 40-field form should see the whole list once instead of
    fixing one thing per save.
    """
    problems: list[str] = []
    sections = definition.get("sections")
    if not isinstance(sections, list) or not sections:
        return ["A form needs at least one section."]

    seen_keys: dict[str, str] = {}
    for s_index, section in enumerate(sections, 1):
        where = f"Section {s_index}"
        if not isinstance(section, dict):
            problems.append(f"{where} is not a section.")
            continue
        if not str(section.get("title") or "").strip():
            problems.append(f"{where} needs a title.")
        fields = section.get("fields")
        if not isinstance(fields, list):
            problems.append(f"{where} has no fields.")
            continue

        for f_index, field in enumerate(fields, 1):
            problems.extend(
                _validate_field(field, f"{where}, field {f_index}", seen_keys)
            )

    return problems


def _validate_field(
    field: Any, where: str, seen_keys: dict[str, str]
) -> list[str]:
    problems: list[str] = []
    if not isinstance(field, dict):
        return [f"{where} is not a field."]

    ftype = str(field.get("type") or "")
    if ftype not in FIELD_TYPES:
        problems.append(f"{where} has an unknown type {ftype!r}.")
        return problems

    label = str(field.get("label") or "").strip()
    if not label:
        problems.append(f"{where} needs a label.")

    if ftype in DISPLAY_ONLY:
        return problems

    key = str(field.get("key") or "")
    if not KEY_PATTERN.match(key):
        problems.append(
            f"{where} ({label or ftype}) needs a key: lower case, starting with "
            "a letter, letters numbers and underscores only."
        )
    elif key in seen_keys:
        problems.append(
            f"{where} reuses the key {key!r}, already used by "
            f"{seen_keys[key]!r}. Answers are stored by key, so they have to "
            "be unique."
        )
    else:
        seen_keys[key] = label or key

    # A field that draws its choices from the season's game does not carry
    # options of its own, and must not be asked for any: the whole point is
    # that the game says what the choices are.
    if ftype in FROM_GAME and field.get("options"):
        problems.append(
            f"{where} ({label}) takes its choices from the season's game, so it "
            "should not have its own options."
        )

    if ftype in NEEDS_OPTIONS:
        options = field.get("options")
        if not isinstance(options, list) or not options:
            problems.append(f"{where} ({label}) needs at least one option.")
        else:
            option_values = []
            for o_index, option in enumerate(options, 1):
                if not isinstance(option, dict):
                    problems.append(f"{where} option {o_index} is malformed.")
                    continue
                value = str(option.get("value") or "").strip()
                if not value:
                    problems.append(f"{where} option {o_index} needs a value.")
                option_values.append(value)
            duplicates = {v for v in option_values if option_values.count(v) > 1 and v}
            for value in sorted(duplicates):
                problems.append(f"{where} ({label}) repeats the option {value!r}.")

    if ftype == "rating":
        scale = field.get("max", 5)
        if not isinstance(scale, int) or not 2 <= scale <= 10:
            problems.append(f"{where} ({label}) needs a rating scale between 2 and 10.")

    if ftype == "actions":
        # A repeatable action group is the generic answer to "this game
        # involves doing a thing over and over". It has to say which thing.
        if not str(field.get("action") or "").strip():
            problems.append(
                f"{where} ({label}) needs to say which action it records. "
                "Pick one from the season's game."
            )

    if ftype in ("counter", "number", "decimal", "slider"):
        low, high = field.get("min"), field.get("max")
        if isinstance(low, (int, float)) and isinstance(high, (int, float)) and low > high:
            problems.append(f"{where} ({label}) has a minimum above its maximum.")

    maps_to = field.get("maps_to")
    if maps_to and maps_to not in CORE_FIELDS:
        problems.append(f"{where} ({label}) maps to unknown core field {maps_to!r}.")

    return problems


def ensure_valid(definition: dict[str, Any]) -> None:
    problems = validate_definition(definition)
    if problems:
        raise FormInvalid(problems)


def missing_core_fields(definition: dict[str, Any]) -> list[dict[str, str]]:
    """Analytics inputs this form no longer collects.

    Warnings, not errors. The builder shows them so dropping a question is a
    decision somebody made rather than a screen that quietly goes blank three
    weeks later.
    """
    mapped = {f.get("maps_to") for f in iter_fields(definition) if f.get("maps_to")}
    return [
        {"field": name, "consequence": consequence}
        for name, consequence in sorted(ANALYTICS_CRITICAL.items())
        if name not in mapped
    ]


def iter_fields(definition: dict[str, Any]):
    """Every field in a definition, in the order they appear."""
    for section in definition.get("sections") or []:
        if isinstance(section, dict):
            for field in section.get("fields") or []:
                if isinstance(field, dict):
                    yield field


# --------------------------------------------------------------------------- #
# Diffing: what changed between two revisions                                  #
# --------------------------------------------------------------------------- #
#: Field properties worth reporting a change in. Ordering and cosmetic keys are
#: excluded so a diff reads like an edit summary, not a JSON dump.
DIFFED_PROPS = (
    "label", "type", "hint", "required", "options", "min", "max",
    "default", "maps_to", "points", "visible_if", "tone",
)


def _field_map(definition: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(f.get("key")): f
        for f in iter_fields(definition)
        if f.get("key") and f.get("type") not in DISPLAY_ONLY
    }


def diff_definitions(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    """A structured, human-readable diff between two form definitions.

    Keyed on the field key rather than position, so moving a field between
    sections reads as a move and not as a delete plus an add.
    """
    old, new = _field_map(before), _field_map(after)
    old_keys, new_keys = set(old), set(new)

    added = [
        {"key": k, "label": new[k].get("label"), "type": new[k].get("type")}
        for k in sorted(new_keys - old_keys)
    ]
    removed = [
        {"key": k, "label": old[k].get("label"), "type": old[k].get("type")}
        for k in sorted(old_keys - new_keys)
    ]

    changed = []
    for key in sorted(old_keys & new_keys):
        deltas = []
        for prop in DIFFED_PROPS:
            was, now = old[key].get(prop), new[key].get(prop)
            if was != now:
                deltas.append({"property": prop, "from": was, "to": now})
        if deltas:
            changed.append({"key": key, "label": new[key].get("label"), "changes": deltas})

    def section_of(definition):
        out = {}
        for section in definition.get("sections") or []:
            for field in section.get("fields") or []:
                if isinstance(field, dict) and field.get("key"):
                    out[str(field["key"])] = section.get("title")
        return out

    old_sections, new_sections = section_of(before), section_of(after)
    moved = [
        {"key": k, "label": new[k].get("label"),
         "from": old_sections.get(k), "to": new_sections.get(k)}
        for k in sorted(old_keys & new_keys)
        if old_sections.get(k) != new_sections.get(k)
    ]

    old_titles = [s.get("title") for s in before.get("sections") or []]
    new_titles = [s.get("title") for s in after.get("sections") or []]

    return {
        "added": added,
        "removed": removed,
        "changed": changed,
        "moved": moved,
        "sections": {"from": old_titles, "to": new_titles},
        "total": len(added) + len(removed) + len(changed) + len(moved),
    }


def summarize_diff(diff: dict[str, Any]) -> str:
    """One line for the history list, e.g. "2 added, 1 removed"."""
    parts = []
    for label, key in (("added", "added"), ("removed", "removed"),
                       ("changed", "changed"), ("moved", "moved")):
        count = len(diff.get(key) or [])
        if count:
            parts.append(f"{count} {label}")
    if diff.get("sections", {}).get("from") != diff.get("sections", {}).get("to"):
        parts.append("sections changed")
    return ", ".join(parts) or "no field changes"


# --------------------------------------------------------------------------- #
# The forms a fresh install starts with                                        #
# --------------------------------------------------------------------------- #
def _tag_options(game: GameDefinition) -> list[dict[str, Any]]:
    return [{"value": t.tag, "label": t.tag, "tone": t.tone} for t in game.tags]


def _endgame_options(game: GameDefinition) -> list[dict[str, Any]]:
    return [
        {"value": s.key, "label": s.label, "points": s.points} for s in game.endgame
    ]


def _rule_points(game: GameDefinition, rule_id: str) -> float | None:
    rule = next((r for r in game.rules if r.rule_id == rule_id), None)
    return rule.points if rule else None


def default_match_form(game: GameDefinition | None = None) -> dict[str, Any]:
    """A match form generated from a game definition.

    A starting point, not a fixed schema: an admin rebuilds it field by field
    in the builder. Generating it from the season's game means a freshly
    created season already asks questions that make sense for its game rather
    than for last year's.
    """
    game = game or bootstrap_2026()
    sections = [
        {
            "title": "Your robot",
            "hint": "The team number fills in from the schedule.",
            "fields": [
                {"key": "team_number", "type": "team", "label": "Team",
                 "maps_to": "team_number", "required": True},
                {"key": "no_show", "type": "toggle", "label": "Robot never showed up",
                 "maps_to": "no_show"},
            ],
        },
    ]

    # One repeatable action group per action the game defines. This is what
    # makes the generated form fit a stacking game as well as a shooting one:
    # the group's options are the game's own phases, pieces and locations.
    action_fields = []
    for action in game.actions:
        action_fields.append({
            "key": f"{action.key}_actions",
            "type": "actions",
            "label": action.label,
            "action": action.key,
            "hint": "Add one for each attempt.",
            "phases": action.phases or game.phase_keys,
            "objects": action.objects or [p.key for p in game.pieces],
            "locations": action.locations or [l.key for l in game.locations],
            "results": action.results or ["made", "missed"],
        })

    if game.field_map.image:
        action_fields.insert(0, {
            "key": "heatmap", "type": "heatmap", "label": "Scoring map",
            "maps_to": "heatmap",
        })

    if action_fields:
        sections.append({
            "title": "Score the match",
            "hint": "Record what the robot actually did.",
            "fields": action_fields,
        })

    if game.endgame:
        sections.append({
            "title": game.endgame_label,
            "fields": [
                {"key": "climb", "type": "select", "label": game.endgame_label,
                 "maps_to": "climb", "default": game.endgame_none,
                 "options": _endgame_options(game)},
            ],
        })

    sections.append({
        "title": "How did they look?",
        "hint": "Gut ratings. 3 is average.",
        "fields": [
            {"key": "driver_skill", "type": "rating", "label": "Driver skill",
             "maps_to": "driver_skill", "max": 5, "default": 3},
            {"key": "speed_rating", "type": "rating", "label": "Speed / cycling",
             "maps_to": "speed_rating", "max": 5, "default": 3},
            {"key": "played_defense", "type": "toggle", "label": "Played defense",
             "maps_to": "played_defense"},
            {"key": "defense_rating", "type": "rating", "label": "Defense quality",
             "maps_to": "defense_rating", "max": 5,
             "visible_if": {"field": "played_defense", "equals": True}},
            {"key": "successful_stops", "type": "counter", "label": "Successful stops",
             "maps_to": "successful_stops", "min": 0,
             "points": _rule_points(game, "stops"),
             "visible_if": {"field": "played_defense", "equals": True}},
            {"key": "defense_on", "type": "text", "label": "Who did they defend?",
             "maps_to": "defense_on",
             "visible_if": {"field": "played_defense", "equals": True}},
        ],
    })

    if game.tags:
        sections.append({
            "title": "Quick tags",
            "hint": "Tap anything you saw, these build the team's profile.",
            "fields": [
                {"key": "tags", "type": "tags", "label": "Quick tags",
                 "maps_to": "tags", "options": _tag_options(game)},
            ],
        })

    sections.append({
        "title": "Problems and notes",
        "hint": "Only if something happened.",
        "fields": [
            {"key": "fouls", "type": "counter", "label": "Fouls",
             "maps_to": "fouls", "min": 0, "points": _rule_points(game, "fouls")},
            {"key": "failure", "type": "toggle", "label": "Robot broke / died",
             "maps_to": "failure"},
            {"key": "failure_details", "type": "text", "label": "What failed?",
             "maps_to": "failure_details",
             "visible_if": {"field": "failure", "equals": True}},
            {"key": "notes", "type": "textarea", "label": "Comments?",
             "maps_to": "notes"},
        ],
    })

    return {
        "name": "Match Scouting",
        "description": f"What a scout fills in during a match of {game.name or 'this game'}.",
        "sections": sections,
    }


def default_pit_form(game: GameDefinition | None = None) -> dict[str, Any]:
    """The built-in pit form. Game agnostic by design: what you ask in a pit
    barely changes year to year."""
    return {
        "name": "Pit Scouting",
        "description": "One report per robot, filled in at their pit.",
        "sections": [
            {
                "title": "The robot",
                "fields": [
                    {"key": "team_number", "type": "team", "label": "Robot number",
                     "maps_to": "team_number", "required": True},
                    {"key": "weight_lbs", "type": "number", "label": "Robot weight",
                     "hint": "Pounds", "min": 0, "max": 200},
                    {"key": "archetype", "type": "text", "label": "Archetype",
                     "hint": "e.g. fast cycler, defense bot, climber"},
                    {"key": "drivetrain", "type": "text", "label": "Drivetrain",
                     "hint": "e.g. swerve, west coast"},
                ],
            },
            {
                "title": "Evidence",
                "fields": [
                    {"key": "robot_photo", "type": "photo", "label": "Photo of the robot"},
                    {"key": "notes", "type": "textarea", "label": "Other notes",
                     "hint": "Anything they told you."},
                ],
            },
        ],
    }


def field_type_catalogue() -> list[dict[str, Any]]:
    """What the builder offers in its "add a field" menu."""
    return [
        {
            "type": key,
            "label": meta["label"],
            "hint": meta["hint"],
            "needs_options": key in NEEDS_OPTIONS,
            "collects_answer": key not in DISPLAY_ONLY,
        }
        for key, meta in FIELD_TYPES.items()
    ]

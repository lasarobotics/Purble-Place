"""The January test.

The claim this file exists to check is the whole point of the platform:

    A completely different FRC game can be configured without changing any
    generic application code.

So it configures four games that share almost nothing with each other or with
2026, scores realistic submissions under each, and asserts the numbers. If any
of these ever needs a change to ``gamedef.py``, ``scoring.py`` or the form
engine to work, the abstraction has failed and the test is where that shows up.

The games are modelled on the shapes FRC has actually used: shooting,
placement onto a grid, stacking, and zone delivery. They are written here as
*data*, exactly as an admin would enter them in the season editor, and none of
them is referenced anywhere in the application.
"""
from __future__ import annotations

import pytest

from app.forms import default_match_form, validate_definition
from app.gamedef import (
    PER_EACH,
    PER_ONCE,
    ActionType,
    EndgameState,
    FieldMap,
    GameDefinition,
    GamePiece,
    Location,
    Phase,
    ScoringRule,
    Tag,
    score,
    validate,
)


# --------------------------------------------------------------------------- #
# Scenario A: a shooting game                                                  #
# --------------------------------------------------------------------------- #
def shooting_game() -> GameDefinition:
    return GameDefinition(
        name="Rapid Volley",
        year=2022,
        phases=[Phase("auto", "Auto", 0, 15), Phase("teleop", "Teleop", 1, 135)],
        pieces=[GamePiece("ball", "Ball")],
        locations=[Location("upper", "Upper hub"), Location("lower", "Lower hub")],
        actions=[
            ActionType("shoot", "Shot", ["auto", "teleop"], ["ball"],
                       ["upper", "lower"], ["made", "missed"]),
        ],
        rules=[
            ScoringRule("a_up", "Auto upper", 4, PER_EACH,
                        {"action": "shoot", "phase": "auto", "location": "upper", "result": "made"}),
            ScoringRule("a_low", "Auto lower", 2, PER_EACH,
                        {"action": "shoot", "phase": "auto", "location": "lower", "result": "made"}),
            ScoringRule("t_up", "Teleop upper", 2, PER_EACH,
                        {"action": "shoot", "phase": "teleop", "location": "upper", "result": "made"}),
            ScoringRule("t_low", "Teleop lower", 1, PER_EACH,
                        {"action": "shoot", "phase": "teleop", "location": "lower", "result": "made"}),
            ScoringRule("taxi", "Left the tarmac", 2, PER_ONCE, {"field": "taxi"}),
            ScoringRule("rung_high", "High rung", 10, PER_ONCE,
                        {"field": "endgame", "equals": "high"}),
        ],
        endgame_label="Rung climbed",
        endgame=[EndgameState("none", "None", 0), EndgameState("low", "Low", 4),
                 EndgameState("high", "High", 10)],
        field_map=FieldMap(image="seasons/2022/field.png", mode="point"),
    )


def test_a_shooting_game_scores_by_phase_and_target():
    game = shooting_game()
    assert validate(game) == []

    actions = (
        [{"action": "shoot", "phase": "auto", "location": "upper", "result": "made"}] * 2      # 8
        + [{"action": "shoot", "phase": "auto", "location": "lower", "result": "missed"}]      # 0
        + [{"action": "shoot", "phase": "teleop", "location": "upper", "result": "made"}] * 5  # 10
        + [{"action": "shoot", "phase": "teleop", "location": "lower", "result": "made"}] * 3  # 3
    )
    responses = {"taxi": True, "endgame": "high"}                                              # 2 + 10

    assert score(responses, actions, game) == 33.0


# --------------------------------------------------------------------------- #
# Scenario B: placement onto a grid                                            #
# --------------------------------------------------------------------------- #
def grid_game() -> GameDefinition:
    return GameDefinition(
        name="Charged Grid",
        year=2023,
        phases=[Phase("auto", "Auto", 0), Phase("teleop", "Teleop", 1)],
        pieces=[GamePiece("cone", "Cone"), GamePiece("cube", "Cube")],
        locations=[Location("high", "High row", group="grid"),
                   Location("mid", "Middle row", group="grid"),
                   Location("hybrid", "Hybrid row", group="grid")],
        actions=[
            ActionType("place", "Placement", ["auto", "teleop"], ["cone", "cube"],
                       ["high", "mid", "hybrid"], ["made", "dropped"]),
        ],
        rules=[
            # Same node is worth more in auto: two rules, one per phase.
            ScoringRule("a_high", "Auto high", 6, PER_EACH,
                        {"action": "place", "phase": "auto", "location": "high", "result": "made"}),
            ScoringRule("a_mid", "Auto mid", 4, PER_EACH,
                        {"action": "place", "phase": "auto", "location": "mid", "result": "made"}),
            ScoringRule("t_high", "Teleop high", 5, PER_EACH,
                        {"action": "place", "phase": "teleop", "location": "high", "result": "made"}),
            ScoringRule("t_mid", "Teleop mid", 3, PER_EACH,
                        {"action": "place", "phase": "teleop", "location": "mid", "result": "made"}),
            ScoringRule("t_low", "Teleop hybrid", 2, PER_EACH,
                        {"action": "place", "phase": "teleop", "location": "hybrid", "result": "made"}),
            ScoringRule("dock", "Docked", 6, PER_ONCE, {"field": "endgame", "equals": "docked"}),
            ScoringRule("engaged", "Engaged", 10, PER_ONCE,
                        {"field": "endgame", "equals": "engaged"}),
        ],
        endgame_label="Charge station",
        endgame=[EndgameState("none", "None", 0), EndgameState("docked", "Docked", 6),
                 EndgameState("engaged", "Engaged", 10)],
    )


def test_a_grid_game_scores_per_node_and_piece():
    game = grid_game()
    assert validate(game) == []

    actions = [
        {"action": "place", "phase": "auto", "object": "cone", "location": "high", "result": "made"},    # 6
        {"action": "place", "phase": "auto", "object": "cube", "location": "mid", "result": "made"},     # 4
        {"action": "place", "phase": "teleop", "object": "cone", "location": "high", "result": "made"},  # 5
        {"action": "place", "phase": "teleop", "object": "cone", "location": "high", "result": "made"},  # 5
        {"action": "place", "phase": "teleop", "object": "cube", "location": "hybrid", "result": "made"},# 2
        {"action": "place", "phase": "teleop", "object": "cone", "location": "mid", "result": "dropped"},# 0
    ]
    assert score({"endgame": "engaged"}, actions, game) == 32.0


def test_a_rule_can_single_out_one_game_piece():
    """A game where one piece is worth more than another needs no new
    machinery: the rule names the object."""
    game = grid_game()
    game.rules.append(
        ScoringRule("cube_bonus", "Cube bonus", 1, PER_EACH,
                    {"action": "place", "object": "cube", "result": "made"})
    )
    actions = [
        {"action": "place", "phase": "teleop", "object": "cube", "location": "hybrid", "result": "made"},
        {"action": "place", "phase": "teleop", "object": "cone", "location": "hybrid", "result": "made"},
    ]
    assert score({}, actions, game) == 5.0  # 2 + 2 hybrid, plus 1 cube bonus


# --------------------------------------------------------------------------- #
# Scenario C: stacking                                                         #
# --------------------------------------------------------------------------- #
def stacking_game() -> GameDefinition:
    """Height matters, and quantity per action matters, which is what the
    ``quantity`` field on an action record is for."""
    return GameDefinition(
        name="Recycle Stack",
        year=2015,
        phases=[Phase("auto", "Auto", 0), Phase("teleop", "Teleop", 1)],
        pieces=[GamePiece("tote", "Tote"), GamePiece("can", "Recycling can")],
        locations=[Location("platform", "Scoring platform"), Location("step", "Step")],
        actions=[
            ActionType("stack", "Stack", ["auto", "teleop"], ["tote"], ["platform"], ["made"]),
            ActionType("cap", "Cap with can", ["teleop"], ["can"], ["platform"], ["made"]),
            ActionType("drop", "Dropped", ["teleop"], ["tote", "can"], [], ["dropped"]),
        ],
        rules=[
            # 2 points per tote in the stack: quantity carries the height.
            ScoringRule("totes", "Tote stacked", 2, PER_EACH,
                        {"action": "stack", "location": "platform", "result": "made"}),
            ScoringRule("can", "Can on top", 4, PER_EACH,
                        {"action": "cap", "result": "made"}),
            ScoringRule("dropped", "Dropped a piece", -1, PER_EACH, {"action": "drop"}),
            ScoringRule("auto_set", "Auto stack set", 20, PER_ONCE,
                        {"action": "stack", "phase": "auto"}),
        ],
        endgame_label="Endgame",
        endgame=[EndgameState("none", "None", 0)],
    )


def test_a_stacking_game_uses_quantity_for_height():
    game = stacking_game()
    assert validate(game) == []

    actions = [
        {"action": "stack", "phase": "auto", "location": "platform", "result": "made", "quantity": 3},
        {"action": "stack", "phase": "teleop", "location": "platform", "result": "made", "quantity": 6},
        {"action": "cap", "phase": "teleop", "result": "made"},
        {"action": "drop", "phase": "teleop"},
        {"action": "drop", "phase": "teleop"},
    ]
    # totes 2*(3+6)=18, can +4, drops -2, auto set +20 (once)
    assert score({}, actions, game) == 40.0


def test_a_game_with_no_endgame_at_all_is_fine():
    """Not every FRC game has ended in a climb, and the platform must not
    assume one."""
    game = stacking_game()
    game.endgame = []
    assert validate(game) == []
    assert game.endgame_none == "none"
    assert score({}, [{"action": "cap", "result": "made"}], game) == 4.0


# --------------------------------------------------------------------------- #
# Scenario D: zone delivery                                                    #
# --------------------------------------------------------------------------- #
def delivery_game() -> GameDefinition:
    return GameDefinition(
        name="Depot Run",
        year=2019,
        phases=[Phase("sandstorm", "Sandstorm", 0), Phase("teleop", "Teleop", 1)],
        pieces=[GamePiece("hatch", "Hatch"), GamePiece("cargo", "Cargo")],
        locations=[Location("rocket", "Rocket"), Location("ship", "Cargo ship"),
                   Location("depot", "Depot")],
        actions=[
            ActionType("deliver", "Delivery", ["sandstorm", "teleop"],
                       ["hatch", "cargo"], ["rocket", "ship"], ["made", "missed"]),
            ActionType("defend", "Defensive action", ["teleop"], [], [], ["made"]),
        ],
        rules=[
            ScoringRule("hatch", "Hatch delivered", 2, PER_EACH,
                        {"action": "deliver", "object": "hatch", "result": "made"}),
            ScoringRule("cargo", "Cargo delivered", 3, PER_EACH,
                        {"action": "deliver", "object": "cargo", "result": "made"}),
            ScoringRule("rocket_bonus", "Rocket bonus", 1, PER_EACH,
                        {"action": "deliver", "location": "rocket", "result": "made"}),
            ScoringRule("defense", "Defensive stop", 1, PER_EACH, {"action": "defend"}),
        ],
        endgame_label="HAB level",
        endgame=[EndgameState("none", "None", 0), EndgameState("l1", "Level 1", 3),
                 EndgameState("l2", "Level 2", 6)],
    )


def test_a_delivery_game_stacks_object_and_location_bonuses():
    game = delivery_game()
    assert validate(game) == []

    actions = [
        {"action": "deliver", "phase": "sandstorm", "object": "hatch", "location": "rocket", "result": "made"},
        {"action": "deliver", "phase": "teleop", "object": "cargo", "location": "rocket", "result": "made"},
        {"action": "deliver", "phase": "teleop", "object": "cargo", "location": "ship", "result": "made"},
        {"action": "defend", "phase": "teleop"},
    ]
    # hatch 2 (+1 rocket), cargo 3 (+1 rocket), cargo 3, defend 1
    assert score({}, actions, game) == 11.0


# --------------------------------------------------------------------------- #
# A deliberately strange future game                                           #
# --------------------------------------------------------------------------- #
def future_2027() -> GameDefinition:
    """Everything the brief asked for in a hypothetical 2027 game.

    Three game pieces, four zones, no climbing, two autonomous phases, a timed
    bonus period, several endgame states, defensive actions, and repeatable
    scoring. None of that is a feature of HazeHub; all of it is configuration.
    """
    return GameDefinition(
        name="Test Game 2027",
        year=2027,
        phases=[
            Phase("auto_a", "Auto: approach", 0, 8),
            Phase("auto_b", "Auto: build", 1, 12),
            Phase("teleop", "Teleop", 2, 120),
            Phase("frenzy", "Frenzy", 3, 20),
        ],
        pieces=[GamePiece("orb", "Orb"), GamePiece("rod", "Rod"), GamePiece("core", "Core")],
        locations=[
            Location("z1", "Zone 1", group="zones", x=0.2, y=0.3),
            Location("z2", "Zone 2", group="zones", x=0.4, y=0.3),
            Location("z3", "Zone 3", group="zones", x=0.6, y=0.3),
            Location("z4", "Zone 4", group="zones", x=0.8, y=0.3),
        ],
        actions=[
            ActionType("deposit", "Deposit", ["auto_a", "auto_b", "teleop", "frenzy"],
                       ["orb", "rod", "core"], ["z1", "z2", "z3", "z4"], ["made", "missed"]),
            ActionType("disrupt", "Disrupt", ["teleop", "frenzy"], [], [], ["made"]),
        ],
        rules=[
            ScoringRule("orb", "Orb deposited", 2, PER_EACH,
                        {"action": "deposit", "object": "orb", "result": "made"}),
            ScoringRule("rod", "Rod deposited", 3, PER_EACH,
                        {"action": "deposit", "object": "rod", "result": "made"}),
            ScoringRule("core", "Core deposited", 8, PER_EACH,
                        {"action": "deposit", "object": "core", "result": "made"}),
            ScoringRule("far_zone", "Far zone bonus", 2, PER_EACH,
                        {"action": "deposit", "location": "z4", "result": "made"}),
            # The timed bonus is simply a phase with its own rule.
            ScoringRule("frenzy", "Frenzy bonus", 3, PER_EACH,
                        {"action": "deposit", "phase": "frenzy", "result": "made"}),
            ScoringRule("auto_a", "Scored in first auto", 5, PER_ONCE,
                        {"action": "deposit", "phase": "auto_a", "result": "made"}),
            ScoringRule("disrupt", "Disruption", 1, PER_EACH, {"action": "disrupt"}),
            ScoringRule("state_locked", "Locked in", 12, PER_ONCE,
                        {"field": "final_state", "equals": "locked"}),
            ScoringRule("penalty", "Penalty", -4, PER_EACH, {"field": "penalties"}),
        ],
        endgame_label="Final state",
        endgame=[
            EndgameState("none", "Nothing", 0),
            EndgameState("parked", "Parked", 4),
            EndgameState("locked", "Locked in", 12),
            EndgameState("overcharged", "Overcharged", 18),
        ],
        tags=[Tag("Fast", "good"), Tag("Fragile", "bad")],
        field_map=FieldMap(image="seasons/2027/field.png", mode="zone",
                           zones=[{"location": "z1", "x": 0.1, "y": 0.2, "w": 0.2, "h": 0.2}]),
    )


def test_a_deliberately_different_future_game_needs_no_code():
    game = future_2027()
    assert validate(game) == []

    actions = [
        {"action": "deposit", "phase": "auto_a", "object": "orb", "location": "z1", "result": "made"},
        {"action": "deposit", "phase": "auto_b", "object": "rod", "location": "z2", "result": "made"},
        {"action": "deposit", "phase": "teleop", "object": "core", "location": "z4", "result": "made"},
        {"action": "deposit", "phase": "frenzy", "object": "orb", "location": "z4", "result": "made"},
        {"action": "deposit", "phase": "teleop", "object": "orb", "location": "z3", "result": "missed"},
        {"action": "disrupt", "phase": "teleop"},
        {"action": "disrupt", "phase": "frenzy"},
    ]
    responses = {"final_state": "locked", "penalties": 1}

    # orbs 2+2=4, rod 3, core 8, z4 bonus 2+2=4, frenzy 3, first auto 5,
    # disrupts 2, locked 12, penalty -4
    assert score(responses, actions, game) == 37.0


def test_four_phases_are_not_a_problem():
    game = future_2027()
    assert game.phase_keys == ["auto_a", "auto_b", "teleop", "frenzy"]


def test_a_form_generated_for_the_future_game_is_valid_and_game_shaped():
    """The generated starting form has to ask about *this* game, not 2026's."""
    game = future_2027()
    form = default_match_form(game)

    assert validate_definition(form) == []

    fields = [f for s in form["sections"] for f in s["fields"]]
    by_key = {f["key"]: f for f in fields}

    # A repeatable group per action the game defines.
    assert "deposit_actions" in by_key
    assert "disrupt_actions" in by_key
    deposit = by_key["deposit_actions"]
    assert deposit["type"] == "actions"
    assert deposit["phases"] == ["auto_a", "auto_b", "teleop", "frenzy"]
    assert deposit["objects"] == ["orb", "rod", "core"]
    assert deposit["locations"] == ["z1", "z2", "z3", "z4"]

    # The endgame control offers this game's states, not last year's.
    endgame = by_key["climb"]
    assert [o["value"] for o in endgame["options"]] == [
        "none", "parked", "locked", "overcharged"
    ]

    # And none of 2026's vocabulary has leaked in.
    assert "l3" not in str(form)


def test_a_game_with_no_field_map_generates_a_form_without_one():
    game = future_2027()
    game.field_map = FieldMap()
    form = default_match_form(game)
    assert "heatmap" not in [f["key"] for s in form["sections"] for f in s["fields"]]


# --------------------------------------------------------------------------- #
# Validation of a game definition                                              #
# --------------------------------------------------------------------------- #
def test_a_rule_pointing_at_a_missing_action_is_caught():
    game = future_2027()
    game.rules.append(ScoringRule("ghost", "Ghost", 1, PER_EACH, {"action": "teleport"}))
    assert any("teleport" in p for p in validate(game))


def test_an_action_using_an_unknown_phase_is_caught():
    game = future_2027()
    game.actions.append(ActionType("x", "X", ["endgame"], [], [], []))
    assert any("endgame" in p for p in validate(game))


def test_duplicate_keys_are_caught():
    game = future_2027()
    game.pieces.append(GamePiece("orb", "Orb again"))
    assert any("orb" in p for p in validate(game))


def test_a_rule_that_matches_nothing_is_caught():
    game = future_2027()
    game.rules.append(ScoringRule("empty", "Empty", 5, PER_EACH, {}))
    assert any("matches nothing" in p for p in validate(game))


def test_a_definition_round_trips_through_its_document_shape():
    game = future_2027()
    back = GameDefinition.from_dict(game.to_dict())

    assert back.name == game.name
    assert back.phase_keys == game.phase_keys
    assert [r.rule_id for r in back.rules] == [r.rule_id for r in game.rules]
    assert back.field_map.mode == "zone"
    assert back.location("z4").label == "Zone 4"


@pytest.mark.parametrize("builder", [shooting_game, grid_game, stacking_game, delivery_game, future_2027])
def test_every_scenario_survives_serialisation(builder):
    """A definition is stored as a document, so it has to come back identical."""
    game = builder()
    assert GameDefinition.from_dict(game.to_dict()).to_dict() == game.to_dict()

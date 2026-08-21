"""The game definition. This is the file you edit in January.

FRC changes the game every year, so every year the scouting form has to change
with it: what a scoring action is worth, what the endgame is called, how many
levels it has, which qualitative tags are worth tapping. Those facts used to be
spread across the scoring module, the scouting page, the analytics and the
insight rules, which meant a new season was a hunt through the codebase.

They all live here now, in one ``GAME`` object, and everything else reads from
it. The frontend reads the same definition over ``GET /api/game``, so changing a
climb level or a tag here changes the buttons the scouts actually tap without
touching any TypeScript.

--------------------------------------------------------------------------
Rolling over to a new season
--------------------------------------------------------------------------
1. Copy the ``GAME_2026`` block below, rename it for the new year, and edit
   the values: ``season``, ``name``, the scoring numbers, ``endgame``, and
   ``tags``.
2. Point ``GAME`` at the new block (or set ``HAZEHUB_SEASON`` and add the
   block to ``GAMES``).
3. Drop the new field image at ``frontend/public/field.png`` and
   ``backend/app/static_field/field.png``.

Nothing else needs to change. Scores recompute from the new values, the
scouting form renders the new endgame and tags, and last season's data stays
readable because every stored entry keeps the season it was collected under.
"""
from __future__ import annotations

import os
from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(frozen=True)
class EndgameLevel:
    """One option in the endgame control, worth ``points`` if achieved."""

    key: str
    label: str
    points: float


@dataclass(frozen=True)
class Tag:
    """A one-tap qualitative observation.

    ``tone`` is "good" or "bad" and decides how the chip reads and how the
    tag counts toward a team's profile.
    """

    tag: str
    tone: str


@dataclass(frozen=True)
class Game:
    """Everything about a season that the rest of the app should not hardcode."""

    season: int
    name: str

    # --- scoring ---------------------------------------------------------- #
    #: Points for a made scoring attempt, by match phase.
    auto_made: float
    teleop_made: float
    #: Bonus for leaving the starting zone during autonomous.
    auto_leave: float
    #: Bonus for completing the endgame action during autonomous.
    auto_endgame_bonus: float
    #: Credited to a defender for each successful stop they are given.
    stop_bonus: float
    #: Subtracted per foul charged against the robot.
    foul_penalty: float

    #: What the endgame is called this year, and its levels. The first entry
    #: must be the "did not do it" option.
    endgame_label: str
    endgame: list[EndgameLevel]

    #: What a scoring attempt is called, for the field map labels.
    scoring_noun: str

    #: The qualitative tags offered on the scouting form.
    tags: list[Tag]

    #: Match phases in the order they happen. Changing these is rare, but a
    #: game with a distinct third period would add one here.
    phases: tuple[str, ...] = ("auto", "teleop")

    # --- derived ---------------------------------------------------------- #
    @property
    def endgame_points(self) -> dict[str, float]:
        return {level.key: level.points for level in self.endgame}

    @property
    def endgame_none(self) -> str:
        """The key meaning "did not do the endgame action"."""
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

    def to_dict(self) -> dict[str, Any]:
        """The shape ``GET /api/game`` returns, for the scouting form."""
        data = asdict(self)
        data["endgame_none"] = self.endgame_none
        data["phases"] = list(self.phases)
        return data


# --------------------------------------------------------------------------- #
# 2026                                                                         #
# --------------------------------------------------------------------------- #
GAME_2026 = Game(
    season=2026,
    name="Rebuilt",
    auto_made=4.0,
    teleop_made=2.5,
    auto_leave=3.0,
    auto_endgame_bonus=4.0,
    stop_bonus=1.5,
    foul_penalty=2.0,
    endgame_label="Endgame climb",
    endgame=[
        EndgameLevel("none", "No climb", 0.0),
        EndgameLevel("l1", "L1", 3.0),
        EndgameLevel("l2", "L2", 6.0),
        EndgameLevel("l3", "L3", 12.0),
    ],
    scoring_noun="attempt",
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
)


#: Every season this build knows about. Add the new one here each January.
GAMES: dict[int, Game] = {
    2026: GAME_2026,
}

#: The season in play. ``HAZEHUB_SEASON`` selects a different one without a
#: code change, which is what makes a mid-season rollback or a replay of last
#: year's event possible.
_requested = int(os.getenv("HAZEHUB_SEASON", "2026"))
GAME: Game = GAMES.get(_requested, GAME_2026)


def game_for(season: int | None = None) -> Game:
    """The definition for a season, falling back to the one in play.

    Analytics over an archived event should read the game it was played
    under, not this year's, or a rule change would silently rewrite history.
    """
    if season is None:
        return GAME
    return GAMES.get(int(season), GAME)

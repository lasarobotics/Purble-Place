"""Seasons: the boundary that keeps last year's data meaning what it meant.

The guarantee being protected here is narrow and absolute: **a change to a
game definition must never reach backwards**. Everything else in this file is
in service of that. If scoring rules could be edited in place, or a submission
did not record the version it was collected under, then fixing a rule in March
would silently rewrite January's rankings and nobody would notice until a
picklist meeting went wrong.

The second guarantee is that creating next year cannot damage this year.
"""
from __future__ import annotations

import pytest

from app import seasons as seasons_mod
from app.gamedef import (
    PER_EACH,
    PER_ONCE,
    ActionType,
    EndgameState,
    GameDefinition,
    GamePiece,
    Location,
    Phase,
    ScoringRule,
)
from app.models import (
    SEASON_ACTIVE,
    SEASON_ARCHIVED,
    SEASON_SETUP,
    Scouter,
    Season,
    SeasonRevision,
)


def simple_game(name="Test Game", year=2026, points=5.0) -> GameDefinition:
    return GameDefinition(
        name=name,
        year=year,
        phases=[Phase("teleop", "Teleop", 0)],
        pieces=[GamePiece("piece", "Piece")],
        locations=[Location("goal", "Goal")],
        actions=[ActionType("score", "Score", ["teleop"], ["piece"], ["goal"], ["made"])],
        rules=[
            ScoringRule("scored", "Scored", points, PER_EACH,
                        {"action": "score", "result": "made"}),
            ScoringRule("fouls", "Foul", -2.0, PER_EACH, {"field": "fouls"}),
        ],
        endgame=[EndgameState("none", "None", 0.0)],
    )


# --------------------------------------------------------------------------- #
# A fake datastore, so these run without one                                   #
# --------------------------------------------------------------------------- #
class _Store:
    def __init__(self):
        self.seasons: dict[str, Season] = {}
        self.revisions: dict[tuple[str, int], SeasonRevision] = {}
        self.settings: dict[str, str] = {}
        self.forms: list = []

    def install(self, monkeypatch):
        r = seasons_mod.repo
        monkeypatch.setattr(r, "season", lambda sid: self.seasons.get(sid))
        monkeypatch.setattr(r, "save_season", lambda s: self.seasons.__setitem__(s.season_id, s))
        monkeypatch.setattr(
            r, "seasons",
            lambda: sorted(self.seasons.values(), key=lambda s: s.year, reverse=True),
        )
        monkeypatch.setattr(
            r, "season_revision", lambda sid, v: self.revisions.get((sid, int(v)))
        )
        monkeypatch.setattr(
            r, "save_season_revision",
            lambda rev: self.revisions.__setitem__((rev.season_id, rev.version), rev),
        )
        monkeypatch.setattr(
            r, "season_revisions",
            lambda sid, limit=100: sorted(
                [x for (s, _), x in self.revisions.items() if s == sid],
                key=lambda x: x.version, reverse=True,
            )[:limit],
        )
        monkeypatch.setattr(r, "setting", lambda k: self.settings.get(k, ""))
        monkeypatch.setattr(r, "set_setting", lambda k, v: self.settings.__setitem__(k, v))
        monkeypatch.setattr(r, "forms", lambda **kw: list(self.forms))
        return seasons_mod


@pytest.fixture
def store(monkeypatch):
    backing = _Store()
    module = backing.install(monkeypatch)
    return module, backing


@pytest.fixture
def author():
    return Scouter(scout_id="Strategy", display_name="Strategy")


# --------------------------------------------------------------------------- #
# Creating                                                                     #
# --------------------------------------------------------------------------- #
def test_creating_a_season_writes_a_first_revision(store, author):
    module, backing = store
    module.create("2026", 2026, author, game=simple_game())

    season = backing.seasons["2026"]
    assert season.game_version == 1
    assert season.status == SEASON_SETUP
    assert backing.revisions[("2026", 1)].message == "New season"
    assert backing.revisions[("2026", 1)].author_name == "Strategy"


@pytest.mark.parametrize("season_id", ["", "  ", "2026 season", "2026/spring", "!!", "A" * 40])
def test_bad_season_ids_are_refused(store, author, season_id):
    module, _ = store
    with pytest.raises(module.SeasonInvalid):
        module.create(season_id, 2026, author, game=simple_game())


def test_a_duplicate_season_is_refused(store, author):
    module, _ = store
    module.create("2026", 2026, author, game=simple_game())
    with pytest.raises(module.SeasonInvalid):
        module.create("2026", 2026, author, game=simple_game())


def test_an_invalid_game_never_creates_a_season(store, author):
    module, backing = store
    broken = simple_game()
    broken.rules.append(ScoringRule("ghost", "Ghost", 1, PER_EACH, {"action": "nope"}))
    with pytest.raises(module.SeasonInvalid):
        module.create("2026", 2026, author, game=broken)
    assert "2026" not in backing.seasons


# --------------------------------------------------------------------------- #
# The January rollover                                                         #
# --------------------------------------------------------------------------- #
def test_duplicating_copies_the_game_and_leaves_the_original_alone(store, author):
    module, backing = store
    module.create("2026", 2026, author, game=simple_game(name="Rebuilt", points=5))
    module.set_status("2026", SEASON_ACTIVE, author)

    module.create("2027", 2027, author, copy_from="2026", copy_forms=False)


    new = backing.seasons["2027"]
    old = backing.seasons["2026"]

    assert new.copied_from == "2026"
    assert new.year == 2027
    assert module.definition("2027").name == "Rebuilt"
    # The copy starts its own history rather than sharing one.
    assert new.game_version == 1
    # And the season it came from is untouched.
    assert old.year == 2026
    assert old.game_version == 1


def test_editing_a_new_season_does_not_touch_the_old_one(store, author):
    module, backing = store
    module.create("2026", 2026, author, game=simple_game(points=5))
    module.create("2027", 2027, author, copy_from="2026", copy_forms=False)

    changed = module.definition("2027")
    changed.name = "Something Else"
    for rule in changed.rules:
        if rule.rule_id == "scored":
            rule.points = 99.0
    module.save_definition("2027", changed, author, "Different game")

    assert module.definition("2026").name == "Test Game", "the old season keeps its own game"
    scored_2026 = next(r for r in module.definition("2026").rules if r.rule_id == "scored")
    scored_2027 = next(r for r in module.definition("2027").rules if r.rule_id == "scored")
    assert scored_2026.points == 5.0
    assert scored_2027.points == 99.0


def test_only_one_season_is_active_at_a_time(store, author):
    """Configuring next year's game into this year's live event is exactly the
    accident seasons exist to prevent."""
    module, backing = store
    module.create("2026", 2026, author, game=simple_game())
    module.create("2027", 2027, author, game=simple_game(year=2027))

    module.set_status("2026", SEASON_ACTIVE, author)
    assert backing.settings[module.CURRENT_SEASON_SETTING] == "2026"

    module.set_status("2027", SEASON_ACTIVE, author)
    assert backing.seasons["2026"].status == SEASON_ARCHIVED
    assert backing.seasons["2027"].status == SEASON_ACTIVE
    assert backing.settings[module.CURRENT_SEASON_SETTING] == "2027"


def test_an_unknown_status_is_refused(store, author):
    module, _ = store
    module.create("2026", 2026, author, game=simple_game())
    with pytest.raises(module.SeasonInvalid):
        module.set_status("2026", "retired", author)


# --------------------------------------------------------------------------- #
# Versioning: the guarantee                                                    #
# --------------------------------------------------------------------------- #
def test_a_scoring_change_never_reaches_backwards(store, author):
    """The single most important property in the codebase.

    A report collected in January must score in June exactly what it scored in
    January, whatever the rules say by then.
    """
    from app.gamedef import score

    module, _ = store
    module.create("2026", 2026, author, game=simple_game(points=5))

    v1 = module.definition_at("2026", 1)
    actions = [{"action": "score", "result": "made"}] * 3
    january = score({}, actions, v1)
    assert january == 15.0

    # March: somebody doubles what a score is worth.
    updated = module.definition("2026")
    next(r for r in updated.rules if r.rule_id == "scored").points = 10.0
    module.save_definition("2026", updated, author, "Doubled scoring")

    # The January report is pinned to v1 and does not move.
    assert score({}, actions, module.definition_at("2026", 1)) == january
    # A report collected now picks up the new rules.
    assert score({}, actions, module.definition_at("2026", 2)) == 30.0


def test_saving_never_edits_a_revision_in_place(store, author):
    module, backing = store
    module.create("2026", 2026, author, game=simple_game(points=5))
    updated = module.definition("2026")
    next(r for r in updated.rules if r.rule_id == "scored").points = 7.0
    module.save_definition("2026", updated, author, "Tweak")

    first = backing.revisions[("2026", 1)]
    assert next(r for r in first.definition["rules"] if r["rule_id"] == "scored")["points"] == 5.0
    assert backing.seasons["2026"].game_version == 2


def test_every_revision_records_who_and_why(store, author):
    module, backing = store
    module.create("2026", 2026, author, game=simple_game())
    module.save_definition("2026", module.definition("2026"), author, "Because")

    row = backing.revisions[("2026", 2)]
    assert row.author_id == "Strategy"
    assert row.message == "Because"
    assert row.parent_version == 1


def test_reverting_moves_forward_and_keeps_everything(store, author):
    module, backing = store
    module.create("2026", 2026, author, game=simple_game(points=5))

    experiment = module.definition("2026")
    next(r for r in experiment.rules if r.rule_id == "scored").points = 50.0
    module.save_definition("2026", experiment, author, "Try 50")

    reverted = module.revert("2026", 1, author)

    assert reverted.version == 3
    assert reverted.reverted_from == 1
    assert ("2026", 2) in backing.revisions, "the version being undone survives"
    scored = next(r for r in module.definition("2026").rules if r.rule_id == "scored")
    assert scored.points == 5.0


def test_a_concurrent_edit_is_refused(store, author):
    module, _ = store
    module.create("2026", 2026, author, game=simple_game())
    module.save_definition("2026", module.definition("2026"), author, "Theirs")

    with pytest.raises(module.SeasonInvalid) as caught:
        module.save_definition(
            "2026", module.definition("2026"), author, "Mine", expected_version=1
        )
    assert "version 2" in str(caught.value)


def test_an_invalid_definition_never_reaches_the_history(store, author):
    module, backing = store
    module.create("2026", 2026, author, game=simple_game())
    broken = module.definition("2026")
    broken.phases = []

    with pytest.raises(module.SeasonInvalid):
        module.save_definition("2026", broken, author, "Break it")
    assert backing.seasons["2026"].game_version == 1


def test_history_marks_the_current_version(store, author):
    module, _ = store
    module.create("2026", 2026, author, game=simple_game())
    module.save_definition("2026", module.definition("2026"), author, "Second")

    rows = module.history("2026")
    assert [r["version"] for r in rows] == [2, 1]
    assert rows[0]["current"] and not rows[1]["current"]


def test_definition_at_an_unknown_version_falls_back_rather_than_raising(store, author):
    """A submission from before the season model has version 0. It should read
    as today's game rather than crash a ranking page."""
    module, _ = store
    module.create("2026", 2026, author, game=simple_game())
    assert module.definition_at("2026", 0).name == "Test Game"
    assert module.definition_at("2026", 99).name == "Test Game"


# --------------------------------------------------------------------------- #
# Pointer and checklist                                                        #
# --------------------------------------------------------------------------- #
def test_the_current_season_falls_back_to_the_active_one(store, author):
    module, backing = store
    module.create("2026", 2026, author, game=simple_game())
    module.set_status("2026", SEASON_ACTIVE, author)
    backing.settings.pop(module.CURRENT_SEASON_SETTING, None)
    assert module.current_season_id() == "2026"


def test_a_pointer_at_a_deleted_season_is_ignored(store, author):
    module, backing = store
    module.create("2026", 2026, author, game=simple_game())
    backing.settings[module.CURRENT_SEASON_SETTING] = "1999"
    assert module.current_season_id() == "2026"


def test_the_checklist_reads_the_definition_rather_than_a_flag(store, author):
    """A checklist tracked as flags can disagree with the thing it describes."""
    module, _ = store
    module.create("2026", 2026, author, game=simple_game())
    done = {i["key"]: i["done"] for i in module.checklist("2026")}

    assert done["game"] and done["phases"] and done["scoring"]
    assert not done["published"], "not active yet"
    assert not done["field"], "no field image configured"


def test_the_checklist_notices_when_scoring_is_missing(store, author):
    module, _ = store
    game = simple_game()
    game.rules = []
    module.create("2026", 2026, author, game=game)
    done = {i["key"]: i["done"] for i in module.checklist("2026")}
    assert not done["scoring"]


# --------------------------------------------------------------------------- #
# Diffing                                                                      #
# --------------------------------------------------------------------------- #
def test_diff_reports_what_changed_per_group(store, author):
    module, _ = store
    before = simple_game(points=5).to_dict()
    after = simple_game(points=9)
    after.pieces.append(GamePiece("extra", "Extra"))
    after = after.to_dict()

    diff = module.diff_definitions(before, after)
    assert diff["groups"]["rules"]["changed"] == ["scored"]
    assert diff["groups"]["pieces"]["added"] == ["extra"]
    assert diff["total"] == 2
    assert "rules" in module.summarize(diff)


def test_reordering_rules_is_not_reported_as_a_change(store, author):
    module, _ = store
    game = simple_game()
    before = game.to_dict()
    game.rules.reverse()
    assert module.diff_definitions(before, game.to_dict())["total"] == 0


def test_an_identical_definition_summarises_as_no_change(store, author):
    module, _ = store
    game = simple_game().to_dict()
    assert module.summarize(module.diff_definitions(game, game)) == "no changes"

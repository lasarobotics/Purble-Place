"""The season definition, the event archive, and the event pointer.

All three exist so that one thing does not silently break another:

* Scoring values live in one file so a new game is one edit, not a hunt.
* An event that ends still has to be readable next season.
* The current event pointer decides what every screen shows, so a stale one
  makes a working install look completely empty.
"""
from __future__ import annotations

import pytest

from app import game as game_mod
from app.game import GAME, Game, EndgameLevel, Tag, game_for
from app.models import EventArchive
from app.scoring import attempt_value, compute_points


# --------------------------------------------------------------------------- #
# The season definition                                                        #
# --------------------------------------------------------------------------- #
def test_scoring_reads_every_value_from_the_game():
    """A whole invented season should score correctly with no code change.

    This is the actual promise of app/game.py: next January is an edit to that
    file. If scoring ever hardcodes a number again, this fails.
    """
    invented = Game(
        season=2099,
        name="Test Game",
        auto_made=10.0,
        teleop_made=1.0,
        auto_leave=7.0,
        auto_endgame_bonus=5.0,
        stop_bonus=2.0,
        foul_penalty=3.0,
        endgame_label="Docking",
        endgame=[
            EndgameLevel("none", "Not docked", 0.0),
            EndgameLevel("docked", "Docked", 20.0),
        ],
        scoring_noun="cube",
        tags=[Tag("Fast", "good"), Tag("Broke", "bad")],
    )
    game_mod.GAMES[2099] = invented
    try:
        entry = {
            "heatmap": [
                {"phase": "auto", "result": "made"},      # 10
                {"phase": "teleop", "result": "made"},    # 1
                {"phase": "teleop", "result": "missed"},  # 0
            ],
            "auto_leave": True,        # 7
            "auto_climb": True,        # 5
            "climb": "docked",         # 20
            "successful_stops": 2,     # 4
            "fouls": 1,                # -3
        }
        assert compute_points(entry, season=2099) == 44.0
    finally:
        game_mod.GAMES.pop(2099, None)


def test_an_explicit_attempt_value_wins():
    # A game with several scoring heights records the real number per tap,
    # and the game file does not need to know the field layout.
    assert attempt_value({"phase": "teleop", "result": "made", "value": 9}) == 9.0
    assert attempt_value({"phase": "teleop", "result": "missed", "value": 9}) == 0.0


def test_unknown_endgame_level_scores_nothing_rather_than_raising():
    # Data collected under last year's game must not crash this year's scoring.
    assert compute_points({"climb": "traversal"}) == 0.0


def test_game_for_falls_back_to_the_season_in_play():
    assert game_for(None) is GAME
    assert game_for(1999) is GAME


def test_endgame_none_is_the_first_level():
    assert GAME.endgame_none == GAME.endgame[0].key


def test_tags_split_by_tone():
    assert set(GAME.positive_tags) | set(GAME.negative_tags) == set(GAME.tag_names)
    assert not set(GAME.positive_tags) & set(GAME.negative_tags)


def test_the_api_shape_carries_what_the_form_needs_to_render():
    data = GAME.to_dict()
    for key in ("season", "endgame", "endgame_none", "endgame_label", "tags", "phases"):
        assert key in data, key
    assert data["endgame"][0]["key"] == data["endgame_none"]


# --------------------------------------------------------------------------- #
# Archives                                                                     #
# --------------------------------------------------------------------------- #
def test_archive_round_trips_through_the_document_shape():
    row = EventArchive(
        event_key="2026haze",
        name="Haze Regional",
        season=2026,
        game_name="Rebuilt",
        counts={"teams": 2, "scouting_entries": 40},
        teams={"418": {"team": 418, "avg_points": 51.5}},
        pit=[{"team_number": 418, "archetype": "fast cycler"}],
        picklists=[{"owner_id": "final-418", "pick_round": 1, "items": [{"team": 254}]}],
    )
    doc = row.to_doc()
    back = EventArchive.from_doc("2026haze", doc)

    assert back.event_key == "2026haze"
    assert back.teams["418"]["avg_points"] == 51.5
    assert back.counts["scouting_entries"] == 40
    assert back.pit[0]["archetype"] == "fast cycler"
    assert back.picklists[0]["items"] == [{"team": 254}]


def test_archive_skips_an_event_with_no_scouting(monkeypatch):
    # A mistyped event key should not leave a document behind.
    from app import archive as archive_mod

    monkeypatch.setattr(archive_mod.repo, "scouting_for_event", lambda _k: [])
    assert archive_mod.archive_if_worthwhile("2026typo") is None
    assert archive_mod.archive_if_worthwhile("") is None


def test_archive_failure_never_blocks_an_event_change(monkeypatch):
    """An admin switching events at a competition must not be stopped by this.

    The submissions are in the datastore either way; the archive is a
    convenience on top of them.
    """
    from app import archive as archive_mod

    monkeypatch.setattr(archive_mod.repo, "scouting_for_event", lambda _k: [object()])

    def boom(_key):
        raise RuntimeError("datastore is having a day")

    monkeypatch.setattr(archive_mod, "archive_event", boom)
    assert archive_mod.archive_if_worthwhile("2026haze") is None


def test_archive_drops_the_bulky_fields(monkeypatch):
    """A champs-sized event still has to fit in one Firestore document."""
    from app import archive as archive_mod

    monkeypatch.setattr(archive_mod, "event_teams", lambda _k: [418])
    monkeypatch.setattr(
        archive_mod,
        "team_summary",
        lambda _k, _t: {
            "team": 418,
            "avg_points": 50.0,
            "avatar": "data:image/png;base64," + "A" * 5000,
            "match_points": [{"match": i, "points": i} for i in range(60)],
        },
    )
    monkeypatch.setattr(archive_mod.repo, "scouting_for_event", lambda _k: [])
    monkeypatch.setattr(archive_mod.repo, "matches_for_event", lambda _k: [])
    monkeypatch.setattr(archive_mod.repo, "pits_for_event", lambda _k: [])
    monkeypatch.setattr(archive_mod.repo, "picklists", lambda _k: [])
    monkeypatch.setattr(archive_mod.repo, "event", lambda _k: None)

    built = archive_mod.build_archive("2026haze")
    summary = built.teams["418"]
    assert "avatar" not in summary
    assert "match_points" not in summary
    assert summary["avg_points"] == 50.0


def test_archiving_requires_an_event_key():
    from app import archive as archive_mod

    with pytest.raises(ValueError):
        archive_mod.build_archive("   ")


# --------------------------------------------------------------------------- #
# The current event pointer                                                    #
# --------------------------------------------------------------------------- #
class _Event:
    def __init__(self, key, start_date=None):
        self.event_key = key
        self.start_date = start_date
        self.name = key


def _wire(monkeypatch, *, current, events, schedules):
    """Stand repo up against fake events without touching a datastore."""
    from app import repo as repo_mod

    written = {}
    monkeypatch.setattr(repo_mod, "current_event", lambda: current)
    monkeypatch.setattr(repo_mod, "events", lambda: [_Event(k) for k in events])
    monkeypatch.setattr(
        repo_mod, "set_setting", lambda k, v: written.__setitem__(k, v)
    )

    class _Backend:
        def load(self, _collection, key):
            return {f"{key}_qm{i}": {} for i in range(schedules.get(key, 0))}

    monkeypatch.setattr(repo_mod.store, "backend", _Backend(), raising=False)
    return repo_mod, written


def test_a_healthy_pointer_is_left_alone(monkeypatch):
    repo_mod, written = _wire(
        monkeypatch, current="2026haze", events=["2026haze"], schedules={"2026haze": 18}
    )
    assert repo_mod.reconcile_current_event() == "2026haze"
    assert written == {}


def test_an_event_with_no_scouting_yet_is_still_healthy(monkeypatch):
    """The morning before a competition looks exactly like this."""
    repo_mod, written = _wire(
        monkeypatch, current="2026haze", events=["2026haze"], schedules={"2026haze": 60}
    )
    assert repo_mod.reconcile_current_event() == "2026haze"
    assert written == {}


def test_a_dangling_pointer_is_repaired_when_there_is_one_candidate(monkeypatch):
    repo_mod, written = _wire(
        monkeypatch,
        current="2027nowhere",
        events=["2026haze"],
        schedules={"2026haze": 18},
    )
    assert repo_mod.reconcile_current_event() == "2026haze"
    assert written == {"current_event": "2026haze"}


def test_an_unset_pointer_adopts_the_only_event_with_a_schedule(monkeypatch):
    repo_mod, written = _wire(
        monkeypatch, current="", events=["2026haze", "2026txman"],
        schedules={"2026haze": 18, "2026txman": 0},
    )
    assert repo_mod.reconcile_current_event() == "2026haze"
    assert written == {"current_event": "2026haze"}


def test_it_refuses_to_guess_between_two_events(monkeypatch):
    """Switching events by itself mid-competition would be much worse than an
    empty page an admin can fix in the dashboard."""
    repo_mod, written = _wire(
        monkeypatch,
        current="2027nowhere",
        events=["2026haze", "2026txman"],
        schedules={"2026haze": 18, "2026txman": 69},
    )
    assert repo_mod.reconcile_current_event() == "2027nowhere"
    assert written == {}


def test_no_event_has_a_schedule_leaves_the_pointer_untouched(monkeypatch):
    repo_mod, written = _wire(
        monkeypatch, current="2026haze", events=[], schedules={}
    )
    assert repo_mod.reconcile_current_event() == "2026haze"
    assert written == {}

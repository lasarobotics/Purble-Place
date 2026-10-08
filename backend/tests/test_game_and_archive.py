"""The event archive and the current-event pointer.

Both exist so that one thing does not silently break another: an event that
ends still has to be readable next season, and the current event pointer
decides what every screen shows, so a stale one makes a working install look
completely empty.

The game definition itself moved out of code and into seasons; it is covered by
test_seasons.py and test_future_season.py.
"""
from __future__ import annotations

import pytest

from app.models import EventArchive


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
        matches=[{"match_key": "2026haze_qm1", "red1": 418}],
        scouting=[{"submission_uuid": "abc", "team_num": 418, "points": 12}],
        analytics={"rankings": {"avg_points": [{"team": 418, "rank": 1}]}},
        chunk_ids=["2026haze__scouting__0000"],
    )
    doc = row.to_doc()
    back = EventArchive.from_doc("2026haze", doc)

    assert back.event_key == "2026haze"
    assert back.teams["418"]["avg_points"] == 51.5
    assert back.counts["scouting_entries"] == 40
    assert back.pit[0]["archetype"] == "fast cycler"
    assert back.picklists[0]["items"] == [{"team": 254}]
    assert back.matches[0]["match_key"] == "2026haze_qm1"
    assert back.scouting[0]["submission_uuid"] == "abc"
    assert back.analytics["rankings"]["avg_points"][0]["rank"] == 1
    assert back.chunk_ids == ["2026haze__scouting__0000"]


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
    monkeypatch.setattr(archive_mod.repo, "bets", lambda _k: [])
    monkeypatch.setattr(archive_mod.repo, "event", lambda _k: None)
    monkeypatch.setattr(archive_mod.repo, "team", lambda _t: None)

    built = archive_mod.build_archive("2026haze")
    summary = built.teams["418"]
    assert "avatar" not in summary
    assert "match_points" not in summary
    assert summary["avg_points"] == 50.0


def test_archive_includes_raw_event_snapshots(monkeypatch):
    from app import archive as archive_mod

    class _Row:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

        def to_doc(self):
            return dict(self.__dict__)

    scout = _Row(
        submission_id="sub1",
        season_id="",
        event_key="2026haze",
        team_number=418,
        no_show=False,
        to_doc=lambda: {"submission_uuid": "sub1", "team_num": 418},
    )
    monkeypatch.setattr(archive_mod, "event_teams", lambda _k: [418])
    monkeypatch.setattr(archive_mod, "team_summary", lambda _k, _t: {"team": 418, "avg_points": 10})
    monkeypatch.setattr(archive_mod.repo, "scouting_for_event", lambda _k: [scout])
    monkeypatch.setattr(archive_mod.repo, "matches_for_event", lambda _k: [_Row(match_key="m1", winner="red")])
    monkeypatch.setattr(archive_mod.repo, "pits_for_event", lambda _k: [])
    monkeypatch.setattr(archive_mod.repo, "picklists", lambda _k: [])
    monkeypatch.setattr(archive_mod.repo, "bets", lambda _k: [])
    monkeypatch.setattr(archive_mod.repo, "event", lambda _k: None)
    monkeypatch.setattr(archive_mod.repo, "team", lambda _t: None)
    monkeypatch.setattr(archive_mod, "_analytics_snapshot", lambda _k: {"ok": True})

    built = archive_mod.build_archive("2026haze", "Custom Name")
    assert built.name == "Custom Name"
    assert built.scouting == [{"submission_uuid": "sub1", "team_num": 418}]
    assert built.matches[0]["match_key"] == "m1"
    assert built.analytics == {"ok": True}


def test_archive_details_are_split_into_chunks():
    from app import archive as archive_mod

    built = EventArchive(
        event_key="2026haze",
        name="Haze Regional",
        counts={"matches": 2, "scouting_entries": 2},
        teams={"418": {"team": 418}},
        matches=[{"match_key": "m1"}, {"match_key": "m2"}],
        scouting=[{"submission_uuid": "a"}, {"submission_uuid": "b"}],
        analytics={"data_analysis": [{"team": 418}]},
    )

    summary, chunks = archive_mod._split_for_storage(built)
    assert summary.matches == []
    assert summary.scouting == []
    assert summary.analytics == {}
    assert summary.chunk_ids == [chunk.archive_id for chunk in chunks]
    assert {chunk.kind for chunk in chunks} == {"matches", "scouting", "analytics"}


def test_archive_detail_rehydrates_chunked_history(monkeypatch):
    from app import repo as repo_mod
    from app import schema
    from app.models import EventArchiveChunk

    summary = EventArchive(
        event_key="2026haze",
        name="Haze Regional",
        counts={"matches": 1, "scouting_entries": 1},
        chunk_ids=["2026haze__matches__0000", "2026haze__scouting__0000"],
    )
    chunks = {
        "2026haze__matches__0000": EventArchiveChunk(
            archive_id="2026haze__matches__0000",
            event_key="2026haze",
            kind="matches",
            data=[{"match_key": "m1"}],
        ),
        "2026haze__scouting__0000": EventArchiveChunk(
            archive_id="2026haze__scouting__0000",
            event_key="2026haze",
            kind="scouting",
            data=[{"submission_uuid": "s1"}],
        ),
    }

    class _Store:
        def get(self, collection, doc_id):
            return summary if collection == schema.EVENT_ARCHIVES and doc_id == "2026haze" else None

        def fetch(self, collection, doc_id):
            assert collection == schema.EVENT_ARCHIVE_CHUNKS
            return chunks.get(doc_id)

    monkeypatch.setattr(repo_mod, "store", _Store())
    detail = repo_mod.archive_detail("2026haze")
    assert detail is not None
    assert detail.matches == [{"match_key": "m1"}]
    assert detail.scouting == [{"submission_uuid": "s1"}]


def test_event_deletes_are_scoped_to_one_competition(monkeypatch):
    from app import repo as repo_mod
    from app import schema

    class _Row:
        def __init__(self, doc_id, event_key):
            self.doc_id = doc_id
            self.submission_id = doc_id
            self.event_key = event_key

    class _Store:
        def __init__(self):
            self.deleted = []

        def all(self, collection):
            return [_Row("keep", "2026other"), _Row("delete", "2026haze")]

        def delete_many(self, collection, ids):
            self.deleted.append((collection, ids))
            return len(ids)

    store = _Store()
    monkeypatch.setattr(repo_mod, "store", store)
    assert repo_mod.delete_scouting_for_event("2026haze") == 1
    assert store.deleted == [(schema.MATCH_SCOUTING, ["delete"])]


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

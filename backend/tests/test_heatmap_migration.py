import pytest

from app import heatmap_migration as migration, repo, schema
from app.cache import LocalBackend, Store
from app.models import ScoutEntry
from app.scoring import compute_points, phase_counts
from app.routers.scouting import ScoutIn, canonical_hash


def report(event="old"):
    return ScoutEntry(event_key=event, match_number=1, team_number=418, scout_id="1",
                      payload_hash="original-hash", data={"heatmap": [
                          {"x": .2, "y": .3, "phase": "auto", "result": "missed"},
                          {"x": .4, "y": .5, "phase": "teleop", "result": "made"},
                      ]}).to_doc()


def test_old_taps_become_made_without_inventing_misses():
    old = report()
    fixed = migration.correct_report(old)
    assert old["data"]["heatmap"][0]["result"] == "missed"
    assert all(p["result"] == "made" for p in fixed["data"]["heatmap"])
    assert fixed["data"]["heatmap_before_made_v1"] == old["data"]["heatmap"]
    assert fixed["payload_hash"] == old["payload_hash"]
    assert fixed["submission_uuid"] == old["submission_uuid"]
    assert fixed["points"] == compute_points(fixed["data"])
    assert migration.correct_report(fixed) == fixed
    assert phase_counts(fixed["data"]) == {
        "auto_made": 1, "auto_missed": 0, "teleop_made": 1, "teleop_missed": 0,
    }


def test_new_counters_round_trip_and_affect_accuracy_not_score():
    data = {"event_key": "test", "team_number": 418, "match_number": 1,
            "alliance": "red", "scout_id": "1", "heatmap": report()["data"]["heatmap"],
            "auto_missed": 2, "teleop_missed": 3}
    ScoutIn(**data)
    saved = ScoutEntry.from_submission(data)
    restored = ScoutEntry.from_doc(saved.doc_id, saved.to_doc())
    counts = phase_counts(restored.data)
    assert counts == {"auto_made": 1, "auto_missed": 2, "teleop_made": 1, "teleop_missed": 3}
    assert compute_points(data) == compute_points({**data, "auto_missed": 0, "teleop_missed": 0})
    assert canonical_hash(data) != canonical_hash({**data, "auto_missed": 1})
    assert canonical_hash({}) == canonical_hash({"auto_missed": 0, "teleop_missed": 0})


def test_migration_persists_all_events_and_skips_second_run(tmp_path, monkeypatch):
    store = Store()
    store.backend = LocalBackend(tmp_path / "data.json")
    monkeypatch.setattr(repo, "store", store)
    for event in ("old", "current"):
        store.backend.set(schema.MATCH_SCOUTING, event, report(event))
    assert migration.migrate_heatmap_shots() == 2
    assert migration.migrate_heatmap_shots() == 0
    reopened = LocalBackend(tmp_path / "data.json")
    assert reopened.get(schema.MATCH_SCOUTING, "old")["data"]["heatmap"][0]["result"] == "made"


def test_failed_migration_is_retryable(tmp_path, monkeypatch):
    store = Store()
    store.backend = LocalBackend(tmp_path / "data.json")
    monkeypatch.setattr(repo, "store", store)
    original = report()
    store.backend.set(schema.MATCH_SCOUTING, "old", original)
    commit = store.backend.commit
    def fail(ops):
        raise RuntimeError("unavailable")
    monkeypatch.setattr(store.backend, "commit", fail)
    with pytest.raises(Exception, match="unavailable"):
        migration.migrate_heatmap_shots()
    assert store.backend.get(schema.APP_SETTINGS, migration.MARKER) is None
    assert store.backend.get(schema.MATCH_SCOUTING, "old")["data"] == original["data"]
    monkeypatch.setattr(store.backend, "commit", commit)
    assert migration.migrate_heatmap_shots() == 1


def test_heatmap_accuracy_includes_unmapped_misses(monkeypatch):
    from app import analytics
    row = ScoutEntry.from_doc("test", report())
    row.data.update(auto_missed=2, teleop_missed=3)
    monkeypatch.setattr(analytics, "team_entries", lambda *_: [row])
    monkeypatch.setattr(repo, "memoized", lambda key, deps, build: build())
    heat = analytics.team_heatmap("old", 418)
    assert len(heat["points"]) == 2
    assert heat["total"] == 7
    assert heat["made"] == 2
    assert heat["accuracy"] == .286
    assert heat["filters"]["auto|red1"]["accuracy"] == .333
    assert heat["filters"]["teleop|red1"]["accuracy"] == .25


def test_archived_reports_and_rankings_are_corrected(tmp_path, monkeypatch):
    from app.models import EventArchive
    store = Store()
    store.backend = LocalBackend(tmp_path / "data.json")
    monkeypatch.setattr(repo, "store", store)
    old = EventArchive(event_key="old", name="Previous competition", scouting=[report()],
                       teams={"418": {"avg_points": 0}})
    store.backend.set(schema.EVENT_ARCHIVES, old.doc_id, old.to_doc())
    migration.migrate_heatmap_shots()
    restored = repo.archive_detail("old")
    assert restored.name == old.name
    assert restored.archived_at == old.archived_at
    assert restored.scouting[0]["data"]["heatmap"][0]["result"] == "made"
    assert restored.teams["418"]["accuracy"] == 1
    assert restored.teams["418"]["avg_points"] == 6.5
    assert restored.analytics["rankings"]["avg_points"]

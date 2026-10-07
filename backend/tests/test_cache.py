"""Tests for the write path that keeps HazeHub inside Firestore's quotas.

Every behaviour here exists to reduce document operations, so each test is
really an assertion about cost: "this must not cost a write".
"""
from __future__ import annotations

import time

import pytest

from app import schema
from app.cache import Store, WriteTooLarge, doc_bytes
from app.firestore_db import QuotaGuard
from app.models import MatchRecord, Scouter, ScoutEntry


class RecordingBackend:
    """A backend that counts operations instead of performing them."""

    name = "recording"

    def __init__(self) -> None:
        self.docs: dict[tuple[str, str], dict] = {}
        self.sets = 0
        self.creates = 0
        self.deletes = 0
        self.commits = 0
        self.batch_sizes: list[int] = []

    def load(self, collection, event_key):  # noqa: ANN001
        return {}

    def watch(self, collection, event_key, on_change):  # noqa: ANN001
        return None

    def set(self, collection, doc_id, data):  # noqa: ANN001
        self.docs[(collection, doc_id)] = data
        self.sets += 1

    def create(self, collection, doc_id, data):  # noqa: ANN001
        if (collection, doc_id) in self.docs:
            return False
        self.docs[(collection, doc_id)] = data
        self.creates += 1
        return True

    def delete(self, collection, doc_id):  # noqa: ANN001
        self.docs.pop((collection, doc_id), None)
        self.deletes += 1

    def commit(self, ops):  # noqa: ANN001
        self.commits += 1
        self.batch_sizes.append(len(ops))
        for kind, collection, doc_id, data in ops:
            if kind == "delete":
                self.docs.pop((collection, doc_id), None)
                self.deletes += 1
            else:
                self.docs[(collection, doc_id)] = data
                self.sets += 1


@pytest.fixture()
def store() -> Store:
    s = Store()
    s.backend = RecordingBackend()
    s.ready = True
    return s


def a_match(number: int = 1, locked: bool = False) -> MatchRecord:
    m = MatchRecord(
        match_key=schema.match_id("2026txman", "qm", number),
        event_key="2026txman",
        comp_level="qm",
        match_number=number,
        betting_locked=locked,
    )
    m.set_alliances([418, 436, 4414], [118, 148, 3005])
    return m


def an_entry(uuid: str, team: int = 418) -> ScoutEntry:
    return ScoutEntry.from_submission(
        {
            "submission_id": uuid,
            "event_key": "2026txman",
            "match_number": 1,
            "team_number": team,
            "scout_id": "1",
            "heatmap": [],
        }
    )


# --------------------------------------------------------------------------- #
# Dirty checking                                                               #
# --------------------------------------------------------------------------- #
def test_rewriting_an_unchanged_document_costs_nothing(store: Store) -> None:
    assert store.write(a_match()) is True
    assert store.backend.sets == 1
    assert store.write(a_match()) is False
    assert store.backend.sets == 1


def test_a_real_change_is_written(store: Store) -> None:
    store.write(a_match())
    assert store.write(a_match(locked=True)) is True
    assert store.backend.sets == 2


def test_mutating_a_cached_object_in_place_still_persists(store: Store) -> None:
    """The read cache hands out live objects, so the whole app does

        m = repo.match_by_key(k); m.betting_locked = True; repo.save_match(m)

    A dirty check that compared the model to the cached model would be
    comparing it to itself and would silently drop the write. The baseline is
    a snapshot of what Firestore holds, so the mutation is detected.
    """
    store.write(a_match())
    cached = store.get(schema.MATCHES, "2026txman_qm1")
    cached.betting_locked = True
    assert store.write(cached) is True
    assert store.backend.docs[(schema.MATCHES, "2026txman_qm1")]["betting_locked"] is True
    # ...and saving it again, now genuinely unchanged, still costs nothing.
    assert store.write(cached) is False


def test_mutating_a_cached_object_persists_in_bulk_too(store: Store) -> None:
    store.write_many([a_match(n) for n in range(1, 6)])
    cached = store.get(schema.MATCHES, "2026txman_qm3")
    cached.red_score, cached.blue_score, cached.winner = 90, 40, "red"
    assert store.write_many([store.get(schema.MATCHES, f"2026txman_qm{n}")
                             for n in range(1, 6)]) == 1
    assert store.backend.docs[(schema.MATCHES, "2026txman_qm3")]["winner"] == "red"


def test_updated_at_alone_does_not_trigger_a_write(store: Store) -> None:
    """Otherwise every TBA schedule re-sync would rewrite all 120 matches."""
    store.write(a_match())
    later = a_match()
    later.updated_at = later.updated_at.replace(year=later.updated_at.year + 1)
    assert store.write(later) is False
    assert store.backend.sets == 1


def test_bulk_write_skips_the_unchanged_rows(store: Store) -> None:
    """A TBA schedule re-sync rebuilds every match but only one has new data."""
    assert store.write_many([a_match(n) for n in range(1, 21)]) == 20
    resynced = [a_match(n) for n in range(1, 21)]
    resynced[7].red_score = 88
    assert store.write_many(resynced) == 1


# --------------------------------------------------------------------------- #
# Idempotent creates                                                           #
# --------------------------------------------------------------------------- #
def test_create_is_idempotent_on_the_submission_uuid(store: Store) -> None:
    assert store.create(an_entry("u-1")) is True
    assert store.create(an_entry("u-1")) is False
    assert store.backend.creates == 1


def test_a_cached_duplicate_never_reaches_firestore(store: Store) -> None:
    store.create(an_entry("u-1"))
    before = store.backend.creates
    store.create(an_entry("u-1"))
    assert store.backend.creates == before


# --------------------------------------------------------------------------- #
# Coalescing                                                                   #
# --------------------------------------------------------------------------- #
def test_coalesced_counter_bumps_collapse_into_one_write(store: Store) -> None:
    s = Scouter(scout_id="1", display_name="Scout 1")
    for _ in range(6):  # six submissions in a burst
        s.matches_scouted += 1
        store.coalesce(s, delay_s=0)
    assert store.backend.sets == 0            # nothing written yet
    assert store.get(schema.SCOUTERS, "1").matches_scouted == 6  # visible now
    store.flush()
    assert store.backend.sets == 1            # one write for all six
    assert store.backend.docs[(schema.SCOUTERS, "1")]["matches_scouted"] == 6


def test_a_pending_write_is_not_flushed_before_it_is_due(store: Store) -> None:
    store.coalesce(Scouter(scout_id="1"), delay_s=60)
    assert store.flush() == 0
    assert store.backend.sets == 0


def test_shutdown_flushes_everything_pending(store: Store) -> None:
    store.coalesce(Scouter(scout_id="1"), delay_s=3600)
    store.stop()
    assert store.backend.sets == 1


def test_deleting_a_document_drops_its_pending_write(store: Store) -> None:
    store.coalesce(Scouter(scout_id="1"), delay_s=0)
    store.delete(schema.SCOUTERS, "1")
    assert store.flush() == 0


# --------------------------------------------------------------------------- #
# Batching                                                                     #
# --------------------------------------------------------------------------- #
def test_batches_stay_under_firestores_500_operation_commit_limit(store: Store) -> None:
    store.write_many([an_entry(f"u-{i}", team=i) for i in range(1200)])
    assert store.backend.commits >= 3
    assert max(store.backend.batch_sizes) <= schema.MAX_BATCH_OPS


def test_bulk_delete_is_batched(store: Store) -> None:
    entries = [an_entry(f"u-{i}") for i in range(600)]
    store.write_many(entries)
    commits_before = store.backend.commits
    removed = store.delete_many(schema.MATCH_SCOUTING, [e.doc_id for e in entries])
    assert removed == 600
    assert store.backend.commits > commits_before
    assert store.count(schema.MATCH_SCOUTING) == 0


# --------------------------------------------------------------------------- #
# Size guards                                                                  #
# --------------------------------------------------------------------------- #
def test_an_oversized_document_is_refused_before_it_reaches_firestore(store: Store) -> None:
    entry = an_entry("huge")
    entry.data = {"failure_details": "x" * (schema.MAX_DOC_BYTES + 1)}
    with pytest.raises(WriteTooLarge):
        store.write(entry)
    assert store.backend.sets == 0


def test_oversized_documents_are_skipped_in_bulk_without_losing_the_rest(store: Store) -> None:
    good = [an_entry(f"u-{i}") for i in range(3)]
    bad = an_entry("huge")
    bad.data = {"failure_details": "x" * (schema.MAX_DOC_BYTES + 1)}
    assert store.write_many([*good, bad]) == 3


def test_doc_bytes_tracks_actual_content(store: Store) -> None:
    small = doc_bytes(an_entry("u-1").to_doc())
    big = an_entry("u-2")
    big.data = {"notes": "x" * 10_000}
    assert doc_bytes(big.to_doc()) > small + 9_000


# --------------------------------------------------------------------------- #
# Revisions (the analytics memoisation key)                                    #
# --------------------------------------------------------------------------- #
def test_revision_advances_only_when_the_collection_changes(store: Store) -> None:
    before = store.revision(schema.MATCHES)
    store.write(a_match())
    after = store.revision(schema.MATCHES)
    assert after > before
    # Even a no-op write bumps the revision — correctness over micro-caching.
    store.write(a_match())
    assert store.revision(schema.MATCHES) >= after
    assert store.revision(schema.BETS) == (0,)


# --------------------------------------------------------------------------- #
# Quota guard                                                                  #
# --------------------------------------------------------------------------- #
def test_guard_sheds_optional_work_but_never_blocks_a_submission() -> None:
    guard = QuotaGuard(read_budget=10, write_budget=10, delete_budget=10)
    guard.count("write", 10)
    assert guard.allow("write") is False              # optional work: shed
    assert guard.allow("write", essential=True) is True  # scouting: always
    assert guard.snapshot()["operations"]["write"]["shed"] == 1


def test_guard_projects_a_twelve_hour_day() -> None:
    guard = QuotaGuard()
    guard.started_at = guard.started_at.replace(year=guard.started_at.year)
    guard.count("read", 500)
    snap = guard.snapshot()
    assert snap["operations"]["read"]["used"] == 500
    assert snap["operations"]["read"]["free_tier_limit"] == 50_000
    assert snap["operations"]["read"]["projected_12h"] >= 500


def test_guard_reports_every_operation_kind() -> None:
    snap = QuotaGuard().snapshot()
    assert set(snap["operations"]) == {"read", "write", "delete"}
    for row in snap["operations"].values():
        assert row["budget"] <= row["free_tier_limit"]


# --------------------------------------------------------------------------- #
# Reads never touch the backend                                                #
# --------------------------------------------------------------------------- #
def test_reads_are_served_from_memory(store: Store) -> None:
    store.write_many([a_match(n) for n in range(1, 51)])
    sets_after_seed = store.backend.sets
    for _ in range(1000):
        store.get(schema.MATCHES, "2026txman_qm7")
        store.all(schema.MATCHES)
        store.count(schema.MATCHES)
    # A thousand reads, zero backend operations of any kind.
    assert store.backend.sets == sets_after_seed
    assert store.backend.creates == 0
    assert store.backend.deletes == 0


def test_settings_round_trip_through_the_cache(store: Store) -> None:
    store.set_setting_raw("current_event", "2026txman")
    assert store.setting_raw("current_event") == "2026txman"
    assert store.all_settings_raw()["current_event"] == "2026txman"
    assert store.backend.sets == 1


def test_stats_report_what_is_cached(store: Store) -> None:
    store.write_many([a_match(n) for n in range(1, 6)])
    stats = store.stats()
    assert stats["backend"] == "recording"
    assert stats["documents"][schema.MATCHES] == 5
    assert stats["cached_total"] == 5

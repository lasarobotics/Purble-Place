from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock

import pytest

from app import analytics as a
from app.views import EntryView, MatchView, TeamView


def entry(points, match=1, team=1, no_show=False, **data):
    return EntryView({"_id": f"{team}-{match}-{points}", "event_key": "test", "team_num": team,
                      "match_num": match, "points": points, "no_show": no_show,
                      "submitted_at": datetime(2026, 1, 1, tzinfo=UTC) + timedelta(days=match), "data": data})


@pytest.fixture
def inputs(monkeypatch):
    entries = MagicMock(return_value=[])
    matches = MagicMock(return_value=[])
    profiles = MagicMock(return_value={})
    monkeypatch.setattr(a, "list_entries", entries)
    monkeypatch.setattr(a, "list_matches", matches)
    monkeypatch.setattr(a, "get_teams_cache", profiles)
    monkeypatch.setattr(a, "get_team_cache", lambda *_: None)
    return entries, matches, profiles


def test_new_metrics_and_no_show_denominators(inputs):
    entries, _, _ = inputs
    entries.return_value = [
        entry(10, 1, heatmap=[{"phase": "auto", "result": "made"}, {"phase": "auto", "result": "missed"}], auto_leave=True, climb="l2", foul_count=2),
        entry(30, 2, failure=True, heatmap=[{"phase": "teleop", "result": "made"}]),
        entry(0, 3, no_show=True),
    ]
    s = a.team_summary(None, "test", 1)
    assert s["avg_points"] == 20
    assert s["accuracy"] == .667
    assert s["auto_accuracy"] == .5
    assert s["teleop_accuracy"] == 1
    assert s["avg_auto_points"] == 3.5
    assert s["avg_teleop_points"] == 1.25
    assert s["avg_endgame_points"] == 3
    assert s["median_points"] == 20
    assert s["recent_points"] == 20
    assert s["trend"] == 20
    assert s["attendance_rate"] == .667
    assert s["operational_rate"] == .333
    assert s["failure_rate"] == .5
    assert s["avg_fouls"] == 1


def test_empty_and_single_sample_are_not_fabricated(inputs):
    entries, _, _ = inputs
    empty = a.team_summary(None, "test", 1)
    assert empty["accuracy"] is None
    assert empty["trend"] is None
    assert empty["avg_auto_points"] is None
    entries.return_value = [entry(0)]
    single = a.team_summary(None, "test", 1)
    assert single["trend"] is None
    assert single["recent_points"] == 0
    assert single["accuracy"] is None


def test_rank_batches_reads_and_sees_new_data(inputs):
    entries, matches, profiles = inputs
    entries.return_value = [entry(10, team=1, foul_count=2), entry(20, team=2)]
    rows = a.rank_teams(None, "test", "avg_fouls")
    assert [r["team"] for r in rows] == [2, 1]
    assert entries.call_count == matches.call_count == profiles.call_count == 1
    entries.return_value.append(entry(80, 2, team=1))
    rows = a.rank_teams(None, "test", "avg_points")
    assert rows[0]["team"] == 1
    assert rows[0]["avg_points"] == 45
    assert a._snapshot.get() is None


def test_compare_does_not_award_missing_epa(inputs):
    entries, _, profiles = inputs
    entries.return_value = [entry(10, team=1), entry(10, team=2)]
    profiles.return_value = {2: TeamView({"_id": 2, "epa": -1})}
    comparison = a.compare_teams(None, "test", [1, 2])
    epa = next(r for r in comparison["metrics"] if r["key"] == "epa")
    assert epa["values"][0] == {"team": 1, "value": None, "best": False}
    assert epa["values"][1]["best"] is True


def test_schedule_adjustment_is_centered(inputs):
    entries, matches, profiles = inputs
    entries.return_value = [entry(10, team=1), entry(30, team=2)]
    matches.return_value = [MatchView({"_id": "test_qm1", "alliances": {"red": {"teams": [1]}, "blue": {"teams": [2]}}})]
    profiles.return_value = {1: TeamView({"_id": 1, "epa": 10}), 2: TeamView({"_id": 2, "epa": 30})}
    rows = a.data_picklist(None, "test")["teams"]
    assert sum(r["sos_adjust"] for r in rows) == 0


def test_recent_form_averages_observers_before_matches(inputs):
    entries, _, _ = inputs
    entries.return_value = [entry(10, 1), entry(30, 1), entry(40, 2)]
    s = a.team_summary(None, "test", 1)
    assert s["recent_points"] == 30
    assert s["trend"] == 20


def test_bundle_reuses_one_input_pass_for_every_metric_and_view(inputs):
    entries, matches, profiles = inputs
    entries.return_value = [entry(10, team=1), entry(30, team=2)]
    db = MagicMock()
    db.scouters.find.return_value = []
    bundle = a.analysis_bundle(db, "test")
    assert entries.call_count == matches.call_count == profiles.call_count == 1
    assert bundle["orders"]["avg_points"] == [2, 1]
    assert all("rank" not in row for row in bundle["teams"])
    assert set(bundle["orders"]) == set(a.RANK_METRICS)
    assert bundle["scouting"]["1"]["summary"]["avg_points"] == 10
    assert bundle["profiles"][0]["team_number"] == 1


def test_heatmap_excludes_no_show_attempts(inputs):
    entries, _, _ = inputs
    entries.return_value = [entry(0, no_show=True, heatmap=[{"x": .5, "y": .5, "phase": "auto", "result": "made"}])]
    heat = a.team_heatmap(None, "test", 1)
    assert heat["total"] == 0
    assert heat["accuracy"] is None


def test_qualification_and_playoff_numbers_are_separate_samples(inputs):
    entries, _, _ = inputs
    playoff = entry(30, 1)
    playoff._doc["comp_level"] = "sf"
    entries.return_value = [entry(10, 1), playoff]
    s = a.team_summary(None, "test", 1)
    assert len(s["match_points"]) == 2
    assert [p["comp_level"] for p in s["match_points"]] == ["qm", "sf"]

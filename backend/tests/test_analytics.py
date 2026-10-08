from unittest.mock import MagicMock
import pytest
from app import analytics as a, repo, schema
from app.models import ScoutEntry


def entry(points=10, match=1, team=1, no_show=False, comp="qm", **data):
    return ScoutEntry(event_key="test", match_number=match, team_number=team, scout_id="scout", points=points, no_show=no_show, comp_level=comp, data=data)

@pytest.fixture
def records(monkeypatch):
    rows = []
    monkeypatch.setattr(repo, "memoized", lambda key, deps, build: build())
    monkeypatch.setattr(repo, "scouting_for_team", lambda event, team: [e for e in rows if e.team_number == team])
    monkeypatch.setattr(repo, "event_teams", lambda event: sorted({e.team_number for e in rows}))
    monkeypatch.setattr(repo, "team", lambda team: None)
    monkeypatch.setattr(repo, "matches_for_event", lambda event: [])
    return rows

def test_rates_exclude_no_shows_and_preserve_attendance(records):
    records.extend([entry(10, heatmap=[{"phase":"auto", "result":"made"}, {"phase":"auto", "result":"missed"}]), entry(30, 2, failure=True), entry(0, 3, no_show=True)])
    s = a.team_summary("test", 1)
    assert s["avg_points"] == 20
    assert s["accuracy"] == .5
    assert s["attendance_rate"] == .667
    assert s["operational_rate"] == .333
    assert s["median_points"] == 20
    assert s["trend"] == 20

def test_empty_attempts_are_unavailable(records):
    records.append(entry())
    assert a.team_summary("test", 1)["accuracy"] is None
    assert a.team_heatmap("test", 1)["accuracy"] is None
    assert a._skew([10, 20]) is None

def test_adjusted_sample_skew():
    assert a._skew([1, 2, 3]) == pytest.approx(0)
    assert a._skew([1, 1, 4]) == pytest.approx(1.7320508075688772)

def test_defense_uses_season_points_relative_to_leader(monkeypatch):
    monkeypatch.setattr(a, "compute_points", lambda data: 3 * data["successful_stops"])
    reports = [entry(played_defense=True, successful_stops=4), entry(played_defense=True, successful_stops=10, failure=True)]
    assert a._defense_capability(reports, 60) == 10
    assert a._defense_capability(reports, 120) == 5
    assert a._defense_capability([entry(played_defense=False, successful_stops=4)], 60) == 0
    assert a._defense_capability(reports, 0) is None
    assert a._defense_capability(reports, None) is None
    assert a._defense_capability([], 60) is None


def test_match_series_separates_playoffs(records):
    records.extend([entry(10,1), entry(30,1), entry(50,1,comp="sf")])
    assert [p["points"] for p in a.team_summary("test",1)["match_points"]] == [20,50]

def test_last_four_distinct_matches():
    rows=[entry(match=i) for i in range(1,6)] + [entry(match=1,comp="sf")]
    assert [(e.comp_level,e.match_number) for e in a._last_four_entries(rows)] == [("qm",3),("qm",4),("qm",5),("sf",1)]

def test_heatmap_cloud_filters(records):
    records.extend([entry(heatmap=[{"x":.2,"y":.4,"phase":"auto","result":"made"}]), entry(no_show=True, heatmap=[{"phase":"auto","result":"missed"}])])
    heat=a.team_heatmap("test",1)
    assert heat["total"] == 1
    assert heat["filters"]["auto|red1"]["accuracy"] == 1
    assert heat["filters"]["teleop|all"]["accuracy"] is None

def test_bundle_includes_complete_analysis(records):
    records.extend([entry(), entry(20,2), entry(30,3)])
    bundle=a.analysis_bundle("test")
    assert bundle["teams"][0]["team"] == 1
    assert bundle["analysis"][0]["defense_capability"] == 0
    assert bundle["analysis"][0]["ranking_point_prediction"] is None
    assert bundle["orders"]["avg_points"] == [1]
    assert "all" in bundle["scouting"]["1"]["heatmaps"]

def test_memo_invalidates_on_revision(monkeypatch):
    repo.invalidate_memo()
    revision=[1]
    monkeypatch.setattr(repo.store,"revision", lambda *args: tuple(revision))
    build=MagicMock(return_value=42)
    assert repo.memoized("test-memo", (schema.MATCH_SCOUTING,), build) == 42
    repo.memoized("test-memo", (schema.MATCH_SCOUTING,), build)
    assert build.call_count == 1
    revision[0]+=1
    repo.memoized("test-memo", (schema.MATCH_SCOUTING,), build)
    assert build.call_count == 2


def test_scoring_reference_uses_event_leader_not_selected_robot(records):
    records.extend([entry(40, team=1), entry(100, team=2), entry(300, team=3, no_show=True)])
    reference = a.scoring_benchmark("test")
    assert reference == {"team": 2, "avg_points": 100}
    assert a.team_summary("test", 1)["relative_scoring"] == .4
    assert a.team_summary("test", 2)["relative_scoring"] == 1
    assert a.team_summary("test", 3)["relative_scoring"] is None


def test_scoring_reference_uses_average_not_single_peak_and_breaks_ties(records):
    records.extend([entry(200, team=1), entry(0, 2, team=1), entry(110, team=2), entry(110, team=3)])
    assert a.scoring_benchmark("test") == {"team": 2, "avg_points": 110}


def test_scoring_reference_missing_positive_scores_is_unavailable(records):
    records.extend([entry(0), entry(-10, team=2)])
    assert a.scoring_benchmark("test")["avg_points"] is None
    assert a.team_summary("test", 1)["relative_scoring"] is None


def test_defense_and_last_four_share_event_scoring_leader(records, monkeypatch):
    monkeypatch.setattr(a, "compute_points", lambda data: 2 * data["successful_stops"])
    records.extend([entry(10, match=i, played_defense=True, successful_stops=3) for i in range(1,6)])
    records.append(entry(100, team=2))
    summary = a.team_summary("test", 1)
    row = next(row for row in a.data_analysis("test") if row["team"] == 1)
    assert summary["defense_capability"] == row["defense_capability"] == row["l4m_defense_capability"] == 6
    assert row["scoring_benchmark"] == {"team": 2, "avg_points": 100}
    # A new leader changes both relative metrics using cloud data.
    records.append(entry(200, team=3))
    assert a.team_summary("test", 1)["defense_capability"] == 3
    assert a.team_summary("test", 1)["relative_scoring"] == .05

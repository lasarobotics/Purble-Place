import pytest

from app import repo, schema, seasons
from app.cache import LocalBackend, Store, StoreUnavailable
from app.epa_scoring import click_values, flat_report, rescore_reports
from app.gamedef import bootstrap_2026
from app.heatmap_migration import migrate_epa_scores
from app.models import EventArchive, MatchRecord, ScoutEntry, TeamCache
from app.scoring import compute_points


@pytest.fixture(autouse=True)
def game(monkeypatch):
    monkeypatch.setattr(seasons, "definition_at", lambda *_: bootstrap_2026())
    repo.invalidate_memo()
    yield
    repo.invalidate_memo()


def report(team=6800, event="test", match=1, shots=50, **data):
    return ScoutEntry(event_key=event, team_number=team, match_number=match,
                      scout_id="1", points=999, payload_hash="original",
                      data={"heatmap": [{"phase": "auto" if i % 2 else "teleop",
                                         "result": "made"} for i in range(shots)], **data})


def test_epa_normalization_and_equal_phases():
    row = report(climb="l3", auto_leave=True, successful_stops=50)
    teams = [TeamCache(team_number=6800, epa=235)]
    value = click_values([flat_report(row)], [], teams)["test", 6800]
    assert value == pytest.approx((235 - 12) / 50)
    assert rescore_reports([row], [], teams)[0].points == 235
    for phase in ("auto", "teleop"):
        assert compute_points({"heatmap": [{"phase": phase}]}, heatmap_value=value) == 4.46
    assert compute_points({"auto_leave": True, "successful_stops": 99,
                           "responses": {"auto_leave": True, "successful_stops": 99}}) == 0
    assert compute_points({"no_show": True, "heatmap": [{}]}, heatmap_value=value) == 0


def test_missing_epa_residual_split_and_event_separation():
    match = MatchRecord(match_key="test_qm1", event_key="test", red1=1, red2=2,
                        red3=3, red_score=300)
    teams = [TeamCache(team_number=1, epa=100)]
    rows = [report(team=2, shots=10), report(team=3, shots=20),
            report(team=2, event="other", shots=10)]
    values = click_values([flat_report(row) for row in rows], [match], teams)
    assert values == {("test", 2): 10, ("test", 3): 5}
    scored = rescore_reports(rows, [match], teams)
    assert [row.points for row in scored] == [100, 100, 25]
    match.red_score = -1
    assert click_values([flat_report(rows[0])], [match], teams) == {}
    match.red_score = 50
    assert click_values([flat_report(rows[0])], [match], teams)["test", 2] == 0


def test_duplicate_scouts_do_not_overweight_a_match_and_zero_shots():
    rows = [report(match=1, shots=10), report(match=1, shots=10),
            report(match=2, shots=30)]
    teams = [TeamCache(team_number=6800, epa=100)]
    values = click_values([flat_report(row) for row in rows], [], teams)
    assert values["test", 6800] == 5
    assert rescore_reports([report(shots=0)], [], teams)[0].points == 0
    assert rescore_reports(rows, [], [TeamCache(team_number=6800, epa=0)])[0].points == 0
    assert rescore_reports(rows, [], [TeamCache(team_number=6800, epa=float("nan"))])[0].points == 25


def setup_store(tmp_path, monkeypatch):
    store = Store()
    store.backend = LocalBackend(tmp_path / "data.json")
    monkeypatch.setattr(repo, "store", store)
    return store


def test_cached_previous_reports_refresh_when_epa_or_reports_change(tmp_path, monkeypatch):
    store = setup_store(tmp_path, monkeypatch)
    old = report(shots=10)
    store.write(old)
    store.write(TeamCache(team_number=6800, epa=100))
    assert repo.scouting_for_event("test")[0].points == 100
    store.write(report(match=2, shots=30))
    assert [r.points for r in repo.scouting_for_event("test")] == [50, 150]
    store.write(TeamCache(team_number=6800, epa=200))
    assert [r.points for r in repo.scouting_for_event("test")] == [100, 300]
    assert old.points == 999
    assert repo.scouting_for_event("test")[0].payload_hash == "original"


def test_match_result_refresh_and_fuel_prediction(tmp_path, monkeypatch):
    from app.analytics import _entry_scoring_points
    store = setup_store(tmp_path, monkeypatch)
    store.write(report(team=2, shots=10, climb="l3"))
    store.write(TeamCache(team_number=1, epa=100))
    match = MatchRecord(match_key="test_qm1", event_key="test", red1=1, red2=2)
    store.write(match)
    assert repo.scouting_for_event("test")[0].points == 37
    match.red_score = 200
    store.write(match)
    scored = repo.scouting_for_event("test")[0]
    assert scored.points == 100
    assert _entry_scoring_points(scored) == 88


def test_migration_persists_reports_and_archives_and_is_retryable(tmp_path, monkeypatch):
    store = setup_store(tmp_path, monkeypatch)
    old = report()
    team = TeamCache(team_number=6800, epa=235)
    store.write(old)
    store.write(team)
    archive = EventArchive(event_key="test", name="Saved", scouting=[old.to_doc()],
                           team_cache=[team.to_doc()])
    store.write(archive)
    commit = store.backend.commit
    def fail(ops):
        raise RuntimeError("offline")
    monkeypatch.setattr(store.backend, "commit", fail)
    with pytest.raises(StoreUnavailable, match="offline"):
        migrate_epa_scores()
    assert store.backend.get(schema.APP_SETTINGS, "heatmap_epa_v2") is None
    assert store.backend.get(schema.MATCH_SCOUTING, old.doc_id)["points"] == 999
    monkeypatch.setattr(store.backend, "commit", commit)
    assert migrate_epa_scores() == 1
    assert migrate_epa_scores() == 0
    reopened = LocalBackend(tmp_path / "data.json")
    assert reopened.get(schema.MATCH_SCOUTING, old.doc_id)["points"] == 235
    detail = repo.archive_detail("test")
    assert detail.scouting[0]["points"] == 235
    assert detail.teams["6800"]["avg_points"] == 162.5
    assert detail.scouting[0]["payload_hash"] == "original"

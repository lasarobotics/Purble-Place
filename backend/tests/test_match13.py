import asyncio

from app import external
from app.models import MatchRecord


def test_match13_event_ratings_normalizes_ratings_and_event_stats(monkeypatch):
    async def fake_match13(path, ttl=None):
        assert path == "/v1/events/2025test/teams"
        return {"teams": [{"teamNumber": 418, "opr": 50.5, "epa": 48.25,
                            "xpEnd": 61.0, "xAuto": 12, "xTele": 40,
                            "xEnd": 9, "sos": .42}]}

    async def fake_tba(path, ttl=None):
        return {"rankings": [{"team_key": "frc418", "record": {"wins": 2, "losses": 1, "ties": 0},
                               "sort_orders": [3.5]}]}

    match = MatchRecord(match_key="2025test_qm1", event_key="2025test", comp_level="qm",
                        match_number=1, red_score=90, blue_score=80)
    match.set_alliances([418, 1, 2], [3, 4, 5])
    monkeypatch.setattr(external, "match13", fake_match13)
    monkeypatch.setattr(external, "tba", fake_tba)
    monkeypatch.setattr(external.repo, "matches_for_event", lambda event: [match])

    row = asyncio.run(external.match13_event_ratings("2025test"))[418]
    assert row == {"opr": 50.5, "match13_epa": 48.25, "xp": 61.0,
                   "x_auto": 12.0, "x_tele": 40.0, "x_end": 9.0,
                   "match13_sos": .42, "record": "2-1-0",
                   "ranking_score": 3.5, "avg_score": 90.0}

"""Regression checks for shared calculations, contention and liveness."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import threading
from unittest.mock import patch

import httpx
import pytest

from app import analytics, repo, schema
from app.cache import Store
from benchmarks.analysis_benchmark import seed, run


@pytest.fixture
def isolated(monkeypatch):
    monkeypatch.setattr(repo, "store", Store())
    repo.invalidate_memo()
    yield
    repo.invalidate_memo()


def test_all_metric_values_match_preoptimization_baseline(isolated):
    assert run(73, 147)["output_sha256"] == "7d02ebb0de8a8c46812056cc1ce51e8909e7ada91785ab8a590840b5ffcb468f"


def test_event_priors_and_team_estimates_are_shared(isolated):
    seed(73, 147)
    with patch.object(analytics, "prepare_event", wraps=analytics.prepare_event) as event, patch.object(analytics, "estimate_avg_points", wraps=analytics.estimate_avg_points) as team:
        analytics.data_analysis("bench")
        analytics.data_analysis("bench")
        assert event.call_count == 1
        assert team.call_count == 73
        repo.store._revision[schema.MATCH_SCOUTING] += 1
        analytics.data_analysis("bench")
        assert event.call_count == 2
        assert team.call_count == 146


def test_single_flight_and_revision_during_build(isolated):
    entered, release = threading.Event(), threading.Event()
    calls = []
    def build():
        calls.append(1)
        entered.set()
        assert release.wait(5)
        return 42
    with ThreadPoolExecutor(max_workers=12) as pool:
        jobs = [pool.submit(repo.memoized, "test", (schema.MATCHES,), build) for _ in range(12)]
        assert entered.wait(5)
        release.set()
        assert [job.result(5) for job in jobs] == [42] * 12
    assert len(calls) == 1
    def changes_revision():
        repo.store._revision[schema.MATCHES] += 1
        return "old"
    assert repo.memoized("changing", (schema.MATCHES,), changes_revision) == "old"
    assert repo.memoized("changing", (schema.MATCHES,), lambda: "new") == "new"


def test_failed_build_can_retry(isolated):
    def fail():
        raise ValueError("test")
    with pytest.raises(ValueError):
        repo.memoized("failed", (), fail)
    assert repo.memoized("failed", (), lambda: 7) == 7


def test_health_remains_available_while_analysis_worker_is_blocked(isolated, monkeypatch):
    from app.main import app
    from app.auth import current_scouter
    from app.models import Scouter
    entered, release = threading.Event(), threading.Event()
    def slow_analysis(*args):
        entered.set()
        assert release.wait(5)
        return []
    monkeypatch.setattr("app.routers.admin.data_analysis", slow_analysis)
    def forbidden(*args):
        raise AssertionError("health must not inspect store or Firestore")
    monkeypatch.setattr(repo.store, "stats", forbidden)
    monkeypatch.setattr("app.firestore_db.status", forbidden)
    old = app.dependency_overrides.copy()
    app.dependency_overrides[current_scouter] = lambda: Scouter("Admin", role="admin")
    async def exercise():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            work = asyncio.create_task(client.get("/api/admin/data-analysis?event=bench"))
            try:
                assert await asyncio.to_thread(entered.wait, 2)
                monkeypatch.setattr(repo, "setting", forbidden)
                response = await asyncio.wait_for(client.get("/api/health"), 1)
                assert response.status_code == 200
                assert "app;dur=" in response.headers["server-timing"]
            finally:
                release.set()
                assert (await work).status_code == 200
    try:
        asyncio.run(exercise())
    finally:
        app.dependency_overrides = old

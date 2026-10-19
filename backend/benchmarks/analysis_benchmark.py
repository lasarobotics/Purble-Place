"""Synthetic, isolated benchmark: never starts or writes the production store."""
import argparse
import cProfile
import hashlib
import json
from pathlib import Path
import statistics
import sys
import time
import asyncio

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import analytics, repo, schema
from app.models import ScoutEntry, MatchRecord, TeamCache


def seed(teams, submissions):
    store = repo.store
    store._docs = {c: {} for c in schema.ALL_COLLECTIONS}
    store._revision = {c: 1 for c in schema.ALL_COLLECTIONS}
    for i in range(submissions):
        team = 100 + i % teams
        row = ScoutEntry(event_key="bench", match_number=i // teams + 1,
                         team_number=team, scout_id="bench", submission_id=f"bench-{i}",
                         data={"heatmap": [{"phase": "auto" if j < 8 else "teleop", "result": "made", "x": .3, "y": .4} for j in range(20 + i % 31)],
                               "auto_missed": i % 4, "teleop_missed": i % 7,
                               "climb": ["none", "l1", "l2", "l3"][i % 4],
                               "played_defense": i % 7 == 0, "successful_stops": i % 3,
                               "failure": i % 17 == 0, "fouls": i % 3}, no_show=i % 53 == 0)
        store._docs[schema.MATCH_SCOUTING][row.doc_id] = row
    for i in range(teams):
        row = TeamCache(team_number=100+i, nickname=f"Team {100+i}", epa=40+i%20)
        store._docs[schema.TEAM_CACHE][row.doc_id] = row
    for i in range(max(1, submissions // 6)):
        row = MatchRecord(match_key=f"bench_qm{i+1}", event_key="bench", match_number=i+1)
        row.set_alliances([100+(i*6+j)%teams for j in range(3)], [100+(i*6+j)%teams for j in range(3,6)])
        store._docs[schema.MATCHES][row.doc_id] = row
    repo.invalidate_memo()


def run(teams, submissions, profile=False):
    seed(teams, submissions)
    profiler = cProfile.Profile()
    started = time.perf_counter()
    rows = analytics.data_analysis("bench")
    cold = time.perf_counter() - started
    warm = []
    for _ in range(100):
        started = time.perf_counter()
        analytics.data_analysis("bench")
        warm.append(time.perf_counter() - started)
    result = {"teams": teams, "submissions": submissions, "cold_ms": round(cold*1000, 3),
              "warm_median_ms": round(statistics.median(warm)*1000, 4),
              "output_sha256": hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()}
    try:
        import resource
        result["peak_rss_mib"] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 2)
    except ImportError:
        pass
    if profile:
        repo.invalidate_memo()
        profiler.runcall(analytics.data_analysis, "bench")
        profiler.dump_stats(str(Path(__file__).with_name("analysis.prof")))
    return result


async def http_run(teams, submissions, concurrency, stub_probe=False):
    import httpx
    from app.main import app
    import app.main as main
    # Isolate CPU scheduling from network/ADC latency in the old health route.
    if stub_probe and hasattr(main, "firestore_status"):
        main.firestore_status = lambda: {"reachable": True}
    from app.auth import current_scouter
    from app.models import Scouter
    seed(teams, submissions)
    app.dependency_overrides[current_scouter] = lambda: Scouter("Admin", role="admin")
    heartbeat = []
    done = False
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://bench") as client:
        async def probe():
            while not done:
                start = time.perf_counter()
                await asyncio.sleep(.02)
                response = await client.get("/api/health")
                assert response.status_code == 200
                heartbeat.append((time.perf_counter()-start)*1000)
        monitor = asyncio.create_task(probe())
        started = time.perf_counter()
        responses = await asyncio.gather(*[client.get("/api/admin/data-analysis?event=bench") for _ in range(concurrency)])
        elapsed = time.perf_counter()-started
        done = True
        await monitor
    assert all(r.status_code == 200 for r in responses)
    assert all(r.json() == responses[0].json() for r in responses)
    result = {"teams":teams, "submissions":submissions, "concurrency":concurrency,
            "firestore_probe_stubbed": stub_probe,
            "batch_ms":round(elapsed*1000,2), "max_health_scheduling_and_response_ms":round(max(heartbeat, default=0),2)}
    try:
        import resource
        result["peak_rss_mib"] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 2)
    except ImportError:
        pass
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output")
    parser.add_argument("--profile", action="store_true")
    parser.add_argument("--cases", default="73:147,73:1470,150:6000")
    parser.add_argument("--http", action="store_true")
    parser.add_argument("--stub-probe", action="store_true")
    args = parser.parse_args()
    cases = [tuple(map(int, c.split(":"))) for c in args.cases.split(",")]
    results = ([asyncio.run(http_run(t,n,c,args.stub_probe)) for t,n in cases for c in (10,30,60,100)] if args.http
               else [run(t,n,args.profile and n == 147) for t,n in cases])
    text = json.dumps(results, indent=2)
    if args.output: Path(args.output).write_text(text + "\n")
    print(text)

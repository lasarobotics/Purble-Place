# Data Analysis performance and session investigation

Measured locally on October 18, 2026. Baseline: commit `9d72ecf`.
No production database was accessed or modified by these benchmarks.

## Confirmed causes

- The async `/api/admin/data-analysis` handler executed synchronous Python
  calculations on the event loop. This prevented timely health responses.
- `estimate_avg_points` reconstructed the complete event consensus for every
  team, both for the scoring benchmark and again for summaries. A 73-team,
  147-submission cProfile run recorded 146 estimator calls and 292 consensus
  calls; 4.238 of 4.376 *profiled* seconds were inside the estimator. Profiling
  overhead is excluded from the timing tables below.
- The repository already indexed reports by team, but event priors and team
  estimates were not reused across these calculations. Concurrent cache misses
  could also independently build the same expensive value.
- `/api/health` performed Firestore client initialization/connectivity probing
  and acquired cache/quota locks. Its middleware also read store settings.
- The API client dispatched global sign-out on any authenticated endpoint's
  401, without verifying whether the session was actually invalid.

## Changes

Event accuracy/endgame priors are computed once per revision; expected team
points are shared by summaries and scoring benchmarks. Existing consensus,
summation order, rounding, metrics and table columns remain intact. A bounded
revision cache now shares in-flight builds and refuses to publish a build if
its dependencies changed while it was running. Audit, scouting, match, team,
season and settings revisions invalidate dependent calculations.

CPU-heavy analytics handlers run in FastAPI's worker threads rather than on
the event loop. Liveness uses cached primitive state, bypasses store-reading
middleware, and requires neither a worker slot nor Firestore. Detailed
diagnostics remain in protected System Health. No extra database writers or
processes were introduced; persistence, offline queues and WebSockets retain
their existing behavior. Store write invalidation remains conservative,
including no-op writes, to preserve correctness during persistence failures.

An endpoint 401 triggers one shared `/api/auth/me` check. Only an authoritative
401 signs out the user; outages do not. A valid session can retry a GET once;
writes are never automatically replayed. Stale responses cannot restore a
signed-out/different session. Refresh updates the in-memory bearer token.
Missing accounts during a failed cache load return 503 rather than revocation.
The existing cookie, expiration, roster authorization and password-revision
checks remain enforced. Failed analysis refreshes retain existing rows and
offer Retry when no rows have loaded, without a UI redesign.

Requests log route template, status and duration, with `Server-Timing` and
warnings above one second. Auth failures log fixed reason codes without
credentials or account IDs.

## Measured calculations

Cold means invalidated derived caches with synthetic reports already in RAM.
Warm timings are the median of 100 calls. Complete JSON output SHA-256 hashes
match baseline for every paired dataset, covering all returned metric values.

| Teams / reports | Windows baseline | Windows fixed |
| --- | ---: | ---: |
| 73 / 147 | 990.672 ms | 47.068 ms |
| 73 / 1,470 | 11,046.155 ms | 404.164 ms |
| 150 / 6,000 | 93,648.816 ms | 1,727.100 ms |

Linux/WSL Python 3.12, actual systemd cgroup limits: CPUQuota=10% (0.1 CPU),
MemoryMax=512M, MemorySwapMax=0:

| Teams / reports | Baseline | Fixed | Fixed peak RSS |
| --- | ---: | ---: | ---: |
| 73 / 147 | 9,594.554 ms | 497.145 ms | 29.55 MiB |
| 73 / 735 | 49,592.313 ms | 2,104.744 ms | 39.18 MiB |
| 150 / 1,470 | 202,596.274 ms | 4,498.562 ms | 51.55 MiB |

Warm calculation medians were approximately 0.001 ms before and after; that
excludes HTTP overhead and serialization. RSS is cumulative process peak.

## Concurrent HTTP and health checks

Actual ASGI routes via httpx, cold cache before each batch, same resource limits.
The old Firestore probe is stubbed only for this comparison to isolate CPU
scheduling. Health time includes a 20-ms polling interval, event-loop delay and
response time. Authentication is overridden to avoid touching real accounts.

| Concurrent requests (73 / 147) | Baseline batch | Fixed batch | Baseline max health | Fixed max health |
| --- | ---: | ---: | ---: | ---: |
| 10 | 9.70 s | 1.00 s | 9.70 s | 0.40 s |
| 30 | 10.20 s | 1.30 s | 10.20 s | 0.49 s |
| 60 | 11.40 s | 2.20 s | 11.40 s | 1.10 s |
| 100 | 11.80 s | 2.70 s | 11.80 s | 0.81 s |

For 150 teams/1,470 reports, fixed batches of 10–100 requests took 5.81–9.09 s;
worst observed health delay was 2.40 s and process peak RSS 114.65 MiB. All
responses were 200 and identical within each batch. No tested fixed health
probe exceeded five seconds. Without stubbing the old connectivity probe,
baseline health delays were 20.93–23.74 s (includes local credential/network
initialization behavior, not a measurement of production Firestore latency).

These are synthetic, in-process ASGI tests with representative resource caps,
not Render load tests. They exclude proxy/TLS, production data loading and other
background jobs. Threads prevent the analysis from directly blocking the event
loop but do not eliminate GIL contention or make unlimited traffic safe.

## Authentication conclusions and deployment

The frontend's unconditional sign-out behavior is confirmed. The exact source
of the reported production 401s is **not confirmed** by available logs.
Expiration, revoked/reset credentials, old auth-version tokens, missing bearer
headers, transient account-cache unavailability, or a changed signing secret
are possibilities. CPU saturation itself does not turn a valid token into 401.
Use the new reason codes to distinguish these cases after deployment.

Keep the existing `HAZEHUB_SECRET` environment value across deployments.
`render.yaml` already provisions it as a persistent generated service variable;
this change does not rotate it or invalidate existing version-2 sessions.
Normal account revocation/password resets still require a new login. The
session TTL remains 14 days. Deleting/recreating the Render service with a new
secret cannot preserve its old signed sessions.

## Reproduction

From `backend`:

```sh
python -m pytest -q
python benchmarks/analysis_benchmark.py --output benchmarks/after.json
python benchmarks/analysis_benchmark.py --cases 73:147 --profile
sudo systemd-run --wait --pipe -p CPUQuota=10% -p MemoryMax=512M -p MemorySwapMax=0 /absolute/venv/bin/python /absolute/backend/benchmarks/analysis_benchmark.py --cases 73:147,73:735,150:1470
sudo systemd-run --wait --pipe -p CPUQuota=10% -p MemoryMax=512M -p MemorySwapMax=0 /absolute/venv/bin/python /absolute/backend/benchmarks/analysis_benchmark.py --cases 73:147,150:1470 --http --stub-probe
```

Use the same script in an isolated baseline checkout for before measurements.
The script seeds only process-local synthetic documents; it never starts the
database lifecycle. Raw results are in `backend/benchmarks/*.json`.
Frontend validation: production build plus the analysis-session, account-setup
and offline-auth Playwright suites (15 tests passed, with the corrected offline
team-chip selector rerun separately). Backend: 302 tests passed. Regression coverage includes output
equivalence, event-prior reuse, concurrent misses, revision changes during a
build, failed-build retry, responsive health, restored sessions and revocation.

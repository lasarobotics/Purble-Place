# Analysis and offline scouting

These features belong to the deployed `frontend` (Next.js) and `backend` (FastAPI/MongoDB)
applications. The separate root Vite/Express prototype is unchanged.

## Metrics

The backend computes phase accuracy; auto, teleop, and endgame point averages;
median output; recent form; scoring trend; attendance; operational reliability;
auto leave rate; and average fouls/stops, alongside the existing rankings,
consistency, schedule adjustment, and consensus metrics. Rates without a denominator
and trends without two observed matches are unavailable rather than fabricated zeros.
Scoring uses the existing configurable proxy in `backend/app/scoring.py`, not an
assertion of official game scoring. Most averages use attended reports; recent form
and trend first average multiple observers of the same match. Hover, keyboard focus,
or tap a metric label for its definition and formatted equation.

## Cloud processing and efficient access

`GET /api/admin/analysis` builds a shared event snapshot with one scouting query,
one schedule query, one batched profile query, and one batched scout-name query.
Per-team summaries are reused within the request. Metric rankings are transmitted
as team-number orders instead of repeating every summary. The client selects cloud
results for ranking, comparison, team details, filtered heatmaps, and consensus;
it does not calculate analytics formulas. Payloads are compressed.

Simultaneous readers share a request. Server change events invalidate the shared
snapshot and trigger a debounced refresh; reconnect also refreshes it. No derived
analytics documents are written. Unchanged ordinary API snapshots are not rewritten
in IndexedDB. Viewing a team no longer forces external TBA/Statbotics refreshes.

## Offline behavior

Open the production app online once to cache the app pages, schedule, authenticated
session, and cloud analysis snapshot. Service workers require HTTPS or localhost;
they are intentionally disabled in development mode. Scouting and saved cloud
analysis then work after disconnecting and reloading. Analysis displays its saved
state while offline; new metrics are computed in the cloud after queued data syncs.
Data never downloaded, first-time sign-in, live betting, remote video, and remote
external content still require connectivity.

Scouting drafts survive reloads. Reports are persisted before transmission, partitioned
by scout, and pinned to their original event. UUIDs and MongoDB unique indexes make
replays safe. Up to 100 entries sync in one batch with one bulk insertion, one match
lock update, one scout counter update, and one notification. Browser Web Locks avoid
parallel outbox flushes across tabs. Rejected reports remain available for correction;
older entries without ownership require explicit review. Authentication rejection
requires signing in again and does not discard queued reports.

## Controls and visualizations

Use **Change hotkeys** before starting a match. Bindings are saved per scout on the
device, require unique letters/numbers, and lock at Start scouting or the first
recorded observation. Holding a key, modifiers, and typing into form fields do not
trigger actions. Phase/result shortcuts select the next field tap; they do not
invent a shot location.

Heatmaps offer Both/Auto/Teleop, a shot-dot toggle, density and outcome legends,
cloud-calculated totals, and a full-size dialog. Trend graphs have responsive axes,
purple shading, smooth non-overshooting segments, and focusable/tappable points.

## Validation

Run `python -m pytest tests -q` from `backend` with its environment activated.
Run `npm run build` and `npm run test:e2e` from `frontend` (install Playwright Chromium
first). Browser tests use fixtures; production deployment and live database load
testing are separate steps.

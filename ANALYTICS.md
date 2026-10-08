# Analysis and offline scouting

The merged application uses Next.js, FastAPI and Firestore. The neutral grey panels,
purple accents, navigation and typography follow commit e3ed209.

## Cloud analysis

All metric formulas run in backend/app/analytics.py. Defense capability is average season-scored defensive-stop points divided by
the event scoring leader's average points, expressed on a percentage scale. It is
a proxy, not measured points prevented. Non-defense and failed reports contribute
zero. A missing or nonpositive reference makes the metric unavailable. The scoring
leader is the robot with the highest average attended-report score, with ties
broken by team number. Relative scoring and both defense windows share this
event-wide reference, regardless of the robots selected in Compare. Recent-four metrics use distinct matches, including playoff rounds. Skew
uses adjusted sample skewness and requires three reports. Ranking point predictions
are heuristics across qualification matches using season thresholds (event upper
quartiles when not configured). Tooltips explain formulas and their limitations.

The /api/admin/analysis snapshot is memoized against scouting, team, match, season
and scouter revisions. Reads use the Firestore write-through memory cache: viewing
analytics adds no Firestore queries or derived-document writes. The client shares
one compressed snapshot across rankings, comparison and team details. Live events
invalidate it and debounce refreshes. Unchanged API snapshots avoid IndexedDB writes.
Multi-instance deployments must enable the incoming cache's snapshot listeners;
otherwise retain its single-instance deployment setting.

## Offline operation

Open the app online once to cache its routes, scripts, schedule and analysis. Offline
analysis displays the last cloud snapshot; new offline reports are analyzed after
sync. No client-side analytics recalculation is performed. A previously unseen event
or uncached screen requires connectivity to download its data.

Scouting drafts and hotkeys are scoped to the signed-in scout. Reports are saved to
IndexedDB before networking, retain UUIDs, and keep local recovery copies after
acknowledgment. The sync endpoint accepts up to 50 records per request, uses atomic
Firestore creates to prevent overwrites, coalesces scout counters, and locks each
match once per batch. Transient errors retry; invalid or conflicting reports remain
available for correction. Cross-tab Web Locks prevent redundant flushes where
supported. The device recovery/export UI from the Firestore app remains available.
Legacy queue entries without an owner are retained for explicit recovery import.
Authenticated API responses are cached per account in IndexedDB, never in a shared
service-worker API cache. Authentication rejection never restores a cached session.

Hotkeys can be edited before Start match or the first recorded observation. They
stay locked until that report is saved. Restored drafts retain the lock.

## Verification

Run `backend/.venv/Scripts/python.exe -m pytest backend/tests` and, inside frontend,
`npm run build` then `npm run test:e2e`. Browser tests use mocked cloud responses;
they cover offline reload/sync, rejected report recovery, hotkeys, formula tooltips,
chart/heatmap controls, authentication rejection and mobile layout. They do not
claim to validate a deployed Firestore project or production quotas.

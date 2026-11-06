# 🟣 Purble Place

UI simplification and repository cleanup notes: [UI audit](UI_AUDIT.md).

The current TypeScript UI is in `frontend/`. The root Vite app is a separate legacy client.

**A centralized FRC scouting, strategy & picklist platform — Purple Haze themed (`#663399`).**

HazeHub replaces a local PurpleScout setup with a single web app that runs anywhere:
collect match & pit scouting, build collaborative picklists, review film against the
data, bet Purple Bucks on matches, and let strategy auto-rank robots by *true* strength.

The database is **Cloud Firestore** (Firebase project `hazehub-8a941`, free Spark
plan). The server — web app and API in one process — runs on the team's own scouting
laptop, which is what keeps the project off the paid plan and keeps the app fast when
venue wifi isn't. It's built to keep a 60-person, 12-hour competition day inside
Firestore's free daily allowance. **Setup walkthrough: [instructions.txt](instructions.txt).**

**Cloudflare Workers staging** (separate from production): an orchestrated Workers + D1 +
Durable Objects + Queues foundation lives in [`cloudflare/`](cloudflare/). It does **not**
replace the Render/Firestore backend until migration is validated. See
[`cloudflare/ARCHITECTURE.md`](cloudflare/ARCHITECTURE.md).

---

## ✨ Features

### For everyone
- **Sign in** with one of the 65 IDs imported from `Untitled spreadsheet (1).xlsx`.
  On first use, enter the ID, then create and confirm a unique password in the popup.
  Later sign-ins use that personal password. Unknown IDs cannot create accounts.
- **Home** — quick instructions and links to Scouting, Pits and the event schedule.
- **Pits** — rotations and match schedules for 418/436, imported from an admin-configurable Google Sheet. See [Pits setup](PITS.md).
- **Match Scouting** — tap-the-field map for made shots (auto/teleop), endgame
  climb, defense, driver/speed ratings, fouls, failures, and notes.
  - **Station memory:** alliance and station are remembered between matches.
  - **Pull from schedule:** auto-fills the team you're watching from the TBA schedule.
  - **Offline-first:** if the connection drops, entries are saved in IndexedDB and
    sync automatically (and de-duplicate) when you're back online.
- **Pre-Match** — while you wait, browse both alliances with team avatars, **expandable
  robot photos**, EPA and pit notes (pulled from The Blue Alliance + Statbotics).
- **Purple Bucks Betting** — odds come from Statbotics win predictions. Heavy favourites
  pay little (a 99% favourite → ~5% profit); underdogs pay big. Bets **lock when the
  match starts** and can't be changed. Everyone starts with **100 PB**.
- **Picklists** — build your own, or collaborate on the shared **master picklist**.

### Shared analysis tools and Admin controls
- **Dashboard (Admin only)** — set the event (syncs the TBA schedule), advance the current match
  (auto-settles bets), turn betting **on/off**, **reset everyone to 100 PB**, lock
  individual matches, and set match results.
- **Team Search** — every match for a team + a **field heatmap overlay** of all their
  scoring positions (filter auto/teleop), trend chart, and the complete pit report
  with every robot photo.
- **Data** — live raw match and pit scouting records, cached on each device for
  offline review with CSV and JSON export.
- **Team Rank** — rank all teams by any metric (avg points, consistency, climb rate, EPA…).
- **Data Picklist** — auto-ranks robots by **true strength**, discounting teams that look
  good only because they keep drawing weak opponents / strong partners (strength of
  schedule). Each row shows base score, reliability, opponent EPA, partner EPA and the
  schedule adjustment so you can see *why* a team ranks where it does.
- **Compare Robots** — side-by-side comparison of 2–6 robots with the best value in each
  row highlighted, plus each robot's heatmap.
- **All Pick Lists** — every picklist made across the team in one place.

Live updates (new scouting, bets, picklist edits, match changes) push to every connected
device over WebSockets, with a polled fallback on the same client-side bus.

---

## 🚀 Quick start (Windows)

```powershell
# 1. One-time setup: Python env, npm install, demo event
./setup.ps1

# 2a. Development — hot-reloading frontend on :3000, API on :8000
./start.ps1

# 2b. Event day — one process serving the app + API on :8000 for everyone
./run-server.ps1 -OpenFirewall
```

`start.ps1` opens **http://localhost:3000**. `run-server.ps1` prints the LAN address
the tablets should use, e.g. **http://192.168.1.47:8000**. Sign in:

| ID | Password | Role |
|----|----------|------|
| `admin` | `HazeRain!` | Administrator |
| Spreadsheet IDs | Personal password created on first use | Members |

Setup seeds a full demo event (`2026haze`: 12 teams, 18 matches, scouting data, bets
and picklists) so every screen has data immediately. Until you point it at Firebase,
data goes to a local JSON file and `/api/health` says so — see
[instructions.txt](instructions.txt) to connect Firestore.

### Manual start (any OS)

```bash
# Backend  (http://localhost:8000, interactive docs at /docs)
cd backend
python -m venv .venv && . .venv/Scripts/activate      # or source .venv/bin/activate
pip install -r requirements.txt
python -m app.demo_data            # optional: seed demo data
uvicorn app.main:app --reload --port 8000

# Frontend (http://localhost:3000)  — in a second terminal
cd frontend
npm install
npm run dev
```

For the single-process event build, build the frontend first — the backend serves
`frontend/out` at `/` whenever it exists:

```bash
cd frontend && NEXT_PUBLIC_API_URL= HAZEHUB_STATIC_EXPORT=1 npm run build && cd ..
cd backend && uvicorn app.main:app --host 0.0.0.0 --port 8000
```

---

## 🏗️ Architecture

```
Chromebook / phone ──► Next.js (TypeScript) ──► FastAPI (Python) ──► Cloud Firestore
   IndexedDB (Dexie)     Firebase Hosting        Cloud Run              (the database)
   offline queue         /api/** + /ws rewrite   in-memory read cache
                                                 TBA + Statbotics
                                                 Purple Bucks odds engine
```

| Layer | Local dev | Production |
|-------|-----------|------------|
| Frontend | `next dev` | Static export → **Firebase Hosting** |
| Backend | `uvicorn` | **Cloud Run** (FastAPI, WebSocket ingress, 1 instance) |
| Database | Firestore emulator, or a JSON file | **Cloud Firestore** |
| Realtime | WebSocket (`/ws`) | same, with an in-process polled fallback |
| Offline | Dexie / IndexedDB | same |

### Staying inside Firestore's quotas

Firestore's free allowance is 50,000 document reads a day. Sixty people using
the app for twelve hours, each device polling for live updates, would exhaust
that within minutes if every device read Firestore directly. So they don't:

- **Reads are served from RAM.** The API loads the event into memory once at
  startup and serves every HTTP GET from a dictionary. Steady-state reads are
  effectively zero.
- **Writes are dirty-checked.** Saving an unchanged document costs nothing —
  which is why re-syncing a 120-match schedule on every match advance writes
  one or two documents, not 120.
- **Counters are coalesced** and bulk work is **batched** below Firestore's
  500-operations-per-commit limit.
- **The live-updates feed is in-process**, not a Firestore collection: it
  would otherwise cost thousands of writes and deletes a day for data with a
  two-hour lifespan.
- Big JSON fields (heatmaps, picklist items, avatars) are **exempt from
  indexing**, and every document is size-checked against the 1 MiB limit
  before a write is attempted.

A measured 12-hour day with 60 people, 100 matches and ~750 submissions comes
in around 5–10% of the free tier. `GET /api/admin/firestore-usage` (and the
admin System page) shows live usage against the allowance.

Because the cache is authoritative, the API **must run as a single instance**
(`--max-instances=1`). Set `HAZEHUB_FIRESTORE_LISTEN=1` to switch to Firestore
snapshot listeners if you ever need to scale out — correct under concurrency,
but it costs a read per change.

### One container, whole app

The root [Dockerfile](Dockerfile) builds the web app and copies it in next to
the API, so a single image serves both on one origin. That is what deploys to
Render — and what you can run anywhere else:

```bash
docker build -t hazehub .
docker run -p 8000:8000 -e FIREBASE_PROJECT_ID=hazehub-8a941 \
  -e FIREBASE_SERVICE_ACCOUNT="$(cat key.json)" hazehub
```

For local development against a Firestore emulator instead:

```bash
docker compose up --build
# web -> http://localhost:3000   api -> http://localhost:8000/docs   db UI -> :4000
```

### Deploying

| Target | Plan | Notes |
|--------|------|-------|
| **Scouting laptop** | free | `./run-server.ps1` — LAN only, survives a dead venue uplink |
| **Render** | free | [render.yaml](render.yaml) blueprint, public HTTPS URL, sleeps when idle |
| Cloud Run + Hosting | Blaze | [deploy/cloud-run-optional.ps1](deploy/cloud-run-optional.ps1), ~$3–5/mo |

Firestore rules and the index policy are the only things pushed to Firebase:

```powershell
firebase login
./deploy/firestore.ps1
```

Full walkthrough — Firebase project, database region, service-account key,
Render setup and quota monitoring — in **[instructions.txt](instructions.txt)**.

> **Not Vercel.** Vercel runs Python as short-lived serverless functions; every
> cold instance would re-read the event from Firestore and blow past the free
> read quota several times over. HazeHub needs a container host, not a
> function host.

### How the environment switch works
The backend resolves its datastore at startup (`backend/app/config.py`,
`backend/app/cache.py`):
- `FIRESTORE_EMULATOR_HOST` set → the local Firestore emulator, no credentials.
- `FIREBASE_PROJECT_ID` set (or running on Cloud Run, where it is discovered
  automatically) → Cloud Firestore.
- Neither → a JSON file under `backend/data/`, so a fresh clone runs offline.
  `/api/health` says so loudly.

The frontend reads `NEXT_PUBLIC_API_URL` (defaults to `http://localhost:8000`).
Leave it **empty** for Firebase Hosting: `/api/**` and `/ws` are rewritten to
Cloud Run, so the app is single-origin with no CORS.

### Security model
Firestore is reached only by this API, through the Firebase Admin SDK.
`firestore.rules` therefore denies every client read and write — no browser
ever holds a Firestore credential. Roster members create personal passwords, stored as salted scrypt hashes, and receive
HMAC-signed tokens. Only `Admin` can access the Event dashboard, System Health,
and their control APIs. Other tools are available to every roster member.

On backend startup, the account migration keeps `Admin` (including a legacy lowercase
`admin`), removes accounts outside `backend/app/account_roster.json`, and creates the
65 roster accounts awaiting password setup. Historical scouting records are retained.
The migration is repeatable and preserves passwords on later restarts. Previous
sessions are invalidated. Legacy `HAZEHUB_ACCOUNTS` and role-ID overrides no longer
change the roster. Admin retains its configured `HAZEHUB_TEAM_PASSWORD` credential
unless it already has a personal password hash.

First-time setup claims an unused roster ID without an email verification step.
Users should claim only their own ID. The popup includes the requested password
reuse warning and explains that administrators manage account data while passwords
are stored as hashes.

---

## 🔌 External APIs
- **The Blue Alliance** — match schedules, team profiles, avatars, robot photos.
- **Statbotics** — team EPA and match win probabilities (drives the betting odds).

Both are cached in the database with a stale-fallback, so the app keeps working on a
spotty venue connection. Keys live in `backend/.env` (see `.env.example`).

---

## 📁 Project layout
```
backend/
  app/
    main.py            FastAPI app, routers, WebSocket
    config.py          env detection (local vs Azure), DB url
    models.py          SQLModel tables
    auth.py            sign-in + tokens
    external.py        TBA + Statbotics clients (cached)
    gamedef.py         the generic model of an FRC game + the scoring engine
    seasons.py         seasons: create, configure, version, roll over
    forms.py           field types, validation, diffing, the starting forms
    form_store.py      form history: append-only, attributed, revertible
    scoring.py         turns a scouting entry into points, reading game.py
    archive.py         rolls a finished event into one durable document
    analytics.py       summaries, rank, strength-of-schedule, compare
    betting_logic.py   Purple Bucks odds engine
    demo_data.py       seed a full demo event
    routers/           auth, scouting, betting, picklists, teams, matches, admin, sync
frontend/
  src/
    app/               Next.js App Router pages (login, home, scout, pit, admin/*, ...)
    components/        Field heatmap, charts, shell/nav, team detail, UI kit
    lib/               api client, auth, Dexie offline queue, websocket, game, types
  public/
    sw.js              service worker: the app keeps working with no signal
```

## 🧱 Form Builder

**Admin > Form Builder** designs the scouting forms in the app. No code, no
deploy: the scouting and pit pages render whatever the forms say, so a new
game is a form change.

Fourteen field types, none of which name a game element: counters, ratings,
choose-one and choose-many, quick tags, a stopwatch, a team picker, a camera
field, a field map, and plain text. Between them they express every scouting
form the team has run, from stacking games to shooting games to grid games.

Fields can carry point values, so a form scores a game this build has never
heard of. They can also be conditional ("only ask the defense rating if they
played defense"). A live preview sits beside the editor and is rendered by the
same component the scouts use, so what you are designing is the form itself.

**Version history works like git.**

| | |
|---|---|
| Save | Writes a new version. Nothing is ever edited in place. |
| Author + message | Every version records who and why. |
| Diff | Field by field, keyed on the field, so a reshuffle reads as a move. |
| Publish | Separate from saving, so a change can be drafted first. |
| Revert | Writes a *new* version copying an old one. The versions in between stay, so a revert is itself revertible. |
| Delete | Archives. The history is kept and the form can be restored. |

Two guard rails. A field's key is the name its answers are stored under
forever, so it is locked once saved: renaming the label is free, renaming the
key is not offered. And dropping a field the built-in analytics read is
allowed but never silent, because "where did the climb rate go" is a question
somebody asks three weeks later.

Answers to fields that have no column of their own are stored in the
submission's `responses` map with the form version that collected them, so a
form rebuilt for a new game needs no schema change.

## 🗓️ Rolling over to a new season

FRC changes the game every January, so the scouting form has to change with
it. Everything game-specific lives in **one file**: `backend/app/game.py`.

1. Copy the `GAME_2026` block, rename it for the new year, and edit the
   values: `season`, `name`, the scoring numbers, `endgame_label`, the
   `endgame` levels, and the quick `tags`.
2. Add it to the `GAMES` dict.
3. Replace the field image at `frontend/public/field.png` and
   `backend/app/static_field/field.png`.

That is the whole job. No TypeScript changes: the scouting form fetches the
definition from `GET /api/game` and renders the endgame buttons and tag chips
from it, caching a copy on each device so a scout with no signal still gets
the right form. `game.py` also seeds the starting forms, which the Form
Builder above then edits. Scoring, the analytics and the insight rules all read the same
object, and each stored entry keeps the season it was collected under, so last
year's numbers are not silently rewritten by this year's rules.

To run a past season (for testing, or to replay last year's event), set
`HAZEHUB_SEASON=2026` and restart.

## 📦 What happens when an event ends

Only the current event is mirrored into memory, which is what keeps a whole
season off Firestore's free-tier read budget. So when an admin sets a new
event, the outgoing one is rolled up into a single `event_archives` document
first: per-team aggregates, the final pick order, the pit reports and the
totals. One read gets the whole event back, which is what makes "how did 254
look at their last regional" answerable in the pit at the next one.

It happens automatically on an event change, and `POST /api/admin/archives/<key>`
re-runs it by hand (safe to repeat) if late scouting syncs in afterwards.

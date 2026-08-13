# 🟣 HazeHub

**A centralized FRC scouting, strategy & picklist platform — Purple Haze themed (`#663399`).**

HazeHub replaces a local PurpleScout setup with a single web app that runs anywhere:
collect match & pit scouting, build collaborative picklists, review film against the
data, bet Purple Bucks on matches, and let strategy auto-rank robots by *true* strength.

The database is **Cloud Firestore** (Firebase project `hazehub-8a941`, free Spark
plan). The server — web app and API in one process — runs on the team's own scouting
laptop, which is what keeps the project off the paid plan and keeps the app fast when
venue wifi isn't. It's built to keep a 60-person, 12-hour competition day inside
Firestore's free daily allowance. **Setup walkthrough: [instructions.txt](instructions.txt).**

---

## ✨ Features

### For everyone
- **Sign in** with a Scouter ID + shared team password (`HazeRain!`). New IDs are created
  on first sign-in. Demo accounts: **`1`, `2`, `3`** (scouts) and **`admin`**.
- **Home** — live Top-Bettors leaderboard, the match on the field, and your open bets.
- **Match Scouting** — tap-the-field heatmap for every scoring attempt (auto/teleop,
  made/missed), endgame climb, defense, driver/speed ratings, fouls, failures, notes,
  and **quick tags** — one-tap structured qualitative chips ("Fast cycles",
  "Died on field", …) that aggregate on the team profile.
  - **Station memory:** your alliance + station are remembered between matches.
  - **Pull from schedule:** auto-fills the team you're watching from the TBA schedule.
  - **Offline-first:** if the connection drops, entries are saved in IndexedDB and
    sync automatically (and de-duplicate) when you're back online.
- **Pre-Match** — while you wait, browse both alliances with team avatars, **expandable
  robot photos**, EPA and pit notes (pulled from The Blue Alliance + Statbotics).
- **Film Review** — embedded **YouTube** paired with the scouting data for that match.
- **Purple Bucks Betting** — odds come from Statbotics win predictions. Heavy favourites
  pay little (a 99% favourite → ~5% profit); underdogs pay big. Bets **lock when the
  match starts** and can't be changed. Everyone starts with **100 PB**.
- **Picklists** — build your own, or collaborate on the shared **master picklist**.
- **Haze Intel** — every team profile carries an AI-assisted summary (headline,
  role, picklist verdict, strengths/concerns) where **every claim cites the
  scouting evidence** behind it. Works offline via a built-in rules engine and
  upgrades to Claude automatically when `ANTHROPIC_API_KEY` is set.

### Admin (everything above, plus)
- **Dashboard** — set the event (syncs the TBA schedule), advance the current match
  (auto-settles bets), turn betting **on/off**, **reset everyone to 100 PB**, lock
  individual matches, and set match results.
- **Team Search** — every match for a team + a **field heatmap overlay** of all their
  scoring positions (filter auto/teleop), trend chart and breakdown.
- **Team Rank** — rank all teams by any metric (avg points, consistency, climb rate, EPA…).
- **Data Picklist** — auto-ranks robots by **true strength**, discounting teams that look
  good only because they keep drawing weak opponents / strong partners (strength of
  schedule). Each row shows base score, reliability, opponent EPA, partner EPA and the
  schedule adjustment so you can see *why* a team ranks where it does.
- **Compare Robots** — side-by-side comparison of 2–6 robots with the best value in each
  row highlighted, plus each robot's heatmap.
- **Consensus Radar** — scout disagreement detection. Flags teams where scouts who
  covered the same match landed far apart, and teams whose scored output percentile
  diverges from their qualitative percentile (ratings, tags, failures) — the exact
  teams to re-watch on film before the picklist locks.
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
| `1`, `2`, `3` | `HazeRain!` | Scouts |

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
ever holds a Firestore credential. Scouters sign in with a shared team
password and get an HMAC token; the API enforces the admin-only routes.

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
    scoring.py         2026 "Rebuilt" point proxy  ← tune scoring here
    analytics.py       summaries, rank, strength-of-schedule, compare
    betting_logic.py   Purple Bucks odds engine
    demo_data.py       seed a full demo event
    routers/           auth, scouting, betting, picklists, teams, matches, admin, sync
frontend/
  src/
    app/               Next.js App Router pages (login, home, scout, betting, admin/*, …)
    components/        Field heatmap, charts, shell/nav, team detail, UI kit
    lib/               api client, auth, Dexie offline queue, websocket, types
```

> Tuning game scoring: the 2026 point values live in `backend/app/scoring.py`. Adjust the
> constants there once official scoring is confirmed and every ranking updates.

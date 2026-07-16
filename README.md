# 🟣 HazeHub

**A centralized FRC scouting, strategy & picklist platform — Purple Haze themed (`#663399`).**

HazeHub replaces a local PurpleScout setup with a single web app that runs anywhere:
collect match & pit scouting, build collaborative picklists, review film against the
data, bet Purple Bucks on matches, and let strategy auto-rank robots by *true* strength.
It runs locally today on SQLite and **automatically switches to Azure** (PostgreSQL +
Container Apps) when the Azure environment variables are present.

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
device over WebSockets — the local stand-in for Azure SignalR.

---

## 🚀 Quick start (Windows)

```powershell
# 1. One-time setup: installs everything + seeds a demo event
./setup.ps1

# 2. Launch backend + frontend (each in its own window)
./start.ps1
```

Then open **http://localhost:3000** and sign in:

| ID | Password | Role |
|----|----------|------|
| `admin` | `HazeRain!` | Administrator |
| `1`, `2`, `3` | `HazeRain!` | Scouts |

The setup seeds a full demo event (`2026haze`: 12 teams, 18 matches, scouting data, bets
and picklists) so every screen has data immediately.

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

---

## 🏗️ Architecture

```
Chromebook / phone ──► Next.js (TypeScript)  ──►  FastAPI (Python)  ──►  SQLite / PostgreSQL
   IndexedDB (Dexie)      Purple Haze UI           SQLModel + ORM         (local / Azure)
   offline queue          WebSocket live           TBA + Statbotics
                                                    Purple Bucks odds engine
```

| Layer | Local (now) | Azure (production) |
|-------|-------------|--------------------|
| Frontend | `next dev` | Static export → **Azure Static Web Apps** |
| Backend | `uvicorn` | **Azure Container Apps** (FastAPI, WebSocket ingress) |
| Database | SQLite file | **Azure Database for PostgreSQL** |
| Realtime | WebSocket (`/ws`) | same code / swap to **Azure SignalR** |
| Offline | Dexie / IndexedDB | same |

### Docker (mirrors the Azure topology)

With Docker installed, one command runs the production stack — PostgreSQL +
FastAPI + Next.js — exactly like it runs on Azure:

```bash
docker compose up --build
# web -> http://localhost:3000   api -> http://localhost:8000/docs
```

Images: [backend/Dockerfile](backend/Dockerfile) (uvicorn, port 8000) and
[frontend/Dockerfile](frontend/Dockerfile) (Next.js standalone, port 3000 —
pass `--build-arg NEXT_PUBLIC_API_URL=<api url>` since `NEXT_PUBLIC_*` is
inlined at build time).

### Deploy to Azure Container Apps

```powershell
az login
az extension add --name containerapp --upgrade
./deploy/azure-containerapps.ps1
```

The script ([deploy/azure-containerapps.ps1](deploy/azure-containerapps.ps1))
provisions the resource group, container registry, **Azure Database for
PostgreSQL**, the Container Apps environment, and both apps — building the
images in the cloud with `az acr build`, so you don't need Docker locally.
Re-run it to ship updates. It prints the live web/API URLs and the generated
Postgres password when it finishes.

### How the Azure switch works
The backend reads its environment at startup (`backend/app/config.py`):
- If `DATABASE_URL` is set (e.g. an Azure Postgres connection string) it uses
  PostgreSQL via `psycopg`; otherwise it uses a local SQLite file — **no code change**.
- It detects Azure via `WEBSITE_SITE_NAME` / `CONTAINER_APP_NAME` and relaxes CORS for
  Static Web Apps. The health endpoint (`/api/health`) reports the active environment.

The frontend reads `NEXT_PUBLIC_API_URL` (defaults to `http://localhost:8000`). For Azure,
set it to your Container Apps URL and build with `HAZEHUB_STATIC_EXPORT=1 npm run build`.

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

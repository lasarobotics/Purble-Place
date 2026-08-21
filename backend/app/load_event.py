"""Load a real TBA event into HazeHub, plus synthetic data for testing.

    .venv\\Scripts\\python -m app.load_event            # 2026txcmp2 (Apollo)
    .venv\\Scripts\\python -m app.load_event 2026txcmp1 # any other event

What it does
------------
1. Syncs the real match schedule (incl. YouTube match videos) from TBA.
2. Syncs EVERY team at the event from TBA: profile, avatar, robot photos,
   Statbotics EPA: plus the home teams (418 Purple Haze, 436 Purple Rain).
3. Generates synthetic scouting entries for the played matches so rankings,
   heatmaps and the Data Picklist have data. Synthetic skill is derived from
   each team's real EPA, so the numbers are plausible.
4. Appends a block of FAKE, unplayed test matches after the real schedule so
   betting / pre-match flows can be exercised (real 2026 matches are already
   decided and therefore locked).
5. Points the app at the event and sets the current match.

Everything is idempotent: re-running wipes and rebuilds this event's documents.

Cost note: this is the most Firestore-expensive thing HazeHub does: roughly
one write per team, per match and per synthetic entry (a few thousand for a
district championship). Run it **once** while setting up, not repeatedly, and
check ``GET /api/admin/firestore-usage`` afterwards.
"""
from __future__ import annotations

import asyncio
import random
import sys
from datetime import datetime, timezone

from . import repo
from .cache import store
from .config import settings
from .database import close_db, init_db
from .external import sync_event_matches, sync_team, tba
from .models import MatchRecord, ScoutEntry
from .scoring import compute_points
from .seed import seed

DEFAULT_EVENT = "2026txcmp2"  # FIRST In Texas District Championship - Apollo
FAKE_MATCHES = 12
SCOUTS = ["1", "2", "3"]

NOTES = [
    "Fast cycler, clean driving.",
    "Struggled under defense pressure.",
    "Reliable climb every match.",
    "Strong auto routine.",
    "Brief mechanical hiccup mid-match.",
    "Good partner communication.",
    "",
]


def _heatmap(skill: float) -> list[dict]:
    pts = []
    for _ in range(random.randint(1, 4)):
        made = random.random() < 0.4 + skill * 0.4
        pts.append({"x": random.uniform(0.1, 0.45), "y": random.uniform(0.15, 0.85),
                    "phase": "auto", "result": "made" if made else "missed"})
    for _ in range(random.randint(4, 12)):
        made = random.random() < 0.45 + skill * 0.45
        pts.append({"x": random.uniform(0.1, 0.9), "y": random.uniform(0.1, 0.9),
                    "phase": "teleop", "result": "made" if made else "missed"})
    return pts


def _entry(event: str, mn: int, team: int, alliance: str, station: int, skill: float) -> ScoutEntry:
    data = {
        "event_key": event, "match_number": mn, "comp_level": "qm",
        "team_number": team, "alliance": alliance, "station": station,
        "scout_id": random.choice(SCOUTS),
        "auto_leave": random.random() < 0.85,
        "auto_climb": random.random() < skill * 0.4,
        "heatmap": _heatmap(skill),
        "climb": random.choices(["none", "l1", "l2", "l3"], weights=[0.2, 0.3, 0.3, 0.2 + skill])[0],
        "played_defense": random.random() < 0.25,
        "defense_rating": random.randint(0, 5),
        "defense_on": "",
        "successful_stops": random.randint(0, 3),
        "driver_skill": min(5, max(1, round(skill * 5 + random.uniform(-1, 1)))),
        "speed_rating": min(5, max(1, round(skill * 5 + random.uniform(-1, 1)))),
        "fouls": random.choices([0, 1, 2], weights=[0.75, 0.18, 0.07])[0],
        "failure": random.random() < 0.07,
        "failure_details": "",
        "notes": random.choice(NOTES),
    }
    return ScoutEntry.from_submission({**data, "points": compute_points(data)})


async def load(event_key: str) -> None:
    init_db()
    seed()

    print(f"[1/5] Syncing real schedule for {event_key} from The Blue Alliance...")
    # Scope the cache to this event, then rebuild it from scratch.
    repo.set_setting("current_event", event_key)
    repo.delete_scouting_for_event(event_key)
    repo.delete_all_bets()
    repo.delete_matches_for_event(event_key)

    matches = await sync_event_matches(event_key)
    if not matches:
        print("  !! Could not reach TBA (or event has no matches).")
        print("  Falling back is easy: run  python -m app.demo_data  for offline demo data.")
        close_db()
        return
    qm = sorted([m for m in matches if m.comp_level == "qm"], key=lambda m: m.match_number)
    with_video = sum(1 for m in matches if m.youtube_key)
    print(f"  {len(matches)} matches ({len(qm)} quals), {with_video} with YouTube video.")

    print("[2/5] Loading every event team from TBA (profile, avatar, photos, EPA)...")
    team_rows = await tba(f"/event/{event_key}/teams/simple", ttl=86400) or []
    event_teams = sorted(int(t["team_number"]) for t in team_rows)
    all_teams = sorted(set(event_teams) | set(settings.HOME_TEAMS))
    for i, t in enumerate(all_teams, 1):
        await sync_team(t)
        if i % 10 == 0 or i == len(all_teams):
            print(f"  {i}/{len(all_teams)} teams synced")

    # Skill map from real EPA for plausible synthetic scouting.
    epas = {}
    for t in event_teams:
        tc = repo.team(t)
        epas[t] = float(tc.epa) if tc and tc.epa is not None else None
    known = [v for v in epas.values() if v is not None]
    lo, hi = (min(known), max(known)) if known else (0.0, 1.0)
    rng = (hi - lo) or 1.0
    skill = {t: (0.5 if v is None else max(0.05, min(0.98, (v - lo) / rng)))
             for t, v in epas.items()}

    print("[3/5] Generating synthetic scouting for played matches...")
    played = [m for m in qm if m.winner is not None]
    entries: list[ScoutEntry] = []
    for m in played:
        for alliance, roster in (("red", m.red), ("blue", m.blue)):
            for idx, t in enumerate(roster, 1):
                entries.append(
                    _entry(event_key, m.match_number, t, alliance, idx, skill.get(t, 0.5))
                )
    store.write_many(entries)
    print(f"  {len(entries)} entries across {len(played)} matches.")

    print(f"[4/5] Adding {FAKE_MATCHES} fake unplayed matches for testing...")
    last = qm[-1].match_number if qm else 0
    pool = event_teams[:]
    fakes: list[MatchRecord] = []
    for i in range(1, FAKE_MATCHES + 1):
        mn = last + i
        roster = random.sample(pool, 6)
        # Sprinkle the home teams through the fakes so 418/436 show up.
        for slot, home in enumerate(settings.HOME_TEAMS):
            if home in all_teams and i % 2 == slot % 2:
                if home not in roster:
                    roster[slot] = home
        fake = MatchRecord(
            match_key=f"{event_key}_qm{mn}", event_key=event_key,
            comp_level="qm", match_number=mn,
        )
        fake.set_alliances(roster[:3], roster[3:])
        fakes.append(fake)
    repo.save_matches(fakes)

    print("[5/5] Pointing the app at the event...")
    repo.set_setting("current_match", str(last))  # fakes (last+1...) stay open for bets
    repo.set_setting("betting_enabled", "1")
    close_db()

    print()
    print(f"Done. Event {event_key}: {len(qm)} real quals ({with_video} videos), "
          f"{FAKE_MATCHES} fake test matches open for betting.")
    print("Sign in as admin / 1 / 2 / 3 with team password 'HazeRain!'.")
    from .firestore_db import guard
    ops = guard.snapshot()["operations"]
    print(f"Firestore ops used: {ops['read']['used']} reads, "
          f"{ops['write']['used']} writes, {ops['delete']['used']} deletes.")


if __name__ == "__main__":
    key = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_EVENT
    asyncio.run(load(key))

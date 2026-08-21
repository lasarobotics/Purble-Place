"""Generate a self-contained demo event so HazeHub is fully explorable without
any network/TBA access.

Run from the backend folder:
    .venv\\Scripts\\python -m app.demo_data

Everything is written through the batched write path, so seeding the demo
event costs roughly 250 Firestore write operations in a handful of commits.
"""
from __future__ import annotations

import os
import random
import sys
from datetime import datetime, timezone

from . import repo
from .cache import store
from .config import settings
from .database import close_db, init_db
from .models import Event, MatchRecord, Picklist, PitEntry, ScoutEntry, TeamCache
from .scoring import compute_points
from .seed import seed

EVENT = "2026haze"
TEAMS = [118, 254, 469, 973, 1011, 1114, 1234, 1678, 1986, 2056, 2767, 3310]
NICKS = {
    118: "Robonauts", 254: "Cheesy Poofs", 469: "Las Guerrillas", 973: "Greybots",
    1011: "CRescendo", 1114: "Simbotics", 1234: "Deus Ex Machina", 1678: "Citrus Circuits",
    1986: "Team Titanium", 2056: "OP Robotics", 2767: "Stryke Force", 3310: "Black Hawk",
}
SCOUTS = ["1", "2", "3"]
# Each scout counts slightly differently: feeds the Consensus Radar.
SCOUT_BIAS = {"1": 1.0, "2": 0.82, "3": 1.14}

POSITIVE_TAGS = ["Fast cycles", "Strong auto", "Clutch climb", "Great defense",
                 "Smart driver", "Consistent", "Good under pressure", "Great partner"]
NEGATIVE_TAGS = ["Died on field", "Dropped pieces", "Slow cycles", "Tippy / unstable",
                 "Penalty prone", "Struggled vs defense", "Comms issues"]
FAILURES = ["lost comms mid-match", "drivetrain stalled", "intake jammed",
            "browned out", "arm chain snapped"]


def _tags(skill: float, failed: bool) -> list[str]:
    tags: list[str] = []
    for t in random.sample(POSITIVE_TAGS, 3):
        if random.random() < skill * 0.55:
            tags.append(t)
    for t in random.sample(NEGATIVE_TAGS, 3):
        if random.random() < (1 - skill) * 0.4:
            tags.append(t)
    if failed and "Died on field" not in tags:
        tags.append("Died on field")
    return tags


def _heatmap(skill: float, bias: float = 1.0) -> list[dict]:
    pts = []
    auto_attempts = random.randint(1, 4)
    tele_attempts = max(2, round(random.randint(4, 12) * bias))
    for _ in range(auto_attempts):
        made = random.random() < (0.4 + skill * 0.4) * bias
        pts.append({"x": random.uniform(0.1, 0.45), "y": random.uniform(0.15, 0.85),
                    "phase": "auto", "result": "made" if made else "missed"})
    for _ in range(tele_attempts):
        made = random.random() < min(0.95, (0.45 + skill * 0.45) * bias)
        pts.append({"x": random.uniform(0.1, 0.9), "y": random.uniform(0.1, 0.9),
                    "phase": "teleop", "result": "made" if made else "missed"})
    return pts


def confirm_target() -> bool:
    """Refuse to seed a real Firestore database without an explicit go-ahead.

    ``setup.ps1`` calls this module, and once ``.env`` points at the live
    project that would push ~250 fake documents into the database the team
    competes with. The emulator and the local dev store are fair game.
    """
    if settings.ENVIRONMENT not in ("firebase", "cloud-run"):
        return True
    if os.getenv("HAZEHUB_ALLOW_DEMO_ON_FIRESTORE") == "1":
        return True
    print(
        f"Refusing to seed demo data into the live Firestore project "
        f"'{settings.FIREBASE_PROJECT_ID}'.\n"
        "\n"
        "This would write ~250 fake documents (event 2026haze) to the database\n"
        "your team competes with, and count against the daily write quota.\n"
        "\n"
        "  To seed a local sandbox instead, point at the emulator:\n"
        "      $env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'\n"
        "\n"
        "  To load a REAL event into Firestore, use:\n"
        "      python -m app.load_event 2026txman\n"
        "\n"
        "  If you really do want demo data in this project:\n"
        "      $env:HAZEHUB_ALLOW_DEMO_ON_FIRESTORE = '1'"
    )
    return False


def generate() -> None:
    if not confirm_target():
        return
    init_db()
    seed()

    # Point the cache at the demo event before writing, so the event-scoped
    # collections mirror what we are about to create.
    repo.set_setting("current_event", EVENT)

    # Clear any previous demo rows for a clean slate.
    repo.delete_scouting_for_event(EVENT)
    repo.delete_matches_for_event(EVENT)
    repo.delete_all_bets()
    for p in repo.picklists(EVENT):
        repo.delete_picklist(p.id)

    ev = repo.event(EVENT) or Event(event_key=EVENT)
    ev.name = "Haze Invitational (Demo)"
    ev.start_date = datetime.now(timezone.utc).date()
    repo.save_event(ev)

    # Teams + EPA (skill 0..1 maps to EPA ~25..75).
    skill: dict[int, float] = {}
    team_rows: list[TeamCache] = []
    for t in TEAMS:
        sk = random.uniform(0.25, 0.95)
        skill[t] = sk
        tc = repo.team(t) or TeamCache(team_number=t)
        tc.nickname = NICKS.get(t, f"Team {t}")
        tc.epa = round(25 + sk * 50, 1)
        tc.city, tc.state, tc.country = "Demo City", "TX", "USA"
        team_rows.append(tc)
    store.write_many(team_rows)

    # Build a qual schedule.
    n_matches = 18
    match_rows: list[MatchRecord] = []
    entry_rows: list[ScoutEntry] = []
    for mn in range(1, n_matches + 1):
        picks = random.sample(TEAMS, 6)
        red, blue = picks[:3], picks[3:]
        rec = MatchRecord(match_key=f"{EVENT}_qm{mn}", event_key=EVENT,
                          comp_level="qm", match_number=mn)
        rec.set_alliances(red, blue)

        red_perf = blue_perf = 0.0
        for alliance, station_teams in (("red", red), ("blue", blue)):
            for idx, t in enumerate(station_teams, 1):
                sk = skill[t]
                scouts_here = [random.choice(SCOUTS)]
                # ~30% of slots get double-scouted → Consensus Radar data.
                if random.random() < 0.3:
                    scouts_here.append(random.choice(
                        [x for x in SCOUTS if x != scouts_here[0]]))
                first_pts = 0.0
                for i, scout in enumerate(scouts_here):
                    bias = SCOUT_BIAS[scout]
                    failed = random.random() < 0.08
                    entry = {
                        "event_key": EVENT, "match_number": mn, "comp_level": "qm",
                        "team_number": t, "alliance": alliance, "station": idx,
                        "scout_id": scout,
                        "auto_leave": random.random() < 0.85,
                        "auto_climb": random.random() < sk * 0.4,
                        "heatmap": _heatmap(sk, bias),
                        "climb": random.choices(["none", "l1", "l2", "l3"],
                                                weights=[0.2, 0.3, 0.3, 0.2 + sk])[0],
                        "tags": _tags(sk, failed),
                        "played_defense": random.random() < 0.25,
                        "defense_rating": random.randint(0, 5),
                        "defense_on": "",
                        "successful_stops": random.randint(0, 3),
                        "driver_skill": min(5, max(1, round(sk * 5 + random.uniform(-1.2, 1.2) * (2 - bias)))),
                        "speed_rating": min(5, max(1, round(sk * 5 + random.uniform(-1, 1)))),
                        "fouls": random.choices([0, 1, 2], weights=[0.7, 0.2, 0.1])[0],
                        "failure": failed,
                        "failure_details": random.choice(FAILURES) if failed else "",
                        "notes": random.choice([
                            "Fast cycler, clean driving.", "Struggled under defense.",
                            "Reliable climb every match.", "Great auto routine.",
                            "Mechanical hiccup mid-match.", "Strong partner, good comms.",
                            "Only scores from the near zone.", "Driver adapts well mid-match.", "",
                        ]),
                    }
                    pts = compute_points(entry)
                    entry["points"] = pts
                    entry_rows.append(ScoutEntry.from_submission(entry))
                    if i == 0:
                        first_pts = pts
                if alliance == "red":
                    red_perf += first_pts
                else:
                    blue_perf += first_pts

        # First ~10 matches are "played" (have results); rest open for betting.
        if mn <= 10:
            rec.red_score = int(red_perf)
            rec.blue_score = int(blue_perf)
            rec.winner = "red" if red_perf > blue_perf else "blue" if blue_perf > red_perf else "tie"

        match_rows.append(rec)

    repo.save_matches(match_rows)
    store.write_many(entry_rows)

    # Pit entries for a couple teams.
    pit_rows = [
        PitEntry(event_key=EVENT, team_number=t, scout_id="1",
                 drivetrain=random.choice(["Swerve", "Tank", "Mecanum"]),
                 weight_lbs=random.randint(90, 125),
                 can_climb=random.choice(["l1", "l2", "l3"]),
                 capabilities=random.sample(
                     ["Auto", "Climb", "Defense", "Fast cycle", "Long range"], 3),
                 notes="Looks competition-ready.")
        for t in TEAMS[:6]
    ]
    store.write_many(pit_rows)

    # A master + a couple personal picklists.
    top = sorted(TEAMS, key=lambda t: -skill[t])
    store.write_many([
        Picklist(event_key=EVENT, owner_id="team", name="Master Picklist", is_master=True,
                 items=Picklist.normalize_items(
                     [{"team": t, "tier": "first" if i < 3 else "second" if i < 6 else "third", "note": ""}
                      for i, t in enumerate(top[:8])])),
        Picklist(event_key=EVENT, owner_id="1", name="Scout 1's Board", is_master=False,
                 items=Picklist.normalize_items(
                     [{"team": t, "tier": "first", "note": "fast"} for t in top[:4]])),
        Picklist(event_key=EVENT, owner_id="2", name="Defense Picks", is_master=False,
                 items=Picklist.normalize_items(
                     [{"team": t, "tier": "second", "note": "plays D"} for t in top[3:7]])),
    ])

    repo.set_setting("current_match", "10")
    repo.set_setting("betting_enabled", "1")
    close_db()

    print(f"Demo event '{EVENT}' created: {len(TEAMS)} teams, 18 matches, "
          f"{len(entry_rows)} scouting entries + picklists.")
    print("Sign in as admin / 1 / 2 / 3 with team password 'HazeRain!'.")


if __name__ == "__main__":
    generate()

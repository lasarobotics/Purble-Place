"""Generate a self-contained demo event so HazeHub is fully explorable without
any network/TBA access.

Run from the backend folder:
    .venv\\Scripts\\python -m app.demo_data
"""
from __future__ import annotations

import random
from datetime import datetime, timezone

from sqlmodel import Session, delete, select

from .database import engine, init_db
from .models import (
    Bet,
    Event,
    MatchRecord,
    Picklist,
    PitEntry,
    ScoutEntry,
    TeamCache,
)
from .scoring import compute_points
from .seed import seed
from .store import set_setting

EVENT = "2026haze"
TEAMS = [118, 254, 469, 973, 1011, 1114, 1234, 1678, 1986, 2056, 2767, 3310]
NICKS = {
    118: "Robonauts", 254: "Cheesy Poofs", 469: "Las Guerrillas", 973: "Greybots",
    1011: "CRescendo", 1114: "Simbotics", 1234: "Deus Ex Machina", 1678: "Citrus Circuits",
    1986: "Team Titanium", 2056: "OP Robotics", 2767: "Stryke Force", 3310: "Black Hawk",
}
SCOUTS = ["1", "2", "3"]
# Each scout counts slightly differently — feeds the Consensus Radar.
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


def generate() -> None:
    init_db()
    seed()
    with Session(engine) as s:
        # Clear any previous demo rows for a clean slate.
        for model in (ScoutEntry, MatchRecord, Bet, PitEntry):
            s.exec(delete(model).where(model.event_key == EVENT))
        for p in s.exec(select(Picklist).where(Picklist.event_key == EVENT)).all():
            s.delete(p)
        s.commit()

        # Event row (2027-schema events table).
        ev = s.get(Event, EVENT) or Event(event_key=EVENT)
        ev.name = "Haze Invitational (Demo)"
        ev.start_date = datetime.now(timezone.utc).date()
        s.add(ev)

        # Teams + EPA (skill 0..1 maps to EPA ~25..75).
        skill = {}
        for t in TEAMS:
            sk = random.uniform(0.25, 0.95)
            skill[t] = sk
            tc = s.get(TeamCache, t) or TeamCache(team_number=t)
            tc.nickname = NICKS.get(t, f"Team {t}")
            tc.epa = round(25 + sk * 50, 1)
            tc.city, tc.state, tc.country = "Demo City", "TX", "USA"
            tc.updated_at = datetime.now(timezone.utc)
            s.add(tc)

        # Build a qual schedule.
        n_matches = 18
        for mn in range(1, n_matches + 1):
            picks = random.sample(TEAMS, 6)
            red, blue = picks[:3], picks[3:]
            mk = f"{EVENT}_qm{mn}"
            rec = MatchRecord(match_key=mk, event_key=EVENT, comp_level="qm",
                              match_number=mn)
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
                        s.add(ScoutEntry.from_submission(entry))
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

            s.add(rec)

        # Pit entries for a couple teams.
        for t in TEAMS[:6]:
            s.add(PitEntry(event_key=EVENT, team_number=t, scout_id="1",
                           drivetrain=random.choice(["Swerve", "Tank", "Mecanum"]),
                           weight_lbs=random.randint(90, 125),
                           can_climb=random.choice(["l1", "l2", "l3"]),
                           capabilities=random.sample(["Auto", "Climb", "Defense", "Fast cycle", "Long range"], 3),
                           notes="Looks competition-ready."))

        # A master + a couple personal picklists.
        top = sorted(TEAMS, key=lambda t: -skill[t])
        s.add(Picklist(event_key=EVENT, owner_id="team", name="Master Picklist", is_master=True,
                       items=[{"team": t, "tier": "first" if i < 3 else "second" if i < 6 else "third", "note": ""}
                              for i, t in enumerate(top[:8])]))
        s.add(Picklist(event_key=EVENT, owner_id="1", name="Scout 1's Board", is_master=False,
                       items=[{"team": t, "tier": "first", "note": "fast"} for t in top[:4]]))
        s.add(Picklist(event_key=EVENT, owner_id="2", name="Defense Picks", is_master=False,
                       items=[{"team": t, "tier": "second", "note": "plays D"} for t in top[3:7]]))

        set_setting(s, "current_event", EVENT)
        set_setting(s, "current_match", "10")
        set_setting(s, "betting_enabled", "1")
        s.commit()

    print(f"Demo event '{EVENT}' created: {len(TEAMS)} teams, 18 matches, scouting + picklists.")
    print("Sign in as admin / 1 / 2 / 3 with team password 'HazeRain!'.")


if __name__ == "__main__":
    generate()

"""Purple Bucks betting."""

from __future__ import annotations

import math
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from pymongo import ReturnDocument
from pymongo.database import Database

from ..auth import current_scouter
from ..betting_logic import odds_for, payout_for
from ..database import database_dependency
from ..external import match_win_prob
from ..models import BetDocument
from ..realtime import emit
from ..repositories import HazeHubRepository, RepositoryError
from ..store import get_setting
from ..views import MatchView, ScouterView, get_match, get_teams_cache
from .matches import teams_payload

router = APIRouter(prefix="/api/betting", tags=["betting"])


def _epa_prob(db: Database, m: MatchView) -> float:
    """Fallback red-win probability from team EPAs (logistic on EPA diff)."""
    cache = get_teams_cache(db, m.red + m.blue)

    def alliance_epa(teams: list[int]) -> float:
        total = 0.0
        for t in teams:
            tc = cache.get(t)
            total += (tc.epa or 0.0) if tc else 0.0
        return total

    red, blue = alliance_epa(m.red), alliance_epa(m.blue)
    return 1.0 / (1.0 + math.pow(10, -(red - blue) / 30.0))


def _win_probs(db: Database, m: MatchView) -> dict:
    red = match_win_prob(db, m.match_key)
    source = "statbotics"
    if red is None:
        red = _epa_prob(db, m)
        source = "epa"
    red = max(0.01, min(0.99, red))
    return {"red": red, "blue": 1 - red, "source": source}


def _is_locked(db: Database, m: MatchView) -> bool:
    if get_setting(db, "betting_enabled") != "1":
        return True
    if m.betting_locked or m.winner is not None:
        return True
    return False


@router.get("/odds")
def odds(
    match_key: str,
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(current_scouter),
) -> dict:
    m = get_match(db, match_key)
    if not m:
        raise HTTPException(status_code=404, detail="Match not found")
    probs = _win_probs(db, m)
    cache = get_teams_cache(db, m.red + m.blue)
    return {
        "match_key": m.match_key,
        "match_number": m.match_number,
        "comp_level": m.comp_level,
        "red": m.red,
        "blue": m.blue,
        "red_teams": teams_payload(cache, m.red),
        "blue_teams": teams_payload(cache, m.blue),
        "locked": _is_locked(db, m),
        "betting_enabled": get_setting(db, "betting_enabled") == "1",
        "source": probs["source"],
        "red_odds": {**odds_for(probs["red"])},
        "blue_odds": {**odds_for(probs["blue"])},
    }


class BetIn(BaseModel):
    match_key: str
    pick: str  # red / blue
    wager: int


def bet_dict(b: dict[str, Any]) -> dict:
    created = b.get("created_at") or datetime.now(UTC)
    return {
        "id": str(b["_id"]),
        "scout_id": b.get("scouter_id"),
        "match_key": b.get("match_key"),
        "match_number": b.get("match_num"),
        "comp_level": b.get("comp_level"),
        "pick": b.get("pick"),
        "wager": b.get("wager"),
        "win_prob": b.get("win_prob"),
        "multiplier": b.get("multiplier"),
        "potential_payout": b.get("potential_payout"),
        "status": b.get("status"),
        "payout": b.get("payout", 0),
        "created_at": created.isoformat(),
    }


@router.post("/place")
def place_bet(
    body: BetIn,
    db: Database = Depends(database_dependency),
    scouter: ScouterView = Depends(current_scouter),
) -> dict:
    if body.pick not in ("red", "blue"):
        raise HTTPException(status_code=400, detail="Pick must be red or blue")
    if body.wager <= 0:
        raise HTTPException(status_code=400, detail="Wager must be positive")

    m = get_match(db, body.match_key)
    if not m:
        raise HTTPException(status_code=404, detail="Match not found")
    if _is_locked(db, m):
        raise HTTPException(status_code=400, detail="Betting is closed for this match")

    probs = _win_probs(db, m)
    p = probs[body.pick]
    o = odds_for(p)
    potential = payout_for(body.wager, o["multiplier"])

    # Escrow the wager atomically — the filter only matches when the balance
    # still covers it, so concurrent bets can't overdraw.
    now = datetime.now(UTC)
    debited = db.scouters.find_one_and_update(
        {"_id": scouter.scout_id, "bucks": {"$gte": body.wager}},
        {"$inc": {"bucks": -body.wager}, "$set": {"updated_at": now}},
        return_document=ReturnDocument.AFTER,
    )
    if debited is None:
        raise HTTPException(status_code=400, detail="Not enough Purple Bucks")

    try:
        bet = BetDocument(
            scouter_id=scouter.scout_id,
            event_key=m.event_key,
            match_key=m.match_key,
            match_num=m.match_number,
            comp_level=m.comp_level,
            pick=body.pick,
            wager=body.wager,
            win_prob=o["win_prob"],
            multiplier=o["multiplier"],
            potential_payout=potential,
        )
        stored = HazeHubRepository(db).place_bet(bet)
    except (ValueError, RepositoryError) as exc:
        # Refund the escrow if the bet itself could not be recorded.
        db.scouters.update_one(
            {"_id": scouter.scout_id}, {"$inc": {"bucks": body.wager}}
        )
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    emit(db, "bet_placed", {"scout": scouter.scout_id, "match": m.match_number})
    return {"ok": True, "bucks": int(debited["bucks"]), "bet": bet_dict(stored)}


@router.get("/mine")
def my_bets(
    db: Database = Depends(database_dependency),
    scouter: ScouterView = Depends(current_scouter),
) -> dict:
    rows = list(
        db.bets.find({"scouter_id": scouter.scout_id}).sort("created_at", -1)
    )
    return {"bucks": scouter.bucks, "bets": [bet_dict(b) for b in rows]}


@router.get("/leaderboard")
def leaderboard(
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(current_scouter),
) -> list[dict]:
    stats: dict[str, dict[str, int]] = {}
    for row in db.bets.aggregate(
        [
            {
                "$group": {
                    "_id": "$scouter_id",
                    "bets": {"$sum": 1},
                    "won": {"$sum": {"$cond": [{"$eq": ["$status", "won"]}, 1, 0]}},
                    "settled": {
                        "$sum": {"$cond": [{"$in": ["$status", ["won", "lost"]]}, 1, 0]}
                    },
                }
            }
        ]
    ):
        stats[str(row["_id"])] = row

    board = []
    for s in db.scouters.find({}):
        sid = str(s["_id"])
        st = stats.get(sid, {})
        settled = int(st.get("settled", 0))
        won = int(st.get("won", 0))
        board.append(
            {
                "scout_id": sid,
                "display_name": s.get("display_name") or sid,
                "bucks": int(s.get("bucks", 0)),
                "is_admin": bool(s.get("is_admin", False)),
                "bets": int(st.get("bets", 0)),
                "won": won,
                "win_rate": round(won / settled, 3) if settled else 0.0,
            }
        )
    board.sort(key=lambda r: (-r["bucks"], r["scout_id"].lower()))
    for i, r in enumerate(board, 1):
        r["rank"] = i
    return board


def resolve_match_bets(db: Database, m: MatchView) -> int:
    """Settle all open bets on a finished match. Returns number settled."""
    if m.winner is None:
        return 0
    open_bets = list(db.bets.find({"match_key": m.match_key, "status": "open"}))
    now = datetime.now(UTC)

    settled = 0
    for b in open_bets:
        if m.winner == "tie":
            status, payout = "refunded", int(b["wager"])
        elif b["pick"] == m.winner:
            status, payout = "won", int(b["potential_payout"])
        else:
            status, payout = "lost", 0
        result = db.bets.update_one(
            {"_id": b["_id"], "status": "open"},
            {"$set": {"status": status, "payout": payout, "resolved_at": now}},
        )
        if result.modified_count == 0:
            continue  # another worker settled it first
        if payout:
            db.scouters.update_one(
                {"_id": b["scouter_id"]},
                {"$inc": {"bucks": payout}, "$set": {"updated_at": now}},
            )
        settled += 1
    if settled:
        emit(db, "bets_resolved", {"match": m.match_number, "winner": m.winner})
    return settled

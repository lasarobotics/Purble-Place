"""Purple Bucks betting."""
from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import repo
from ..auth import current_scouter
from ..betting_logic import odds_for, payout_for
from ..external import match_win_prob
from ..models import Bet, MatchRecord, Scouter
from ..realtime import emit
from .matches import teams_payload

router = APIRouter(prefix="/api/betting", tags=["betting"])


def _match(match_key: str) -> Optional[MatchRecord]:
    return repo.match_by_key(match_key)


def _epa_prob(m: MatchRecord) -> float:
    """Fallback red-win probability from team EPAs (logistic on EPA diff)."""

    def alliance_epa(teams: list[int]) -> float:
        total = 0.0
        for t in teams:
            tc = repo.team(t)
            total += (tc.epa or 0.0) if tc else 0.0
        return total

    red, blue = alliance_epa(m.red), alliance_epa(m.blue)
    return 1.0 / (1.0 + math.pow(10, -(red - blue) / 30.0))


async def _win_probs(m: MatchRecord) -> dict:
    red = await match_win_prob(m.match_key)
    source = "statbotics"
    if red is None:
        red = _epa_prob(m)
        source = "epa"
    red = max(0.01, min(0.99, red))
    return {"red": red, "blue": 1 - red, "source": source}


def _betting_enabled() -> bool:
    return repo.setting("betting_enabled") == "1"


def lock_reason(m: MatchRecord) -> str:
    """Why betting is closed on this match, or "" if it is open.

    Every one of these has to be checked. A match whose score has come back
    from The Blue Alliance is already decided, so allowing a bet on it would
    be free Purple Bucks; so would betting on the match currently being
    played, or on one that has already been scouted.
    """
    if not _betting_enabled():
        return "Betting is turned off"
    if m.winner is not None:
        return "This match is over"
    if m.red_score is not None or m.blue_score is not None:
        # Scores arrive from TBA before the winner field is derived, and a
        # partial score still tells you who is winning.
        return "Results are already in for this match"
    if m.betting_locked:
        return "Betting closed when scouting started"
    current = _int(repo.setting("current_match"))
    if m.comp_level == "qm" and current and m.match_number <= current:
        return "This match has already been played"
    return ""


def _is_locked(m: MatchRecord) -> bool:
    return bool(lock_reason(m))


def _int(value: object) -> int:
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return 0


@router.get("/odds")
async def odds(
    match_key: str,
    _: Scouter = Depends(current_scouter),
) -> dict:
    m = _match(match_key)
    if not m:
        raise HTTPException(status_code=404, detail="Match not found")
    probs = await _win_probs(m)
    return {
        "match_key": m.match_key,
        "match_number": m.match_number,
        "comp_level": m.comp_level,
        "red": m.red,
        "blue": m.blue,
        "red_teams": teams_payload(m.red),
        "blue_teams": teams_payload(m.blue),
        "locked": _is_locked(m),
        "lock_reason": lock_reason(m),
        "betting_enabled": _betting_enabled(),
        "source": probs["source"],
        "red_odds": {**odds_for(probs["red"])},
        "blue_odds": {**odds_for(probs["blue"])},
    }


class BetIn(BaseModel):
    match_key: str
    pick: str  # red / blue
    wager: int


@router.post("/place")
async def place_bet(
    body: BetIn,
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    if body.pick not in ("red", "blue"):
        raise HTTPException(status_code=400, detail="Pick must be red or blue")
    if body.wager <= 0:
        raise HTTPException(status_code=400, detail="Wager must be positive")
    if body.wager > scouter.bucks:
        raise HTTPException(status_code=400, detail="Not enough Purple Bucks")

    m = _match(body.match_key)
    if not m:
        raise HTTPException(status_code=404, detail="Match not found")
    closed = lock_reason(m)
    if closed:
        raise HTTPException(status_code=400, detail=f"Betting is closed. {closed}.")

    probs = await _win_probs(m)
    p = probs[body.pick]
    o = odds_for(p)
    potential = payout_for(body.wager, o["multiplier"])

    # Escrow the wager immediately. Two documents, written directly (not
    # coalesced): a balance the user can see must be durable before the
    # response returns.
    scouter.bucks -= body.wager
    bet = Bet(
        scout_id=scouter.scout_id,
        event_key=m.event_key,
        match_key=m.match_key,
        match_number=m.match_number,
        comp_level=m.comp_level,
        pick=body.pick,
        wager=body.wager,
        win_prob=o["win_prob"],
        multiplier=o["multiplier"],
        potential_payout=potential,
    )
    repo.save_bet(bet)
    repo.save_scouter(scouter)

    emit("bet_placed", {"scout": scouter.scout_id, "match": m.match_number})
    return {"ok": True, "bucks": scouter.bucks, "bet": _bet_dict(bet)}


def _bet_dict(b: Bet) -> dict:
    return {
        "id": b.id,
        "scout_id": b.scout_id,
        "match_key": b.match_key,
        "match_number": b.match_number,
        "comp_level": b.comp_level,
        "pick": b.pick,
        "wager": b.wager,
        "win_prob": b.win_prob,
        "multiplier": b.multiplier,
        "potential_payout": b.potential_payout,
        "status": b.status,
        "payout": b.payout,
        "created_at": b.created_at.isoformat(),
    }


@router.get("/mine")
def my_bets(scouter: Scouter = Depends(current_scouter)) -> dict:
    rows = repo.bets_by_scout().get(scouter.scout_id, [])
    rows = sorted(rows, key=lambda b: b.id, reverse=True)
    return {"bucks": scouter.bucks, "bets": [_bet_dict(b) for b in rows]}


@router.get("/leaderboard")
def leaderboard(_: Scouter = Depends(current_scouter)) -> list[dict]:
    # One grouped pass over the bets (memoised) instead of a per-scouter query.
    by_scout = repo.bets_by_scout()
    board = []
    for s in repo.scouters():
        bets = by_scout.get(s.scout_id, [])
        won = sum(1 for b in bets if b.status == "won")
        settled = sum(1 for b in bets if b.status in ("won", "lost"))
        board.append(
            {
                "scout_id": s.scout_id,
                "display_name": s.display_name or s.scout_id,
                "bucks": s.bucks,
                "is_admin": s.is_admin,
                "bets": len(bets),
                "won": won,
                "win_rate": round(won / settled, 3) if settled else 0.0,
            }
        )
    board.sort(key=lambda r: (-r["bucks"], r["scout_id"].lower()))
    for i, r in enumerate(board, 1):
        r["rank"] = i
    return board


def resolve_match_bets(m: MatchRecord) -> int:
    """Settle all open bets on a finished match. Returns number settled.

    Bets and the scouters they pay out to are collected first and written in
    two batched commits, so settling a full match costs a handful of
    operations instead of one write per bet plus one per balance.
    """
    if m.winner is None:
        return 0
    open_bets = repo.open_bets_for_match(m.match_key)
    if not open_bets:
        return 0

    now = datetime.now(timezone.utc)
    touched: dict[str, Scouter] = {}
    for b in open_bets:
        scouter = touched.get(b.scout_id) or repo.scouter(b.scout_id)
        if scouter is not None:
            touched[b.scout_id] = scouter
        if m.winner == "tie":
            b.status = "refunded"
            b.payout = b.wager
            if scouter:
                scouter.bucks += b.wager
        elif b.pick == m.winner:
            b.status = "won"
            b.payout = b.potential_payout
            if scouter:
                scouter.bucks += b.potential_payout
        else:
            b.status = "lost"
            b.payout = 0
        b.resolved_at = now

    repo.save_bets(open_bets)
    if touched:
        repo.save_scouters(list(touched.values()))

    emit("bets_resolved", {"match": m.match_number, "winner": m.winner})
    return len(open_bets)

"""Purple Bucks betting."""
from __future__ import annotations

import math
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from ..auth import current_scouter
from ..betting_logic import odds_for, payout_for
from ..database import get_session
from ..external import match_win_prob
from ..models import Bet, MatchRecord, Scouter, TeamCache
from ..realtime import emit
from ..store import get_setting

router = APIRouter(prefix="/api/betting", tags=["betting"])


def _match(session: Session, match_key: str) -> Optional[MatchRecord]:
    return session.exec(
        select(MatchRecord).where(MatchRecord.match_key == match_key)
    ).first()


def _epa_prob(session: Session, m: MatchRecord) -> float:
    """Fallback red-win probability from team EPAs (logistic on EPA diff)."""
    def alliance_epa(teams: list[int]) -> float:
        total = 0.0
        for t in teams:
            tc = session.get(TeamCache, t)
            total += (tc.epa or 0.0) if tc else 0.0
        return total

    red, blue = alliance_epa(m.red), alliance_epa(m.blue)
    return 1.0 / (1.0 + math.pow(10, -(red - blue) / 30.0))


async def _win_probs(session: Session, m: MatchRecord) -> dict:
    red = await match_win_prob(session, m.match_key)
    source = "statbotics"
    if red is None:
        red = _epa_prob(session, m)
        source = "epa"
    red = max(0.01, min(0.99, red))
    return {"red": red, "blue": 1 - red, "source": source}


def _is_locked(session: Session, m: MatchRecord) -> bool:
    if get_setting(session, "betting_enabled") != "1":
        return True
    if m.betting_locked or m.winner is not None:
        return True
    # A match is "started" once the field pointer reaches it.
    if m.comp_level == "qm":
        cur = int(get_setting(session, "current_match") or 0)
        if m.match_number <= cur:
            return True
    return False


@router.get("/odds")
async def odds(
    match_key: str,
    session: Session = Depends(get_session),
    _: Scouter = Depends(current_scouter),
) -> dict:
    m = _match(session, match_key)
    if not m:
        raise HTTPException(status_code=404, detail="Match not found")
    probs = await _win_probs(session, m)
    return {
        "match_key": m.match_key,
        "match_number": m.match_number,
        "comp_level": m.comp_level,
        "red": m.red,
        "blue": m.blue,
        "locked": _is_locked(session, m),
        "betting_enabled": get_setting(session, "betting_enabled") == "1",
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
    session: Session = Depends(get_session),
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    if body.pick not in ("red", "blue"):
        raise HTTPException(status_code=400, detail="Pick must be red or blue")
    if body.wager <= 0:
        raise HTTPException(status_code=400, detail="Wager must be positive")
    if body.wager > scouter.bucks:
        raise HTTPException(status_code=400, detail="Not enough Purple Bucks")

    m = _match(session, body.match_key)
    if not m:
        raise HTTPException(status_code=404, detail="Match not found")
    if _is_locked(session, m):
        raise HTTPException(status_code=400, detail="Betting is closed for this match")

    probs = await _win_probs(session, m)
    p = probs[body.pick]
    o = odds_for(p)
    potential = payout_for(body.wager, o["multiplier"])

    # Escrow the wager immediately.
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
    session.add(bet)
    session.add(scouter)
    session.commit()
    session.refresh(bet)

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
def my_bets(
    session: Session = Depends(get_session),
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    rows = session.exec(
        select(Bet).where(Bet.scout_id == scouter.scout_id).order_by(Bet.id.desc())
    ).all()
    return {"bucks": scouter.bucks, "bets": [_bet_dict(b) for b in rows]}


@router.get("/leaderboard")
def leaderboard(
    session: Session = Depends(get_session),
    _: Scouter = Depends(current_scouter),
) -> list[dict]:
    rows = session.exec(select(Scouter)).all()
    board = []
    for s in rows:
        bets = session.exec(select(Bet).where(Bet.scout_id == s.scout_id)).all()
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


def resolve_match_bets(session: Session, m: MatchRecord) -> int:
    """Settle all open bets on a finished match. Returns number settled."""
    if m.winner is None:
        return 0
    open_bets = session.exec(
        select(Bet).where(Bet.match_key == m.match_key, Bet.status == "open")
    ).all()
    from datetime import datetime, timezone

    settled = 0
    for b in open_bets:
        scouter = session.get(Scouter, b.scout_id)
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
        b.resolved_at = datetime.now(timezone.utc)
        session.add(b)
        if scouter:
            session.add(scouter)
        settled += 1
    session.commit()
    if settled:
        emit("bets_resolved", {"match": m.match_number, "winner": m.winner})
    return settled

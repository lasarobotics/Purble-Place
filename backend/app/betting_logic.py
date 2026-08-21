"""Purple Bucks betting odds.

Odds come straight from the Statbotics win probability for the picked
alliance.  Betting the heavy favourite pays little; betting the underdog pays
a lot: classic fair-odds with a small house edge and a floor so favourites
still earn something.

    profit_fraction = clamp( (1 - p)/p * EDGE , MIN_PROFIT , MAX_PROFIT )
    multiplier      = 1 + profit_fraction        (payout = wager * multiplier)

Example: p = 0.99 (99% favourite) -> (0.01/0.99)*0.9 ≈ 0.009 -> floored to
MIN_PROFIT (5%) -> 1.05x.  p = 0.20 underdog -> (0.8/0.2)*0.9 = 3.6 -> 4.6x.
"""
from __future__ import annotations

HOUSE_EDGE = 0.9
MIN_PROFIT = 0.05      # favourites still earn at least 5%
MAX_PROFIT = 15.0      # cap the longshot upside


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def odds_for(win_prob: float) -> dict:
    p = clamp(win_prob, 0.01, 0.99)
    profit = clamp((1 - p) / p * HOUSE_EDGE, MIN_PROFIT, MAX_PROFIT)
    multiplier = round(1 + profit, 3)
    return {
        "win_prob": round(p, 4),
        "profit_pct": round(profit * 100, 1),
        "multiplier": multiplier,
    }


def payout_for(wager: int, multiplier: float) -> int:
    return int(round(wager * multiplier))

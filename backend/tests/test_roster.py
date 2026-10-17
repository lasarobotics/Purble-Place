"""The closed account roster, and the reconciliation it feeds.

Two behaviours worth locking down, because both fail silently:

* Sign-in used to provision an account for whatever ID was typed, so a typo
  created a parallel account whose scouting nobody looked at again.
* Reconciliation used to report a whole match as "missing" only when nobody
  scouted it at all, so five reports out of six looked perfectly clean.
"""
from __future__ import annotations

import pytest

from app.auth import (
    UNKNOWN_ACCOUNT_MESSAGE,
    _picklist_account_may_reach,
    canonical_account_id,
    role_for_new_account,
    verify_login_password,
)
from app.config import settings
from app.models import ROLE_ADMIN, ROLE_PICKLIST, ROLE_SCOUTER, ROLE_STRATEGY


# --------------------------------------------------------------------------- #
# Roster                                                                       #
# --------------------------------------------------------------------------- #
def test_roster_has_one_admin_and_65_spreadsheet_accounts():
    assert len(settings.ACCOUNTS) == 66
    assert [key for key, role in settings.ACCOUNTS.items() if role == ROLE_ADMIN] == ["Admin"]
    assert all(key.isdigit() and len(key) == 8 for key in settings.ACCOUNTS if key != "Admin")


@pytest.mark.parametrize("typed,expected", [("Admin", "Admin"), ("admin", "Admin"), ("ADMIN", "Admin"), (" 10217860 ", "10217860")])
def test_known_ids_resolve_to_one_canonical_account(typed, expected):
    assert canonical_account_id(typed) == expected


@pytest.mark.parametrize("typed", ["", "admin2", "Strategy", "PicklistMeeting", "picklist", "1", "15", "Demo"])
def test_unknown_ids_are_refused(typed):
    assert canonical_account_id(typed) is None


def test_roles_come_from_the_roster():
    assert role_for_new_account("admin") == ROLE_ADMIN
    assert role_for_new_account("10217860") == ROLE_SCOUTER


def test_rejection_message_does_not_list_the_valid_ids():
    # One shared password means anyone who could read the list could use it.
    for account in settings.ACCOUNTS:
        if account.isdigit():
            continue
        assert account not in UNKNOWN_ACCOUNT_MESSAGE


# --------------------------------------------------------------------------- #
# What the picklist meeting screen may reach                                   #
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "path,method,allowed",
    [
        ("/api/picklists/meeting", "GET", True),
        ("/api/picklists/12", "PUT", True),
        ("/api/teams/254", "GET", True),
        # A justification can reference a match; reading it must work.
        ("/api/scout/match/12", "GET", True),
        ("/api/pit/254", "GET", True),
        ("/api/matches/event-ratings", "GET", True),
        ("/api/admin/analysis", "GET", True),
        # ...but the projector account still cannot write anything.
        ("/api/scout", "POST", False),
        ("/api/pit", "POST", False),
        ("/api/scout/mine", "GET", False),
        ("/api/betting/place", "POST", False),
        ("/api/admin/current-match", "POST", False),
    ],
)
def test_picklist_account_boundary(path, method, allowed):
    assert _picklist_account_may_reach(path, method) is allowed


# --------------------------------------------------------------------------- #
# Reconciliation                                                               #
# --------------------------------------------------------------------------- #
class _Match:
    def __init__(self, number, red, blue):
        self.match_number = number
        self.comp_level = "qm"
        self.red = red
        self.blue = blue


class _Entry:
    def __init__(self, match, team, alliance="red", station=1, no_show=False):
        self.match_number = match
        self.comp_level = "qm"
        self.team_number = team
        self.alliance = alliance
        self.station = station
        self.no_show = no_show
        self.scout_id = "1"


RED = [11, 12, 13]
BLUE = [21, 22, 23]


def _reconcile(monkeypatch, entries, matches=None):
    from app.routers import system

    matches = matches or [_Match(1, RED, BLUE)]
    monkeypatch.setattr(system.repo, "matches_for_event", lambda _k: matches)
    monkeypatch.setattr(system.repo, "scouting_for_event", lambda _k: entries)
    return system._reconciliation("2026haze", max(m.match_number for m in matches))


def test_missing_report_names_the_alliance_and_station(monkeypatch):
    # Five of six robots scouted: the gap is red station 2, team 12.
    entries = [_Entry(1, t) for t in (11, 13, 21, 22, 23)]
    rec = _reconcile(monkeypatch, entries)

    assert rec["missing"]["count"] == 1
    assert rec["missing"]["slots"] == [
        {"match": 1, "alliance": "red", "station": 2, "team": 12}
    ]
    # The match had reports, so it is not "no scouting at all".
    assert rec["missing"]["matches"] == []


def test_full_coverage_reports_nothing_missing(monkeypatch):
    entries = [_Entry(1, t) for t in RED + BLUE]
    assert _reconcile(monkeypatch, entries)["missing"]["count"] == 0


def test_a_no_show_report_still_counts_as_covered(monkeypatch):
    # Somebody sat in that chair and reported the robot never appeared. That
    # is data, not a gap.
    entries = [_Entry(1, t) for t in RED + BLUE[1:]]
    entries.append(_Entry(1, 21, alliance="blue", station=1, no_show=True))
    assert _reconcile(monkeypatch, entries)["missing"]["count"] == 0


def test_second_report_on_a_robot_is_coverage_not_a_fault(monkeypatch):
    entries = [_Entry(1, t) for t in RED + BLUE]
    entries.append(_Entry(1, 11, station=1))  # same robot, same station, 2nd scout
    rec = _reconcile(monkeypatch, entries)

    assert rec["missing"]["count"] == 0
    assert rec["double_scouted"]["count"] == 1
    assert rec["double_scouted"]["items"] == [{"match": 1, "team": 11, "count": 2}]
    # Both submissions are still counted; neither is discarded.
    assert rec["by_match"][0]["submissions"] == 7
    assert rec["by_match"][0]["teams_covered"] == 6


def test_wrong_team_report_carries_where_the_scout_was_sitting(monkeypatch):
    entries = [_Entry(1, t) for t in RED + BLUE]
    entries.append(_Entry(1, 999, alliance="blue", station=3))
    rec = _reconcile(monkeypatch, entries)

    assert rec["wrong_team"]["count"] == 1
    assert rec["wrong_team"]["items"][0]["alliance"] == "blue"
    assert rec["wrong_team"]["items"][0]["station"] == 3

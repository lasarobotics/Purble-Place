"""Admin: event/match control, betting management, analytics."""
from __future__ import annotations

import re
import csv
import io
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from .. import repo, schema
from ..analytics import (
    RANK_METRICS,
    analysis_bundle,
    compare_teams,
    data_analysis,
    data_picklist,
    event_teams,
    rank_teams,
    scout_disagreements,
    team_entries,
    team_heatmap,
    team_summary,
)
from ..archive import archive_event, archive_if_worthwhile
from ..auth import canonical_account_id, current_scouter, require_admin, require_full_admin
from ..config import settings
from ..external import sync_event_matches
from ..firestore_db import guard
from ..models import ROLE_ADMIN, ROLE_SCOUTER, ROLE_STRATEGY, ROLE_PICKLIST, ROLES, Bet, MatchRecord, Scouter, ScoutingAuditDocument
from ..scouting_review import audit_state, apply_patch
from ..realtime import emit
from .betting import resolve_match_bets
from .scouting import _entry_dict, _pit_dict
from .teams import report_dict, scout_name

router = APIRouter(prefix="/api/admin", tags=["admin"])


def _youtube_id(value: str) -> str:
    value = (value or "").strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", value):
        return value
    match = re.search(r"(?:v=|/embed/|youtu\.be/|/v/|/shorts/)([A-Za-z0-9_-]{11})", value)
    return match.group(1) if match else value


def _settle_finished_matches(event_key: str) -> int:
    settled = 0
    for match in repo.matches_for_event(event_key):
        if match.winner is not None:
            settled += resolve_match_bets(match)
    return settled


@router.get("/settings")
def get_settings(_: Scouter = Depends(require_admin)) -> dict:
    s = repo.all_settings()
    return {
        "current_event": s.get("current_event", ""),
        "current_match": int(s.get("current_match", "0") or 0),
        "betting_enabled": s.get("betting_enabled", "1") == "1",
        "post_comp_mode": s.get("post_comp_mode", "0") == "1",
        "season": settings.SEASON,
        "environment": settings.ENVIRONMENT,
        "tba_configured": bool(settings.TBA_KEY),
    }


class EventIn(BaseModel):
    event_key: str


@router.post("/event")
async def set_event(
    body: EventIn,
    _: Scouter = Depends(require_admin),
) -> dict:
    event_key = body.event_key.strip().lower()
    if event_key and not re.fullmatch(r"\d{4}[a-z0-9]+", event_key):
        raise HTTPException(status_code=400, detail="Use a TBA event key such as 2026txman")
    # Freeze the outgoing event first. Switching is the moment its records
    # stop being readable from the cache, so this is the last chance to roll
    # them up cheaply, and doing it here means nobody has to remember to.
    previous = repo.current_event()
    archived = None
    if previous and previous != event_key:
        rolled = archive_if_worthwhile(previous)
        archived = rolled.event_key if rolled else None
    # This re-scopes the event-filtered caches, which costs one full read of
    # the new event's documents: the only bulk read outside a cold start.
    repo.set_setting("current_event", event_key)
    matches = await sync_event_matches(event_key) if event_key and settings.TBA_KEY else []
    settled = _settle_finished_matches(event_key) if event_key else 0
    emit("settings_changed", {"current_event": event_key})
    return {
        "ok": True,
        "event": event_key,
        "matches": len(matches),
        "bets_settled": settled,
        "archived": archived,
    }


class CurrentMatchIn(BaseModel):
    match_number: int = Field(ge=1)


@router.post("/current-match")
async def set_current_match(
    body: CurrentMatchIn,
    _: Scouter = Depends(require_admin),
) -> dict:
    repo.set_setting("current_match", str(body.match_number))
    # Pull fresh results and settle any matches that just finished. The
    # schedule sync only writes matches whose data actually changed.
    event_key = repo.current_event()
    settled = 0
    if event_key:
        await sync_event_matches(event_key)
        settled = _settle_finished_matches(event_key)
    emit("match_advanced", {"current_match": body.match_number})
    return {"ok": True, "current_match": body.match_number, "bets_settled": settled}


class ScheduleCsvIn(BaseModel):
    event_key: str = ""
    csv_text: str


@router.post("/schedule/csv")
def import_schedule_csv(
    body: ScheduleCsvIn,
    _: Scouter = Depends(require_admin),
) -> dict:
    """Validate an entire CSV, then atomically replace this event's schedule."""
    event_key = (body.event_key or repo.current_event()).strip().lower()
    if not re.fullmatch(r"\d{4}[a-z0-9]+", event_key):
        raise HTTPException(status_code=400, detail="Set a valid event key before importing a schedule")
    if len(body.csv_text.encode("utf-8")) > 512 * 1024:
        raise HTTPException(status_code=413, detail="Schedule CSV is larger than 512 KiB")
    reader = csv.DictReader(io.StringIO(body.csv_text.lstrip("\ufeff")))
    if not reader.fieldnames:
        raise HTTPException(status_code=400, detail="The CSV has no header row")
    aliases = {
        "match": "match_number", "match_num": "match_number", "matchnumber": "match_number",
        "red_1": "red1", "red_2": "red2", "red_3": "red3",
        "blue_1": "blue1", "blue_2": "blue2", "blue_3": "blue3",
    }
    normalized_headers = {
        aliases.get(name.strip().lower().replace(" ", "_"), name.strip().lower().replace(" ", "_"))
        for name in reader.fieldnames if name
    }
    required_headers = {"match_number", "red1", "red2", "red3", "blue1", "blue2", "blue3"}
    missing = sorted(required_headers - normalized_headers)
    if missing:
        raise HTTPException(status_code=400, detail=f"Schedule CSV is missing columns: {', '.join(missing)}")
    rows: list[MatchRecord] = []
    seen: set[tuple[str, int]] = set()
    for line, raw in enumerate(reader, start=2):
        values = {
            aliases.get((key or "").strip().lower().replace(" ", "_"), (key or "").strip().lower().replace(" ", "_")): value
            for key, value in raw.items()
        }
        try:
            match_number = int(values.get("match_number") or 0)
            comp_level = (values.get("comp_level") or "qm").strip().lower()
            teams = [int(values.get(key) or 0) for key in ("red1", "red2", "red3", "blue1", "blue2", "blue3")]
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=f"CSV row {line} contains a non-numeric match or team number") from exc
        if match_number < 1:
            raise HTTPException(status_code=400, detail=f"CSV row {line}: match_number must be at least 1")
        if comp_level not in {"qm", "ef", "qf", "sf", "f"}:
            raise HTTPException(status_code=400, detail=f"CSV row {line}: unsupported comp_level {comp_level!r}")
        if any(team < 1 for team in teams):
            raise HTTPException(status_code=400, detail=f"CSV row {line}: all six team numbers must be at least 1")
        if len(set(teams)) != 6:
            raise HTTPException(status_code=400, detail=f"CSV row {line}: a team cannot occupy two stations")
        identity = (comp_level, match_number)
        if identity in seen:
            raise HTTPException(status_code=400, detail=f"CSV row {line}: duplicate {comp_level} match {match_number}")
        seen.add(identity)
        match = MatchRecord(
            match_key=f"{event_key}_{comp_level}{match_number}", event_key=event_key,
            comp_level=comp_level, match_number=match_number,
        )
        match.set_alliances(teams[:3], teams[3:])
        rows.append(match)
    if not rows:
        raise HTTPException(status_code=400, detail="The CSV contains no schedule rows")
    if len(rows) > 200:
        raise HTTPException(status_code=400, detail="A schedule may contain at most 200 matches")
    repo.replace_event_schedule(event_key, rows)
    emit("settings_changed", {"current_event": event_key, "schedule_imported": True})
    return {"ok": True, "event": event_key, "matches": len(rows)}


class ToggleIn(BaseModel):
    enabled: bool


class ArchiveResetIn(BaseModel):
    name: str = ""


def _set_post_comp_unlock_cookie(response: Response) -> None:
    response.set_cookie(
        "post_comp_unlocked",
        "1",
        max_age=60 * 60 * 24,
        httponly=False,
        samesite="lax",
        path="/",
    )


@router.post("/betting/toggle")
def toggle_betting(
    body: ToggleIn,
    _: Scouter = Depends(require_admin),
) -> dict:
    repo.set_setting("betting_enabled", "1" if body.enabled else "0")
    emit("settings_changed", {"betting_enabled": body.enabled})
    return {"ok": True, "betting_enabled": body.enabled}


@router.post("/post-comp/toggle")
def toggle_post_comp(
    body: ToggleIn,
    response: Response,
    _: Scouter = Depends(require_admin),
) -> dict:
    repo.set_setting("post_comp_mode", "1" if body.enabled else "0")
    if body.enabled:
        _set_post_comp_unlock_cookie(response)
    else:
        response.delete_cookie("post_comp_unlocked", path="/")
    emit("settings_changed", {"post_comp_mode": body.enabled})
    return {"ok": True, "post_comp_mode": body.enabled}


@router.post("/betting/reset")
def reset_betting(_: Scouter = Depends(require_admin)) -> dict:
    """Wipe all bets and reset every scouter to the starting balance.

    Both halves run as batched commits (chunked below Firestore's 500
    operations per commit), so resetting a full event is a few commits rather
    than hundreds of individual writes.
    """
    deleted = repo.delete_all_bets()
    rows = repo.scouters()
    for s in rows:
        s.bucks = settings.STARTING_BUCKS
    repo.save_scouters(rows)
    emit("betting_reset", {})
    return {"ok": True, "starting": settings.STARTING_BUCKS, "bets_deleted": deleted}


def _admin_bet_dict(bet: Bet) -> dict:
    return {
        "id": bet.id,
        "scout_id": bet.scout_id,
        "scout_name": scout_name(bet.scout_id),
        "match_key": bet.match_key,
        "match_number": bet.match_number,
        "comp_level": bet.comp_level,
        "pick": bet.pick,
        "wager": bet.wager,
        "win_prob": bet.win_prob,
        "multiplier": bet.multiplier,
        "potential_payout": bet.potential_payout,
        "status": bet.status,
        "payout": bet.payout,
        "created_at": bet.created_at.isoformat(),
    }


@router.get("/bets")
def list_bets(_: Scouter = Depends(require_admin)) -> list[dict]:
    return [_admin_bet_dict(bet) for bet in repo.bets()]


@router.delete("/bets/{bet_id}")
def delete_bet(
    bet_id: int,
    _: Scouter = Depends(require_admin),
) -> dict:
    bet = repo.bet(bet_id)
    if not bet:
        raise HTTPException(status_code=404, detail="Bet not found")
    scouter = repo.scouter(bet.scout_id)
    if scouter:
        if bet.status in ("open", "lost"):
            scouter.bucks += bet.wager
        elif bet.status == "won":
            scouter.bucks -= max(0, bet.payout - bet.wager)
        repo.save_scouter(scouter)
    repo.delete_bet(bet_id)
    emit("bet_deleted", {"id": bet_id})
    return {"ok": True, "bucks": scouter.bucks if scouter else None}


class FilmIn(BaseModel):
    match_key: str
    youtube_key: str = ""
    film_summary: str | None = None
    film_events: list[dict] | None = None


@router.post("/match/youtube")
def set_film(
    body: FilmIn,
    _: Scouter = Depends(current_scouter),
) -> dict:
    """Save the film for a match: video link, written takeaway, and the
    timestamped key-events play-by-play."""
    m = repo.match_by_key(body.match_key)
    if not m:
        raise HTTPException(status_code=404, detail="Match not found")
    m.youtube_key = _youtube_id(body.youtube_key)
    if body.film_summary is not None:
        m.film_summary = body.film_summary
    if body.film_events is not None:
        m.film_events = body.film_events
    repo.save_match(m)
    emit("film_updated", {"match_key": body.match_key})
    return {"ok": True}


@router.post("/match/result")
def set_result(_: Scouter = Depends(require_admin)) -> dict:
    raise HTTPException(status_code=400, detail="Manual result setting is disabled. Winners are pulled from TBA.")


# --------------------------------------------------------------------------- #
# Analytics                                                                    #
# --------------------------------------------------------------------------- #
@router.get("/metrics")
def metrics(_: Scouter = Depends(current_scouter)) -> dict:
    return {"metrics": [{"key": k, "label": v} for k, v in RANK_METRICS.items()]}


@router.get("/analysis")
def get_analysis(
    event: str | None = None,
    _: Scouter = Depends(current_scouter),
) -> dict:
    return analysis_bundle(repo.resolve_event(event))


@router.get("/raw-data")
def raw_data(
    event: str | None = None,
    _: Scouter = Depends(require_admin),
) -> dict:
    """Raw event records from the in-process cache; this causes no Firestore read."""
    event_key = repo.resolve_event(event)
    originals = [entry for entry in repo.store.all(schema.MATCH_SCOUTING) if entry.event_key == event_key]
    states = audit_state(repo.scouting_audits(event_key))
    expected = {team: team_summary(event_key, team).get("avg_points") for team in event_teams(event_key)}
    entries = []
    for original in originals:
        state = states.get(original.submission_id, {})
        effective = apply_patch(original, state.get("patch") or {})
        row = _entry_dict(effective)
        row["review"] = {k: state.get(k, v) for k, v in {"flagged": False, "voided": False, "revision": 0}.items()}
        row["expected_avg_points"] = expected.get(effective.team_number)
        row["original"] = _entry_dict(original) if state.get("patch") else None
        entries.append(row)
    return {
        "event": event_key,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "entries": entries,
        # Keep image bytes out of this event-wide response. Each report still
        # exposes its photo count, while Team Search loads and locally caches
        # the selected team's full-resolution photos on demand.
        "pit_entries": [_pit_dict(entry, include_photos=False) for entry in repo.pits_for_event(event_key)],
    }


class ReviewActionIn(BaseModel):
    reason: str = Field(min_length=2, max_length=1000)
    category: str = Field(default="other", max_length=80)
    expected_revision: int | None = None
    patch: dict = Field(default_factory=dict)


def _review_action(report_id: str, action: str, body: ReviewActionIn, admin: Scouter) -> dict:
    original = repo.store.get(schema.MATCH_SCOUTING, report_id)
    if original is None:
        raise HTTPException(status_code=404, detail="Scouting report not found")
    states = audit_state(repo.scouting_audits(original.event_key))
    current = states.get(report_id, {"revision": 0})
    if body.expected_revision is not None and body.expected_revision != current.get("revision", 0):
        raise HTTPException(status_code=409, detail="This report changed since you opened it. Refresh before saving.")
    patch = dict(body.patch or {}) if action == "edit" else {}
    blocked = {"submission_id", "client_uuid", "id", "created_at", "payload_hash", "points"}
    if blocked.intersection(patch):
        raise HTTPException(status_code=400, detail="Immutable identity and computed fields cannot be edited")
    for key in ("team_number", "match_number", "station"):
        if key in patch:
            try: patch[key] = int(patch[key])
            except (TypeError, ValueError): raise HTTPException(status_code=400, detail=f"{key} must be an integer")
    if int(patch.get("team_number", 1)) < 1 or int(patch.get("match_number", 1)) < 1:
        raise HTTPException(status_code=400, detail="Team and match numbers must be at least 1")
    if "station" in patch and not 1 <= int(patch["station"]) <= 3:
        raise HTTPException(status_code=400, detail="Station must be 1-3")
    if "alliance" in patch and patch["alliance"] not in {"red", "blue"}:
        raise HTTPException(status_code=400, detail="Alliance must be red or blue")
    if "comp_level" in patch and patch["comp_level"] not in {"qm", "qf", "sf", "f"}:
        raise HTTPException(status_code=400, detail="Competition level must be qm, qf, sf, or f")
    if len(str(patch.get("notes", ""))) > schema.MAX_NOTES_CHARS:
        raise HTTPException(status_code=400, detail="Notes exceed the maximum length")
    if "heatmap" in patch:
        if not isinstance(patch["heatmap"], list):
            raise HTTPException(status_code=400, detail="Heatmap must be a list of attempts")
        if len(patch["heatmap"]) > schema.MAX_HEATMAP_ATTEMPTS:
            raise HTTPException(status_code=400, detail="Heatmap has too many attempts")
    for key in ("auto_missed", "teleop_missed", "foul_count", "successful_stops"):
        if key in patch:
            try: patch[key] = int(patch[key])
            except (TypeError, ValueError): raise HTTPException(status_code=400, detail=f"{key} must be an integer")
            if patch[key] < 0: raise HTTPException(status_code=400, detail=f"{key} cannot be negative")
    for key in ("driver_skill", "speed_rating", "defense_rating"):
        if key in patch:
            try: patch[key] = int(patch[key])
            except (TypeError, ValueError): raise HTTPException(status_code=400, detail=f"{key} must be an integer")
            if not 1 <= patch[key] <= 5: raise HTTPException(status_code=400, detail=f"{key} must be 1-5")
    now = datetime.now(timezone.utc).isoformat()
    next_revision = current.get("revision", 0) + 1
    effective_before = apply_patch(original, current.get("patch") or {})
    before = {key: getattr(effective_before, key) if hasattr(effective_before, key) else effective_before.data.get(key)
              for key in patch}
    doc = ScoutingAuditDocument(id=f"{report_id}__{next_revision:06d}", event_key=original.event_key, data={
        "event_key": original.event_key, "report_id": report_id, "action": action,
        "reason": body.reason.strip(), "category": body.category.strip(), "patch": patch, "before": before,
        "actor_id": admin.scout_id, "actor_name": admin.display_name, "created_at": now,
        "previous_revision": current.get("revision", 0),
    })
    if not repo.create_scouting_audit(doc):
        raise HTTPException(status_code=409, detail="This report changed while you were saving. Refresh and try again.")
    repo.invalidate_memo()
    emit("scouting_corrected", {"report_id": report_id, "action": action, "event": original.event_key})
    return {"ok": True, "revision": next_revision}


@router.post("/scouting-data/{report_id}/flag")
def flag_report(report_id: str, body: ReviewActionIn, admin: Scouter = Depends(require_admin)) -> dict:
    return _review_action(report_id, "flag", body, admin)

@router.post("/scouting-data/{report_id}/resolve")
def resolve_report(report_id: str, body: ReviewActionIn, admin: Scouter = Depends(require_admin)) -> dict:
    return _review_action(report_id, "resolve_flag", body, admin)

@router.post("/scouting-data/{report_id}/edit")
def edit_report(report_id: str, body: ReviewActionIn, admin: Scouter = Depends(require_admin)) -> dict:
    return _review_action(report_id, "edit", body, admin)

@router.post("/scouting-data/{report_id}/void")
def void_report(report_id: str, body: ReviewActionIn, admin: Scouter = Depends(require_admin)) -> dict:
    return _review_action(report_id, "void", body, admin)

@router.post("/scouting-data/{report_id}/restore")
def restore_report(report_id: str, body: ReviewActionIn, admin: Scouter = Depends(require_admin)) -> dict:
    return _review_action(report_id, "restore", body, admin)

@router.get("/scouting-data/{report_id}/audit")
def report_audit(report_id: str, admin: Scouter = Depends(require_admin)) -> dict:
    original = repo.store.get(schema.MATCH_SCOUTING, report_id)
    if original is None: raise HTTPException(status_code=404, detail="Scouting report not found")
    rows = [r.data for r in repo.scouting_audits(original.event_key) if r.data.get("report_id") == report_id]
    rows.sort(key=lambda r: r.get("created_at", ""))
    return {"report_id": report_id, "actions": rows}


class MatchReviewIn(BaseModel):
    event_key: str = ""
    comp_level: str = "qm"
    match_number: int = Field(ge=1)
    reason: str = Field(min_length=2, max_length=1000)
    category: str = Field(default="match_review", max_length=80)


@router.post("/scouting-data/match/void")
def void_match_reports(body: MatchReviewIn, admin: Scouter = Depends(require_admin)) -> dict:
    event_key = repo.resolve_event(body.event_key or None)
    rows = [e for e in repo.store.all(schema.MATCH_SCOUTING) if e.event_key == event_key
            and e.comp_level == body.comp_level and e.match_number == body.match_number]
    for row in rows:
        _review_action(row.submission_id, "void", ReviewActionIn(reason=body.reason, category=body.category), admin)
    return {"ok": True, "count": len(rows)}


@router.get("/event-teams")
def list_event_teams(
    event: str | None = None,
    _: Scouter = Depends(current_scouter),
) -> list[int]:
    return event_teams(repo.resolve_event(event))


@router.get("/rank")
def rank(
    metric: str = "avg_points",
    event: str | None = None,
    _: Scouter = Depends(current_scouter),
) -> dict:
    event_key = repo.resolve_event(event)
    return {"metric": metric, "teams": rank_teams(event_key, metric)}


@router.get("/data-analysis")
def get_data_analysis(
    event: str | None = None,
    _: Scouter = Depends(current_scouter),
) -> dict:
    event_key = repo.resolve_event(event)
    # Return cached scouting analysis immediately. Match 13 is loaded through
    # /api/matches/event-ratings so an upstream slowdown never blocks this table.
    return {"event": event_key, "teams": data_analysis(event_key)}


@router.get("/data-picklist")
def get_data_picklist(
    event: str | None = None,
    _: Scouter = Depends(current_scouter),
) -> dict:
    return data_picklist(repo.resolve_event(event))


@router.get("/disagreements")
def get_disagreements(
    event: str | None = None,
    _: Scouter = Depends(current_scouter),
) -> dict:
    """Consensus radar: teams where scouts disagree with each other, or the
    numbers disagree with the qualitative reads."""
    return scout_disagreements(repo.resolve_event(event))


@router.get("/compare")
def compare(
    teams: str,
    event: str | None = None,
    _: Scouter = Depends(current_scouter),
) -> dict:
    event_key = repo.resolve_event(event)
    nums = []
    for part in teams.split(","):
        part = part.strip()
        if part.isdigit():
            nums.append(int(part))
    nums = nums[:6]
    return compare_teams(event_key, nums)


@router.get("/team/{team}/summary")
def get_team_summary(
    team: int,
    event: str | None = None,
    _: Scouter = Depends(current_scouter),
) -> dict:
    return team_summary(repo.resolve_event(event), team)


@router.get("/team/{team}/heatmap")
def get_team_heatmap(
    team: int,
    phase: str | None = None,
    event: str | None = None,
    _: Scouter = Depends(current_scouter),
) -> dict:
    return team_heatmap(repo.resolve_event(event), team, phase)


@router.get("/team/{team}/reports")
def get_team_reports(
    team: int,
    event: str | None = None,
    _: Scouter = Depends(current_scouter),
) -> list[dict]:
    event_key = repo.resolve_event(event)
    return [
        report_dict(entry, scout_name(entry.scout_id))
        for entry in team_entries(event_key, team)
    ]


@router.get("/scouters")
def scouters(_: Scouter = Depends(require_admin)) -> list[dict]:
    out = []
    for s in repo.scouters():
        seen = repo.last_seen(s)
        out.append(
            {
                "scout_id": s.scout_id,
                "s_number": s.s_number,
                "display_name": s.display_name or s.scout_id,
                "role": s.role,
                "is_admin": s.is_admin,
                "bucks": s.bucks,
                "matches_scouted": s.matches_scouted,
                "last_seen": seen.isoformat() if seen else None,
            }
        )
    out.sort(key=lambda r: -r["matches_scouted"])
    return out


class RoleIn(BaseModel):
    role: str


class PasswordResetIn(BaseModel):
    scout_id: str


@router.post("/scouters/password-reset")
def reset_scouter_password(
    body: PasswordResetIn,
    _: Scouter = Depends(require_full_admin),
) -> dict:
    """Return a roster member to first-use password setup.

    Clearing the hash also invalidates their active requests because
    ``current_scouter`` refuses member accounts until setup is complete.
    """
    canonical = canonical_account_id(body.scout_id)
    if canonical is None:
        raise HTTPException(status_code=404, detail="Scouter ID is not on the roster")
    if canonical == "Admin":
        raise HTTPException(
            status_code=400,
            detail="The Admin password is managed through HAZEHUB_TEAM_PASSWORD",
        )
    target = repo.scouter(canonical)
    if target is None:
        raise HTTPException(status_code=404, detail="Scouter account was not found")
    target.password_hash = ""
    repo.save_scouter(target)
    emit("password_reset", {"scout_id": target.scout_id})
    return {"ok": True, "scout_id": target.scout_id}


@router.post("/scouters/{scout_id}/role")
def set_role(
    scout_id: str,
    body: RoleIn,
    admin: Scouter = Depends(require_full_admin),
) -> dict:
    """Roles are fixed; retain the route to reject older clients clearly."""
    raise HTTPException(status_code=400, detail="Roles are fixed by the roster. Admin is the only administrator.")


@router.get("/roles")
def list_roles(_: Scouter = Depends(require_admin)) -> dict:
    return {
        "roles": [
            {"key": ROLE_SCOUTER, "label": "Scouter",
             "description": "Collects match and pit data. Builds their own picklists."},
            {"key": ROLE_STRATEGY, "label": "Strategy",
             "description": "Everything a scouter does, plus all analysis screens. "
                            "Their picklists outrank scouter lists in the meeting."},
            {"key": ROLE_ADMIN, "label": "Admin",
             "description": "Strategy, plus event control, film and account roles."},
            {"key": ROLE_PICKLIST, "label": "Picklist meeting",
             "description": "Shared screen account for the picklist meeting. "
                            "Can only view teams and edit picklists."},
        ]
    }


# --------------------------------------------------------------------------- #
# Firestore quota                                                              #
# --------------------------------------------------------------------------- #
@router.get("/firestore-usage")
def firestore_usage(_: Scouter = Depends(require_admin)) -> dict:
    """Where today's Firestore document operations went.

    ``projected_12h`` extrapolates the current rate over a full competition
    day: if it stays under the free-tier limits, the event costs nothing.
    """
    return {
        **guard.snapshot(),
        "cache": repo.cache_stats(),
        "note": (
            "Reads are dominated by the one-time load at startup; steady-state "
            "requests are served from memory. Writes track actual submissions."
        ),
    }


@router.post("/cache/reload")
def reload_cache(_: Scouter = Depends(require_admin)) -> dict:
    """Re-read the current event from Firestore.

    Only needed if data was changed outside this service (a console edit, a
    manual import). Costs one read per document in the event.
    """
    event_key = repo.current_event()
    from ..cache import store

    store.retarget_event("")
    store.retarget_event(event_key)
    repo.invalidate_memo()
    return {"ok": True, "event": event_key, "cache": repo.cache_stats()}


# --------------------------------------------------------------------------- #
# Event archives                                                               #
# --------------------------------------------------------------------------- #
def _archive_dict(row) -> dict:
    return {
        "event_key": row.event_key,
        "name": row.name,
        "season": row.season,
        "game_name": row.game_name,
        "archived_at": row.archived_at.isoformat(),
        "counts": row.counts,
        "teams": row.teams,
        "pit": row.pit,
        "picklists": row.picklists,
        "event": row.event,
        "matches": row.matches,
        "scouting": row.scouting,
        "pit_raw": row.pit_raw,
        "picklists_raw": row.picklists_raw,
        "bets": row.bets,
        "team_cache": row.team_cache,
        "analytics": row.analytics,
        "chunk_ids": row.chunk_ids,
    }


@router.get("/archives")
def list_archives(_: Scouter = Depends(require_admin)) -> list[dict]:
    """Every event this installation has finished, newest first.

    Summaries only. The per-team detail is a second request, because the
    whole point of the archive is that the list stays small enough to load
    without thinking about it.
    """
    return [
        {
            "event_key": a.event_key,
            "name": a.name,
            "season": a.season,
            "game_name": a.game_name,
            "archived_at": a.archived_at.isoformat(),
            "counts": a.counts,
            "match_count": a.counts.get("matches", 0),
            "team_count": a.counts.get("teams", 0),
            "scouting_count": a.counts.get("scouting_entries", 0),
        }
        for a in repo.archives()
    ]


@router.get("/archives/{event_key}")
def get_archive(event_key: str, _: Scouter = Depends(require_admin)) -> dict:
    row = repo.archive_detail(event_key)
    if row is None:
        raise HTTPException(status_code=404, detail=f"No archive for {event_key}")
    return _archive_dict(row)


@router.post("/archives/{event_key}")
def create_archive(event_key: str, _: Scouter = Depends(require_admin)) -> dict:
    """Archive an event now.

    Normally this happens by itself when the current event changes. Doing it
    by hand is for taking a checkpoint mid-event, or for rebuilding an archive
    after late scouting has synced in. Re-running overwrites, so it is safe.
    """
    event_key = (event_key or "").strip()
    if event_key != repo.current_event() and not repo.event(event_key):
        raise HTTPException(status_code=404, detail=f"Unknown event {event_key}")
    row = archive_event(event_key)
    emit("event_archived", {"event": row.event_key})
    return {"ok": True, "event": row.event_key, "counts": row.counts}


@router.post("/archive-and-reset")
def archive_and_reset(
    body: ArchiveResetIn,
    _: Scouter = Depends(require_admin),
) -> dict:
    event_key = repo.current_event()
    if not event_key:
        raise HTTPException(status_code=400, detail="No current event is set.")

    row = archive_event(event_key, body.name.strip() or None)
    verified = repo.archive_detail(event_key)
    if (
        verified is None
        or verified.counts != row.counts
        or len(verified.scouting) != row.counts.get("scouting_entries", 0)
        or len(verified.matches) != row.counts.get("matches", 0)
    ):
        raise HTTPException(status_code=500, detail="Archive verification failed; active data was not cleared.")

    deleted = {
        "scouting": repo.delete_scouting_for_event(event_key),
        "matches": repo.delete_matches_for_event(event_key),
        "pit": repo.delete_pits_for_event(event_key),
        "picklists": repo.delete_picklists_for_event(event_key),
        "bets": repo.delete_bets_for_event(event_key),
    }
    repo.delete_event(event_key)
    repo.set_setting("current_event", "")
    repo.set_setting("current_match", "0")
    emit("settings_changed", {"current_event": "", "current_match": 0})
    emit("event_archived", {"event": event_key})
    return {"ok": True, "archive": _archive_dict(row), "deleted": deleted}

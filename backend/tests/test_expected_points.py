from app.expected_points import estimate_avg_points
from app.models import ScoutEntry, ScoutingAuditDocument
from app.scouting_review import audit_state, effective_entries


def report(match=1, scout="a", points=0, made=4, missed=1):
    return ScoutEntry(
        event_key="event", match_number=match, team_number=418, scout_id=scout,
        points=points,
        actions=[{"phase": "teleop", "action": "score", "result": "made"} for _ in range(made)]
                + [{"phase": "teleop", "action": "score", "result": "missed"} for _ in range(missed)],
        data={"climb": "none"},
    )


def test_expected_points_ignores_epa_calibrated_report_points_and_duplicate_scouts():
    base = [report(1, points=1), report(2, points=999)]
    expected = estimate_avg_points(base, base)
    duplicate = report(1, scout="second observer", points=5000)
    assert estimate_avg_points(base + [duplicate], base + [duplicate]) == expected


def test_expected_points_counts_failures_once_through_zero_volume():
    healthy = report(1, made=8, missed=2)
    failed = report(2, made=0, missed=0)
    failed.data["failure"] = True
    assert estimate_avg_points([healthy, failed], [healthy, failed]) < estimate_avg_points([healthy], [healthy])


def test_review_actions_preserve_original_and_fold_append_only_state():
    original = report()
    actions = [
        ScoutingAuditDocument("1", {"report_id": original.submission_id, "action": "flag", "created_at": "1"}, "event"),
        ScoutingAuditDocument("2", {"report_id": original.submission_id, "action": "edit", "patch": {"team_number": 436}, "created_at": "2"}, "event"),
        ScoutingAuditDocument("3", {"report_id": original.submission_id, "action": "void", "created_at": "3"}, "event"),
    ]
    state = audit_state(actions)[original.submission_id]
    assert state["flagged"] and state["voided"] and state["revision"] == 3
    assert effective_entries([original], actions) == []
    effective = effective_entries([original], actions, include_voided=True)[0]
    assert effective.team_number == 436
    assert original.team_number == 418

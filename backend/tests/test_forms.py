"""Form definitions, validation, diffing, and the git-like history.

Two things are being protected here.

The first is data: a field's key is the name its answers are stored under
forever, so duplicate keys and silent renames have to be impossible. The
validator is the only thing standing between a mis-click and a season of
unreadable submissions.

The second is the record: saving must never overwrite, reverting must never
delete, and every version must carry who wrote it and why. If any of that
stops being true, "who dropped the defense rating and when" becomes
unanswerable, which is the whole reason the history exists.
"""
from __future__ import annotations

import pytest

from app.forms import (
    FIELD_TYPES,
    FormInvalid,
    default_match_form,
    default_pit_form,
    diff_definitions,
    ensure_valid,
    iter_fields,
    missing_core_fields,
    summarize_diff,
    validate_definition,
)
from app.models import Form, FormRevision


def form(*fields, title="Section 1"):
    return {"name": "Test", "sections": [{"title": title, "fields": list(fields)}]}


# --------------------------------------------------------------------------- #
# Validation                                                                   #
# --------------------------------------------------------------------------- #
def test_the_built_in_forms_are_valid():
    # A fresh install must not start in a broken state.
    assert validate_definition(default_match_form()) == []
    assert validate_definition(default_pit_form()) == []


def test_every_field_type_is_renderable_as_declared():
    """A type in the catalogue with no label would render as a blank control."""
    for key, meta in FIELD_TYPES.items():
        assert meta["label"], key
        assert meta["hint"], key


def test_a_form_needs_a_section():
    assert validate_definition({"sections": []})
    assert validate_definition({})


def test_duplicate_keys_are_refused():
    """Two fields sharing a key means one silently overwrites the other."""
    problems = validate_definition(
        form(
            {"key": "cycles", "type": "counter", "label": "Auto cycles"},
            {"key": "cycles", "type": "counter", "label": "Teleop cycles"},
        )
    )
    assert any("cycles" in p and "unique" in p for p in problems)


@pytest.mark.parametrize("key", ["", "Cycles", "9lives", "has space", "has-dash", "x" * 41])
def test_bad_keys_are_refused(key):
    problems = validate_definition(form({"key": key, "type": "counter", "label": "N"}))
    assert any("key" in p for p in problems)


@pytest.mark.parametrize("key", ["cycles", "auto_cycles", "l4", "a"])
def test_good_keys_are_accepted(key):
    assert validate_definition(form({"key": key, "type": "counter", "label": "N"})) == []


def test_a_choice_field_needs_options():
    problems = validate_definition(form({"key": "climb", "type": "select", "label": "Climb"}))
    assert any("option" in p for p in problems)


def test_repeated_option_values_are_refused():
    problems = validate_definition(
        form({
            "key": "climb", "type": "select", "label": "Climb",
            "options": [{"value": "l1"}, {"value": "l1"}],
        })
    )
    assert any("repeats" in p for p in problems)


def test_an_unknown_field_type_is_refused():
    assert validate_definition(form({"key": "x", "type": "hologram", "label": "X"}))


def test_instructions_need_no_key():
    # A note collects nothing, so demanding a key for it would be noise.
    assert validate_definition(form({"type": "note", "label": "Watch the intake"})) == []


def test_a_rating_scale_has_to_be_usable():
    assert validate_definition(form({"key": "d", "type": "rating", "label": "D", "max": 1}))
    assert validate_definition(form({"key": "d", "type": "rating", "label": "D", "max": 99}))
    assert validate_definition(form({"key": "d", "type": "rating", "label": "D", "max": 5})) == []


def test_a_minimum_above_a_maximum_is_refused():
    assert validate_definition(
        form({"key": "c", "type": "counter", "label": "C", "min": 10, "max": 2})
    )


def test_mapping_to_an_unknown_core_field_is_refused():
    assert validate_definition(
        form({"key": "x", "type": "counter", "label": "X", "maps_to": "vibes"})
    )


def test_every_problem_is_reported_at_once():
    """An admin fixing a 40-field form should see the whole list, not one item
    per save."""
    problems = validate_definition(
        form(
            {"key": "BAD", "type": "counter", "label": ""},
            {"key": "also bad", "type": "select", "label": "Pick"},
        )
    )
    assert len(problems) >= 3


def test_ensure_valid_carries_the_problems():
    with pytest.raises(FormInvalid) as caught:
        ensure_valid(form({"key": "", "type": "counter", "label": ""}))
    assert caught.value.problems


# --------------------------------------------------------------------------- #
# Analytics warnings                                                           #
# --------------------------------------------------------------------------- #
def test_the_default_match_form_feeds_the_analytics():
    assert missing_core_fields(default_match_form()) == []


def test_dropping_an_analytics_input_is_warned_about_not_blocked():
    """Warning, not error: a game where nobody plays defense is a real thing,
    and the team is allowed to stop asking."""
    definition = default_match_form()
    for section in definition["sections"]:
        section["fields"] = [f for f in section["fields"] if f.get("maps_to") != "climb"]

    assert validate_definition(definition) == []  # still saveable
    warnings = missing_core_fields(definition)
    assert [w["field"] for w in warnings] == ["climb"]
    assert "climb rate" in warnings[0]["consequence"]


def test_a_form_built_from_scratch_warns_about_everything_it_lost():
    warnings = missing_core_fields(form({"key": "x", "type": "counter", "label": "X"}))
    assert {w["field"] for w in warnings} >= {"team_number", "climb", "tags"}


# --------------------------------------------------------------------------- #
# Diffing                                                                      #
# --------------------------------------------------------------------------- #
def test_diff_reports_additions_and_removals():
    before = form({"key": "a", "type": "counter", "label": "A"})
    after = form({"key": "b", "type": "counter", "label": "B"})
    d = diff_definitions(before, after)

    assert [x["key"] for x in d["added"]] == ["b"]
    assert [x["key"] for x in d["removed"]] == ["a"]
    assert d["total"] == 2


def test_diff_reports_a_property_change():
    before = form({"key": "a", "type": "counter", "label": "A", "points": 2})
    after = form({"key": "a", "type": "counter", "label": "Algae", "points": 6})
    d = diff_definitions(before, after)

    assert not d["added"] and not d["removed"]
    props = {c["property"]: (c["from"], c["to"]) for c in d["changed"][0]["changes"]}
    assert props["label"] == ("A", "Algae")
    assert props["points"] == (2, 6)


def test_moving_a_field_is_a_move_not_a_delete_and_an_add():
    """Keyed on the field, not its position, so a reshuffle stays readable."""
    field = {"key": "a", "type": "counter", "label": "A"}
    before = {"sections": [{"title": "One", "fields": [field]}, {"title": "Two", "fields": []}]}
    after = {"sections": [{"title": "One", "fields": []}, {"title": "Two", "fields": [field]}]}
    d = diff_definitions(before, after)

    assert not d["added"] and not d["removed"]
    assert d["moved"] == [{"key": "a", "label": "A", "from": "One", "to": "Two"}]


def test_reordering_within_a_section_is_not_a_change():
    a = {"key": "a", "type": "counter", "label": "A"}
    b = {"key": "b", "type": "counter", "label": "B"}
    d = diff_definitions(form(a, b), form(b, a))
    assert d["total"] == 0


def test_diff_against_nothing_is_all_additions():
    d = diff_definitions({"sections": []}, default_match_form())
    assert len(d["added"]) == len(list(iter_fields(default_match_form())))
    assert not d["removed"]


def test_summary_reads_like_an_edit_note():
    before = form({"key": "a", "type": "counter", "label": "A"})
    after = form(
        {"key": "a", "type": "counter", "label": "Algae"},
        {"key": "b", "type": "counter", "label": "B"},
    )
    assert summarize_diff(diff_definitions(before, after)) == "1 added, 1 changed"
    assert summarize_diff(diff_definitions(after, after)) == "no field changes"


# --------------------------------------------------------------------------- #
# Documents                                                                    #
# --------------------------------------------------------------------------- #
def test_a_revision_is_addressable_by_form_and_version():
    # Zero padded so revisions sort in order as document IDs.
    assert FormRevision(form_id="match", version=7).doc_id == "match@000007"
    assert FormRevision(form_id="match", version=1234).doc_id == "match@001234"
    assert FormRevision(form_id="m", version=2).doc_id > FormRevision(form_id="m", version=1).doc_id


def test_a_revision_round_trips():
    row = FormRevision(
        form_id="match",
        version=4,
        definition=default_match_form(),
        parent_version=3,
        message="Add algae counters",
        author_id="Strategy",
        author_name="Strategy",
        reverted_from=2,
        summary="1 added",
    )
    back = FormRevision.from_doc(row.doc_id, row.to_doc())

    assert back.version == 4
    assert back.parent_version == 3
    assert back.message == "Add algae counters"
    assert back.author_name == "Strategy"
    assert back.reverted_from == 2
    assert back.definition["sections"][0]["title"] == "Your robot"


def test_a_form_round_trips():
    row = Form(
        form_id="pit", kind="pit", name="Pit Scouting",
        published_version=3, latest_version=5, archived=True, updated_by="Admin",
    )
    back = Form.from_doc("pit", row.to_doc())

    assert (back.published_version, back.latest_version) == (3, 5)
    assert back.archived is True
    assert back.updated_by == "Admin"


# --------------------------------------------------------------------------- #
# The history rules                                                            #
# --------------------------------------------------------------------------- #
class _Store:
    """Enough of repo to exercise form_store without a datastore."""

    def __init__(self):
        self.forms: dict[str, Form] = {}
        self.revisions: dict[tuple[str, int], FormRevision] = {}

    def install(self, monkeypatch):
        from app import form_store

        monkeypatch.setattr(form_store.repo, "form", lambda fid: self.forms.get(fid))
        monkeypatch.setattr(form_store.repo, "save_form", lambda f: self.forms.__setitem__(f.form_id, f))
        monkeypatch.setattr(
            form_store.repo, "form_revision",
            lambda fid, v: self.revisions.get((fid, int(v))),
        )
        monkeypatch.setattr(
            form_store.repo, "save_form_revision",
            lambda r: self.revisions.__setitem__((r.form_id, r.version), r),
        )
        monkeypatch.setattr(
            form_store.repo, "form_revisions",
            lambda fid, limit=100: sorted(
                [r for (f, _), r in self.revisions.items() if f == fid],
                key=lambda r: r.version, reverse=True,
            )[:limit],
        )
        return form_store


@pytest.fixture
def fs(monkeypatch):
    backing = _Store()
    module = backing.install(monkeypatch)
    return module, backing


@pytest.fixture
def author():
    from app.models import Scouter

    return Scouter(scout_id="Strategy", display_name="Strategy")


def _seed(fs, author):
    module, backing = fs
    module.create_form("match", "match", default_match_form(), author, "First")
    return module, backing


def test_saving_never_overwrites(fs, author):
    module, backing = _seed(fs, author)
    definition = default_match_form()
    definition["sections"][0]["fields"].append(
        {"key": "extra", "type": "counter", "label": "Extra"}
    )
    module.save_revision("match", definition, author, "Add extra")

    assert backing.revisions[("match", 1)].version == 1
    assert "extra" not in [f["key"] for f in iter_fields(backing.revisions[("match", 1)].definition)]
    assert "extra" in [f["key"] for f in iter_fields(backing.revisions[("match", 2)].definition)]
    assert backing.forms["match"].latest_version == 2


def test_every_revision_records_who_and_why(fs, author):
    module, backing = _seed(fs, author)
    module.save_revision("match", default_match_form(), author, "Tidy up")
    row = backing.revisions[("match", 2)]

    assert row.author_id == "Strategy"
    assert row.author_name == "Strategy"
    assert row.message == "Tidy up"
    assert row.parent_version == 1
    assert row.created_at is not None


def test_reverting_moves_forward_and_keeps_everything(fs, author):
    """The point of a revert is to undo the change, not to erase the attempt."""
    module, backing = _seed(fs, author)

    v2 = default_match_form()
    v2["sections"][0]["fields"].append({"key": "temp", "type": "counter", "label": "Temp"})
    module.save_revision("match", v2, author, "Try something")

    reverted = module.revert("match", 1, author)

    assert reverted.version == 3, "revert writes a new version"
    assert reverted.reverted_from == 1
    assert ("match", 2) in backing.revisions, "the version being undone survives"
    assert "temp" not in [f["key"] for f in iter_fields(reverted.definition)]
    assert backing.forms["match"].published_version == 3


def test_a_revert_can_itself_be_reverted(fs, author):
    module, backing = _seed(fs, author)
    v2 = default_match_form()
    v2["sections"][0]["fields"].append({"key": "temp", "type": "counter", "label": "Temp"})
    module.save_revision("match", v2, author, "Add temp")
    module.revert("match", 1, author)          # v3: drops temp
    again = module.revert("match", 2, author)  # v4: brings it back

    assert again.version == 4
    assert "temp" in [f["key"] for f in iter_fields(again.definition)]


def test_publishing_is_separate_from_saving(fs, author):
    """A form change lands on sixty devices at once, so it can be drafted."""
    module, backing = _seed(fs, author)
    definition = default_match_form()
    definition["sections"][0]["fields"].append({"key": "draft", "type": "counter", "label": "Draft"})
    module.save_revision("match", definition, author, "Draft it", publish=False)

    assert backing.forms["match"].latest_version == 2
    assert backing.forms["match"].published_version == 1
    assert "draft" not in [f["key"] for f in iter_fields(module.published_definition("match"))]

    module.publish("match", 2, author)
    assert "draft" in [f["key"] for f in iter_fields(module.published_definition("match"))]


def test_a_concurrent_edit_is_refused_rather_than_silently_dropped(fs, author):
    """Two strategy leads editing one form is normal; losing one of their
    afternoons to a last-write-wins save is not."""
    module, _ = _seed(fs, author)
    module.save_revision("match", default_match_form(), author, "Theirs")

    with pytest.raises(module.FormConflict) as caught:
        module.save_revision(
            "match", default_match_form(), author, "Mine", expected_version=1
        )
    assert "version 2" in str(caught.value)


def test_an_invalid_definition_never_reaches_the_history(fs, author):
    module, backing = _seed(fs, author)
    with pytest.raises(FormInvalid):
        module.save_revision("match", form({"key": "", "type": "counter", "label": ""}), author)
    assert backing.forms["match"].latest_version == 1


def test_deleting_is_archiving_and_keeps_the_history(fs, author):
    module, backing = _seed(fs, author)
    module.create_form("debrief", "custom", form({"key": "a", "type": "text", "label": "A"}), author)

    module.set_archived("debrief", True, author)
    assert backing.forms["debrief"].archived is True
    assert ("debrief", 1) in backing.revisions

    module.set_archived("debrief", False, author)
    assert backing.forms["debrief"].archived is False


def test_the_built_in_forms_cannot_be_deleted(fs, author):
    """The scouting and pit pages render from them, so removing one takes
    scouting down entirely."""
    module, _ = _seed(fs, author)
    with pytest.raises(ValueError):
        module.set_archived("match", True, author)


def test_creating_a_duplicate_form_is_refused(fs, author):
    module, _ = _seed(fs, author)
    with pytest.raises(ValueError):
        module.create_form("match", "custom", default_match_form(), author)


@pytest.mark.parametrize("form_id", ["has space", "has/slash", "", "!!"])
def test_bad_form_ids_are_refused(fs, author, form_id):
    module, _ = _seed(fs, author)
    with pytest.raises(ValueError):
        module.create_form(form_id, "custom", form({"key": "a", "type": "text", "label": "A"}), author)


def test_history_marks_what_is_live(fs, author):
    module, _ = _seed(fs, author)
    module.save_revision("match", default_match_form(), author, "Second")

    rows = module.history("match")
    assert [r["version"] for r in rows] == [2, 1], "newest first"
    assert rows[0]["published"] and rows[0]["latest"]
    assert not rows[1]["published"]


def test_seeding_never_resets_an_edited_form(fs, author):
    """An install that has customised its forms must survive a deploy."""
    module, backing = _seed(fs, author)
    edited = default_match_form()
    edited["name"] = "Our Match Form"
    module.save_revision("match", edited, author, "Rename")

    module.seed_builtin_forms()

    assert backing.forms["match"].latest_version == 2
    assert backing.forms["match"].name == "Our Match Form"

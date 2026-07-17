"""MongoDB collection validators and index declarations.

The validators provide database-side protection even when a writer bypasses
the Pydantic application models. References between collections are checked by
``HazeHubRepository`` because MongoDB intentionally has no foreign keys.
"""

from __future__ import annotations

from typing import Any

from pymongo import ASCENDING, DESCENDING, IndexModel


SCHEMA_VERSION = 2
COMP_LEVELS = ["qm", "qf", "sf", "f"]
BET_STATUSES = ["open", "won", "lost", "refunded"]
PICK_TIERS = ["first", "second", "third", "dnp"]

TIMESTAMP_PROPERTIES = {
    "created_at": {"bsonType": "date"},
    "updated_at": {"bsonType": "date"},
}

COLLECTION_SCHEMAS: dict[str, dict[str, Any]] = {
    "scouters": {
        "bsonType": "object",
        "required": [
            "_id",
            "s_number",
            "display_name",
            "is_admin",
            "bucks",
            "matches_scouted",
            "last_seen",
            "created_at",
            "updated_at",
        ],
        "additionalProperties": False,
        "properties": {
            "_id": {"bsonType": "string", "minLength": 1, "maxLength": 100},
            "s_number": {"bsonType": "int", "minimum": 1},
            "display_name": {"bsonType": "string", "minLength": 1, "maxLength": 100},
            "is_admin": {"bsonType": "bool"},
            "bucks": {"bsonType": "int", "minimum": 0},
            "matches_scouted": {"bsonType": "int", "minimum": 0},
            "last_seen": {"bsonType": "date"},
            **TIMESTAMP_PROPERTIES,
        },
    },
    "events": {
        "bsonType": "object",
        "required": ["_id", "year", "created_at", "updated_at"],
        "additionalProperties": False,
        "properties": {
            "_id": {"bsonType": "string", "pattern": r"^\d{4}[a-z0-9]+$"},
            "year": {"bsonType": "int", "minimum": 1992, "maximum": 2200},
            "name": {"bsonType": ["string", "null"], "maxLength": 200},
            "start_date": {"bsonType": ["date", "null"]},
            "end_date": {"bsonType": ["date", "null"]},
            **TIMESTAMP_PROPERTIES,
        },
    },
    "matches": {
        "bsonType": "object",
        "required": [
            "_id",
            "event_key",
            "comp_level",
            "set_number",
            "match_num",
            "alliances",
            "betting_locked",
            "created_at",
            "updated_at",
        ],
        "additionalProperties": False,
        "properties": {
            "_id": {"bsonType": "string", "minLength": 1},
            "event_key": {"bsonType": "string", "pattern": r"^\d{4}[a-z0-9]+$"},
            "comp_level": {"enum": COMP_LEVELS},
            "set_number": {"bsonType": "int", "minimum": 1},
            "match_num": {"bsonType": "int", "minimum": 1},
            "alliances": {
                "bsonType": "object",
                "required": ["red", "blue"],
                "additionalProperties": False,
                "properties": {
                    color: {
                        "bsonType": "object",
                        "required": ["teams"],
                        "additionalProperties": False,
                        "properties": {
                            "teams": {
                                "bsonType": "array",
                                "minItems": 1,
                                "maxItems": 4,
                                "uniqueItems": True,
                                "items": {"bsonType": "int", "minimum": 1},
                            },
                            "score": {"bsonType": ["int", "null"], "minimum": -1},
                        },
                    }
                    for color in ("red", "blue")
                },
            },
            "winner": {"enum": ["red", "blue", "tie", None]},
            "predicted_time": {"bsonType": ["int", "null"], "minimum": 0},
            "betting_locked": {"bsonType": "bool"},
            "youtube_key": {"bsonType": "string", "maxLength": 200},
            "film_summary": {"bsonType": "string", "maxLength": 20000},
            "film_events": {"bsonType": "array", "items": {"bsonType": "object"}},
            **TIMESTAMP_PROPERTIES,
        },
    },
    "match_scouting": {
        "bsonType": "object",
        "required": [
            "_id",
            "event_key",
            "match_key",
            "comp_level",
            "set_number",
            "match_num",
            "team_num",
            "alliance",
            "station",
            "scouter_id",
            "data",
            "points",
            "no_show",
            "submitted_at",
            "updated_at",
        ],
        "additionalProperties": False,
        "properties": {
            "_id": {"bsonType": "string", "minLength": 36, "maxLength": 36},
            "client_submission_id": {
                "bsonType": ["string", "null"],
                "minLength": 1,
                "maxLength": 100,
            },
            "event_key": {"bsonType": "string", "pattern": r"^\d{4}[a-z0-9]+$"},
            "match_key": {"bsonType": "string", "minLength": 1},
            "comp_level": {"enum": COMP_LEVELS},
            "set_number": {"bsonType": "int", "minimum": 1},
            "match_num": {"bsonType": "int", "minimum": 1},
            "team_num": {"bsonType": "int", "minimum": 1},
            "alliance": {"enum": ["red", "blue"]},
            "station": {"bsonType": "int", "minimum": 1, "maximum": 3},
            "scouter_id": {"bsonType": "string", "minLength": 1, "maxLength": 100},
            "data": {
                "bsonType": "object",
                "required": ["foul_count"],
                "properties": {
                    "foul_count": {"bsonType": "int", "minimum": 0},
                },
            },
            "points": {"bsonType": ["double", "int"], "minimum": 0},
            "no_show": {"bsonType": "bool"},
            "comments": {"bsonType": ["string", "null"], "maxLength": 5000},
            "submitted_at": {"bsonType": "date"},
            "updated_at": {"bsonType": "date"},
        },
    },
    "picklists": {
        "bsonType": "object",
        "required": [
            "_id",
            "event_key",
            "owner_id",
            "picklist_name",
            "items",
            "is_master",
            "created_at",
            "updated_at",
        ],
        "additionalProperties": False,
        "properties": {
            "_id": {"bsonType": "string", "minLength": 36, "maxLength": 36},
            "event_key": {"bsonType": "string", "pattern": r"^\d{4}[a-z0-9]+$"},
            "owner_id": {"bsonType": "string", "minLength": 1, "maxLength": 100},
            "picklist_name": {"bsonType": "string", "minLength": 1, "maxLength": 200},
            "items": {
                "bsonType": "array",
                "items": {
                    "bsonType": "object",
                    "required": ["rank", "team_num", "tier"],
                    "additionalProperties": False,
                    "properties": {
                        "rank": {"bsonType": "int", "minimum": 1},
                        "team_num": {"bsonType": "int", "minimum": 1},
                        "tier": {"enum": PICK_TIERS},
                        "comments": {
                            "bsonType": ["string", "null"],
                            "maxLength": 5000,
                        },
                    },
                },
            },
            "is_master": {"bsonType": "bool"},
            **TIMESTAMP_PROPERTIES,
        },
    },
    "bets": {
        "bsonType": "object",
        "required": [
            "_id",
            "scouter_id",
            "event_key",
            "match_key",
            "match_num",
            "comp_level",
            "pick",
            "wager",
            "win_prob",
            "multiplier",
            "potential_payout",
            "status",
            "payout",
            "created_at",
        ],
        "additionalProperties": False,
        "properties": {
            "_id": {"bsonType": "string", "minLength": 36, "maxLength": 36},
            "scouter_id": {"bsonType": "string", "minLength": 1, "maxLength": 100},
            "event_key": {"bsonType": "string", "pattern": r"^\d{4}[a-z0-9]+$"},
            "match_key": {"bsonType": "string", "minLength": 1},
            "match_num": {"bsonType": "int", "minimum": 1},
            "comp_level": {"enum": COMP_LEVELS},
            "pick": {"enum": ["red", "blue"]},
            "wager": {"bsonType": "int", "minimum": 1},
            "win_prob": {"bsonType": ["double", "int"], "minimum": 0, "maximum": 1},
            "multiplier": {"bsonType": ["double", "int"], "minimum": 1},
            "potential_payout": {"bsonType": "int", "minimum": 0},
            "status": {"enum": BET_STATUSES},
            "payout": {"bsonType": "int", "minimum": 0},
            "created_at": {"bsonType": "date"},
            "resolved_at": {"bsonType": ["date", "null"]},
        },
    },
    "pit_scouting": {
        "bsonType": "object",
        "required": ["_id", "event_key", "team_num", "updated_at"],
        "additionalProperties": False,
        "properties": {
            "_id": {"bsonType": "string", "minLength": 36, "maxLength": 36},
            "event_key": {"bsonType": "string", "pattern": r"^\d{4}[a-z0-9]+$"},
            "team_num": {"bsonType": "int", "minimum": 1},
            "scouter_id": {"bsonType": "string", "maxLength": 100},
            "drivetrain": {"bsonType": "string", "maxLength": 200},
            "weight_lbs": {"bsonType": ["double", "int", "null"], "minimum": 0},
            "width_in": {"bsonType": ["double", "int", "null"], "minimum": 0},
            "length_in": {"bsonType": ["double", "int", "null"], "minimum": 0},
            "can_climb": {"bsonType": "string", "maxLength": 20},
            "auto_routine": {"bsonType": "string", "maxLength": 2000},
            "capabilities": {"bsonType": "array", "items": {"bsonType": "string"}},
            "robot_photo": {"bsonType": "string"},
            "notes": {"bsonType": "string", "maxLength": 5000},
            "updated_at": {"bsonType": "date"},
        },
    },
    "team_cache": {
        "bsonType": "object",
        "required": ["_id", "updated_at"],
        "additionalProperties": False,
        "properties": {
            "_id": {"bsonType": "int", "minimum": 1},
            "nickname": {"bsonType": "string", "maxLength": 200},
            "name": {"bsonType": "string", "maxLength": 500},
            "city": {"bsonType": "string", "maxLength": 100},
            "state": {"bsonType": "string", "maxLength": 100},
            "country": {"bsonType": "string", "maxLength": 100},
            "rookie_year": {
                "bsonType": ["int", "null"],
                "minimum": 1992,
                "maximum": 2200,
            },
            "avatar": {"bsonType": "string"},
            "photos": {"bsonType": "array", "items": {"bsonType": "string"}},
            "epa": {"bsonType": ["double", "int", "null"]},
            "updated_at": {"bsonType": "date"},
        },
    },
    "app_settings": {
        "bsonType": "object",
        "required": ["_id", "value", "updated_at"],
        "additionalProperties": False,
        "properties": {
            "_id": {"bsonType": "string", "minLength": 1, "maxLength": 100},
            "value": {"bsonType": "string", "maxLength": 500},
            "updated_at": {"bsonType": "date"},
        },
    },
    "external_cache": {
        "bsonType": "object",
        "required": ["_id", "fetched_at"],
        "additionalProperties": False,
        "properties": {
            "_id": {"bsonType": "string", "minLength": 1, "maxLength": 2000},
            "payload": {},
            "fetched_at": {"bsonType": "date"},
        },
    },
    "activity": {
        "bsonType": "object",
        "required": ["_id", "event", "ts"],
        "additionalProperties": False,
        "properties": {
            "_id": {"bsonType": "string", "minLength": 36, "maxLength": 36},
            "event": {"bsonType": "string", "minLength": 1, "maxLength": 100},
            "payload": {},
            "ts": {"bsonType": "date"},
        },
    },
}


COLLECTION_INDEXES: dict[str, list[IndexModel]] = {
    "scouters": [
        IndexModel([("s_number", ASCENDING)], unique=True, name="uq_scouter_number"),
    ],
    "events": [
        IndexModel([("year", DESCENDING)], name="ix_event_year"),
    ],
    "matches": [
        IndexModel(
            [
                ("event_key", ASCENDING),
                ("comp_level", ASCENDING),
                ("set_number", ASCENDING),
                ("match_num", ASCENDING),
            ],
            unique=True,
            name="uq_event_match",
        ),
        IndexModel([("event_key", ASCENDING), ("predicted_time", ASCENDING)], name="ix_schedule"),
    ],
    "match_scouting": [
        IndexModel(
            [
                ("event_key", ASCENDING),
                ("comp_level", ASCENDING),
                ("set_number", ASCENDING),
                ("match_num", ASCENDING),
                ("team_num", ASCENDING),
                ("scouter_id", ASCENDING),
            ],
            unique=True,
            name="uq_robot_match_scouter",
        ),
        IndexModel(
            [("client_submission_id", ASCENDING)],
            unique=True,
            partialFilterExpression={"client_submission_id": {"$type": "string"}},
            name="uq_client_submission",
        ),
        IndexModel(
            [("event_key", ASCENDING), ("team_num", ASCENDING), ("submitted_at", DESCENDING)],
            name="ix_event_team_scouting",
        ),
        IndexModel(
            [("scouter_id", ASCENDING), ("submitted_at", DESCENDING)],
            name="ix_scouter_activity",
        ),
    ],
    "picklists": [
        IndexModel(
            [
                ("event_key", ASCENDING),
                ("owner_id", ASCENDING),
                ("picklist_name", ASCENDING),
            ],
            unique=True,
            name="uq_owner_picklist_name",
        ),
        IndexModel(
            [("event_key", ASCENDING), ("is_master", ASCENDING)],
            name="ix_event_picklists",
        ),
    ],
    "bets": [
        IndexModel(
            [("scouter_id", ASCENDING), ("created_at", DESCENDING)],
            name="ix_scouter_bets",
        ),
        IndexModel(
            [("match_key", ASCENDING), ("status", ASCENDING)],
            name="ix_match_open_bets",
        ),
        IndexModel([("event_key", ASCENDING)], name="ix_event_bets"),
    ],
    "pit_scouting": [
        IndexModel(
            [("event_key", ASCENDING), ("team_num", ASCENDING)],
            unique=True,
            name="uq_pit_team",
        ),
    ],
    "team_cache": [],
    "app_settings": [],
    "external_cache": [
        IndexModel([("fetched_at", DESCENDING)], name="ix_cache_age"),
    ],
    "activity": [
        # Realtime events are ephemeral: clients poll the last few seconds,
        # so Mongo can expire anything older than two hours on its own.
        IndexModel([("ts", ASCENDING)], expireAfterSeconds=7200, name="ttl_activity"),
    ],
}

"""The engine's real payloads, executed against the real migrations on Postgres 16.

The rows come from vtrack_engine.events and vtrack_engine.dedupe — the same functions the
routes call — and go in through json_populate_record, which is how PostgREST turns a JSON
body into a row. So text→enum, ISO→timestamptz and list→jsonb are coerced here exactly as
they would be on Supabase.

Runs when VTRACK_TEST_PG_DSN points at a superuser on a Postgres 16 cluster (CI sets it).
Unset: skipped, so a laptop without Postgres still runs the suite. Set but unreachable:
FAILS — CI must never quietly skip the one test that proves the payloads fit the schema.
"""

import json
import os
import typing
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from tests.conftest import seeded_vehicles
from vtrack_engine.auth import Device
from vtrack_engine.db import jsonable
from vtrack_engine.decide import Decision, PlateKind, Reason, Thresholds, decide, interpret
from vtrack_engine.dedupe import OpenEvent, merge
from vtrack_engine.events import new_event_row

DSN = os.environ.get("VTRACK_TEST_PG_DSN")
pytestmark = pytest.mark.skipif(not DSN, reason="VTRACK_TEST_PG_DSN not set")

REPO = Path(__file__).resolve().parents[3]
SQL = [Path(__file__).with_name("pg_shims.sql"),
       REPO / "supabase/migrations/0001_init.sql",
       REPO / "supabase/migrations/0002_policies.sql",
       REPO / "supabase/seed.sql"]
CAM = Device("cam-a", "capture", "gate1", "A")
DISPLAY = Device("display-b", "display", "gate1", "A")
NOW = datetime(2026, 9, 22, 6, 0, tzinfo=UTC)


@pytest.fixture(scope="module")
def db():
    import psycopg
    name = f"vtrack_test_{uuid.uuid4().hex[:10]}"
    admin = psycopg.connect(DSN, autocommit=True)   # set but unreachable → error, not skip
    admin.execute(f'create database "{name}"')
    conn = psycopg.connect(psycopg.conninfo.make_conninfo(DSN, dbname=name), autocommit=True)
    try:
        for f in SQL:
            conn.execute(f.read_text())
        yield conn
    finally:
        conn.close()
        admin.execute(f'drop database "{name}" with (force)')
        admin.close()


def insert(conn, row, role="service_role"):
    conn.execute(f"set role {role}")
    try:
        return conn.execute(
            "insert into public.events select * from json_populate_record(null::public.events, %s::json) "
            "returning *", (json.dumps(jsonable(row)),)).fetchone()
    finally:
        conn.execute("reset role")


def update(conn, event_id, fields, role="service_role"):
    from psycopg import sql
    sets = sql.SQL(", ").join(sql.SQL("{c} = r.{c}").format(c=sql.Identifier(c)) for c in fields)
    q = sql.SQL("update public.events e set {sets} from json_populate_record(null::public.events, %s::json) r "
                "where e.id = %s returning e.*").format(sets=sets)
    conn.execute(f"set role {role}")
    try:
        return conn.execute(q, (json.dumps(jsonable(fields)), event_id)).fetchone()
    finally:
        conn.execute("reset role")


def enum_labels(conn, typ):
    return {r[0] for r in conn.execute(
        "select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = %s",
        (typ,))}


def camera_row(text, conf, device=CAM, source="camera"):
    th = Thresholds()
    vehicles = seeded_vehicles()
    interp = interpret(text, conf, th)
    vehicle = vehicles.get(interp.plate_norm) if interp.early is None else None
    verdict = decide(interp, vehicle, NOW.date(), th)
    return new_event_row(event_id=str(uuid.uuid4()), now=NOW, device=device, interp=interp,
                         verdict=verdict, vehicle=None, bbox=(10, 20, 110, 60),
                         engine="fast-alpr", latency_ms=180, source=source)


class TestTypesAgree:
    """The Python Literals and the SQL enums must be the same sets, or a decision the engine
    can make is one the database refuses — at the gate, not in review."""

    @pytest.mark.parametrize(("literal", "enum"), [(Decision, "decision"), (Reason, "deny_reason"),
                                                   (PlateKind, "plate_kind")])
    def test_literal_matches_enum(self, db, literal, enum):
        assert set(typing.get_args(literal)) == enum_labels(db, enum)


class TestPayloads:
    @pytest.mark.parametrize(("text", "conf", "decision", "reason"), [
        ("SBA1234G", 0.95, "allow", None),
        ("SKN8821R", 0.95, "deny", "not_on_list"),
        ("SNB953BE", 0.58, "check", "low_confidence"),
        ("0BA1234G", 0.95, "check", "ambiguous"),
        ("HELLO", 0.95, "check", "invalid_pattern"),
        ("12345 MID", 0.95, "allow", None),
        ("JHA 1234", 0.95, "deny", "not_on_list"),
    ])
    def test_every_kind_of_event_inserts(self, db, text, conf, decision, reason):
        row = camera_row(text, conf)
        got = insert(db, row)
        cols = [d.name for d in db.execute("select * from public.events limit 0").description]
        stored = dict(zip(cols, got, strict=True))
        assert (stored["decision"], stored["reason"]) == (decision, reason)
        assert (stored["site"], stored["lane"], stored["device_id"]) == ("gate1", "A", "cam-a")
        assert stored["bbox"] == [10, 20, 110, 60]
        assert stored["read_count"] == 1 and stored["source"] == "camera"

    def test_a_manual_event_inserts(self, db):
        insert(db, camera_row("SNB9538E", 1.0, device=DISPLAY, source="manual"))

    def test_a_dedupe_update_applies(self, db):
        first = camera_row("SNB953BE", 0.58)            # check, low confidence
        insert(db, first)
        existing = OpenEvent(first["id"], first["plate_norm"], first["decision"],
                             first["confidence"], 1, NOW)
        later = NOW + timedelta(seconds=2)
        better = camera_row("SNB9538E", 0.93)
        out = merge(existing, better, later, 15)
        assert out.adopted
        got = update(db, first["id"], out.fields)
        cols = [d.name for d in db.execute("select * from public.events limit 0").description]
        stored = dict(zip(cols, got, strict=True))
        assert (stored["decision"], stored["read_count"], float(stored["confidence"])) == ("allow", 2, 0.93)
        assert stored["last_read_at"] == later

    def test_a_heartbeat_touch_applies_and_needs_no_role(self, db):
        db.execute("set role service_role")
        try:
            db.execute("update public.devices set last_seen_at = %s, version = %s where id = 'cam-a'",
                       (NOW, "m1"))
        finally:
            db.execute("reset role")
        assert db.execute("select version from public.devices where id='cam-a'").fetchone()[0] == "m1"


class TestPrivileges:
    def test_anon_cannot_write_events(self, db):
        # The M0 guarantee the whole engine design leans on: the public key cannot forge
        # a decision. Only the service key — held by the engine alone — can.
        import psycopg
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            insert(db, camera_row("SBA1234G", 0.95), role="anon")

    def test_an_unknown_device_is_a_foreign_key_error(self, db):
        # Why auth.py refuses a token whose device has no row, before anything is written.
        import psycopg
        row = camera_row("SBA1234G", 0.95, device=Device("cam-z", "capture", "gate1", "A"))
        with pytest.raises(psycopg.errors.ForeignKeyViolation):
            insert(db, row)

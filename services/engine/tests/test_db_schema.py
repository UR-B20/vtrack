"""The engine's real payloads, executed against the real migrations on Postgres 16.

The rows come from vtrack_engine.events and vtrack_engine.dedupe — the same functions the
routes call — and go in through json_populate_record, which is how PostgREST turns a JSON
body into a row. So text→enum, ISO→timestamptz and list→jsonb are coerced here exactly as
they would be on Supabase.

Runs when VTRACK_TEST_PG_DSN points at a superuser on a Postgres 16 cluster (CI sets it).
Unset: skipped, so a laptop without Postgres still runs the suite. Set but unreachable:
FAILS — CI must never quietly skip the one test that proves the payloads fit the schema.
"""

import contextlib
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
       REPO / "supabase/migrations/0003_foreign_reason.sql",
       REPO / "supabase/migrations/0004_display_sign_in.sql",
       REPO / "supabase/migrations/0005_device_tokens.sql",
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
        ("JHA 1234", 0.95, "deny", "foreign"),
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


@contextlib.contextmanager
def as_user(conn, role, app_role=None):
    """A request as PostgREST makes it: the database role, plus the JWT claims auth.jwt()
    reads. `app_role` is app_metadata.role — 'admin', 'display', or None for a login that
    was never given one."""
    claims = {"role": role}
    if app_role:
        claims["app_metadata"] = {"role": app_role}
    conn.execute("select set_config('request.jwt.claims', %s, false)", (json.dumps(claims),))
    conn.execute(f"set role {role}")
    try:
        yield conn
    finally:
        conn.execute("reset role")
        conn.execute("select set_config('request.jwt.claims', '', false)")


def count(conn, relation):
    return conn.execute(f"select count(*) from {relation}").fetchone()[0]


@pytest.fixture(scope="module")
def an_event(db):
    return insert(db, camera_row("SBA1234G", 0.95))[0]


class TestPublicKeyOpensNothing:
    """0004 (CLAUDE.md §11, Display sign-in): the anon key is inside the public website, so
    it must read nothing and write nothing — not the list, not the history, not the
    devices, and no OK rows."""

    @pytest.mark.parametrize("relation", ["public.vehicles_public", "public.devices_public",
                                          "public.events", "public.vehicles", "public.devices",
                                          "public.guard_actions"])
    def test_anon_reads_nothing(self, db, relation):
        import psycopg
        with as_user(db, "anon"), pytest.raises(psycopg.errors.InsufficientPrivilege):
            count(db, relation)

    def test_anon_cannot_press_ok(self, db, an_event):
        import psycopg
        with as_user(db, "anon"), pytest.raises(psycopg.errors.InsufficientPrivilege):
            db.execute("insert into public.guard_actions (event_id, action) values (%s, 'confirmed')",
                       (an_event,))

    @pytest.mark.parametrize("relation", ["public.vehicles_public", "public.devices_public",
                                          "public.events"])
    def test_a_login_without_a_role_sees_no_rows(self, db, an_event, relation):
        # Anyone can create a Supabase login (admin sign-in creates users on first OTP);
        # only the app_metadata role, which users cannot set themselves, opens anything.
        with as_user(db, "authenticated"):
            assert count(db, relation) == 0


class TestDisplay:
    def test_reads_the_list_the_devices_and_the_events(self, db, an_event):
        vehicles, devices = count(db, "public.vehicles"), count(db, "public.devices")
        with as_user(db, "authenticated", "display"):
            assert count(db, "public.vehicles_public") == vehicles > 0
            assert count(db, "public.devices_public") == devices > 0
            assert count(db, "public.events") >= 1

    def test_never_reads_a_token_hash(self, db):
        import psycopg
        with as_user(db, "authenticated", "display"), pytest.raises(psycopg.errors.InsufficientPrivilege):
            db.execute("select token_hash from public.devices")

    def test_presses_ok_on_a_real_event(self, db, an_event):
        with as_user(db, "authenticated", "display"):
            db.execute("insert into public.guard_actions (event_id, action, reason) "
                       "values (%s, 'confirmed', 'OK on the gate screen')", (an_event,))
        assert db.execute("select count(*) from public.guard_actions where event_id = %s",
                          (an_event,)).fetchone()[0] >= 1

    @pytest.mark.parametrize(("action", "with_event"), [("let_through", True), ("turned_away", True),
                                                        ("confirmed", False)])
    def test_writes_nothing_but_ok(self, db, an_event, action, with_event):
        import psycopg
        with as_user(db, "authenticated", "display"), pytest.raises(psycopg.errors.InsufficientPrivilege):
            db.execute("insert into public.guard_actions (event_id, action) values (%s, %s)",
                       (an_event if with_event else None, action))

    def test_cannot_change_the_list_or_read_the_trail(self, db):
        import psycopg
        with as_user(db, "authenticated", "display"):
            assert count(db, "public.guard_actions") == 0          # admin's audit trail
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                db.execute("insert into public.vehicles (plate_norm, plate_display, owner_name) "
                           "values ('SKN8821R', 'SKN 8821 R', 'Nobody')")
            assert db.execute("update public.vehicles set status = 'suspended' returning id").fetchall() == []
            assert db.execute("delete from public.vehicles returning id").fetchall() == []


class TestAdmin:
    def test_still_manages_the_list_and_reads_the_trail(self, db, an_event):
        with as_user(db, "authenticated", "admin"):
            vid = db.execute("insert into public.vehicles (plate_norm, plate_display, owner_name) "
                             "values ('SKN8821R', 'SKN 8821 R', 'Test') returning id").fetchone()[0]
            assert db.execute("update public.vehicles set status = 'suspended' where id = %s returning id",
                              (vid,)).fetchone()
            assert db.execute("delete from public.vehicles where id = %s returning id", (vid,)).fetchone()
            assert count(db, "public.vehicles_public") > 0
            db.execute("select count(*) from public.guard_actions")   # readable, not an error


class TestAdvisorFixes:
    """The Supabase advisor warnings 0004 exists to clear."""

    @pytest.mark.parametrize("view", ["vehicles_public", "devices_public"])
    def test_views_run_as_the_caller(self, db, view):
        opts = db.execute("select reloptions from pg_class where oid = %s::regclass",
                          (f"public.{view}",)).fetchone()[0] or []
        assert "security_invoker=on" in opts

    def test_role_checks_read_the_jwt_once_per_statement(self, db):
        bare = db.execute(
            "select tablename, policyname from pg_policies where schemaname = 'public' "
            "and (coalesce(qual, '') || coalesce(with_check, '')) ~ 'auth\\.jwt\\(\\)' "
            "and (coalesce(qual, '') || coalesce(with_check, '')) !~ 'SELECT auth\\.jwt\\(\\)'").fetchall()
        assert bare == []

    def test_no_write_policy_is_always_true(self, db):
        loose = db.execute(
            "select tablename, policyname from pg_policies where schemaname = 'public' "
            "and cmd in ('INSERT', 'UPDATE', 'DELETE') "
            "and (coalesce(qual, '') = 'true' or coalesce(with_check, '') = 'true')").fetchall()
        assert loose == []

    @pytest.mark.parametrize(("table", "column"), [("events", "vehicle_id"), ("events", "device_id"),
                                                   ("guard_actions", "event_id")])
    def test_foreign_keys_are_indexed(self, db, table, column):
        assert db.execute(
            "select 1 from pg_indexes where schemaname = 'public' and tablename = %s "
            "and indexdef ~ %s", (table, rf"\({column}\)")).fetchone()


HASH = "ab" * 32


class TestDeviceTokens:
    """0005 (CLAUDE.md §11, Device tokens): an admin sets a device's token hash from the
    Devices page; nobody else can, and no browser ever reads one."""

    @pytest.fixture(autouse=True)
    def clean(self, db):
        yield
        db.execute("update public.devices set token_hash = null, token_rotated_at = null")

    def hash_of(self, db, dev="cam-a"):
        return db.execute("select token_hash from public.devices where id = %s", (dev,)).fetchone()[0]

    def test_admin_sets_a_new_token_hash(self, db):
        with as_user(db, "authenticated", "admin"):
            cur = db.execute("update public.devices set token_hash = %s, token_rotated_at = now() "
                             "where id = 'cam-a'", (HASH,))
            assert cur.rowcount == 1
            # It can see when, never what.
            assert db.execute("select token_rotated_at from public.devices where id = 'cam-a'").fetchone()[0]
        assert self.hash_of(db) == HASH

    def test_admin_cannot_rewrite_anything_else(self, db):
        import psycopg
        with as_user(db, "authenticated", "admin"), pytest.raises(psycopg.errors.InsufficientPrivilege):
            db.execute("update public.devices set site = 'elsewhere' where id = 'cam-a'")

    def test_the_display_cannot_set_one(self, db):
        with as_user(db, "authenticated", "display"):
            cur = db.execute("update public.devices set token_hash = %s where id = 'cam-a'", (HASH,))
            assert cur.rowcount == 0
        assert self.hash_of(db) is None

    def test_anon_cannot_set_one(self, db):
        import psycopg
        with as_user(db, "anon"), pytest.raises(psycopg.errors.InsufficientPrivilege):
            db.execute("update public.devices set token_hash = %s where id = 'cam-a'", (HASH,))

    @pytest.mark.parametrize("bad", ["not-a-hash", "AB" * 32, "ab" * 31])
    def test_only_a_sha256_hex_is_accepted(self, db, bad):
        import psycopg
        with as_user(db, "authenticated", "admin"), pytest.raises(psycopg.errors.CheckViolation):
            db.execute("update public.devices set token_hash = %s where id = 'cam-a'", (bad,))

    def test_no_browser_reads_a_hash_even_after_one_is_set(self, db):
        import psycopg
        db.execute("update public.devices set token_hash = %s where id = 'cam-a'", (HASH,))
        for app_role in ("admin", "display"):
            with as_user(db, "authenticated", app_role), pytest.raises(psycopg.errors.InsufficientPrivilege):
                db.execute("select token_hash from public.devices")

    def test_the_engine_reads_them(self, db):
        db.execute("update public.devices set token_hash = %s where id = 'cam-a'", (HASH,))
        db.execute("set role service_role")
        try:
            assert self.hash_of(db) == HASH
        finally:
            db.execute("reset role")

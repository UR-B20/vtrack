"""SupabaseStore's requests, asserted whole: method, path, query string, headers, body."""

import asyncio
import base64
import json
from datetime import UTC, datetime

import httpx
import pytest

from vtrack_engine.db import StoreConflict, StoreError, SupabaseStore

URL = "https://proj.supabase.co"
SECRET = "sb_secret_test_key"
LEGACY = (base64.urlsafe_b64encode(b'{"alg":"HS256"}').decode().rstrip("=") + "."
          + base64.urlsafe_b64encode(b'{"role":"service_role"}').decode().rstrip("=") + ".sig")
T = datetime(2026, 9, 22, 6, 0, 5, 123000, tzinfo=UTC)


class Recorder:
    def __init__(self, reply=None, status=200, exc=None):
        self.requests: list[httpx.Request] = []
        self.reply, self.status, self.exc = reply, status, exc

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.exc:
            raise self.exc
        if self.status == 204:
            return httpx.Response(204)
        return httpx.Response(self.status, json=self.reply if self.reply is not None else [])

    @property
    def last(self) -> httpx.Request:
        return self.requests[-1]


def store(rec, key=SECRET):
    return SupabaseStore(URL, key, client=httpx.AsyncClient(transport=httpx.MockTransport(rec)))


def run(coro):
    return asyncio.run(coro)


class TestHeaders:
    def test_a_secret_key_travels_in_apikey_only(self):
        rec = Recorder([{"id": "cam-a"}])
        run(store(rec).ping())
        assert rec.last.headers["apikey"] == SECRET
        assert "authorization" not in rec.last.headers

    def test_a_legacy_service_role_jwt_travels_in_both(self):
        rec = Recorder([{"id": "cam-a"}])
        run(store(rec, LEGACY).ping())
        assert rec.last.headers["apikey"] == LEGACY
        assert rec.last.headers["authorization"] == f"Bearer {LEGACY}"


class TestReads:
    def test_ping_reads_a_table_anon_cannot(self):
        rec = Recorder([{"id": "cam-a"}])
        run(store(rec).ping())
        assert (rec.last.method, rec.last.url.path) == ("GET", "/rest/v1/devices")
        assert dict(rec.last.url.params) == {"select": "id", "limit": "1"}

    def test_get_devices_quotes_ids(self):
        rec = Recorder([{"id": "cam-a", "role": "capture", "site": "gate1", "lane": "A"}])
        out = run(store(rec).get_devices(["cam-a", "display-b"]))
        assert rec.last.url.params["id"] == 'in.("cam-a","display-b")'
        assert out["cam-a"]["site"] == "gate1"

    def test_get_vehicle(self):
        rec = Recorder([{"id": "v1", "plate_norm": "SBA1234G", "plate_display": "SBA 1234 G",
                         "owner_name": "Tan Wei Ming", "org_unit": "HQ Coy", "pass_type": "permanent",
                         "status": "active", "valid_from": "2026-01-01", "valid_until": None}])
        v = run(store(rec).get_vehicle("SBA1234G"))
        assert rec.last.url.path == "/rest/v1/vehicles"   # the base table, via the service key
        assert rec.last.url.params["plate_norm"] == "eq.SBA1234G"
        assert (v.id, v.valid_from.isoformat(), v.valid_until) == ("v1", "2026-01-01", None)

    def test_missing_vehicle_is_none(self):
        assert run(store(Recorder([])).get_vehicle("SKN8821R")) is None

    def test_find_open_event_is_the_exact_5_3_key(self):
        rec = Recorder([{"id": "e1", "plate_norm": "SNB9538E", "decision": "check",
                         "confidence": 0.58, "read_count": 2,
                         "last_read_at": "2026-09-22T06:00:02.5+00:00"}])
        ev = run(store(rec).find_open_event("gate1", "A", "SNB9538E", T))
        p = rec.last.url.params
        assert (p["site"], p["lane"], p["plate_norm"], p["source"]) == (
            "eq.gate1", "eq.A", "eq.SNB9538E", "eq.camera")
        assert p["last_read_at"] == "gte.2026-09-22T06:00:05.123000+00:00"
        assert (p["order"], p["limit"]) == ("last_read_at.desc", "1")
        assert (ev.id, ev.read_count, ev.confidence) == ("e1", 2, 0.58)

    def test_the_plus_in_a_timestamp_is_percent_encoded(self):
        # A literal '+' in a query string decodes as a space — a filter that silently
        # matches nothing, which would make dedupe never dedupe.
        rec = Recorder([])
        run(store(rec).find_open_event("gate1", "A", "SNB9538E", T))
        assert b"%2B00%3A00" in rec.last.url.raw_path or b"%2B00:00" in rec.last.url.raw_path
        assert b"+00" not in rec.last.url.raw_path


class TestWrites:
    def test_insert_asks_for_the_row_back_and_serialises_times(self):
        rec = Recorder([{"id": "e1"}], status=201)
        run(store(rec).insert_event({"id": "e1", "ts": T, "bbox": (1, 2, 3, 4)}))
        assert (rec.last.method, rec.last.url.path) == ("POST", "/rest/v1/events")
        assert rec.last.headers["prefer"] == "return=representation"
        body = json.loads(rec.last.content)
        assert body == {"id": "e1", "ts": T.isoformat(), "bbox": [1, 2, 3, 4]}

    def test_update_targets_one_event(self):
        rec = Recorder([{"id": "e1", "read_count": 2}])
        run(store(rec).update_event("e1", {"read_count": 2, "last_read_at": T}))
        assert (rec.last.method, rec.last.url.params["id"]) == ("PATCH", "eq.e1")

    def test_update_of_a_vanished_event_is_an_error(self):
        with pytest.raises(StoreError) as e:
            run(store(Recorder([])).update_event("gone", {"read_count": 2}))
        assert e.value.status == 404

    def test_heartbeat_is_a_patch_that_cannot_create_a_device(self):
        rec = Recorder([{"id": "cam-a"}])
        assert run(store(rec).touch_device("cam-a", "m1", T)) is True
        assert (rec.last.method, rec.last.url.path) == ("PATCH", "/rest/v1/devices")
        assert rec.last.url.params["id"] == "eq.cam-a"
        assert rec.last.headers["prefer"] == "return=representation"
        assert json.loads(rec.last.content) == {"last_seen_at": T.isoformat(), "version": "m1"}

    def test_a_heartbeat_for_a_missing_row_says_so(self):
        # PostgREST answers a PATCH that matches nothing with an empty list, not an error.
        assert run(store(Recorder([])).touch_device("engine-1", "m2", T)) is False


class TestFailures:
    def test_a_rejected_key_says_so(self):
        rec = Recorder({"code": "PGRST301", "message": "JWSError"}, status=401)
        with pytest.raises(StoreError) as e:
            run(store(rec).ping())
        assert e.value.status == 401 and "SUPABASE_SERVICE_KEY" in e.value.detail

    def test_permission_denied_names_the_wrong_key(self):
        rec = Recorder({"code": "42501", "message": "permission denied for table devices"}, status=401)
        with pytest.raises(StoreError) as e:
            run(store(rec).ping())
        assert "secret key" in e.value.detail or "SUPABASE_SERVICE_KEY" in e.value.detail

    def test_duplicate_insert_is_a_conflict(self):
        rec = Recorder({"code": "23505", "message": "duplicate key"}, status=409)
        with pytest.raises(StoreConflict):
            run(store(rec).insert_event({"id": "e1"}))

    def test_timeout_is_504(self):
        rec = Recorder(exc=httpx.ReadTimeout("slow"))
        with pytest.raises(StoreError) as e:
            run(store(rec).ping())
        assert e.value.status == 504

    def test_unreachable_is_502_and_mentions_a_paused_project(self):
        rec = Recorder(exc=httpx.ConnectError("nope"))
        with pytest.raises(StoreError) as e:
            run(store(rec).ping())
        assert e.value.status == 502 and "paused" in e.value.detail

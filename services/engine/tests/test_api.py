"""The four routes end to end: FastAPI app → auth → image checks → ALPR → decide → dedupe →
store. The ALPR is scripted and the store is in memory; both are tested for real elsewhere
(test_alpr_real.py, test_db_contract.py, test_db_schema.py)."""

import asyncio
from datetime import UTC, datetime, timedelta
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from tests.conftest import seeded_vehicles
from tests.memory_store import InMemoryStore
from tests.stub_alpr import StubALPR
from vtrack_engine.alpr.base import ALPRError, PlateRead
from vtrack_engine.config import Settings
from vtrack_engine.db import StoreError
from vtrack_engine.main import create_app

CAM, DISP = "c" * 32, "d" * 32
DEVICES = {
    "cam-a": {"id": "cam-a", "role": "capture", "site": "gate1", "lane": "A"},
    "display-b": {"id": "display-b", "role": "display", "site": "gate1", "lane": "A"},
}


def settings(**over):
    base = dict(_env_file=None, device_tokens={"cam-a": CAM, "display-b": DISP},
                allowed_origins=["http://localhost:5173"], rate_limit_per_s=50)
    return Settings(**{**base, **over})


class Rig:
    def __init__(self, alpr="stub", store=None, background=False, **over):
        self.alpr = StubALPR() if alpr == "stub" else alpr
        self.store = store or InMemoryStore(seeded_vehicles(), DEVICES)
        self.app = create_app(settings(**over), store=self.store, alpr=self.alpr, load_model=False,
                              background=background)
        self.client = TestClient(self.app)

    def __enter__(self):
        self.client.__enter__()
        return self

    def __exit__(self, *a):
        self.client.__exit__(*a)

    def frame(self, text=None, conf=0.95, token=CAM, captured_at=None, image=None, **form):
        if text is not None:
            self.alpr.say(text, conf)
        data = {"captured_at": captured_at or datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                **form}
        return self.client.post("/recognise", headers={"X-Device-Token": token} if token else {},
                                files={"image": ("f.jpg", image or jpeg(), "image/jpeg")}, data=data)

    def manual(self, plate, token=DISP, **body):
        return self.client.post("/manual", headers={"X-Device-Token": token},
                                json={"plate_text": plate, **body})

    @property
    def events(self):
        return list(self.store.events.values())


def jpeg(w=640, h=360, fmt="JPEG", orientation=None):
    buf = BytesIO()
    extra = {}
    if orientation:
        exif = Image.Exif()
        exif[0x0112] = orientation
        extra["exif"] = exif.tobytes()
    Image.new("RGB", (w, h), (30, 30, 30)).save(buf, fmt, **extra)
    return buf.getvalue()


@pytest.fixture
def rig():
    with Rig() as r:
        yield r


# ── /recognise: refusals, cheapest first ───────────────────────────────────────────────
class TestRecogniseRefusals:
    def test_no_token_is_401(self, rig):
        assert rig.frame("SBA1234G", token=None).status_code == 401

    def test_unknown_token_is_401(self, rig):
        assert rig.frame("SBA1234G", token="x" * 32).status_code == 401

    def test_a_display_token_cannot_submit_frames(self, rig):
        assert rig.frame("SBA1234G", token=DISP).status_code == 403

    def test_a_body_naming_another_device_is_403(self, rig):
        assert rig.frame("SBA1234G", device_id="display-b").status_code == 403

    @pytest.mark.parametrize(("image", "status"), [
        (jpeg(fmt="PNG"), 415), (jpeg(w=300), 422), (b"\xff\xd8\xff" + b"\0" * (401 * 1024), 413)])
    def test_bad_images_are_refused_before_the_model_runs(self, rig, image, status):
        assert rig.frame("SBA1234G", image=image).status_code == status
        assert rig.alpr.calls == 0

    @pytest.mark.parametrize("delta", [timedelta(seconds=-30), timedelta(seconds=30)])
    def test_a_stale_or_future_frame_is_refused(self, rig, delta):
        when = (datetime.now(UTC) + delta).isoformat()
        r = rig.frame("SBA1234G", captured_at=when)
        assert r.status_code == 422 and "clock" in r.json()["detail"]

    def test_captured_at_is_required(self, rig):
        r = rig.client.post("/recognise", headers={"X-Device-Token": CAM},
                            files={"image": ("f.jpg", jpeg(), "image/jpeg")})
        assert r.status_code == 422

    def test_model_not_ready_is_503(self):
        with Rig(alpr=None) as r:
            res = r.frame()
            assert res.status_code == 503 and "loading" in res.json()["detail"]

    def test_reader_failure_is_502_not_no_plate(self, rig):
        rig.alpr.error = ALPRError("Plate Recognizer quota or rate limit reached")
        r = rig.frame("SBA1234G")
        assert r.status_code == 502 and "quota" in r.json()["detail"]


# ── /recognise: decisions ────────────────────────────────────────────────────────────────
class TestRecogniseDecisions:
    def test_allow(self, rig):
        body = rig.frame("SBA1234G", 0.95).json()
        assert (body["decision"], body["reason"], body["deduped"]) == ("allow", None, False)
        assert body["flags"] == {"verify": False}
        assert body["plate_display"] == "SBA 1234 G"
        assert body["vehicle"]["owner_name"] == "Tan Wei Ming"

    def test_the_event_takes_site_and_lane_from_the_device_row(self, rig):
        rig.frame("SBA1234G")
        ev = rig.events[0]
        assert (ev["device_id"], ev["site"], ev["lane"], ev["source"]) == ("cam-a", "gate1", "A", "camera")

    def test_deny_not_on_list(self, rig):
        assert rig.frame("SKN8821R").json()["decision"] == "deny"

    def test_check_carries_no_vehicle_details(self, rig):
        body = rig.frame("SBA1234G", 0.5).json()
        assert (body["decision"], body["reason"], body["vehicle"]) == ("check", "low_confidence", None)

    def test_verify_between_the_thresholds(self, rig):
        assert rig.frame("SBA1234G", 0.7).json()["flags"] == {"verify": True}

    def test_a_dropped_check_letter_on_an_approved_plate_is_check_not_deny(self, rig):
        # The real model's own misread of a clear SNB 9538 E, through a webcam.
        body = rig.frame("SNB9538", 0.997).json()
        assert (body["decision"], body["reason"]) == ("check", "ambiguous")
        assert (body["plate_norm"], body["repaired_from"]) == ("SNB9538E", "SNB9538")
        assert body["vehicle"] is None

    def test_a_clean_read_then_refines_that_check_to_allow(self, rig):
        first = rig.frame("SNB9538", 0.997).json()
        second = rig.frame("SNB9538E", 0.95).json()
        assert second["event_id"] == first["event_id"] and second["decision"] == "allow"

    def test_a_truly_foreign_unlisted_plate_is_still_deny(self, rig):
        body = rig.frame("JHA1234", 0.95).json()
        assert (body["decision"], body["reason"]) == ("deny", "not_on_list")

    def test_no_plate_writes_no_event(self, rig):
        rig.alpr.next = []
        body = rig.frame().json()
        assert body["decision"] is None and body["event_id"] is None
        assert rig.events == []

    def test_an_empty_ocr_text_is_no_plate(self, rig):
        body = rig.frame("", 0.99).json()
        assert body["decision"] is None and rig.events == []


# ── /recognise: which plate, in the lane ROI (alpr/base.py select) ──────────────────────
def plate(text, bbox, conf=0.95):
    return PlateRead(text=text, confidence=conf, bbox=bbox, engine="stub")


class TestPlateSelection:
    def test_two_plates_in_position_write_nothing_and_say_why(self, rig):
        rig.alpr.next = [plate("SBA1234G", (40, 150, 200, 200)),
                         plate("SKN8821R", (300, 100, 600, 180))]
        body = rig.frame().json()
        assert body["decision"] is None and body["rejected"] == "multiple_plates"
        assert rig.events == []

    def test_a_plate_at_the_edge_of_the_roi_is_not_read(self, rig):
        rig.alpr.next = [plate("SBA1234G", (0, 150, 200, 200))]
        body = rig.frame().json()
        assert body["decision"] is None and body["rejected"] == "edge"
        assert rig.events == []

    def test_the_calibrated_band_reads_the_car_at_the_stop_line(self, rig):
        # Queued car nearer the camera: a 400 px plate. The car at the guard: 200 px.
        rig.alpr.next = [plate("SKN8821R", (100, 250, 500, 340)),
                         plate("SBA1234G", (200, 150, 400, 200))]
        body = rig.frame(roi='{"plate_w": [0.2, 0.4]}').json()
        assert (body["plate_norm"], body["decision"]) == ("SBA1234G", "allow")

    def test_without_a_band_the_same_scene_decides_nothing(self, rig):
        rig.alpr.next = [plate("SKN8821R", (100, 250, 500, 340)),
                         plate("SBA1234G", (200, 150, 400, 200))]
        assert rig.frame().json()["rejected"] == "multiple_plates"

    @pytest.mark.parametrize("roi", ["nope", "[1]", '{"plate_w": [0.4, 0.2]}',
                                     '{"plate_w": [0, 0.2]}', '{"plate_w": "wide"}'])
    def test_a_malformed_calibration_is_refused_not_ignored(self, rig, roi):
        r = rig.frame("SBA1234G", roi=roi)
        assert r.status_code == 422 and "roi" in r.json()["detail"]
        assert rig.events == []

    def test_other_roi_keys_are_ignored(self, rig):
        body = rig.frame("SBA1234G", roi='{"x": 0.1, "y": 0.2}').json()
        assert body["decision"] == "allow"

    def test_boxes_are_measured_against_the_frame_as_the_model_sees_it(self, rig):
        # A portrait photo stored landscape (EXIF orientation 6): cv2 decodes it turned,
        # 360 wide × 640 high, and the plate box comes back in those coordinates.
        rig.alpr.next = [plate("SBA1234G", (60, 400, 300, 460))]
        assert rig.frame(image=jpeg(orientation=6)).json()["decision"] == "allow"


# ── /recognise: dedupe through the real routes ──────────────────────────────────────────
class TestRefinement:
    def test_repeat_reads_refine_one_event(self, rig):
        rig.frame("SBA1234G", 0.8)
        second = rig.frame("SBA1234G", 0.9).json()
        assert second["deduped"] is True and len(rig.events) == 1
        assert rig.events[0]["read_count"] == 2 and rig.events[0]["confidence"] == 0.9

    def test_check_upgrades_to_allow_in_place(self, rig):
        first = rig.frame("SNB953BE", 0.58).json()        # repaired to SNB9538E, low confidence
        assert (first["decision"], first["plate_norm"]) == ("check", "SNB9538E")
        second = rig.frame("SNB9538E", 0.95).json()
        assert second["event_id"] == first["event_id"] and second["decision"] == "allow"
        assert len(rig.events) == 1

    def test_a_departing_car_refines_its_own_event_and_does_not_retake_the_stage(self, rig):
        a = rig.frame("SBA1234G", 0.95).json()           # car A allowed
        b = rig.frame("SKN8821R", 0.95).json()           # car B denied, now on stage
        again = rig.frame("SBA1234G", 0.90).json()       # A pulling away, still in frame
        assert again["event_id"] == a["event_id"] and again["deduped"] is True
        assert len(rig.events) == 2
        newest = max(rig.events, key=lambda e: e["ts"])
        assert newest["id"] == b["event_id"]              # B's red is still the newest event

    def test_a_car_back_after_the_window_is_a_new_event(self, rig):
        rig.frame("SBA1234G")
        rig.store.events[rig.events[0]["id"]]["last_read_at"] = (
            datetime.now(UTC) - timedelta(seconds=16)).isoformat()
        assert rig.frame("SBA1234G").json()["deduped"] is False
        assert len(rig.events) == 2

    def test_a_seen_plate_re_read_after_the_window_writes_nothing(self, rig):
        # The lane never emptied, so /capture says the car is still there: no second event.
        rig.frame("SBA1234G")
        rig.store.events[rig.events[0]["id"]]["last_read_at"] = (
            datetime.now(UTC) - timedelta(seconds=16)).isoformat()
        body = rig.frame("SBA1234G", seen_plate="SBA1234G").json()
        assert (body["event_id"], body["decision"], body["plate_norm"]) == (None, "allow", "SBA1234G")
        assert body["vehicle"]["owner_name"] and body["deduped"] is False
        assert len(rig.events) == 1

    def test_a_seen_plate_re_read_inside_the_window_refines_the_event(self, rig):
        first = rig.frame("SBA1234G", 0.8).json()
        body = rig.frame("SBA1234G", 0.9, seen_plate="SBA1234G").json()
        assert body["event_id"] == first["event_id"] and body["deduped"] is True
        assert rig.events[0]["read_count"] == 2

    def test_a_different_plate_than_the_seen_one_is_a_new_event(self, rig):
        rig.frame("SBA1234G")
        body = rig.frame("SNB9538E", seen_plate="SBA1234G").json()
        assert body["event_id"] and len(rig.events) == 2

    @pytest.mark.parametrize("seen", ["sba1234g", "SBA 1234 G", "SBA1234G;--", "A" * 13])
    def test_a_malformed_seen_plate_is_refused_not_ignored(self, rig, seen):
        r = rig.frame("SBA1234G", seen_plate=seen)
        assert r.status_code == 422 and "seen_plate" in r.json()["detail"]
        assert rig.events == []


class TestFailedWrites:
    def test_a_failed_write_returns_an_error_and_no_decision(self, rig):
        rig.store.fail_writes = StoreError(504, "Supabase did not answer in time")
        r = rig.frame("SBA1234G")
        assert r.status_code == 504
        assert "decision" not in r.json()                  # /capture must not show a colour


# ── /manual ────────────────────────────────────────────────────────────────────────────
class TestManual:
    def test_a_capture_token_cannot_type_plates(self, rig):
        assert rig.manual("SBA1234G", token=CAM).status_code == 403

    def test_allow_as_a_new_manual_event(self, rig):
        body = rig.manual("SBA 1234 G", actor="Sgt Lim").json()
        assert (body["decision"], body["confidence"]) == ("allow", 1.0)
        assert rig.events[0]["source"] == "manual" and rig.events[0]["engine"] == "manual"

    def test_a_bad_check_letter_is_refused_and_named(self, rig):
        r = rig.manual("SBA1234F")
        assert r.status_code == 422 and r.json()["detail"] == "check letter should be G"

    def test_a_typed_plate_is_never_repaired(self, rig):
        # SNB953BE repairs to an approved plate from a camera; typed, it is a typo and must
        # not become someone else's green.
        assert rig.manual("SNB953BE").status_code == 422
        assert rig.events == []

    def test_mid_and_foreign_are_accepted(self, rig):
        assert rig.manual("12345 MID").json()["decision"] == "allow"
        assert rig.manual("JHA 1234").json()["decision"] == "deny"

    def test_manual_never_merges_with_the_camera(self, rig):
        rig.frame("SNB9538E", 0.5)                         # camera CHECK
        rig.manual("SNB9538E")
        rig.frame("SNB9538E", 0.95)                         # camera again: refines its own
        sources = sorted((e["source"], e["read_count"]) for e in rig.events)
        assert sources == [("camera", 2), ("manual", 1)]


# ── /heartbeat ─────────────────────────────────────────────────────────────────────────
class TestHeartbeat:
    def test_touches_the_device(self, rig):
        r = rig.client.post("/heartbeat", headers={"X-Device-Token": CAM},
                            json={"device_id": "cam-a", "role": "capture", "version": "m1"})
        assert r.status_code == 204
        assert rig.store.devices["cam-a"]["version"] == "m1"
        assert rig.store.devices["cam-a"]["last_seen_at"]

    def test_a_stated_role_must_match_the_token(self, rig):
        # How /capture validates a pairing: a display token cannot pair as a camera.
        r = rig.client.post("/heartbeat", headers={"X-Device-Token": DISP},
                            json={"device_id": "display-b", "role": "capture"})
        assert r.status_code == 403 and "display device" in r.json()["detail"]

    def test_cannot_speak_for_another_device(self, rig):
        r = rig.client.post("/heartbeat", headers={"X-Device-Token": CAM}, json={"device_id": "display-b"})
        assert r.status_code == 403


# ── /health ────────────────────────────────────────────────────────────────────────────
class TestHealth:
    def test_healthy(self, rig):
        r = rig.client.get("/health")
        body = r.json()
        assert r.status_code == 200
        assert (body["engine"], body["model"], body["db"], body["reason"]) == (
            "local", "stub-model", "ok", None)
        assert body["thresholds"]["conf_decide"] == 0.85
        assert body["version"].startswith("m2")

    def test_the_public_view_is_status_only(self, rig):
        # Brief §3.10: the engine is on the public internet; its device list and error text
        # are not for anyone who finds the URL.
        body = rig.client.get("/health").json()
        assert not {"devices", "db_error", "model_error"} & body.keys()

    def test_a_device_token_adds_the_detail(self, rig):
        body = rig.client.get("/health", headers={"X-Device-Token": CAM}).json()
        assert body["devices"]["cam-a"] == "ok · capture · gate1/A"
        assert "db_error" in body and "model_error" in body

    def test_an_unknown_token_gets_the_public_view_not_an_error(self, rig):
        r = rig.client.get("/health", headers={"X-Device-Token": "x" * 32})
        assert r.status_code == 200 and "devices" not in r.json()

    def test_a_placeholder_token_never_unlocks_the_detail(self):
        with Rig(device_tokens={"cam-a": "<random 32 chars>"}) as r:
            body = r.client.get("/health", headers={"X-Device-Token": "<random 32 chars>"}).json()
            assert "devices" not in body

    def test_model_loading_is_503_with_a_reason(self):
        with Rig(alpr=None) as r:
            res = r.client.get("/health")
            assert res.status_code == 503
            assert (res.json()["model_status"], res.json()["reason"]) == ("loading", "model_loading")

    def test_a_rejected_key_is_503_db_auth(self, rig):
        rig.store.fail_ping = StoreError(401, "Supabase rejected the key — check SUPABASE_SERVICE_KEY")
        res = rig.client.get("/health", headers={"X-Device-Token": CAM})
        assert res.status_code == 503 and res.json()["reason"] == "db_auth"
        assert "SUPABASE_SERVICE_KEY" in res.json()["db_error"]

    def test_an_unreachable_database_is_503_db_unreachable(self, rig):
        rig.store.fail_ping = StoreError(504, "Supabase did not answer in time")
        assert rig.client.get("/health").json()["reason"] == "db_unreachable"

    def test_the_running_version_carries_the_render_commit(self):
        with Rig(render_git_commit="e47732b0123456789") as r:
            assert r.client.get("/health").json()["version"] == "m2+e47732b"


class TestReady:
    """/ready is Render's: latched, from memory (main.py docstring)."""

    def test_ready_once_the_model_is_loaded_and_the_database_answered(self, rig):
        r = rig.client.get("/ready")
        assert r.status_code == 200 and r.json() == {"ready": True}

    def test_not_ready_while_the_model_loads(self):
        with Rig(alpr=None) as r:
            res = r.client.get("/ready")
            assert res.status_code == 503 and res.json()["reason"] == "model_loading"

    def test_a_wrong_key_never_becomes_ready(self):
        # The deploy is cancelled and the running engine keeps the gate.
        s = settings(supabase_url="https://p.supabase.co", supabase_service_key="sb_publishable_x")
        with TestClient(create_app(s, alpr=StubALPR(), load_model=False, background=False)) as c:
            res = c.get("/ready")
            assert res.status_code == 503 and res.json()["reason"] == "db_not_configured"

    def test_a_database_that_never_answered_is_not_ready(self):
        store = InMemoryStore(seeded_vehicles(), DEVICES)
        store.fail_devices = StoreError(401, "Supabase rejected the key")
        store.fail_ping = StoreError(401, "Supabase rejected the key")
        with Rig(store=store) as r:
            r.client.get("/health")
            res = r.client.get("/ready")
            assert res.status_code == 503 and res.json()["reason"] == "db_auth"

    def test_once_ready_a_database_blip_does_not_unready_it(self, rig):
        # Restarting the engine cannot fix Supabase; /health still tells the truth.
        assert rig.client.get("/ready").status_code == 200
        rig.store.fail_ping = StoreError(504, "Supabase did not answer in time")
        assert rig.client.get("/health").status_code == 503
        assert rig.client.get("/ready").status_code == 200

    def test_no_device_tokens_is_not_a_database_that_answered(self):
        # With no tokens the device lookup makes no request; it must not count as an answer.
        store = InMemoryStore(seeded_vehicles(), DEVICES)
        store.fail_ping = StoreError(502, "cannot reach Supabase")
        with Rig(store=store, device_tokens={}) as r:
            res = r.client.get("/ready")
            assert res.status_code == 503 and res.json()["reason"] == "db_unreachable"

    def test_ready_does_no_io(self, rig):
        rig.store.calls.clear()
        rig.client.get("/ready")
        assert rig.store.calls == []


class TestEngineHeartbeat:
    def test_touches_the_engine_row_with_the_running_version(self):
        from vtrack_engine.main import _engine_heartbeat
        devices = {**DEVICES, "engine-1": {"id": "engine-1", "role": "engine", "site": None, "lane": None}}
        with Rig(store=InMemoryStore(seeded_vehicles(), devices), render_git_commit="abc1234") as r:
            r.client.portal.call(_engine_heartbeat, r.app.state.engine)
            assert r.store.devices["engine-1"]["version"] == "m2+abc1234"

    def test_a_missing_row_or_a_failure_is_logged_not_raised(self, rig, caplog):
        from vtrack_engine.main import _engine_heartbeat
        rig.client.portal.call(_engine_heartbeat, rig.app.state.engine)     # no engine-1 row
        rig.client.portal.call(_engine_heartbeat, rig.app.state.engine)
        assert sum("seed.sql" in m for m in caplog.messages) == 1           # warned once
        rig.store.fail_touch = StoreError(504, "Supabase did not answer in time")
        rig.client.portal.call(_engine_heartbeat, rig.app.state.engine)
        assert any("heartbeat failed" in m for m in caplog.messages)

    def test_tests_and_injected_stores_run_no_timers(self, rig):
        assert rig.store.touches == 0

    def test_with_timers_on_it_probes_and_heartbeats_without_being_asked(self):
        import time
        with Rig(background=True) as r:
            deadline = time.monotonic() + 2
            while (r.store.touches == 0 or "ping" not in r.store.calls) and time.monotonic() < deadline:
                r.client.portal.call(asyncio.sleep, 0.01)
            assert r.store.touches == 1 and "ping" in r.store.calls


class TestStartupRefusals:
    def test_a_publishable_key_is_refused_at_startup(self):
        s = settings(supabase_url="https://p.supabase.co", supabase_service_key="sb_publishable_x")
        app = create_app(s, alpr=StubALPR(), load_model=False, background=False)
        with TestClient(app) as c:
            body = c.get("/health", headers={"X-Device-Token": CAM}).json()
            assert body["db"] == "error" and "SECRET key" in body["db_error"]
            assert body["reason"] == "db_not_configured"

    def test_a_device_with_no_site_is_refused(self):
        devices = {**DEVICES, "cam-a": {**DEVICES["cam-a"], "site": None}}
        with Rig(store=InMemoryStore(seeded_vehicles(), devices)) as r:
            assert r.frame("SBA1234G").status_code == 403
            body = r.client.get("/health", headers={"X-Device-Token": DISP}).json()
            assert "/display" in body["devices"]["cam-a"]

    def test_the_example_placeholder_token_is_refused(self):
        with Rig(device_tokens={"cam-a": "<random 32 chars>"}) as r:
            assert r.frame("SBA1234G", token="<random 32 chars>").status_code == 403


class TestEdges:
    def test_rate_limit_is_per_device_and_answers_429(self):
        with Rig(rate_limit_per_s=2) as r:
            codes = [r.client.post("/heartbeat", headers={"X-Device-Token": CAM}, json={}).status_code
                     for _ in range(5)]
            assert 429 in codes
            # another device has its own allowance
            assert r.client.post("/heartbeat", headers={"X-Device-Token": DISP}, json={}).status_code == 204

    def test_cors_allows_the_configured_origin_only(self, rig):
        pre = lambda o: rig.client.options("/recognise", headers={  # noqa: E731
            "Origin": o, "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "X-Device-Token"})
        assert pre("http://localhost:5173").headers.get("access-control-allow-origin") == "http://localhost:5173"
        assert "access-control-allow-origin" not in pre("https://evil.example").headers

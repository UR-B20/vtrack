"""
main.py — the VTrack Engine's HTTP surface (CLAUDE.md §5.5).

    POST /recognise   X-Device-Token (capture)   a frame   → one decided event
    POST /manual      X-Device-Token (display)   a plate   → one decided event, source=manual
    POST /heartbeat   X-Device-Token             liveness  → 204
    GET  /health      none (token adds detail)   what is live, and whether it works now
    GET  /ready       none                       may this instance take the gate? (Render)

Order inside /recognise is deliberate:
  1. the cheap refusals (token, rate, image, frame age) before anything expensive;
  2. inference in a worker thread, OUTSIDE any lock — it is the slow part;
  3. a per-(site, lane) lock around ONLY read-open-event → merge → write, so two frames of
     one car in flight cannot both insert, and a slow Supabase call cannot hold a lane for
     longer than the client timeout;
  4. if the write fails, the answer is an error with NO decision in it. /capture must never
     show a colour the guard's screen did not get.

Run it with ONE worker: the lane locks live in this process. `uv run vtrack-engine` does.

/ready vs /health. Render routes traffic by /ready. It answers from memory and is LATCHED:
200 once the model is loaded and the database has answered once since start, then 200 for
the life of the process. So a deploy with a wrong key never becomes ready — Render cancels
it and the running engine keeps the gate — while a Supabase blip later on does not get a
working engine restarted in a loop (restarting cannot fix Supabase). /health is the live
truth for the status pills: 200 only while a frame could be decided AND stored right now.
Its public body is status only (brief §3.10); a known device token adds the detail.
"""

import asyncio
import hashlib
import logging
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime
from typing import Annotated, Any

from fastapi import FastAPI, File, Form, Header, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded

from .alpr import ALPR, ALPRError, build_alpr, select
from .auth import AuthError, Device, DeviceRegistry, check_claim
from .clock import now_utc, today_at_gate
from .config import WHERE_SECRETS_LIVE, Settings, load_settings, service_key_problem
from .db import EventStore, StoreError, SupabaseStore
from .decide import Interpretation, decide, interpret
from .dedupe import Insert, merge, window_start
from .events import new_event_row, no_plate_response, response_from_row
from .images import MAX_BYTES, ImageRejected, validate_jpeg
from .pipeline import band_from_roi, conclude, lookups
from .plates import CIVILIAN, checksum_letter, classify

VERSION = "m2"
log = logging.getLogger("vtrack.engine")


class ApiError(Exception):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


@dataclass
class EngineState:
    settings: Settings
    store: EventStore | None
    registry: DeviceRegistry
    alpr: ALPR | None = None
    model_status: str = "loading"            # loading | ready | error
    model_error: str | None = None
    db_error: str | None = None
    # Coarse and public: db_not_configured | db_auth | db_unreachable.
    db_reason: str | None = None
    db_checked_at: float = 0.0
    db_answered: bool = False           # the database has answered at least once
    ready: bool = False                 # /ready, latched (module docstring)
    last_reason: str | None = "starting"
    heartbeat_warned: bool = False
    started_at: float = field(default_factory=time.monotonic)
    lane_locks: dict[tuple[str, str], asyncio.Lock] = field(default_factory=dict)

    def lane_lock(self, site: str, lane: str) -> asyncio.Lock:
        return self.lane_locks.setdefault((site, lane), asyncio.Lock())


def _token_key(request: Request) -> str:
    # Rate limit per device token (§5.5), never per IP: mobile data changes address
    # constantly. Hashed so the limiter never holds the token itself.
    token = request.headers.get("x-device-token") or ""
    return hashlib.sha256(token.encode()).hexdigest()[:16]


class ManualBody(BaseModel):
    device_id: str | None = None
    plate_text: str
    actor: str | None = None
    event_id: str | None = None      # the event being confirmed; the stale-confirm check is M3


class HeartbeatBody(BaseModel):
    device_id: str | None = None
    role: str | None = None
    version: str | None = None
    stats: dict[str, Any] | None = None


def create_app(settings: Settings | None = None, store: EventStore | None = None,
               alpr: ALPR | None = None, load_model: bool = True,
               background: bool | None = None) -> FastAPI:
    """Build the app. Production calls it bare and everything comes from the environment;
    tests pass a store, an ALPR and settings in. `background` runs the database probe and
    the engine's own heartbeat on timers; by default only against the real Supabase."""
    settings = settings or load_settings()
    injected_store = store is not None
    if background is None:
        background = not injected_store

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state: EngineState = app.state.engine
        if state.store is None and not injected_store:
            problem = service_key_problem(settings.supabase_service_key)
            if problem is None and not settings.supabase_url:
                problem = f"SUPABASE_URL is not set {WHERE_SECRETS_LIVE}"
            if problem:
                state.db_error, state.db_reason = problem, "db_not_configured"
                log.error("database not configured: %s", problem)
            else:
                state.store = SupabaseStore(settings.supabase_url, settings.supabase_service_key)
        if not settings.device_tokens:
            log.error("DEVICE_TOKENS is empty %s — no device can use this engine",
                      WHERE_SECRETS_LIVE)
        await _check_db(state)
        tasks: list[asyncio.Task] = []
        if state.alpr is not None:
            state.model_status = "ready"
        elif load_model:
            tasks.append(asyncio.create_task(_load_model(state)))
        if background:
            tasks.append(asyncio.create_task(_every(5.0, lambda: _probe_db(state, every_s=0))))
            tasks.append(asyncio.create_task(
                _every(settings.heartbeat_s, lambda: _engine_heartbeat(state))))
        _note(state)
        try:
            yield
        finally:
            for task in tasks:
                task.cancel()
            if state.store is not None:
                await state.store.aclose()

    app = FastAPI(title="VTrack Engine", version=VERSION, lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.state.engine = EngineState(settings=settings, store=store,
                                   registry=DeviceRegistry(settings.device_tokens), alpr=alpr)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_methods=["GET", "POST"],
        allow_headers=["X-Device-Token", "Content-Type"],
        allow_credentials=False,
        max_age=600,
    )

    limiter = Limiter(key_func=_token_key)
    app.state.limiter = limiter
    rate = lambda: f"{settings.rate_limit_per_s}/second"  # noqa: E731

    @app.exception_handler(RateLimitExceeded)
    async def _too_many(request: Request, exc: RateLimitExceeded) -> JSONResponse:
        return JSONResponse({"detail": f"more than {settings.rate_limit_per_s} requests a second "
                                       "from this device"}, status_code=429)

    @app.exception_handler(ApiError)
    @app.exception_handler(AuthError)
    @app.exception_handler(ImageRejected)
    @app.exception_handler(StoreError)
    async def _known(request: Request, exc: Any) -> JSONResponse:
        status = exc.status
        # A store failure is a failure of THIS engine to reach its database: 502/503/504.
        if isinstance(exc, StoreError) and not 500 <= status < 600:
            status = 502
        return JSONResponse({"detail": exc.detail}, status_code=status)

    def state_of(request: Request) -> EngineState:
        return request.app.state.engine

    async def authenticate(state: EngineState, token: str | None, claimed: str | None,
                           role: str | None = None) -> Device:
        if not state.registry.loaded:
            await _ensure_devices(state)
        device = state.registry.resolve(token)
        check_claim(device, claimed)
        if role and device.role != role:
            raise AuthError(403, f"{device.id} is a {device.role} device; this needs {role}")
        return device

    def require_store(state: EngineState) -> EventStore:
        if state.store is None:
            raise ApiError(503, state.db_error or "database not configured")
        return state.store

    # ── POST /recognise ─────────────────────────────────────────────────────────────
    @app.post("/recognise")
    @limiter.limit(rate)
    async def recognise(
        request: Request,
        image: Annotated[UploadFile, File()],
        device_id: Annotated[str | None, Form()] = None,
        captured_at: Annotated[str | None, Form()] = None,
        roi: Annotated[str | None, Form()] = None,
        x_device_token: Annotated[str | None, Header()] = None,
    ) -> JSONResponse:
        t0 = time.perf_counter()
        state = state_of(request)
        device = await authenticate(state, x_device_token, device_id, role="capture")
        store = require_store(state)

        data = await image.read(MAX_BYTES + 1)
        width, height = validate_jpeg(data)
        _check_frame_age(captured_at, settings.max_frame_age_s)
        try:
            band = band_from_roi(roi)
        except ValueError as exc:
            raise ApiError(422, str(exc)) from exc

        if state.alpr is None or state.model_status != "ready":
            raise ApiError(503, state.model_error or "the plate model is still loading")
        try:
            reads = await run_in_threadpool(state.alpr.recognise, data, settings.region)
        except ALPRError as exc:
            raise ApiError(502, str(exc)) from exc

        selection = select(reads, width, height, band)
        chosen = selection.read
        if chosen is None:
            return JSONResponse(no_plate_response(_ms(t0), selection.rejected))

        # The same pure steps the benchmark runs (pipeline.py); only the lookups are I/O.
        th = settings.thresholds
        interp = interpret(chosen.text, chosen.confidence, th)
        plates = lookups(interp)
        found = await asyncio.gather(*(store.get_vehicle(p) for p in plates))
        outcome = conclude(interp, dict(zip(plates, found, strict=True)), today_at_gate(), th)
        interp, verdict, vehicle = outcome.interp, outcome.verdict, outcome.vehicle

        async with state.lane_lock(device.site, device.lane):
            now = now_utc()
            candidate = new_event_row(
                event_id=str(uuid.uuid4()), now=now, device=device, interp=interp,
                verdict=verdict, vehicle=vehicle, bbox=chosen.bbox,
                engine=state.alpr.name, latency_ms=_ms(t0), source="camera",
            )
            existing = await store.find_open_event(
                device.site, device.lane, interp.plate_norm,
                window_start(now, settings.dedupe_s))
            action = merge(existing, candidate, now, settings.dedupe_s)
            if isinstance(action, Insert):
                row, deduped = await store.insert_event(action.row), False
            else:
                row, deduped = await store.update_event(action.event_id, action.fields), True

        if vehicle is None and row["decision"] != "check" and row.get("plate_norm"):
            # A merge kept an earlier decision this frame did not look up for itself.
            vehicle = await store.get_vehicle(row["plate_norm"])
        return JSONResponse(response_from_row(row, vehicle=vehicle, conf_decide=th.conf_decide,
                                              latency_ms=_ms(t0), deduped=deduped))

    # ── POST /manual ───────────────────────────────────────────────────────────────
    @app.post("/manual")
    @limiter.limit(rate)
    async def manual(request: Request, body: ManualBody,
                     x_device_token: Annotated[str | None, Header()] = None) -> JSONResponse:
        t0 = time.perf_counter()
        state = state_of(request)
        device = await authenticate(state, x_device_token, body.device_id, role="display")
        store = require_store(state)
        interp = _typed_plate(body.plate_text)
        th = settings.thresholds
        vehicle = await store.get_vehicle(interp.plate_norm)
        verdict = decide(interp, vehicle, today_at_gate(), th)
        row = new_event_row(
            event_id=str(uuid.uuid4()), now=now_utc(), device=device, interp=interp,
            verdict=verdict, vehicle=vehicle, bbox=None, engine="manual",
            latency_ms=_ms(t0), source="manual",
        )
        # Always a new event, never merged into the camera's: the audit keeps both what the
        # camera read and what the guard confirmed.
        stored = await store.insert_event(row)
        return JSONResponse(response_from_row(stored, vehicle=vehicle, conf_decide=th.conf_decide,
                                              latency_ms=_ms(t0), deduped=False))

    # ── POST /heartbeat ────────────────────────────────────────────────────────────
    @app.post("/heartbeat", status_code=204)
    @limiter.limit(rate)
    async def heartbeat(request: Request, body: HeartbeatBody,
                        x_device_token: Annotated[str | None, Header()] = None) -> Response:
        state = state_of(request)
        device = await authenticate(state, x_device_token, body.device_id)
        # /capture pairs by sending a heartbeat, so a role mismatch is refused here: pairing a
        # camera screen with the display's token must fail at pairing, not at the first frame.
        if body.role and body.role != device.role:
            raise AuthError(403, f"{device.id} is a {device.role} device, not a {body.role}")
        await require_store(state).touch_device(device.id, body.version, now_utc())
        return Response(status_code=204)

    # ── GET /health ────────────────────────────────────────────────────────────────
    @app.get("/health")
    async def health(request: Request,
                     x_device_token: Annotated[str | None, Header()] = None) -> JSONResponse:
        state = state_of(request)
        await _probe_db(state)
        reason = _not_ready_reason(state)
        body: dict[str, Any] = {
            "engine": settings.alpr_engine,
            "model": state.alpr.model if state.alpr and state.model_status == "ready" else None,
            "model_status": state.model_status,
            "db": "ok" if state.store is not None and state.db_error is None else "error",
            "reason": reason,
            "thresholds": {
                "conf_decide": settings.conf_decide, "conf_check": settings.conf_check,
                "dedupe_s": settings.dedupe_s, "repair_max_subs": settings.repair_max_subs,
                "max_frame_age_s": settings.max_frame_age_s,
                "rate_limit_per_s": settings.rate_limit_per_s,
            },
            "uptime_s": int(time.monotonic() - state.started_at),
            "version": running_version(settings),
        }
        if state.registry.knows(x_device_token):
            # A paired device may diagnose the engine; the public may not (§3.10). An
            # unknown token is not an error here, just the public view.
            body |= {"model_error": state.model_error, "db_error": state.db_error,
                     "devices": state.registry.status()}
        # 200 only while a frame could be decided and stored right now; `reason` says why not.
        return JSONResponse(body, status_code=200 if reason is None else 503)

    # ── GET /ready ─────────────────────────────────────────────────────────────────
    @app.get("/ready")
    async def ready(request: Request) -> JSONResponse:
        state = state_of(request)
        _note(state)
        if state.ready:
            return JSONResponse({"ready": True})
        return JSONResponse({"ready": False, "reason": _not_ready_reason(state) or "db_waiting"},
                            status_code=503)

    return app


# ── helpers ────────────────────────────────────────────────────────────────────────────

def _ms(t0: float) -> int:
    return int((time.perf_counter() - t0) * 1000)


def running_version(settings: Settings) -> str:
    commit = settings.render_git_commit[:7]
    return f"{VERSION}+{commit}" if commit else VERSION


def _not_ready_reason(state: EngineState) -> str | None:
    """Why a frame could not be decided and stored right now — coarse, and public."""
    if state.model_status != "ready":
        return "model_loading" if state.model_status == "loading" else "model_error"
    if state.store is None:
        return state.db_reason or "db_not_configured"
    if state.db_error is not None:
        return state.db_reason or "db_unreachable"
    return None


def _note(state: EngineState) -> None:
    """Latch /ready, and log each change of readiness once: Render → Logs is where the
    owner looks when a deploy does not go live. Reasons only — never a plate or a token."""
    if not state.ready and state.model_status == "ready" and state.db_answered:
        state.ready = True
        log.info("ready: plate model loaded, database answered")
    reason = _not_ready_reason(state)
    if reason != state.last_reason:
        state.last_reason = reason
        if reason:
            log.warning("not able to decide frames: %s", reason)
        else:
            log.info("healthy")


def _db_ok(state: EngineState) -> None:
    state.db_error = state.db_reason = None
    state.db_answered = True
    _note(state)


def _db_failed(state: EngineState, exc: StoreError) -> None:
    state.db_error = exc.detail
    state.db_reason = "db_auth" if exc.status in (401, 403) else "db_unreachable"
    _note(state)


async def _every(period_s: float, job) -> None:
    """Run `job` now and then every `period_s`, forever; one failure never stops it."""
    while True:
        try:
            await job()
        except Exception:  # noqa: BLE001
            log.exception("background job failed")
        await asyncio.sleep(period_s)


async def _engine_heartbeat(state: EngineState) -> None:
    """Touch the engine's own `devices` row: the running version goes on record, and the
    Supabase free tier, which pauses after 7 idle days, never goes idle while it runs."""
    if state.store is None:
        return
    s = state.settings
    try:
        touched = await state.store.touch_device(s.engine_device_id, running_version(s),
                                                 now_utc())
    except StoreError as exc:
        log.warning("engine heartbeat failed: %s", exc.detail)
        return
    if not touched and not state.heartbeat_warned:
        state.heartbeat_warned = True
        log.warning("no `devices` row for %s — has supabase/seed.sql been run?",
                    s.engine_device_id)


def _check_frame_age(captured_at: str | None, max_age_s: float) -> None:
    """A delayed frame of the previous car, arriving after the next car's event, would
    otherwise stage a fresh green. Symmetric, so a device clock a little ahead passes."""
    if not captured_at:
        raise ApiError(422, "captured_at is required")
    try:
        taken = datetime.fromisoformat(captured_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ApiError(422, "captured_at must be an ISO 8601 timestamp") from exc
    if taken.tzinfo is None:
        raise ApiError(422, "captured_at must carry a timezone (e.g. …Z)")
    skew = (now_utc() - taken).total_seconds()
    if abs(skew) > max_age_s:
        direction = "old" if skew > 0 else "in the future"
        raise ApiError(422, f"frame is {abs(skew):.1f} s {direction}; the limit is "
                            f"{max_age_s:g} s — check this device's clock")


def _typed_plate(text: str) -> Interpretation:
    """A plate a guard typed. It is taken exactly as typed: never repaired, because a
    repaired typo could turn into someone else's approved plate. A bad check letter is
    refused and named, as the admin drawer does."""
    kind, canon, ok = classify(text)
    if kind == "invalid":
        raise ApiError(422, "not a recognisable plate")
    if kind == "civilian" and not ok:
        prefix, number, _ = CIVILIAN.match(canon).groups()  # type: ignore[union-attr]
        raise ApiError(422, f"check letter should be {checksum_letter(prefix, number)}")
    return Interpretation(plate_raw=text, plate_norm=canon, plate_kind=kind, checksum_ok=ok,
                          repaired_from=None, confidence=1.0, early=None)


async def _ensure_devices(state: EngineState) -> None:
    if state.store is None or state.registry.loaded:
        return
    try:
        rows = await state.store.get_devices(state.registry.device_ids)
    except StoreError as exc:
        _db_failed(state, exc)
        return
    # Not _db_ok: with no device tokens configured this makes no request at all, and only
    # a real answer from the database may count towards /ready.
    state.registry.load(rows)


async def _probe_db(state: EngineState, every_s: float = 5.0) -> None:
    if state.store is None:
        return
    if time.monotonic() - state.db_checked_at < every_s and state.db_checked_at:
        return
    state.db_checked_at = time.monotonic()
    await _check_db(state)


async def _check_db(state: EngineState) -> None:
    """One real round trip. The only thing that marks the database as having answered."""
    if state.store is None:
        return
    try:
        await state.store.ping()
    except StoreError as exc:
        _db_failed(state, exc)
        return
    _db_ok(state)
    await _ensure_devices(state)


async def _load_model(state: EngineState) -> None:
    try:
        alpr = await run_in_threadpool(build_alpr, state.settings)
        warm = getattr(alpr, "warm_up", None)
        if warm:
            await run_in_threadpool(warm)
        state.alpr, state.model_status, state.model_error = alpr, "ready", None
        log.info("plate model ready: %s", alpr.model)
    except Exception as exc:  # noqa: BLE001 — any failure here must leave a readable reason
        state.model_status = "error"
        state.model_error = f"{type(exc).__name__}: {exc}"
        log.error("plate model failed to load: %s", state.model_error)
    _note(state)


app = create_app()

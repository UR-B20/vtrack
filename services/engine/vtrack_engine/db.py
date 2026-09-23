"""
db.py — the engine's only I/O with Supabase, over PostgREST with the service key.

`httpx` straight to /rest/v1 rather than supabase-py: CLAUDE.md §3 lists httpx, the engine
needs four verbs on three tables, and every request it makes is then something a test can
see whole — headers, query string, body.

Two things are easy to get wrong here, and both would look like a bug somewhere else:

  • Key headers. A new-style `sb_secret_…` key is NOT a JWT. It travels in `apikey` only;
    sent as `Authorization: Bearer` too, Supabase may try to parse it as a JWT and reject
    the request as "Invalid JWT". A legacy service_role key IS a JWT and goes in both.
  • Query encoding. Every filter goes through httpx `params=`. A hand-built
    `last_read_at=gte.2026-…+00:00` sends a literal `+`, which the server decodes as a
    space — a filter that silently matches nothing, i.e. dedupe that never dedupes.
"""

from datetime import date, datetime
from typing import Any, Protocol

import httpx

from .config import key_kind
from .decide import VehicleRow
from .dedupe import OpenEvent

VEHICLE_COLUMNS = (
    "id,plate_norm,plate_display,owner_name,org_unit,pass_type,status,valid_from,valid_until"
)
OPEN_EVENT_COLUMNS = "id,plate_norm,decision,confidence,read_count,last_read_at"
DEVICE_COLUMNS = "id,role,site,lane"


class StoreError(Exception):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


class StoreConflict(StoreError):
    """The row already exists — for an insert with an engine-generated id, a retry of a
    write that actually landed."""


class EventStore(Protocol):
    async def ping(self) -> None: ...
    async def get_devices(self, ids: list[str]) -> dict[str, dict[str, Any]]: ...
    async def get_vehicle(self, plate_norm: str) -> VehicleRow | None: ...
    async def find_open_event(self, site: str, lane: str, plate_norm: str,
                              since: datetime) -> OpenEvent | None: ...
    async def insert_event(self, row: dict[str, Any]) -> dict[str, Any]: ...
    async def update_event(self, event_id: str, fields: dict[str, Any]) -> dict[str, Any]: ...
    async def touch_device(self, device_id: str, version: str | None,
                           seen_at: datetime) -> None: ...
    async def aclose(self) -> None: ...


def auth_headers(key: str) -> dict[str, str]:
    headers = {"apikey": key}
    if key_kind(key) in ("service_role_jwt", "other_jwt"):
        headers["Authorization"] = f"Bearer {key}"
    return headers


def jsonable(value: Any) -> Any:
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: jsonable(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [jsonable(v) for v in value]
    return value


def _date(value: str | None) -> date | None:
    return date.fromisoformat(value) if value else None


def vehicle_from_row(row: dict[str, Any]) -> VehicleRow:
    return VehicleRow(
        id=row["id"], plate_norm=row["plate_norm"], plate_display=row["plate_display"],
        owner_name=row["owner_name"], org_unit=row.get("org_unit"), pass_type=row["pass_type"],
        status=row["status"], valid_from=_date(row.get("valid_from")),
        valid_until=_date(row.get("valid_until")),
    )


def open_event_from_row(row: dict[str, Any]) -> OpenEvent:
    conf = row.get("confidence")
    return OpenEvent(
        id=row["id"], plate_norm=row["plate_norm"], decision=row["decision"],
        confidence=float(conf) if conf is not None else None,
        read_count=int(row["read_count"]),
        last_read_at=datetime.fromisoformat(row["last_read_at"]),
    )


def _describe(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        body = {}
    code = body.get("code") if isinstance(body, dict) else None
    message = (body.get("message") if isinstance(body, dict) else None) or response.text[:200]
    if response.status_code == 401 or code in ("PGRST301", "PGRST302"):
        return f"Supabase rejected the key ({message}) — check SUPABASE_SERVICE_KEY"
    if code == "42501":
        return f"permission denied ({message}) — SUPABASE_SERVICE_KEY is not the secret key"
    if code == "23503":
        return f"foreign key violation ({message}) — has supabase/seed.sql been run?"
    return " · ".join(p for p in (code, message) if p) or f"HTTP {response.status_code}"


class SupabaseStore:
    def __init__(self, url: str, key: str, client: httpx.AsyncClient | None = None,
                 timeout_s: float = 3.0) -> None:
        self._base = url.rstrip("/") + "/rest/v1"
        self._headers = {**auth_headers(key), "Accept": "application/json"}
        # One client for the life of the engine: a fresh TLS handshake per call would
        # spend a real share of the 2 s budget on three round trips.
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(timeout_s))

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _request(self, method: str, table: str, *, params: dict[str, str] | None = None,
                       body: Any = None, prefer: str | None = None) -> Any:
        headers = dict(self._headers)
        if prefer:
            headers["Prefer"] = prefer
        try:
            r = await self._client.request(
                method, f"{self._base}/{table}", params=params,
                json=jsonable(body) if body is not None else None, headers=headers,
            )
        except httpx.TimeoutException as exc:
            raise StoreError(504, "Supabase did not answer in time") from exc
        except httpx.HTTPError as exc:
            raise StoreError(502, f"cannot reach Supabase ({type(exc).__name__}) — check "
                                  "SUPABASE_URL and that the project is not paused") from exc
        if r.status_code == 409:
            raise StoreConflict(409, _describe(r))
        if r.status_code >= 400:
            raise StoreError(r.status_code, _describe(r))
        if r.status_code == 204 or not r.content:
            return None
        return r.json()

    async def ping(self) -> None:
        # `devices` is a base table the anon role has no privilege on (0002_policies.sql),
        # so this succeeds only with a genuine service key sent in the right headers.
        await self._request("GET", "devices", params={"select": "id", "limit": "1"})

    async def get_devices(self, ids: list[str]) -> dict[str, dict[str, Any]]:
        if not ids:
            return {}
        quoted = ",".join(f'"{i}"' for i in ids)
        rows = await self._request("GET", "devices",
                                   params={"select": DEVICE_COLUMNS, "id": f"in.({quoted})"})
        return {r["id"]: r for r in rows or []}

    async def get_vehicle(self, plate_norm: str) -> VehicleRow | None:
        rows = await self._request("GET", "vehicles", params={
            "select": VEHICLE_COLUMNS, "plate_norm": f"eq.{plate_norm}", "limit": "1"})
        return vehicle_from_row(rows[0]) if rows else None

    async def find_open_event(self, site: str, lane: str, plate_norm: str,
                              since: datetime) -> OpenEvent | None:
        rows = await self._request("GET", "events", params={
            "select": OPEN_EVENT_COLUMNS,
            "site": f"eq.{site}", "lane": f"eq.{lane}", "plate_norm": f"eq.{plate_norm}",
            "source": "eq.camera", "last_read_at": f"gte.{since.isoformat()}",
            "order": "last_read_at.desc", "limit": "1",
        })
        return open_event_from_row(rows[0]) if rows else None

    async def insert_event(self, row: dict[str, Any]) -> dict[str, Any]:
        rows = await self._request("POST", "events", body=row, prefer="return=representation")
        return rows[0]

    async def update_event(self, event_id: str, fields: dict[str, Any]) -> dict[str, Any]:
        rows = await self._request("PATCH", "events", params={"id": f"eq.{event_id}"},
                                   body=fields, prefer="return=representation")
        if not rows:
            raise StoreError(404, f"event {event_id} no longer exists")
        return rows[0]

    async def touch_device(self, device_id: str, version: str | None,
                           seen_at: datetime) -> None:
        # PATCH, never upsert: an upsert without `role` violates its NOT NULL, and it would
        # let any valid token create device rows.
        fields: dict[str, Any] = {"last_seen_at": seen_at}
        if version:
            fields["version"] = version[:64]
        await self._request("PATCH", "devices", params={"id": f"eq.{device_id}"},
                            body=fields, prefer="return=minimal")

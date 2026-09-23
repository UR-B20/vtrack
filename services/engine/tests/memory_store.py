"""An in-memory EventStore for the API tests. It mirrors the PostgREST semantics SupabaseStore
relies on — in particular the exact §5.3 key — so a store-level mistake would show up in
tests/test_api.py rather than only at the gate. Not importable by the engine itself."""

from datetime import datetime
from typing import Any

from vtrack_engine.db import StoreConflict, StoreError, open_event_from_row, vehicle_from_row
from vtrack_engine.decide import VehicleRow
from vtrack_engine.dedupe import OpenEvent


def _iso(v: Any) -> Any:
    return v.isoformat() if isinstance(v, datetime) else v


class InMemoryStore:
    def __init__(self, vehicles: dict[str, VehicleRow], devices: dict[str, dict[str, Any]]):
        self.vehicles = vehicles
        self.devices = {k: dict(v) for k, v in devices.items()}
        self.events: dict[str, dict[str, Any]] = {}
        self.fail_writes: StoreError | None = None
        self.fail_ping: StoreError | None = None
        self.calls: list[str] = []

    async def ping(self) -> None:
        self.calls.append("ping")
        if self.fail_ping:
            raise self.fail_ping

    async def get_devices(self, ids: list[str]) -> dict[str, dict[str, Any]]:
        return {i: self.devices[i] for i in ids if i in self.devices}

    async def get_vehicle(self, plate_norm: str) -> VehicleRow | None:
        self.calls.append(f"get_vehicle:{plate_norm}")
        v = self.vehicles.get(plate_norm)
        return vehicle_from_row(_row_of(v)) if v else None

    async def find_open_event(self, site, lane, plate_norm, since) -> OpenEvent | None:
        hits = [e for e in self.events.values()
                if e["site"] == site and e["lane"] == lane and e["plate_norm"] == plate_norm
                and e["source"] == "camera" and datetime.fromisoformat(e["last_read_at"]) >= since]
        hits.sort(key=lambda e: e["last_read_at"], reverse=True)
        return open_event_from_row(hits[0]) if hits else None

    async def insert_event(self, row: dict[str, Any]) -> dict[str, Any]:
        if self.fail_writes:
            raise self.fail_writes
        if row["id"] in self.events:
            raise StoreConflict(409, "duplicate key value violates unique constraint")
        stored = {k: _iso(v) for k, v in row.items()}
        self.events[row["id"]] = stored
        return dict(stored)

    async def update_event(self, event_id: str, fields: dict[str, Any]) -> dict[str, Any]:
        if self.fail_writes:
            raise self.fail_writes
        self.events[event_id].update({k: _iso(v) for k, v in fields.items()})
        return dict(self.events[event_id])

    async def touch_device(self, device_id, version, seen_at) -> None:
        self.devices[device_id]["last_seen_at"] = seen_at.isoformat()
        if version:
            self.devices[device_id]["version"] = version

    async def aclose(self) -> None:
        pass


def _row_of(v: VehicleRow) -> dict[str, Any]:
    return {**v.__dict__,
            "valid_from": v.valid_from.isoformat() if v.valid_from else None,
            "valid_until": v.valid_until.isoformat() if v.valid_until else None}

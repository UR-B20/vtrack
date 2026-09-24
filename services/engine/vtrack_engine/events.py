"""
events.py — the row the engine writes and the answer it gives (CLAUDE.md §4, §5.5). Pure.

One function builds the `events` row, and tests/test_db_schema.py executes exactly that row
against the real migrations on Postgres. The payload that is tested is the payload that is
sent.
"""

from datetime import datetime
from typing import Any

from .auth import Device
from .decide import Interpretation, VehicleRow, Verdict
from .plates import format_plate


def new_event_row(*, event_id: str, now: datetime, device: Device, interp: Interpretation,
                  verdict: Verdict, vehicle: VehicleRow | None,
                  bbox: tuple[int, int, int, int] | None, engine: str, latency_ms: int,
                  source: str) -> dict[str, Any]:
    # site and lane come from the device's own row, never from the request (auth.py).
    return {
        "id": event_id,
        "ts": now,
        "device_id": device.id,
        "site": device.site,
        "lane": device.lane,
        "plate_raw": interp.plate_raw,
        "plate_norm": interp.plate_norm,
        "plate_kind": interp.plate_kind,
        "confidence": interp.confidence,
        "checksum_ok": interp.checksum_ok,
        "repaired_from": interp.repaired_from,
        "vehicle_id": vehicle.id if vehicle else None,
        "decision": verdict.decision,
        "reason": verdict.reason,
        "image_path": None,     # crops are M3
        "bbox": list(bbox) if bbox else None,
        "engine": engine,
        "latency_ms": latency_ms,
        "read_count": 1,
        "last_read_at": now,
        "source": source,
    }


def response_from_row(row: dict[str, Any], *, vehicle: VehicleRow | None, conf_decide: float,
                      latency_ms: int, deduped: bool, stored: bool = True) -> dict[str, Any]:
    """§5.5's response, from the event AS STORED. After a dedupe merge that is the refined
    event, not merely this frame's read, so /capture shows what /display shows. `stored`
    False: a re-read of the `seen_plate` that wrote nothing (dedupe.py Skip) — the answer
    is this read's, and there is no event id."""
    decision = row["decision"]
    confidence = float(row["confidence"]) if row.get("confidence") is not None else None
    verify = decision != "check" and confidence is not None and confidence < conf_decide
    show_vehicle = vehicle if (vehicle and decision != "check") else None
    until = show_vehicle.valid_until if show_vehicle else None
    return {
        "event_id": row["id"] if stored else None,
        "plate_norm": row["plate_norm"],
        "plate_display": show_vehicle.plate_display if show_vehicle
        else format_plate(row["plate_norm"] or ""),
        "plate_kind": row["plate_kind"],
        "confidence": confidence,
        "checksum_ok": row["checksum_ok"],
        "repaired_from": row["repaired_from"],
        "decision": decision,
        "reason": row["reason"],
        "flags": {"verify": verify},
        "vehicle": {
            "owner_name": show_vehicle.owner_name,
            "org_unit": show_vehicle.org_unit,
            "pass_type": show_vehicle.pass_type,
            "valid_until": until.isoformat() if until else None,
        } if show_vehicle else None,
        "bbox": row.get("bbox"),
        "latency_ms": latency_ms,
        "deduped": deduped,
    }


def no_plate_response(latency_ms: int, rejected: str | None = None) -> dict[str, Any]:
    """Nothing readable in position in the frame. No event is written: an empty tap must not
    put amber on the guard's screen. `rejected` says why plates that WERE seen were not
    read — "edge", "size" or "multiple_plates" (alpr/base.py select) — so /capture can say
    so while the ROI is being set up."""
    return {"event_id": None, "decision": None, "reason": None, "plate_norm": None,
            "rejected": rejected, "latency_ms": latency_ms, "deduped": False}

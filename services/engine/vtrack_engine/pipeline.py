"""
pipeline.py — from what the reader saw to a decision. Pure: no I/O, no clock (CLAUDE.md §1).

/recognise and the real-model tests both run THESE functions, so the tests check the
decisions the gate makes rather than a copy of them:

    sel     = select(reads, width, height, band)             # which plate   (alpr/base.py)
    interp  = interpret(sel.read.text, sel.read.confidence, th)
    rows    = {p: <look p up> for p in lookups(interp)}      # I/O stays with the caller
    outcome = conclude(interp, rows, today, th)
"""

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date

from .alpr.base import PlateBand
from .decide import Interpretation, Thresholds, VehicleRow, Verdict, as_truncated_read, decide


@dataclass(frozen=True)
class Outcome:
    interp: Interpretation
    verdict: Verdict
    vehicle: VehicleRow | None


def lookups(interp: Interpretation) -> list[str]:
    """The plates `conclude` needs looked up. None when the read is already a CHECK. A
    foreign read is denied whatever the list says, so only its Singapore completion is
    looked up (decide.py, dropped check letter)."""
    if interp.early is not None:
        return []
    if interp.plate_kind == "foreign":
        return [interp.completion] if interp.completion else []
    return [interp.plate_norm]


def conclude(interp: Interpretation, rows: Mapping[str, VehicleRow | None], today: date,
             th: Thresholds) -> Outcome:
    decided_on_row = interp.early is None and interp.plate_kind != "foreign"
    vehicle = rows.get(interp.plate_norm) if decided_on_row else None
    # Not on the list as read, but its one Singapore completion is: we may be looking at an
    # approved car whose check letter the camera lost. Ask; never deny, never allow.
    if (vehicle is None and interp.early is None and interp.completion
            and rows.get(interp.completion) is not None):
        interp = as_truncated_read(interp)
    return Outcome(interp, decide(interp, vehicle, today, th), vehicle)


def band_from_roi(roi: str | None) -> PlateBand | None:
    """§5.5's optional `roi` form field. /capture sends `{"plate_w": [min, max]}`, the
    calibrated plate width at the stop line as fractions of the frame width; other keys are
    ignored. Raises ValueError, naming the problem, for anything malformed: a calibration
    that is silently dropped would quietly switch the queued-car guard off."""
    if roi is None or not roi.strip():
        return None
    try:
        data = json.loads(roi)
    except json.JSONDecodeError as exc:
        raise ValueError("roi must be JSON") from exc
    if not isinstance(data, dict):
        raise ValueError("roi must be a JSON object")
    plate_w = data.get("plate_w")
    if plate_w is None:
        return None
    if (not isinstance(plate_w, list) or len(plate_w) != 2
            or not all(isinstance(v, int | float) and not isinstance(v, bool) for v in plate_w)):
        raise ValueError("roi.plate_w must be [min, max]")
    lo, hi = float(plate_w[0]), float(plate_w[1])
    if not 0 < lo < hi <= 1:
        raise ValueError("roi.plate_w must be fractions of the frame width, 0 < min < max ≤ 1")
    return PlateBand(lo, hi)


SEEN_PLATE = re.compile(r"^[A-Z0-9]{1,12}$")
MAX_FRAME_NO = 99


def complete(interp: Interpretation) -> bool:
    """A whole plate, read as it is: a Singapore plate whose check letter fits, or a MID
    plate. Not complete: part of a plate, a dropped or wrong check letter, a read that
    only fits after correction, and anything foreign-shaped (a Singapore plate missing its
    last letter looks foreign)."""
    if interp.repaired_from is not None:
        return False
    return interp.plate_kind == "mid" or (interp.plate_kind == "civilian" and interp.checksum_ok)


def hold_partial(interp: Interpretation, frame: int | None, seen_plate: str | None,
                 hold_frames: int) -> bool:
    """Owner's call (27 Oct 2026): the gate must not show half a plate while the car is
    still pulling in. An incomplete read writes nothing — /capture keeps sending — until
    the vehicle's `hold_frames`-th frame, after which the best the camera can do is shown
    in orange for the guard. While /capture says a car already answered for is still there
    (`seen_plate`), an incomplete read never replaces that answer. A frame with no number
    (a TAP, an older /capture) is decided as before."""
    if complete(interp):
        return False
    if seen_plate is not None:
        return True
    return frame is not None and frame < hold_frames


def frame_from_form(value: str | None) -> int | None:
    """/recognise's optional `frame`: which frame of this vehicle this is, from 1. Raises
    ValueError for anything else, as for `seen_plate`."""
    if value is None or not value.strip():
        return None
    if not re.fullmatch(r"[1-9][0-9]?", value):
        raise ValueError(f"frame must be a whole number from 1 to {MAX_FRAME_NO}")
    return int(value)


def seen_plate_from_form(value: str | None) -> str | None:
    """/recognise's optional `seen_plate`: the plate_norm /capture already has a confident
    answer for, while the lane has not been empty since (dedupe.py). Raises ValueError for
    anything that is not a plate_norm: a hint that is silently dropped would put the same
    car back on the display."""
    if value is None or not value.strip():
        return None
    if not SEEN_PLATE.fullmatch(value):   # `$` alone would admit a trailing newline
        raise ValueError("seen_plate must be a plate_norm: A-Z and 0-9 only, at most 12")
    return value

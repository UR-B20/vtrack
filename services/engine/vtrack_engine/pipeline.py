"""
pipeline.py — from what the reader saw to a decision. Pure: no I/O, no clock (CLAUDE.md §1).

/recognise, the real-model tests and scripts/benchmark.py all run THESE functions, so the
benchmark measures the decisions the gate makes rather than a copy of them:

    sel     = select(reads, width, height, band)             # which plate   (alpr/base.py)
    interp  = interpret(sel.read.text, sel.read.confidence, th)
    rows    = {p: <look p up> for p in lookups(interp)}      # I/O stays with the caller
    outcome = conclude(interp, rows, today, th)
"""

import json
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
    foreign-shaped read also needs its Singapore completion (decide.py, dropped check
    letter)."""
    if interp.early is not None:
        return []
    return [interp.plate_norm] + ([interp.completion] if interp.completion else [])


def conclude(interp: Interpretation, rows: Mapping[str, VehicleRow | None], today: date,
             th: Thresholds) -> Outcome:
    vehicle = rows.get(interp.plate_norm) if interp.early is None else None
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

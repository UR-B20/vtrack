"""
decide.py — CLAUDE.md §5.2, the decision. Pure: no I/O, no clock, no settings object.

Two phases, because the vehicle lookup depends on which plate we think we read:

    interp  = interpret(read_text, confidence, thresholds)   # what did we read?
    vehicle = <caller looks up interp.plate_norm>             # I/O lives in the caller
    verdict = decide(interp, vehicle, today, thresholds)      # what does that mean here?

The overriding rule is §1's: never a confident wrong green. When unsure, return check.

Pinned against the M0 gate display, which renders exactly these fields:
  • checksum_ok records the RAW read. Stage.tsx shows "CHECKSUM FAILED ON RAW READ" from
    checksum_ok=false together with repaired_from.
  • A NULL valid_from / valid_until is an open bound, as in apps/web/src/lib/status.ts.
  • `verify` exists only in the API response; `events` has no flags column, and the display
    derives its VERIFY badge from the stored confidence.
  • Confidence is rounded to the column's 3 places BEFORE any threshold comparison. The
    display compares the stored value against 0.85; deciding on 0.8496 and storing 0.850
    would make the engine say VERIFY and the display say nothing.

One deliberate reading of the spec, flagged rather than buried:
  §5.2's pseudocode sends `invalid` straight to CHECK and only repairs a `civilian` read
  with a bad check letter. But every repair example in §5.1 — SNB953BE, SG2O17C, SBS988OU —
  classifies as `invalid`: an OCR slip puts a letter in the digit block, which breaks the
  pattern rather than the checksum. Read literally, repair() would never run on any of its
  own examples, and gate-check.png's "SNB 953B E → SNB 9538 E" could never happen. So an
  `invalid` read is also offered to repair(). Every guard still applies: the repair must
  yield exactly ONE checksum-valid plate, the read must clear CONF_CHECK, a repaired plate
  that is not on the list is CHECK (never DENY), and the display marks every repaired
  result REPAIRED. `mid` and `foreign` are never repaired. STRICT_SPEC_REPAIR below restores
  the literal reading.

And one guard the spec does not have, which only ever turns a DENY into a CHECK:
  The real model, reading a clear SNB 9538 E through a webcam, returned "SNB9538" at 0.997 —
  it dropped the check letter and was sure of every character it did emit, so the
  weakest-character rule cannot catch it. Without its check letter that read has the shape
  §5.1 calls `foreign`, foreign plates are never repaired, and it is not on the list: a
  confident DENY, no VERIFY, for an approved car. But a Singapore check letter is fully
  determined by prefix and number, so such a read has exactly one possible completion. When
  the read itself is not on the list and that completion IS, the answer is CHECK
  ("ambiguous"), with the completed plate as the best guess. Never a green: a genuinely
  foreign plate (Sabah plates also start with S) must not be allowed on an SG row.
"""

import re
from dataclasses import dataclass, replace
from datetime import date
from typing import Literal

from .plates import checksum_letter, classify, normalise, repair

Decision = Literal["allow", "deny", "check"]
Reason = Literal[
    "not_on_list", "expired", "suspended",
    "unreadable", "low_confidence", "ambiguous", "invalid_pattern",
]
PlateKind = Literal["civilian", "mid", "foreign", "invalid"]

# False: an `invalid` read is offered to repair() (see module docstring).
# True:  §5.2 read literally — only a civilian read with a bad check letter is repaired.
STRICT_SPEC_REPAIR = False


@dataclass(frozen=True)
class Thresholds:
    conf_decide: float = 0.85
    conf_check: float = 0.60
    repair_max_subs: int = 2


@dataclass(frozen=True)
class Verdict:
    decision: Decision
    reason: Reason | None
    # CONF_CHECK <= confidence < CONF_DECIDE and the read still decided (§5.2).
    verify: bool = False


@dataclass(frozen=True)
class Interpretation:
    plate_raw: str               # exactly what the ALPR returned
    plate_norm: str              # the best guess: what is looked up, stored and shown
    plate_kind: PlateKind
    checksum_ok: bool            # of the RAW read, not of the best guess
    repaired_from: str | None    # normalised raw read, when a repair was made
    confidence: float            # rounded to 3 places, clamped to [0, 1]
    early: Verdict | None        # a CHECK decided before any lookup is needed
    # A foreign-shaped read that is exactly a Singapore plate minus its check letter, completed.
    completion: str | None = None


@dataclass(frozen=True)
class VehicleRow:
    """The columns of `vehicles` the decision reads."""
    id: str
    plate_norm: str
    plate_display: str
    owner_name: str
    org_unit: str | None
    pass_type: str
    status: str
    valid_from: date | None
    valid_until: date | None


def is_readable(text: str | None) -> bool:
    """False for an empty OCR result. The caller writes no event for it: an empty tap must
    not put amber on the guard's screen."""
    return bool(text and normalise(text))


_SG_WITHOUT_CHECK = re.compile(r"^([A-Z]{1,3})(\d{1,4})$")


def sg_completion(plate_norm: str) -> str | None:
    """'SNB9538' → 'SNB9538E': the one Singapore plate this read could be if the camera lost
    its check letter. None when the read has a trailing letter or another shape."""
    m = _SG_WITHOUT_CHECK.match(plate_norm)
    return f"{m[1]}{m[2]}{checksum_letter(m[1], m[2])}" if m else None


def as_truncated_read(interp: Interpretation) -> Interpretation:
    """The read is not on the list but its completion is: we may be looking at an approved car
    whose check letter the camera lost. Ask — show the completed plate as the best guess and
    the read as the raw — never allow on it."""
    assert interp.completion is not None
    return replace(
        interp, plate_norm=interp.completion, plate_kind="civilian", checksum_ok=False,
        repaired_from=interp.plate_norm, early=Verdict("check", "ambiguous"), completion=None,
    )


def interpret(text: str, confidence: float, th: Thresholds) -> Interpretation:
    confidence = round(min(max(float(confidence), 0.0), 1.0), 3)
    raw_norm = normalise(text)
    kind, canon, ok = classify(text)
    repaired_from: str | None = None
    early: Verdict | None = None

    repairable = (kind == "civilian" and not ok) or (kind == "invalid" and not STRICT_SPEC_REPAIR)
    if repairable:
        cands = repair(text, th.repair_max_subs)
        if len(cands) == 1:
            canon, kind, repaired_from = cands[0], "civilian", raw_norm
        elif len(cands) > 1:
            early = Verdict("check", "ambiguous")
            canon = raw_norm
        else:
            early = Verdict("check", "invalid_pattern" if kind == "invalid" else "unreadable")
            canon = raw_norm
    elif kind == "invalid":
        early = Verdict("check", "invalid_pattern")

    if early is None and confidence < th.conf_check:
        early = Verdict("check", "low_confidence")

    return Interpretation(
        plate_raw=text,
        plate_norm=canon,
        plate_kind=kind,
        checksum_ok=ok,
        repaired_from=repaired_from,
        confidence=confidence,
        early=early,
        completion=sg_completion(canon) if kind == "foreign" else None,
    )


def decide(interp: Interpretation, vehicle: VehicleRow | None, today: date,
           th: Thresholds) -> Verdict:
    if interp.early is not None:
        return interp.early

    # Only a result that still decides carries VERIFY; a CHECK is already a question.
    verify = interp.confidence < th.conf_decide

    if vehicle is None:
        # A repaired plate that is not on the list means we are not sure what we read:
        # ask the guard rather than turn someone away on our own guess (§5.2).
        if interp.repaired_from:
            return Verdict("check", "not_on_list")
        return Verdict("deny", "not_on_list", verify)

    if vehicle.status == "suspended":
        return Verdict("deny", "suspended", verify)
    if (vehicle.valid_from is not None and today < vehicle.valid_from) or (
        vehicle.valid_until is not None and today > vehicle.valid_until
    ):
        return Verdict("deny", "expired", verify)
    return Verdict("allow", None, verify)

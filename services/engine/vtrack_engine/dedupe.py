"""
dedupe.py — CLAUDE.md §5.3, refinement while a vehicle sits at the guard. Pure.

A stopped vehicle produces many reads. They refine ONE event rather than stacking up new
ones, and the display re-renders that event in place when it receives the UPDATE.

The key is §5.3's, exactly: (site, lane, plate_norm), camera rows only, within DEDUPE_S of
the event's last read. It is deliberately NOT "the latest event in the lane":

    car A (allowed) is pulling away, still in frame · car B (denied) is on the stage
    lane-latest:  A's next read ≠ B → a NEW A event → newer ts → it takes the stage:
                  a green over the car being turned away
    §5.3 key:     A's next read updates A's own older event → the display moves it to the
                  rail only (displayMachine.ts) → B's red stays up

`plate_norm` is the repaired best guess, so the common misread already shares a key: a
SNB953BE frame and a clean SNB9538E frame both land on SNB9538E. §5.3's further clause —
merging a read of a *different* plate that is a confusable variant — is deferred to M2.
It only matters for misreads repair() cannot fix, TAP mode does not produce them, and
about 0.16% of valid plates have a valid confusable twin (SNB991M / SN8991M), so it needs
real multi-frame data to design safely rather than a guess.

On a match, one of three things happens, and read-derived columns are only ever adopted
together — never a new confidence beside an old checksum, which would render
"CHECKSUM FAILED ON RAW READ" on a clean PROCEED:

    existing check,  new read decides           → adopt the new read wholesale (§5.3 upgrade)
    same decision,   new read more confident    → adopt the new read wholesale
    anything else                               → count the read, change nothing else

So a decided event is never downgraded to check, and a green is never flipped by a
same-plate read that disagrees — the same plate means the same list row, so a
disagreement is noise, not news.

`seen_plate` (24 Sep 2026): /capture already has a confident answer for this plate and has
not seen the lane empty since, so the car has not left. It re-reads it when the lane
settles again, to tell a lookalike car pulled in nose to tail from the same car. Inside
the window that read refines the event as above. Outside it there is nothing to refine,
and inserting would put the same car back on the display with a chime, so nothing is
written (`Skip`).
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

# Columns that describe *a read*. Adopted as one unit, never piecemeal.
READ_COLUMNS = (
    "plate_raw", "plate_norm", "plate_kind", "confidence", "checksum_ok",
    "repaired_from", "bbox", "engine", "latency_ms",
)
DECISION_COLUMNS = ("decision", "reason", "vehicle_id")
ADOPTABLE = READ_COLUMNS + DECISION_COLUMNS


@dataclass(frozen=True)
class OpenEvent:
    """The columns of an existing camera event that the merge reads."""
    id: str
    plate_norm: str
    decision: str
    confidence: float | None
    read_count: int
    last_read_at: datetime


@dataclass(frozen=True)
class Insert:
    row: dict[str, Any]


@dataclass(frozen=True)
class Skip:
    """Write nothing: a re-read of the vehicle /capture says is still there (`seen_plate`)."""


@dataclass(frozen=True)
class Update:
    event_id: str
    fields: dict[str, Any] = field(default_factory=dict)
    adopted: bool = False


def window_start(now: datetime, dedupe_s: float) -> datetime:
    """Reads at or after this instant still belong to the event they refine."""
    return now - timedelta(seconds=dedupe_s)


def _should_adopt(existing: OpenEvent, candidate: dict[str, Any]) -> bool:
    new_decision = candidate["decision"]
    if existing.decision == "check" and new_decision in ("allow", "deny"):
        return True
    old_conf = existing.confidence if existing.confidence is not None else -1.0
    return new_decision == existing.decision and candidate["confidence"] > old_conf


def merge(existing: OpenEvent | None, candidate: dict[str, Any], now: datetime,
          dedupe_s: float, seen_plate: str | None = None) -> Insert | Update | Skip:
    """`candidate` is the full row this read would insert. `existing` is the store's answer
    to "an open event with this exact key?" — re-checked here, so a wrong lookup can never
    merge two different plates or revive a vehicle that has already left. `seen_plate` is
    the plate /capture says is still in the lane (see the top of this file)."""
    if (
        existing is None
        or existing.plate_norm != candidate["plate_norm"]
        or existing.last_read_at < window_start(now, dedupe_s)
    ):
        if seen_plate is not None and candidate["plate_norm"] == seen_plate:
            return Skip()
        return Insert(candidate)

    fields: dict[str, Any] = {"read_count": existing.read_count + 1, "last_read_at": now}
    adopted = _should_adopt(existing, candidate)
    if adopted:
        fields.update({k: candidate[k] for k in ADOPTABLE})
    return Update(existing.id, fields, adopted)

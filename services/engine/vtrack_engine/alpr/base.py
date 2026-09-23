"""
alpr/base.py — the seam between the engine and whatever reads plates (CLAUDE.md §5.4).

Both adapters answer the same question, so the gate benchmark in M2 can swap one for the
other with no code change (ALPR_ENGINE=local|cloud).
"""

from typing import Protocol

from pydantic import BaseModel

from ..decide import is_readable


class PlateRead(BaseModel):
    text: str
    confidence: float
    bbox: tuple[int, int, int, int]     # x1, y1, x2, y2 in frame pixels
    engine: str


class ALPR(Protocol):
    name: str       # recorded in events.engine
    model: str      # reported by /health

    def recognise(self, image: bytes, region: str = "sg") -> list[PlateRead]: ...


class ALPRError(Exception):
    """The reader could not answer — distinct from answering "no plate"."""


def area(read: PlateRead) -> int:
    x1, y1, x2, y2 = read.bbox
    return max(0, x2 - x1) * max(0, y2 - y1)


def pick(reads: list[PlateRead]) -> PlateRead | None:
    """The plate the decision is about: the LARGEST in the frame, since the vehicle stopped
    at the guard is the nearest one to the camera.

    If that plate is unreadable, the answer is "no plate" — never a smaller, readable one
    further back. Falling back would decide the car at the guard on the number plate of the
    car queued behind it."""
    if not reads:
        return None
    nearest = max(reads, key=area)
    return nearest if is_readable(nearest.text) else None

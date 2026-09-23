"""
alpr/base.py — the seam between the engine and whatever reads plates (CLAUDE.md §5.4).

Both adapters answer the same question, so the gate benchmark in M2 can swap one for the
other with no code change (ALPR_ENGINE=local|cloud).
"""

from dataclasses import dataclass
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


@dataclass(frozen=True)
class PlateBand:
    """The width a plate has at the stop line, as fractions of the frame's width. /capture
    calibrates it at the gate (SET PLATE SIZE) and sends it in §5.5's optional `roi` field."""
    min_w: float
    max_w: float

    def admits(self, read: PlateRead, frame_w: int) -> bool:
        x1, _, x2, _ = read.bbox
        return self.min_w <= (x2 - x1) / frame_w <= self.max_w


@dataclass(frozen=True)
class Selection:
    read: PlateRead | None            # the one plate the decision is about, if any
    # Why plates were seen but none was chosen: "edge" | "size" | "multiple_plates".
    rejected: str | None = None


EDGE_MARGIN = 0.01      # of the frame's width / height, and never under 2 px


def inside(read: PlateRead, frame_w: int, frame_h: int) -> bool:
    mx, my = max(2, round(frame_w * EDGE_MARGIN)), max(2, round(frame_h * EDGE_MARGIN))
    x1, y1, x2, y2 = read.bbox
    return x1 >= mx and y1 >= my and x2 <= frame_w - mx and y2 <= frame_h - my


def select(reads: list[PlateRead], frame_w: int, frame_h: int,
           band: PlateBand | None = None) -> Selection:
    """The plate the decision is about, or none.

    The frame is the lane ROI that /capture crops around the stop line, so:
      • a plate cut by the frame's edge belongs to a car that is not in position — ignored;
      • with a calibrated band, a plate much bigger or smaller than one at the stop line
        belongs to a car nearer or further than it (the car queued behind) — ignored;
      • of what is left there must be EXACTLY ONE plate. Two plates in position is a scene
        the engine cannot resolve, so it decides nothing and says why, rather than guess
        whose green it is.
    If that one plate is unreadable the answer is "no plate" — never a different, readable
    plate: that would decide the car at the guard on the number plate of another car.

    This replaces M1's "largest plate wins", which is only right when the camera faces the
    front of arriving vehicles; from behind, the car queued nearest the camera is the
    larger one."""
    if not reads:
        return Selection(None)
    placed = [r for r in reads if inside(r, frame_w, frame_h)]
    if not placed:
        return Selection(None, "edge")
    sized = [r for r in placed if band is None or band.admits(r, frame_w)]
    if not sized:
        return Selection(None, "size")
    if len(sized) > 1:
        return Selection(None, "multiple_plates")
    only = sized[0]
    return Selection(only if is_readable(only.text) else None)

"""A scripted ALPR for the API tests. Deliberately NOT selectable through ALPR_ENGINE: a
reader that returns whatever it is told is a way to ship scripted greens."""

from vtrack_engine.alpr.base import PlateRead


class StubALPR:
    name = "stub"
    model = "stub-model"

    def __init__(self) -> None:
        self.next: list[PlateRead] = []
        self.error: Exception | None = None
        self.calls = 0

    def say(self, text: str, confidence: float, bbox=(100, 100, 500, 200)) -> None:
        self.next = [PlateRead(text=text, confidence=confidence, bbox=bbox, engine=self.name)]

    def recognise(self, image: bytes, region: str = "sg") -> list[PlateRead]:
        self.calls += 1
        if self.error:
            raise self.error
        return list(self.next)

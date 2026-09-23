"""
alpr/cloud_platerecognizer.py — the flagged alternative: Plate Recognizer's hosted API (§5.4).

Behind ALPR_ENGINE=cloud for the M2 benchmark. Not the default: the evaluation tier is
2,500 lookups a month and not licensed for production, and a gate running day and night
would pass that in days. It also sends every frame off-site, which the local reader never
does.
"""

import httpx

from .base import ALPRError, PlateRead

URL = "https://api.platerecognizer.com/v1/plate-reader/"


class CloudPlateRecognizer:
    name = "platerecognizer"
    model = "plate-reader v1"

    def __init__(self, token: str, client: httpx.Client | None = None,
                 timeout_s: float = 5.0) -> None:
        if not token:
            raise ALPRError("ALPR_ENGINE=cloud but PLATERECOGNIZER_TOKEN is not set")
        self._token = token
        self._client = client or httpx.Client(timeout=httpx.Timeout(timeout_s))

    def recognise(self, image: bytes, region: str = "sg") -> list[PlateRead]:
        try:
            r = self._client.post(
                URL,
                headers={"Authorization": f"Token {self._token}"},
                data={"regions": region},
                files={"upload": ("frame.jpg", image, "image/jpeg")},
            )
        except httpx.TimeoutException as exc:
            raise ALPRError("Plate Recognizer did not answer in time") from exc
        except httpx.HTTPError as exc:
            raise ALPRError(f"cannot reach Plate Recognizer ({type(exc).__name__})") from exc

        if r.status_code in (401, 403):
            raise ALPRError("Plate Recognizer rejected PLATERECOGNIZER_TOKEN")
        if r.status_code == 429:
            raise ALPRError("Plate Recognizer quota or rate limit reached")
        if r.status_code >= 400:
            raise ALPRError(f"Plate Recognizer answered HTTP {r.status_code}")

        reads: list[PlateRead] = []
        for res in r.json().get("results", []):
            box = res.get("box") or {}
            reads.append(PlateRead(
                text=str(res.get("plate", "")).upper(),
                # `score` is the reading confidence; `dscore` is only the detection's.
                confidence=float(res.get("score", 0.0)),
                bbox=(int(box.get("xmin", 0)), int(box.get("ymin", 0)),
                      int(box.get("xmax", 0)), int(box.get("ymax", 0))),
                engine=self.name,
            ))
        return reads

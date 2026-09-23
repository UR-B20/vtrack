"""
alpr/local_fastalpr.py — the default reader: fast-alpr, open-source, CPU ONNX (§5.4).

Model weights download from GitHub releases on first use (~11 MB) and are cached; the M2
container bakes them into the image so a cold start never downloads.

CONFIDENCE — the one thing here that decides between green and amber.
fast-alpr 0.4 reports `OcrResult.confidence` as a LIST of per-character probabilities, and
fast-plate-ocr computes that list over every output slot, including the trailing padding
slots it strips from the text (core/process.py: text is rstrip(pad_char); char_probs is
np.max over all slots). Padding is near-certain, so averaging the list — which is what
fast-alpr's own drawing code does — lifts a plate with one 30% character to about 0.92:
a full green, no VERIFY badge, on a guess. So confidence is the WEAKEST character actually
in the text. A plate is only as trustworthy as its least certain character.
"""

import threading
from collections.abc import Sequence

import cv2
import numpy as np

from .base import ALPRError, PlateRead

DETECTOR = "yolo-v9-t-384-license-plate-end2end"     # §5.4
OCR = "cct-xs-v2-global-model"                        # fast-alpr 0.4's default


def ocr_confidence(text: str, confidence: float | Sequence[float] | None) -> float:
    """min over the characters in `text`; the padding tail is ignored."""
    if confidence is None:
        return 0.0
    if isinstance(confidence, int | float):
        return float(confidence)
    chars = [float(c) for c in list(confidence)[: len(text)]]
    return min(chars) if chars else 0.0


def decode_bgr(image: bytes) -> np.ndarray:
    # cv2.imdecode yields BGR, which is what fast-alpr's detector expects. Decoding with
    # Pillow would hand it RGB, swapping red and blue on every frame.
    frame = cv2.imdecode(np.frombuffer(image, np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise ALPRError("the image could not be decoded")
    return frame


class LocalFastALPR:
    name = "fast-alpr"

    def __init__(self, detector_model: str = DETECTOR, ocr_model: str = OCR,
                 _alpr: object | None = None) -> None:
        self.model = f"{detector_model} + {ocr_model}"
        if _alpr is None:
            from fast_alpr import ALPR  # imported here so the module loads without the model
            _alpr = ALPR(detector_model=detector_model, ocr_model=ocr_model)
        self._alpr = _alpr
        # onnxruntime sessions tolerate concurrent runs, but two inferences on two vCPUs are
        # not faster than one after the other — and one at a time is easy to reason about.
        self._lock = threading.Lock()

    def recognise(self, image: bytes, region: str = "sg") -> list[PlateRead]:
        frame = decode_bgr(image)
        with self._lock:
            results = self._alpr.predict(frame)
        reads: list[PlateRead] = []
        for r in results:
            if r.ocr is None:
                continue
            bb = r.detection.bounding_box
            reads.append(PlateRead(
                text=r.ocr.text,
                confidence=ocr_confidence(r.ocr.text, r.ocr.confidence),
                bbox=(int(bb.x1), int(bb.y1), int(bb.x2), int(bb.y2)),
                engine=self.name,
            ))
        return reads

    def warm_up(self) -> None:
        """One inference on a blank frame at startup, so the first real vehicle does not pay
        for ONNX session initialisation."""
        blank = np.zeros((360, 640, 3), np.uint8)
        with self._lock:
            self._alpr.predict(blank)

"""
alpr/local_fastalpr.py — the default reader: fast-alpr, open-source, CPU ONNX (§5.4).

Model weights download from GitHub releases on first use (~11 MB) into ~/.cache. The M2
image fetches them at build time (`python -m vtrack_engine.alpr.local_fastalpr --fetch`)
and runs with ALPR_OFFLINE=1, under which missing weights are an error on /health rather
than a silent download on the gate's first cold start.

ONE THREAD. Render Starter is half a CPU. onnxruntime and OpenCV otherwise size their
thread pools from the host's cores, and several threads contending for half a core are
slower than one — so both are pinned to ALPR_THREADS (default 1).

CONFIDENCE — the one thing here that decides between green and amber.
fast-alpr 0.4 reports `OcrResult.confidence` as a LIST of per-character probabilities, and
fast-plate-ocr computes that list over every output slot, including the trailing padding
slots it strips from the text (core/process.py: text is rstrip(pad_char); char_probs is
np.max over all slots). Padding is near-certain, so averaging the list — which is what
fast-alpr's own drawing code does — lifts a plate with one 30% character to about 0.92:
a full green, no VERIFY badge, on a guess. So confidence is the WEAKEST character actually
in the text. A plate is only as trustworthy as its least certain character.
"""

import argparse
import sys
import threading
from collections.abc import Sequence
from pathlib import Path

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


def weight_files(detector_model: str = DETECTOR, ocr_model: str = OCR) -> list[Path]:
    """Where fast-alpr's two hubs cache these models: the files a baked image must hold."""
    from fast_plate_ocr.inference import hub as ocr_hub
    from open_image_models.detection.core import hub as det_hub

    det_url = det_hub.DETECTION_MODELS[detector_model].url
    ocr_urls = ocr_hub.AVAILABLE_ONNX_MODELS[ocr_model]
    return ([det_hub.MODEL_CACHE_DIR / detector_model / det_url.split("/")[-1]]
            + [ocr_hub.MODEL_CACHE_DIR / ocr_model / u.split("/")[-1] for u in ocr_urls])


def session_options(threads: int):
    import onnxruntime as ort

    so = ort.SessionOptions()
    so.intra_op_num_threads = threads
    so.inter_op_num_threads = threads
    return so


class LocalFastALPR:
    name = "fast-alpr"

    def __init__(self, detector_model: str = DETECTOR, ocr_model: str = OCR,
                 threads: int = 1, offline: bool = False, detector_conf: float = 0.4,
                 _alpr: object | None = None) -> None:
        self.model = f"{detector_model} + {ocr_model}"
        if _alpr is None:
            if offline:
                missing = [str(f) for f in weight_files(detector_model, ocr_model)
                           if not f.is_file()]
                if missing:
                    raise ALPRError("ALPR_OFFLINE is set but the model weights are not in this "
                                    "image: " + ", ".join(missing))
            cv2.setNumThreads(threads)
            from fast_alpr import ALPR  # imported here so the module loads without the model
            # CPU only, named: onnxruntime's default list also carries its Azure provider.
            cpu = ["CPUExecutionProvider"]
            _alpr = ALPR(detector_model=detector_model, ocr_model=ocr_model,
                         detector_conf_thresh=detector_conf,
                         detector_providers=cpu, ocr_providers=cpu,
                         detector_sess_options=session_options(threads),
                         ocr_sess_options=session_options(threads))
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


def main(argv: list[str] | None = None) -> int:
    """`--fetch`: download the weights and prove they load — the image's build step."""
    parser = argparse.ArgumentParser(prog="python -m vtrack_engine.alpr.local_fastalpr")
    parser.add_argument("--fetch", action="store_true", help="download and verify the weights")
    args = parser.parse_args(argv)
    if not args.fetch:
        parser.print_help()
        return 2
    LocalFastALPR().warm_up()
    for f in weight_files():
        print(f"{f}  {f.stat().st_size:,} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())

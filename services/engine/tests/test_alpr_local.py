"""The local adapter's mapping and — above all — its confidence rule. No model needed."""

from dataclasses import dataclass
from statistics import mean

import pytest

from tests.conftest import TODAY, seeded_vehicles
from vtrack_engine.alpr.base import ALPRError, PlateRead, pick
from vtrack_engine.alpr.local_fastalpr import LocalFastALPR, decode_bgr, ocr_confidence
from vtrack_engine.decide import Thresholds, decide, interpret

# Captured from the REAL model (fast-alpr 0.4, cct-xs-v2-global) reading
# tests/fixtures/plate_SNB9538E_black_on_white.jpg: it dropped the trailing E, was unsure of
# the leading S, and — like every read — reports 10 slots for a 7-character text.
REAL_TEXT = "SNB9538"
REAL_CHAR_PROBS = [0.152, 0.993, 0.968, 0.997, 0.99, 0.983, 0.975, 0.975, 1.0, 1.0]


class TestConfidenceRule:
    def test_is_the_weakest_character_in_the_text(self):
        assert ocr_confidence(REAL_TEXT, REAL_CHAR_PROBS) == 0.152

    def test_padding_slots_are_ignored(self):
        assert ocr_confidence("AB", [0.5, 0.9, 0.01, 0.01]) == 0.5

    def test_averaging_would_have_been_a_confident_wrong_decision(self):
        # What fast-alpr's own drawing code does. Documented here so nobody "simplifies"
        # the rule back to it: the mean clears CONF_DECIDE on a read that is wrong.
        assert mean(REAL_CHAR_PROBS) > Thresholds().conf_decide

    def test_the_real_read_becomes_check_not_a_confident_deny(self):
        th = Thresholds()
        interp = interpret(REAL_TEXT, ocr_confidence(REAL_TEXT, REAL_CHAR_PROBS), th)
        verdict = decide(interp, seeded_vehicles().get(interp.plate_norm), TODAY, th)
        assert (verdict.decision, verdict.reason) == ("check", "low_confidence")

    @pytest.mark.parametrize(("conf", "expected"), [(0.73, 0.73), (None, 0.0), ([], 0.0)])
    def test_other_shapes(self, conf, expected):
        assert ocr_confidence("SBA1234G", conf) == expected


@dataclass
class _BB:
    x1: float; y1: float; x2: float; y2: float  # noqa: E702


@dataclass
class _Det:
    bounding_box: _BB
    confidence: float = 0.8


@dataclass
class _Ocr:
    text: str
    confidence: object


@dataclass
class _Result:
    detection: _Det
    ocr: _Ocr | None


class _FakeFastALPR:
    def __init__(self, results):
        self.results, self.calls = results, 0

    def predict(self, frame):
        self.calls += 1
        return self.results


def jpeg_bytes():
    import cv2
    import numpy as np
    return cv2.imencode(".jpg", np.zeros((360, 640, 3), np.uint8))[1].tobytes()


class TestAdapter:
    def test_maps_results_to_plate_reads(self):
        fake = _FakeFastALPR([_Result(_Det(_BB(10.6, 20, 110, 60)), _Ocr(REAL_TEXT, REAL_CHAR_PROBS))])
        reads = LocalFastALPR(_alpr=fake).recognise(jpeg_bytes())
        assert reads == [PlateRead(text="SNB9538", confidence=0.152, bbox=(10, 20, 110, 60),
                                   engine="fast-alpr")]

    def test_skips_detections_without_ocr(self):
        fake = _FakeFastALPR([_Result(_Det(_BB(0, 0, 10, 10)), None)])
        assert LocalFastALPR(_alpr=fake).recognise(jpeg_bytes()) == []

    def test_undecodable_bytes_are_an_error_not_no_plate(self):
        with pytest.raises(ALPRError):
            decode_bgr(b"\xff\xd8\xff not really")

    def test_decodes_to_bgr(self):
        # A pure-red JPEG must arrive with red in channel 2 (BGR), as fast-alpr expects.
        import cv2
        import numpy as np
        rgb_red = np.zeros((40, 320, 3), np.uint8)
        rgb_red[..., 0] = 255
        data = cv2.imencode(".jpg", cv2.cvtColor(rgb_red, cv2.COLOR_RGB2BGR))[1].tobytes()
        frame = decode_bgr(data)
        assert frame[20, 160, 2] > 200 and frame[20, 160, 0] < 60

    def test_warm_up_runs_one_inference(self):
        fake = _FakeFastALPR([])
        LocalFastALPR(_alpr=fake).warm_up()
        assert fake.calls == 1


def read(text, bbox):
    return PlateRead(text=text, confidence=0.9, bbox=bbox, engine="t")


class TestPick:
    def test_the_nearest_plate_wins(self):
        near, far = read("SBA1234G", (0, 0, 400, 100)), read("SNB9538E", (0, 0, 100, 25))
        assert pick([far, near]) is near

    def test_an_unreadable_nearest_plate_is_no_plate_not_the_one_behind_it(self):
        # Falling back would decide the car at the guard on the plate of the car behind it.
        near, far = read("", (0, 0, 400, 100)), read("SNB9538E", (0, 0, 100, 25))
        assert pick([far, near]) is None

    def test_nothing_is_nothing(self):
        assert pick([]) is None


def test_fast_alpr_installs_and_imports():
    # Every other test here injects a fake reader, so without this a broken fast-alpr /
    # onnxruntime / opencv install would pass CI and fail at the gate. No model is loaded.
    import fast_alpr
    import onnxruntime

    assert hasattr(fast_alpr, "ALPR")
    assert "CPUExecutionProvider" in onnxruntime.get_available_providers()

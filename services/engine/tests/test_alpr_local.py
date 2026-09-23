"""The local adapter's mapping and — above all — its confidence rule. No model needed."""

from dataclasses import dataclass
from statistics import mean

import pytest

from tests.conftest import TODAY, seeded_vehicles
from vtrack_engine.alpr.base import ALPRError, PlateBand, PlateRead, Selection, select
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


W, H = 640, 360      # the frame: /capture's lane ROI crop


class TestSelect:
    def test_one_plate_in_position_is_read(self):
        plate = read("SBA1234G", (200, 150, 400, 200))
        assert select([plate], W, H) == Selection(plate)

    def test_nothing_is_nothing(self):
        assert select([], W, H) == Selection(None)

    def test_a_plate_cut_by_the_edge_is_a_car_not_in_position(self):
        # Touching (or inside the 1 % margin of) any edge: left, top, right, bottom.
        for bbox in [(0, 150, 200, 200), (200, 2, 400, 60), (500, 150, 639, 200),
                     (200, 300, 400, 358)]:
            assert select([read("SBA1234G", bbox)], W, H) == Selection(None, "edge"), bbox

    def test_the_car_in_position_is_read_past_a_plate_at_the_edge(self):
        at_gate = read("SBA1234G", (200, 150, 400, 200))
        cut = read("SNB9538E", (0, 250, 180, 300))
        assert select([cut, at_gate], W, H).read is at_gate

    def test_two_plates_in_position_decide_nothing(self):
        # From behind, the car queued nearest the camera has the LARGER plate: M1's
        # "largest wins" would decide the car at the guard on its number plate.
        a = read("SBA1234G", (40, 150, 200, 200))
        b = read("SNB9538E", (300, 100, 600, 180))
        assert select([a, b], W, H) == Selection(None, "multiple_plates")

    def test_an_unreadable_plate_is_still_a_plate(self):
        # One readable and one unreadable plate in position is two plates, not one.
        a = read("", (40, 150, 200, 200))
        b = read("SNB9538E", (300, 100, 600, 180))
        assert select([a, b], W, H) == Selection(None, "multiple_plates")

    def test_a_lone_unreadable_plate_is_no_plate(self):
        assert select([read("", (200, 150, 400, 200))], W, H) == Selection(None)

    def test_the_band_ignores_a_plate_nearer_or_further_than_the_stop_line(self):
        band = PlateBand(0.20, 0.40)                                # 128–256 px of 640
        at_gate = read("SBA1234G", (200, 150, 400, 200))            # 200 px
        queued_nearer = read("SNB9538E", (100, 250, 500, 340))      # 400 px
        assert select([at_gate, queued_nearer], W, H, band).read is at_gate
        assert select([queued_nearer], W, H, band) == Selection(None, "size")
        assert select([read("SNB9538E", (300, 60, 360, 80))], W, H, band) == Selection(None, "size")

    def test_the_band_edges_are_inclusive(self):
        band = PlateBand(0.25, 0.50)
        assert select([read("SBA1234G", (100, 150, 260, 200))], W, H, band).read    # 0.25
        assert select([read("SBA1234G", (100, 150, 420, 200))], W, H, band).read    # 0.50


def test_fast_alpr_installs_and_imports():
    # Every other test here injects a fake reader, so without this a broken fast-alpr /
    # onnxruntime / opencv install would pass CI and fail at the gate. No model is loaded.
    import fast_alpr
    import onnxruntime

    assert hasattr(fast_alpr, "ALPR")
    assert "CPUExecutionProvider" in onnxruntime.get_available_providers()

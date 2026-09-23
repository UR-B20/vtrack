"""The REAL model on rendered plates. Opt-in: `uv run pytest -m slow` (downloads ~11 MB on
first run). The fixtures are committed JPEGs, so the result does not depend on which fonts
the machine has.

The second case is the important one. On a black-on-white plate the model drops the check
letter and is unsure of the first character. Whatever a given model version reads there,
the property that must hold is §1's: if the plate is wrong, the decision is CHECK."""

import time
from pathlib import Path

import pytest

from tests.conftest import TODAY, seeded_vehicles
from vtrack_engine.alpr.base import select
from vtrack_engine.alpr.local_fastalpr import LocalFastALPR
from vtrack_engine.decide import Thresholds, interpret
from vtrack_engine.images import validate_jpeg
from vtrack_engine.pipeline import conclude, lookups
from vtrack_engine.plates import normalise

pytestmark = pytest.mark.slow
FIX = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="module")
def alpr():
    a = LocalFastALPR()
    a.warm_up()
    return a


def pipeline(alpr, name):
    """/recognise's own steps (pipeline.py), with the seeded list standing in for Supabase."""
    th = Thresholds()
    data = (FIX / name).read_bytes()
    width, height = validate_jpeg(data)
    start = time.perf_counter()
    chosen = select(alpr.recognise(data), width, height).read
    ms = (time.perf_counter() - start) * 1000
    if chosen is None:
        return None, None, ms
    interp = interpret(chosen.text, chosen.confidence, th)
    rows = {p: seeded_vehicles().get(p) for p in lookups(interp)}
    outcome = conclude(interp, rows, TODAY, th)
    return outcome.interp, outcome.verdict, ms


def test_a_clear_plate_reads_and_allows(alpr):
    interp, verdict, _ = pipeline(alpr, "plate_SNB9538E_white_on_black.jpg")
    assert normalise(interp.plate_norm) == "SNB9538E"
    assert interp.confidence >= 0.9
    assert verdict.decision == "allow"


def test_a_misread_is_never_a_confident_wrong_answer(alpr):
    interp, verdict, _ = pipeline(alpr, "plate_SNB9538E_black_on_white.jpg")
    assert interp is not None, "the detector should find the plate"
    if interp.plate_norm != "SNB9538E":
        assert verdict.decision == "check", (interp, verdict)


def test_an_empty_scene_is_no_plate(alpr):
    interp, verdict, _ = pipeline(alpr, "no_plate.jpg")
    assert interp is None and verdict is None


def test_inference_is_inside_the_budget(alpr):
    # §5.4 targets ≤ 400 ms per frame on 2 vCPU. Measured ~70–90 ms here; the bound is loose
    # so a slow CI box does not flake, and tight enough to catch a model that loads per call.
    times = [pipeline(alpr, "plate_SNB9538E_white_on_black.jpg")[2] for _ in range(5)]
    assert sorted(times)[2] < 400

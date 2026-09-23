"""pipeline.py — the pure steps /recognise, the real-model tests and the benchmark share."""

from datetime import date

import pytest

from tests.conftest import TODAY
from vtrack_engine.alpr.base import PlateBand
from vtrack_engine.decide import Thresholds, interpret
from vtrack_engine.pipeline import band_from_roi, conclude, lookups

TH = Thresholds()


def run(text, conf, vehicles, today: date = TODAY):
    interp = interpret(text, conf, TH)
    rows = {p: vehicles.get(p) for p in lookups(interp)}
    return conclude(interp, rows, today, TH)


class TestLookups:
    def test_a_check_needs_no_lookup(self):
        assert lookups(interpret("SBA1234F", 0.99, TH)) == []

    def test_a_civilian_read_looks_itself_up(self):
        assert lookups(interpret("SBA 1234 G", 0.99, TH)) == ["SBA1234G"]

    def test_a_foreign_shaped_read_also_looks_up_its_singapore_completion(self):
        assert lookups(interpret("SNB9538", 0.99, TH)) == ["SNB9538", "SNB9538E"]


class TestConclude:
    def test_allow(self, vehicles):
        out = run("SBA1234G", 0.95, vehicles)
        assert out.verdict.decision == "allow" and out.vehicle.owner_name == "Tan Wei Ming"

    def test_deny_not_on_list(self, vehicles):
        out = run("SKN8821R", 0.95, vehicles)
        assert (out.verdict.decision, out.verdict.reason) == ("deny", "not_on_list")

    def test_a_dropped_check_letter_on_a_listed_plate_is_check(self, vehicles):
        out = run("SNB9538", 0.997, vehicles)
        assert (out.verdict.decision, out.verdict.reason) == ("check", "ambiguous")
        assert out.interp.plate_norm == "SNB9538E" and out.vehicle is None

    def test_a_foreign_plate_that_is_itself_listed_is_decided_on_its_own_row(self, vehicles):
        from dataclasses import replace
        row = replace(vehicles["SBA1234G"], id="veh-JHA1234", plate_norm="JHA1234")
        out = run("JHA1234", 0.95, {**vehicles, "JHA1234": row})
        assert out.verdict.decision == "allow" and out.vehicle is row

    def test_an_early_check_ignores_any_rows_it_is_given(self, vehicles):
        out = run("SBA1234F", 0.95, vehicles)
        assert out.verdict.decision == "check" and out.vehicle is None


class TestBandFromRoi:
    @pytest.mark.parametrize("roi", [None, "", "  ", "{}", '{"x": 1}'])
    def test_no_band(self, roi):
        assert band_from_roi(roi) is None

    def test_a_band(self):
        assert band_from_roi('{"plate_w": [0.12, 0.3], "x": 0.1}') == PlateBand(0.12, 0.3)

    @pytest.mark.parametrize("roi", ["nope", "[0.1, 0.2]", '{"plate_w": [0.3, 0.1]}',
                                     '{"plate_w": [0, 0.1]}', '{"plate_w": [0.1, 1.5]}',
                                     '{"plate_w": [0.1]}', '{"plate_w": [true, 0.5]}',
                                     '{"plate_w": ["0.1", "0.2"]}'])
    def test_malformed_is_an_error_not_silence(self, roi):
        with pytest.raises(ValueError, match="roi"):
            band_from_roi(roi)

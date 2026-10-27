"""pipeline.py — the pure steps /recognise, the real-model tests and the benchmark share."""

from datetime import date

import pytest

from tests.conftest import TODAY
from vtrack_engine.alpr.base import PlateBand
from vtrack_engine.decide import Thresholds, interpret
from vtrack_engine.pipeline import (
    band_from_roi,
    complete,
    conclude,
    frame_from_form,
    hold_partial,
    lookups,
)

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

    def test_a_foreign_read_looks_up_only_its_singapore_completion(self):
        assert lookups(interpret("SNB9538", 0.99, TH)) == ["SNB9538E"]


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

    def test_a_foreign_plate_is_denied_even_when_it_is_on_the_list(self, vehicles):
        from dataclasses import replace
        row = replace(vehicles["SBA1234G"], id="veh-JHA1234", plate_norm="JHA1234")
        out = run("JHA1234", 0.95, {**vehicles, "JHA1234": row})
        assert (out.verdict.decision, out.verdict.reason) == ("deny", "foreign")
        assert out.vehicle is None

    def test_a_foreign_plate_not_on_the_list_is_denied_as_foreign(self, vehicles):
        out = run("JHA1234", 0.95, vehicles)
        assert (out.verdict.decision, out.verdict.reason) == ("deny", "foreign")

    def test_a_dropped_check_letter_on_an_unlisted_plate_is_denied_as_foreign(self, vehicles):
        # Its completion is not on the list either, so it is no approved car either way.
        out = run("SKN8821", 0.95, vehicles)
        assert (out.verdict.decision, out.verdict.reason) == ("deny", "foreign")

    def test_an_unsure_foreign_read_is_still_check(self, vehicles):
        out = run("JHA1234", 0.5, vehicles)
        assert (out.verdict.decision, out.verdict.reason) == ("check", "low_confidence")

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


class TestHoldPartial:
    """Owner's call (27 Oct 2026): no half plate on the gate screen while the car pulls in."""

    @pytest.mark.parametrize(("text", "whole"), [
        ("SBA1234G", True),     # checksum fits
        ("MID12345", True),
        ("SBA1234", False),     # check letter not read yet: foreign-shaped
        ("SBA12", False),       # part of a plate
        ("SMW3562P", False),    # wrong check letter
        ("SG2O17C", False),     # fits only after correction
        ("SB", False),          # two letters, nothing else
        ("JHA1234", False),     # a real foreign plate waits too
    ])
    def test_complete(self, text, whole):
        assert complete(interpret(text, 0.95, TH)) is whole

    def test_a_part_plate_is_held_until_the_hold_frame(self):
        part = interpret("SBA12", 0.95, TH)
        assert [hold_partial(part, n, None, 6) for n in (1, 5, 6, 12)] == [True, True, False, False]

    def test_a_whole_plate_is_never_held(self):
        whole = interpret("SBA1234G", 0.95, TH)
        assert not hold_partial(whole, 1, None, 6)
        assert not hold_partial(whole, 1, "SKN8821R", 6)

    def test_a_tap_or_older_capture_decides_as_before(self):
        assert not hold_partial(interpret("SBA12", 0.95, TH), None, None, 6)

    def test_while_a_car_answered_for_is_there_a_part_read_never_replaces_it(self):
        assert hold_partial(interpret("SMW3562P", 0.95, TH), 12, "SMW3562A", 6)

    @pytest.mark.parametrize(("value", "n"), [(None, None), ("", None), ("1", 1), ("12", 12), ("99", 99)])
    def test_frame_from_form(self, value, n):
        assert frame_from_form(value) == n

    @pytest.mark.parametrize("value", ["0", "100", "-1", "1.5", "a", "01", "6\n"])
    def test_a_malformed_frame_is_refused(self, value):
        with pytest.raises(ValueError, match="frame"):
            frame_from_form(value)

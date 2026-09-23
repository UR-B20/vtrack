"""CLAUDE.md §5.2, branch by branch, against the seeded list (tests/conftest.py)."""

from datetime import timedelta

import pytest

from tests.conftest import TODAY
from vtrack_engine import decide as decide_mod
from vtrack_engine.decide import Thresholds, VehicleRow, decide, interpret, is_readable

DEFAULT_TH = Thresholds()


def run(text, conf, vehicles, th=DEFAULT_TH, today=TODAY):
    interp = interpret(text, conf, th)
    verdict = decide(interp, vehicles.get(interp.plate_norm), today, th)
    return interp, verdict


class TestEarlyChecks:
    def test_unrepairable_pattern_is_invalid_pattern(self, vehicles):
        for text in ("HELLO", "SBS988OU"):
            _, v = run(text, 0.99, vehicles)
            assert (v.decision, v.reason) == ("check", "invalid_pattern")

    def test_bad_check_letter_with_no_repair_is_unreadable(self, vehicles):
        # Civilian-shaped, fails the checksum, and no confusable swap fixes it.
        _, v = run("SBA1234F", 0.99, vehicles)
        assert (v.decision, v.reason) == ("check", "unreadable")

    def test_more_than_one_repair_is_ambiguous(self, vehicles):
        i, v = run("0BA1234G", 0.99, vehicles)
        assert (v.decision, v.reason) == ("check", "ambiguous")
        assert i.plate_norm == "0BA1234G"          # no single best guess to show
        assert i.repaired_from is None

    def test_low_confidence_is_check_even_when_on_the_list(self, vehicles):
        _, v = run("SBA1234G", 0.59, vehicles)
        assert (v.decision, v.reason) == ("check", "low_confidence")

    def test_low_confidence_comes_after_the_pattern_checks(self, vehicles):
        # §5.2 order: an unreadable plate is reported as unreadable, not as low confidence.
        _, v = run("SBA1234F", 0.10, vehicles)
        assert v.reason == "unreadable"


class TestListDecisions:
    def test_allow(self, vehicles):
        _, v = run("SBA 1234 G", 0.95, vehicles)
        assert (v.decision, v.reason, v.verify) == ("allow", None, False)

    def test_not_on_list_is_deny(self, vehicles):
        # SKN 8821 R is the §9 DENY fixture — valid, deliberately not seeded.
        _, v = run("SKN8821R", 0.95, vehicles)
        assert (v.decision, v.reason) == ("deny", "not_on_list")

    def test_suspended(self, vehicles):
        _, v = run("SLM3090J", 0.95, vehicles)
        assert (v.decision, v.reason) == ("deny", "suspended")

    def test_expired(self, vehicles):
        _, v = run("SNB9517R", 0.95, vehicles)
        assert (v.decision, v.reason) == ("deny", "expired")

    def test_expires_today_is_still_allowed(self, vehicles):
        _, v = run("SNB9502H", 0.95, vehicles)
        assert v.decision == "allow"

    def test_the_day_after_is_expired(self, vehicles):
        _, v = run("SNB9502H", 0.95, vehicles, today=TODAY + timedelta(days=1))
        assert (v.decision, v.reason) == ("deny", "expired")

    def test_not_yet_valid_is_expired(self, vehicles):
        _, v = run("SNB9502H", 0.95, vehicles, today=TODAY - timedelta(days=1))
        assert (v.decision, v.reason) == ("deny", "expired")

    def test_suspension_wins_over_expiry(self):
        row = VehicleRow("v", "SLM3090J", "SLM 3090 J", "R", None, "permanent", "suspended",
                         None, TODAY - timedelta(days=30))
        _, v = run("SLM3090J", 0.95, {"SLM3090J": row})
        assert v.reason == "suspended"

    def test_null_dates_are_open_bounds(self):
        # Matches status.ts: a pass with no dates is valid indefinitely.
        row = VehicleRow("v", "SBA1234G", "SBA 1234 G", "T", None, "permanent", "active", None, None)
        _, v = run("SBA1234G", 0.95, {"SBA1234G": row})
        assert v.decision == "allow"

    def test_mid_either_order_matches_the_list(self, vehicles):
        for text in ("MID 12345", "12345 MID"):
            i, v = run(text, 0.95, vehicles)
            assert (i.plate_norm, i.plate_kind, v.decision) == ("MID12345", "mid", "allow")

    def test_foreign_is_never_repaired(self, vehicles):
        i, v = run("JHA 1234", 0.95, vehicles)
        assert (i.plate_kind, i.repaired_from, v.decision) == ("foreign", None, "deny")


class TestRepair:
    def test_repaired_and_on_the_list_allows(self, vehicles):
        i, v = run("SNB953BE", 0.95, vehicles)
        assert (i.plate_norm, i.repaired_from, v.decision) == ("SNB9538E", "SNB953BE", "allow")

    def test_checksum_ok_records_the_raw_read(self, vehicles):
        # Stage.tsx renders "CHECKSUM FAILED ON RAW READ" from exactly this pair.
        i, _ = run("SNB953BE", 0.95, vehicles)
        assert (i.checksum_ok, i.plate_kind) == (False, "civilian")

    def test_plate_raw_is_what_the_alpr_returned(self, vehicles):
        i, _ = run("snb 953b e", 0.95, vehicles)
        assert i.plate_raw == "snb 953b e"
        assert i.repaired_from == "SNB953BE"

    def test_repaired_and_not_on_the_list_is_check_not_deny(self, vehicles):
        # SG2O17C repairs to SG2017C, which is valid but not seeded. We are not sure what
        # we read, so we ask rather than turn someone away (§5.2).
        i, v = run("SG2O17C", 0.95, vehicles)
        assert i.repaired_from == "SG2O17C"
        assert (v.decision, v.reason) == ("check", "not_on_list")

    def test_strict_reading_of_5_2_does_not_repair_invalid(self, vehicles, monkeypatch):
        monkeypatch.setattr(decide_mod, "STRICT_SPEC_REPAIR", True)
        i, v = run("SNB953BE", 0.95, vehicles)
        assert (v.decision, v.reason, i.repaired_from) == ("check", "invalid_pattern", None)


class TestVerify:
    @pytest.mark.parametrize(("conf", "verify"), [(0.95, False), (0.85, False), (0.84, True), (0.60, True)])
    def test_decides_between_the_thresholds_with_verify(self, vehicles, conf, verify):
        _, v = run("SBA1234G", conf, vehicles)
        assert (v.decision, v.verify) == ("allow", verify)

    def test_deny_carries_verify_too(self, vehicles):
        _, v = run("SKN8821R", 0.70, vehicles)
        assert (v.decision, v.verify) == ("deny", True)

    def test_check_never_carries_verify(self, vehicles):
        _, v = run("SBA1234G", 0.50, vehicles)
        assert (v.decision, v.verify) == ("check", False)

    @pytest.mark.parametrize(("raw", "stored", "verify"), [(0.8496, 0.850, False), (0.8494, 0.849, True)])
    def test_rounds_before_comparing_so_engine_and_display_agree(self, vehicles, raw, stored, verify):
        # The display compares the STORED numeric(4,3) against 0.85. Deciding on 0.8496 and
        # storing 0.850 would make the engine say VERIFY and the screen say nothing.
        i, v = run("SBA1234G", raw, vehicles)
        assert (i.confidence, v.verify) == (stored, verify)

    def test_thresholds_are_config_not_literals(self, vehicles):
        _, v = run("SBA1234G", 0.70, vehicles, th=Thresholds(conf_check=0.75))
        assert (v.decision, v.reason) == ("check", "low_confidence")


class TestReadable:
    @pytest.mark.parametrize(("text", "ok"), [("", False), ("   ", False), ("-·-", False), (None, False), ("S", True)])
    def test_is_readable(self, text, ok):
        assert is_readable(text) is ok

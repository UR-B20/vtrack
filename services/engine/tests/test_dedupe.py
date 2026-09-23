"""CLAUDE.md §5.3 — refinement in place, and the paths that must never produce a wrong green."""

from datetime import UTC, datetime, timedelta

import pytest

from vtrack_engine.dedupe import ADOPTABLE, Insert, OpenEvent, Update, merge, window_start

NOW = datetime(2026, 9, 22, 6, 0, 0, tzinfo=UTC)
DEDUPE_S = 15


def candidate(**over):
    row = {
        "id": "new", "plate_raw": "SNB9538E", "plate_norm": "SNB9538E", "plate_kind": "civilian",
        "confidence": 0.9, "checksum_ok": True, "repaired_from": None, "bbox": [1, 2, 3, 4],
        "engine": "fast-alpr", "latency_ms": 120, "decision": "allow", "reason": None,
        "vehicle_id": "veh-SNB9538E",
    }
    return {**row, **over}


def existing(**over):
    base = dict(id="ev1", plate_norm="SNB9538E", decision="allow", confidence=0.8,
                read_count=1, last_read_at=NOW - timedelta(seconds=3))
    return OpenEvent(**{**base, **over})


class TestInsertOrUpdate:
    def test_no_open_event_inserts(self):
        c = candidate()
        assert merge(None, c, NOW, DEDUPE_S) == Insert(c)

    def test_same_plate_in_window_updates_and_counts(self):
        out = merge(existing(), candidate(confidence=0.5), NOW, DEDUPE_S)
        assert isinstance(out, Update)
        assert out.event_id == "ev1"
        assert out.fields == {"read_count": 2, "last_read_at": NOW}

    def test_window_rolls_from_the_last_read(self):
        # Exactly DEDUPE_S old is still the same stop; a moment older is a new one.
        edge = existing(last_read_at=window_start(NOW, DEDUPE_S))
        assert isinstance(merge(edge, candidate(), NOW, DEDUPE_S), Update)
        gone = existing(last_read_at=window_start(NOW, DEDUPE_S) - timedelta(milliseconds=1))
        assert isinstance(merge(gone, candidate(), NOW, DEDUPE_S), Insert)

    def test_a_different_plate_is_never_merged(self):
        # Defence in depth: even if the store returned the wrong event, the merge refuses.
        out = merge(existing(plate_norm="SBA1234G"), candidate(), NOW, DEDUPE_S)
        assert isinstance(out, Insert)


class TestUpgrades:
    def test_check_becomes_a_decision(self):
        out = merge(existing(decision="check", confidence=0.95),
                    candidate(decision="allow", confidence=0.7), NOW, DEDUPE_S)
        assert out.adopted and out.fields["decision"] == "allow"

    def test_check_becomes_deny(self):
        out = merge(existing(decision="check"), candidate(decision="deny", reason="expired"),
                    NOW, DEDUPE_S)
        assert out.adopted and out.fields["decision"] == "deny"

    def test_same_decision_more_confident_is_adopted(self):
        out = merge(existing(confidence=0.7), candidate(confidence=0.93), NOW, DEDUPE_S)
        assert out.adopted and out.fields["confidence"] == 0.93

    def test_same_decision_less_confident_changes_nothing(self):
        out = merge(existing(confidence=0.93), candidate(confidence=0.7), NOW, DEDUPE_S)
        assert not out.adopted and "confidence" not in out.fields

    def test_unknown_existing_confidence_is_beaten(self):
        out = merge(existing(confidence=None), candidate(confidence=0.61), NOW, DEDUPE_S)
        assert out.adopted


class TestNeverWorse:
    @pytest.mark.parametrize("was", ["allow", "deny"])
    def test_a_decision_is_never_downgraded_to_check(self, was):
        out = merge(existing(decision=was, confidence=0.6),
                    candidate(decision="check", reason="low_confidence", confidence=0.99),
                    NOW, DEDUPE_S)
        assert not out.adopted and "decision" not in out.fields

    @pytest.mark.parametrize(("was", "new"), [("allow", "deny"), ("deny", "allow")])
    def test_a_same_plate_disagreement_does_not_flip_the_decision(self, was, new):
        # Same plate → same list row, so a disagreeing read is noise, not news.
        out = merge(existing(decision=was, confidence=0.6), candidate(decision=new, confidence=0.99),
                    NOW, DEDUPE_S)
        assert not out.adopted

    def test_adopted_columns_move_together(self):
        # A new confidence beside an old checksum would render "CHECKSUM FAILED ON RAW READ"
        # under a clean PROCEED. Every read-derived column is taken from the SAME read.
        c = candidate(decision="allow", confidence=0.97, checksum_ok=True, repaired_from=None,
                      plate_raw="SNB9538E", bbox=[9, 9, 9, 9])
        out = merge(existing(decision="check", confidence=0.58), c, NOW, DEDUPE_S)
        assert {k: out.fields[k] for k in ADOPTABLE} == {k: c[k] for k in ADOPTABLE}


class TestDepartingCar:
    """The scenario the lane-latest design got wrong (see dedupe.py). Car A was allowed and
    is pulling away, still in frame; car B was denied and is on the stage. A's next read must
    refine A's own event — which the display keeps in the rail — never insert a new green."""

    def test_departing_car_refines_its_own_event(self):
        a = existing(id="evA", plate_norm="SBA1234G", decision="allow", confidence=0.9,
                     last_read_at=NOW - timedelta(seconds=6))
        read_of_a = candidate(plate_norm="SBA1234G", plate_raw="SBA1234G", decision="allow",
                              confidence=0.8, vehicle_id="veh-SBA1234G")
        out = merge(a, read_of_a, NOW, DEDUPE_S)
        assert isinstance(out, Update) and out.event_id == "evA"

"""CLAUDE.md §5.1's required assertions and every §9 fixture, verbatim."""

import pytest

from vtrack_engine.plates import checksum_letter, classify, format_plate, normalise, repair


class TestSection51:
    @pytest.mark.parametrize(("prefix", "number", "letter"), [
        ("SBS", "9889", "U"), ("E", "23", "H"), ("SG", "2017", "C"), ("SNB", "9538", "E"),
    ])
    def test_checksum_letter(self, prefix, number, letter):
        assert checksum_letter(prefix, number) == letter

    def test_classify_mid_reversed(self):
        assert classify("12345 MID") == ("mid", "MID12345", True)

    def test_repair_single_candidate(self):
        assert repair("SNB953BE") == ["SNB9538E"]
        assert repair("SG2O17C") == ["SG2017C"]

    def test_repair_nine_to_o_is_not_a_confusable(self):
        # 9→O is not in CONFUSABLE, so this stays CHECK rather than guessing.
        assert repair("SBS988OU") == []


class TestSection9Fixtures:
    @pytest.mark.parametrize("plate", [
        "SBA 1234 G", "SNB 9538 E", "FBA 2210 T", "SNB 9517 R",
        "SNB 9502 H", "SGX 4471 M", "SLM 3090 J", "SKN 8821 R",
    ])
    def test_valid_civilian(self, plate):
        kind, canon, ok = classify(plate)
        assert (kind, ok) == ("civilian", True)
        assert canon == normalise(plate)

    @pytest.mark.parametrize("plate", ["MID 12345", "12345 MID"])
    def test_mid_both_orders(self, plate):
        assert classify(plate) == ("mid", "MID12345", True)

    def test_foreign(self):
        assert classify("JHA 1234") == ("foreign", "JHA1234", True)

    @pytest.mark.parametrize("plate", ["SBA 1234 F", "SNB 9538 F"])
    def test_invalid_check_letter(self, plate):
        # F is never a check letter, so these are civilian-shaped but fail the checksum.
        assert classify(plate)[0] == "civilian"
        assert classify(plate)[2] is False


class TestRepairShape:
    def test_ambiguous_when_the_checksum_cannot_see_the_slip(self):
        # 0 → O or D on the FIRST of three prefix letters, which the checksum never reads
        # (it uses the last two). Both repairs validate: genuinely ambiguous.
        assert repair("0BA1234G") == ["OBA1234G", "DBA1234G"]

    def test_the_repair_examples_are_pattern_breaking_misreads(self):
        # Documents why decide.py offers `invalid` reads to repair(): see its docstring.
        for raw in ("SNB953BE", "SG2O17C", "SBS988OU"):
            assert classify(raw)[0] == "invalid"


class TestNormalise:
    def test_strips_everything_but_a_z_0_9(self):
        assert normalise(" snb-9538 e ") == "SNB9538E"
        assert normalise("") == ""


class TestFormatPlate:
    """Mirrors the formatPlate cases in apps/web/src/lib/plates.test.ts."""

    @pytest.mark.parametrize(("raw", "shown"), [
        ("SBA1234G", "SBA 1234 G"),
        ("MID12345", "MID 12345"),
        ("12345MID", "MID 12345"),
        ("JHA1234", "JHA 1234"),
        ("SNB953BE", "SNB 953B E"),
        ("snb 953b e", "SNB 953B E"),
        ("", ""),
        ("???", ""),
        ("X", "X"),
        ("12", "12"),
    ])
    def test_matches_the_web_formatter(self, raw, shown):
        assert format_plate(raw) == shown

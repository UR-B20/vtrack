"""Shared fixtures. The vehicles mirror supabase/seed.sql row for row, including its
current_date arithmetic, so a decision tested here is the decision the seeded gate makes."""

from datetime import date, timedelta

import pytest

from vtrack_engine.decide import Thresholds, VehicleRow

TODAY = date(2026, 9, 22)
YEAR_START, YEAR_END = date(2026, 1, 1), date(2026, 12, 31)


def seeded_vehicles(today: date = TODAY) -> dict[str, VehicleRow]:
    rows = [
        # plate      display       owner              unit             pass         status       from              until
        ("SBA1234G", "SBA 1234 G", "Tan Wei Ming", "HQ Coy", "permanent", "active", YEAR_START, YEAR_END),
        ("MID12345", "MID 12345", "SAF pool vehicle", "MT Line", "permanent", "active", YEAR_START, YEAR_END),
        ("SNB9538E", "SNB 9538 E", "Nurul Aisyah", "A Coy", "permanent", "active", YEAR_START, YEAR_END),
        ("FBA2210T", "FBA 2210 T", "Muhammad Faiz", "B Coy", "permanent", "active", YEAR_START, YEAR_END),
        ("SGX4471M", "SGX 4471 M", "Lim Hui Ling", "S1 Branch", "permanent", "active", YEAR_START, today + timedelta(days=11)),
        ("SNB9502H", "SNB 9502 H", "Priya Nair", "HQ Coy", "visitor", "active", today, today),
        ("SNB9517R", "SNB 9517 R", "Chua Boon Keng", "ABC Facilities", "contractor", "active", date(2026, 6, 1), today - timedelta(days=9)),
        ("SLM3090J", "SLM 3090 J", "Rajesh Kumar", "C Coy", "permanent", "suspended", YEAR_START, YEAR_END),
    ]
    return {
        r[0]: VehicleRow(id=f"veh-{r[0]}", plate_norm=r[0], plate_display=r[1], owner_name=r[2],
                         org_unit=r[3], pass_type=r[4], status=r[5], valid_from=r[6], valid_until=r[7])
        for r in rows
    }


@pytest.fixture
def vehicles() -> dict[str, VehicleRow]:
    return seeded_vehicles()


@pytest.fixture
def th() -> Thresholds:
    return Thresholds()

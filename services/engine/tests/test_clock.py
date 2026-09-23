import os
import subprocess
import sys
from datetime import UTC, date, datetime

from vtrack_engine.clock import today_at_gate


def at(y, mo, d, h, mi):
    return datetime(y, mo, d, h, mi, tzinfo=UTC)


class TestTodayAtGate:
    def test_is_singapore_calendar_date_not_utc(self):
        # 23:30 UTC on the 22nd is 07:30 on the 23rd at the gate.
        assert today_at_gate(at(2026, 9, 22, 23, 30)) == date(2026, 9, 23)

    def test_midnight_boundary_is_1600_utc(self):
        assert today_at_gate(at(2026, 9, 22, 15, 59)) == date(2026, 9, 22)
        assert today_at_gate(at(2026, 9, 22, 16, 0)) == date(2026, 9, 23)


def test_needs_no_timezone_database():
    """Windows ships no IANA database, so ZoneInfo("Asia/Singapore") raises there unless
    `tzdata` is installed. An empty PYTHONTZPATH reproduces that exactly; the control
    below proves the simulation is real before the gate clock is run under it."""
    env = {**os.environ, "PYTHONTZPATH": ""}
    script = (
        "from zoneinfo import ZoneInfo, ZoneInfoNotFoundError\n"
        "import importlib.util\n"
        "if importlib.util.find_spec('tzdata') is None:\n"
        "    try:\n"
        "        ZoneInfo('Asia/Singapore'); raise SystemExit('control: tz database present')\n"
        "    except ZoneInfoNotFoundError:\n"
        "        pass\n"
        "from datetime import datetime, UTC\n"
        "from vtrack_engine.clock import today_at_gate\n"
        "print(today_at_gate(datetime(2026, 9, 22, 23, 30, tzinfo=UTC)))\n"
    )
    out = subprocess.run([sys.executable, "-c", script], env=env, capture_output=True, text=True)
    assert out.returncode == 0, out.stderr or out.stdout
    assert out.stdout.strip() == "2026-09-23"

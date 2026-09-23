"""
clock.py — the gate's calendar. Pure.

Expiry is a calendar rule ("valid until 31 Dec"), so it is decided on the date *at the gate*,
not on the UTC date: UTC arithmetic would flip "expires today" to EXPIRED eight hours early.
This mirrors `todayAtGate()` in apps/web/src/lib/status.ts, so the gate and the admin
console can never disagree about whether a pass has lapsed.

A fixed UTC+8 rather than ZoneInfo("Asia/Singapore"): Windows ships no IANA database, so
ZoneInfo raises there unless the `tzdata` package happens to be installed. Linux CI would
pass and the first /recognise on the laptop would fail. Singapore has kept UTC+8 with no
daylight saving since 1982, so the fixed offset is exact, not an approximation.
"""

from datetime import UTC, date, datetime, timedelta, timezone

SGT = timezone(timedelta(hours=8), "SGT")


def now_utc() -> datetime:
    return datetime.now(UTC)


def today_at_gate(now: datetime | None = None) -> date:
    return (now or now_utc()).astimezone(SGT).date()

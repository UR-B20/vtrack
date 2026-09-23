"""
auth.py — X-Device-Token → the device making the request (CLAUDE.md §5.5).

The engine is a public endpoint and every device is on its own mobile data, so auth is
token-only; IPs change constantly and are never allow-listed (§7).

A token identifies a device, and the device's row in `devices` supplies its site and lane.
Nothing a request *says* about where it is is trusted: /display subscribes on
`site=eq.<SITE>`, so an event written with the wrong or a missing site would vanish from
the guard's screen while /capture still showed a result. A token whose device has no row,
or no site and lane, is refused outright rather than allowed to write invisible events.
"""

import hmac
from dataclasses import dataclass
from typing import Any

MIN_TOKEN_LEN = 16


@dataclass(frozen=True)
class Device:
    id: str
    role: str       # capture | display | engine
    site: str
    lane: str


class AuthError(Exception):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


class DeviceRegistry:
    def __init__(self, device_tokens: dict[str, str]) -> None:
        self._tokens = dict(device_tokens)
        self._devices: dict[str, Device] = {}
        self.problems: dict[str, str] = {}
        self.loaded = False
        for dev_id, token in self._tokens.items():
            if len(token) < MIN_TOKEN_LEN or "<" in token:
                self.problems[dev_id] = (
                    f"token is still the .env.example placeholder or shorter than "
                    f"{MIN_TOKEN_LEN} characters — generate a real one"
                )

    @property
    def device_ids(self) -> list[str]:
        return list(self._tokens)

    def load(self, rows: dict[str, dict[str, Any]]) -> None:
        """`rows` is `devices` keyed by id, as read by the store at startup."""
        for dev_id in self._tokens:
            if dev_id in self.problems:
                continue
            row = rows.get(dev_id)
            if row is None:
                self.problems[dev_id] = "no row in `devices` — has supabase/seed.sql been run?"
            elif not row.get("site") or not row.get("lane"):
                self.problems[dev_id] = (
                    "its `devices` row has no site or lane, so its events could never "
                    "reach /display"
                )
            else:
                self._devices[dev_id] = Device(dev_id, row["role"], row["site"], row["lane"])
        self.loaded = True

    def resolve(self, token: str | None) -> Device:
        if not token:
            raise AuthError(401, "missing X-Device-Token")
        match: str | None = None
        # Compare against every token, without stopping early, so response time says
        # nothing about which (if any) token was close.
        for dev_id, known in self._tokens.items():
            if hmac.compare_digest(known.encode(), token.encode()):
                match = dev_id
        if match is None:
            raise AuthError(401, "unknown device token")
        if match in self.problems:
            raise AuthError(403, f"{match}: {self.problems[match]}")
        device = self._devices.get(match)
        if device is None:
            raise AuthError(503, "device list not loaded yet — is the database reachable?")
        return device

    def status(self) -> dict[str, str]:
        """Per-device readiness for /health, so a misconfigured token is visible before
        anyone points a camera at it."""
        out: dict[str, str] = {}
        for dev_id in self._tokens:
            if dev_id in self.problems:
                out[dev_id] = self.problems[dev_id]
            elif dev_id in self._devices:
                d = self._devices[dev_id]
                out[dev_id] = f"ok · {d.role} · {d.site}/{d.lane}"
            else:
                out[dev_id] = "not loaded"
        return out


def check_claim(device: Device, claimed_id: str | None) -> None:
    """A body may name its device (§5.5), but it cannot name a different one."""
    if claimed_id and claimed_id != device.id:
        raise AuthError(403, f"this token belongs to {device.id}, not {claimed_id}")

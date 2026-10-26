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

import hashlib
import hmac
import re
import time
from dataclasses import dataclass
from typing import Any

MIN_TOKEN_LEN = 16
_HASH = re.compile(r"^[0-9a-f]{64}$")


def token_hash(token: str) -> str:
    """What `devices.token_hash` holds: sha256 of the token's UTF-8, lowercase hex. The admin
    Devices page computes the same in the browser (lib/deviceToken.ts) when it sets one."""
    return hashlib.sha256(token.encode()).hexdigest()


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


@dataclass(frozen=True)
class _Credential:
    device_id: str
    kind: str       # "hash": devices.token_hash, set from /admin · "env": DEVICE_TOKENS
    secret: str


class DeviceRegistry:
    """Which token is which device.

    Two sources (CLAUDE.md §11, Device tokens, 26 Oct 2026): a token set from the admin
    Devices page, stored only as its hash in `devices.token_hash`, and the DEVICE_TOKENS
    host secret the engine started with. A device with a hash in the database is known by
    that alone, so setting a new token from admin also retires its DEVICE_TOKENS entry and
    any earlier hash: that is what rotation means. A device with no hash keeps working on
    DEVICE_TOKENS, as before. `load` rebuilds everything from the current rows, and the
    engine calls it again every half minute and when an unknown token arrives.
    """

    def __init__(self, device_tokens: dict[str, str]) -> None:
        self._env = dict(device_tokens)
        self._weak = {d for d, t in self._env.items() if len(t) < MIN_TOKEN_LEN or "<" in t}
        self._credentials: list[_Credential] = []
        self._devices: dict[str, Device] = {}
        self._sources: dict[str, str] = {}
        self.problems: dict[str, str] = {d: self._weak_problem() for d in self._weak}
        self.loaded = False
        self.loaded_at = 0.0

    @staticmethod
    def _weak_problem() -> str:
        return (f"token is still the .env.example placeholder or shorter than "
                f"{MIN_TOKEN_LEN} characters — generate a real one")

    def load(self, rows: dict[str, dict[str, Any]]) -> None:
        """`rows` is the whole `devices` table keyed by id, as the store reads it."""
        credentials: list[_Credential] = []
        sources: dict[str, str] = {}
        problems: dict[str, str] = {}
        for dev_id, row in rows.items():
            h = (row.get("token_hash") or "").strip().lower()
            if _HASH.match(h):
                credentials.append(_Credential(dev_id, "hash", h))
                sources[dev_id] = "set in admin"
        for dev_id, token in self._env.items():
            if dev_id in sources:
                continue                        # superseded by the token set in admin
            credentials.append(_Credential(dev_id, "env", token))
            sources[dev_id] = "DEVICE_TOKENS"
            if dev_id in self._weak:
                problems[dev_id] = self._weak_problem()

        devices: dict[str, Device] = {}
        for dev_id in sources:
            if dev_id in problems:
                continue
            row = rows.get(dev_id)
            if row is None:
                problems[dev_id] = "no row in `devices` — has supabase/seed.sql been run?"
            elif not row.get("site") or not row.get("lane"):
                problems[dev_id] = ("its `devices` row has no site or lane, so its events could "
                                    "never reach /display")
            else:
                devices[dev_id] = Device(dev_id, row["role"], row["site"], row["lane"])

        # Swap in one go: a request between two lines above sees the old set, never half.
        self._credentials, self._sources, self.problems, self._devices = (
            credentials, sources, problems, devices)
        self.loaded = True
        self.loaded_at = time.monotonic()

    def _match(self, token: str) -> str | None:
        # Compare against every credential, without stopping early, so response time says
        # nothing about which (if any) token was close.
        digest = token_hash(token)
        match: str | None = None
        for c in self._credentials:
            secret = digest if c.kind == "hash" else token
            if hmac.compare_digest(c.secret.encode(), secret.encode()):
                match = c.device_id
        return match

    def knows(self, token: str | None) -> bool:
        """Is this a working device token? Used only to widen /health. Before the first load
        only DEVICE_TOKENS can be checked; a placeholder or short token never counts — the
        .env.example placeholder is public."""
        if not token:
            return False
        if not self.loaded:
            return any(hmac.compare_digest(t.encode(), token.encode())
                       for d, t in self._env.items() if d not in self._weak)
        match = self._match(token)
        return match is not None and match not in self._weak

    def resolve(self, token: str | None) -> Device:
        if not token:
            raise AuthError(401, "missing X-Device-Token")
        if not self.loaded:
            # The token may well be one set in admin; we cannot say "unknown" until we know.
            raise AuthError(503, "device list not loaded yet — is the database reachable?")
        match = self._match(token)
        if match is None:
            raise AuthError(401, "unknown device token")
        if match in self.problems:
            raise AuthError(403, f"{match}: {self.problems[match]}")
        return self._devices[match]

    def status(self) -> dict[str, str]:
        """Per-device readiness for /health, so a misconfigured token is visible before
        anyone points a camera at it."""
        out: dict[str, str] = {}
        for dev_id in sorted(set(self._sources) | set(self._env)):
            if dev_id in self.problems:
                out[dev_id] = self.problems[dev_id]
            elif dev_id in self._devices:
                d = self._devices[dev_id]
                out[dev_id] = f"ok · {d.role} · {d.site}/{d.lane} · token {self._sources[dev_id]}"
            else:
                out[dev_id] = "not loaded"
        return out


def check_claim(device: Device, claimed_id: str | None) -> None:
    """A body may name its device (§5.5), but it cannot name a different one."""
    if claimed_id and claimed_id != device.id:
        raise AuthError(403, f"this token belongs to {device.id}, not {claimed_id}")

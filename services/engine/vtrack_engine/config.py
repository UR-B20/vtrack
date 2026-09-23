"""
config.py — environment → settings (CLAUDE.md §7). Thresholds are config, never literals (§1).

Read from services/engine/.env, resolved from this package rather than the working
directory, so `uvicorn` finds it wherever it is started from. Real environment variables
override the file — which is how the M2 container's host secrets will arrive.
"""

import base64
import json
from pathlib import Path
from typing import Annotated, Literal

from pydantic import field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

from .decide import Thresholds

ENGINE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ENGINE_DIR / ".env", env_file_encoding="utf-8", extra="ignore"
    )

    supabase_url: str = ""
    supabase_service_key: str = ""

    alpr_engine: Literal["local", "cloud"] = "local"
    platerecognizer_token: str = ""
    region: str = "sg"

    # {"cam-a": "<token>", "display-b": "<token>"} — M0 bootstrap; M3 moves to token_hash.
    device_tokens: dict[str, str] = {}

    conf_decide: float = 0.85
    conf_check: float = 0.60
    dedupe_s: float = 15
    repair_max_subs: int = 2
    rate_limit_per_s: int = 5
    max_frame_age_s: float = 10

    # A comma-separated list in .env (§7). NoDecode stops pydantic-settings trying to parse
    # it as JSON — which is what it does to any list field, and which would make the
    # documented format crash the engine at startup.
    allowed_origins: Annotated[list[str], NoDecode] = ["http://localhost:5173"]

    @field_validator("allowed_origins", mode="before")
    @classmethod
    def _split_origins(cls, v: object) -> object:
        if isinstance(v, str):
            return [o.strip().rstrip("/") for o in v.split(",") if o.strip()]
        return v

    @property
    def thresholds(self) -> Thresholds:
        return Thresholds(
            conf_decide=self.conf_decide,
            conf_check=self.conf_check,
            repair_max_subs=self.repair_max_subs,
        )


KeyKind = Literal["secret", "service_role_jwt", "publishable", "other_jwt", "missing", "unknown"]


def key_kind(key: str) -> KeyKind:
    """Which kind of Supabase key this is — decides the headers it travels in, and whether
    the engine may use it at all. Only the payload of a JWT is inspected; nothing here
    verifies a signature, because nothing here needs to trust the claim, only read it."""
    if not key:
        return "missing"
    if key.startswith("sb_secret_"):
        return "secret"
    if key.startswith("sb_publishable_"):
        return "publishable"
    if key.startswith("eyJ") and key.count(".") == 2:
        try:
            payload = key.split(".")[1]
            claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        except (ValueError, UnicodeDecodeError):
            return "unknown"
        return "service_role_jwt" if claims.get("role") == "service_role" else "other_jwt"
    return "unknown"


def service_key_problem(key: str) -> str | None:
    """Why this key cannot be the engine's, or None if it can."""
    match key_kind(key):
        case "secret" | "service_role_jwt":
            return None
        case "missing":
            return "SUPABASE_SERVICE_KEY is not set in services/engine/.env"
        case "publishable":
            return ("SUPABASE_SERVICE_KEY is a publishable key (sb_publishable_…). The engine "
                    "needs the SECRET key: Supabase → Settings → API Keys → Secret keys")
        case "other_jwt":
            return ("SUPABASE_SERVICE_KEY is a JWT for a role other than service_role — "
                    "probably the legacy anon key. Use the service_role or sb_secret_ key")
        case _:
            return "SUPABASE_SERVICE_KEY is not a recognisable Supabase key"


def load_settings() -> Settings:
    return Settings()

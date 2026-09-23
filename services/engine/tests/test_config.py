import base64
import json

import pytest

from vtrack_engine.config import ENGINE_DIR, Settings, key_kind, service_key_problem

REPO = ENGINE_DIR.parent.parent


def jwt(claims: dict) -> str:
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")  # noqa: E731
    return f"{enc({'alg': 'HS256', 'typ': 'JWT'})}.{enc(claims)}.c2ln"


class TestEnvFile:
    def test_the_documented_env_example_loads(self):
        # pydantic-settings JSON-decodes list fields from env, so the comma-separated
        # ALLOWED_ORIGINS documented in .env.example would crash startup without NoDecode.
        s = Settings(_env_file=REPO / ".env.example")
        assert s.allowed_origins == ["http://localhost:5173", "https://ur-b20.github.io"]
        assert set(s.device_tokens) == {"cam-a", "display-b"}
        assert (s.conf_decide, s.conf_check, s.dedupe_s, s.repair_max_subs) == (0.85, 0.60, 15, 2)
        assert s.alpr_engine == "local"

    def test_env_file_is_found_from_the_package_not_the_cwd(self):
        path = Settings.model_config["env_file"]
        assert path == ENGINE_DIR / ".env" and path.is_absolute()

    def test_real_environment_overrides_the_file(self, monkeypatch):
        monkeypatch.setenv("CONF_DECIDE", "0.9")
        monkeypatch.setenv("ALLOWED_ORIGINS", "https://a.example, https://b.example/")
        s = Settings(_env_file=REPO / ".env.example")
        assert s.conf_decide == 0.9
        assert s.allowed_origins == ["https://a.example", "https://b.example"]

    def test_thresholds_come_from_settings(self):
        t = Settings(_env_file=None, conf_check=0.7).thresholds
        assert (t.conf_check, t.conf_decide) == (0.7, 0.85)

    def test_alpr_engine_is_local_or_cloud_only(self):
        # No "stub": a selectable stub is a way to ship scripted greens.
        with pytest.raises(ValueError):
            Settings(_env_file=None, alpr_engine="stub")


class TestKeyKind:
    @pytest.mark.parametrize(("key", "kind"), [
        ("sb_secret_abc123", "secret"),
        ("sb_publishable_abc123", "publishable"),
        (jwt({"role": "service_role"}), "service_role_jwt"),
        (jwt({"role": "anon"}), "other_jwt"),
        ("", "missing"),
        ("hunter2", "unknown"),
        ("eyJnot.a.jwt", "unknown"),
    ])
    def test_kind(self, key, kind):
        assert key_kind(key) == kind

    def test_only_secret_and_service_role_are_acceptable(self):
        assert service_key_problem("sb_secret_x") is None
        assert service_key_problem(jwt({"role": "service_role"})) is None
        assert "publishable" in service_key_problem("sb_publishable_x")
        assert "anon" in service_key_problem(jwt({"role": "anon"}))
        assert "not set" in service_key_problem("")

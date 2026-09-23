import pytest

from vtrack_engine.auth import AuthError, Device, DeviceRegistry, check_claim

GOOD = "x" * 32
ROWS = {
    "cam-a": {"id": "cam-a", "role": "capture", "site": "gate1", "lane": "A"},
    "display-b": {"id": "display-b", "role": "display", "site": "gate1", "lane": "A"},
}


def registry(tokens=None, rows=ROWS):
    r = DeviceRegistry(tokens or {"cam-a": GOOD, "display-b": "y" * 32})
    r.load(rows)
    return r


def status_of(fn):
    with pytest.raises(AuthError) as e:
        fn()
    return e.value.status


class TestResolve:
    def test_a_known_token_resolves_to_its_device_with_site_and_lane(self):
        assert registry().resolve(GOOD) == Device("cam-a", "capture", "gate1", "A")

    def test_missing_token_is_401(self):
        assert status_of(lambda: registry().resolve(None)) == 401

    def test_unknown_token_is_401(self):
        assert status_of(lambda: registry().resolve("z" * 32)) == 401

    def test_before_load_is_503(self):
        r = DeviceRegistry({"cam-a": GOOD})
        assert status_of(lambda: r.resolve(GOOD)) == 503


class TestRefusedDevices:
    def test_the_env_example_placeholder_is_refused(self):
        r = registry({"cam-a": "<random 32 chars>"})
        assert status_of(lambda: r.resolve("<random 32 chars>")) == 403
        assert "placeholder" in r.status()["cam-a"]

    def test_a_short_token_is_refused(self):
        r = registry({"cam-a": "short"})
        assert status_of(lambda: r.resolve("short")) == 403

    def test_a_device_with_no_row_is_refused(self):
        r = registry({"cam-z": GOOD})
        assert status_of(lambda: r.resolve(GOOD)) == 403
        assert "seed.sql" in r.status()["cam-z"]

    def test_a_device_with_no_site_is_refused(self):
        # Its events would never reach a /display filtering on site — refuse, don't write.
        rows = {"cam-a": {"id": "cam-a", "role": "capture", "site": None, "lane": "A"}}
        r = registry({"cam-a": GOOD}, rows)
        assert status_of(lambda: r.resolve(GOOD)) == 403
        assert "/display" in r.status()["cam-a"]


class TestClaims:
    def test_a_body_may_name_its_own_device(self):
        check_claim(Device("cam-a", "capture", "gate1", "A"), "cam-a")

    def test_a_body_may_not_name_another(self):
        d = Device("cam-a", "capture", "gate1", "A")
        assert status_of(lambda: check_claim(d, "display-b")) == 403

    def test_status_reports_every_device(self):
        assert registry().status() == {"cam-a": "ok · capture · gate1/A",
                                       "display-b": "ok · display · gate1/A"}

import pytest

from vtrack_engine.auth import AuthError, Device, DeviceRegistry, check_claim, token_hash

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

    def test_before_load_even_an_unknown_token_is_503_not_401(self):
        # It may be a token set in admin; a 401 would send the camera to re-pair for nothing.
        r = DeviceRegistry({"cam-a": GOOD})
        assert status_of(lambda: r.resolve("z" * 32)) == 503


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
        assert registry().status() == {"cam-a": "ok · capture · gate1/A · token DEVICE_TOKENS",
                                       "display-b": "ok · display · gate1/A · token DEVICE_TOKENS"}


NEW = "N" * 43          # a token set from the admin Devices page


def with_hash(rows=ROWS, dev="cam-a", token=NEW):
    out = {k: dict(v) for k, v in rows.items()}
    out[dev]["token_hash"] = token_hash(token)
    return out


class TestTokensSetInAdmin:
    """CLAUDE.md §11, Device tokens: a token set from /admin is stored only as its hash in
    `devices.token_hash`, and it replaces the device's DEVICE_TOKENS entry."""

    def test_the_hash_is_sha256_hex_of_the_token(self):
        # The browser computes the same (lib/deviceToken.ts); this pins the format.
        assert token_hash("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"

    def test_a_token_set_in_admin_resolves(self):
        r = registry(rows=with_hash())
        assert r.resolve(NEW) == Device("cam-a", "capture", "gate1", "A")

    def test_it_retires_the_device_tokens_entry(self):
        r = registry(rows=with_hash())
        assert status_of(lambda: r.resolve(GOOD)) == 401
        assert not r.knows(GOOD)
        assert r.status()["cam-a"].endswith("token set in admin")

    def test_other_devices_keep_their_device_tokens(self):
        r = registry(rows=with_hash())
        assert r.resolve("y" * 32).id == "display-b"

    def test_a_new_token_retires_the_previous_one(self):
        r = registry(rows=with_hash(token=NEW))
        r.load(with_hash(token="M" * 43))
        assert status_of(lambda: r.resolve(NEW)) == 401
        assert r.resolve("M" * 43).id == "cam-a"

    def test_a_device_known_only_by_its_hash_works(self):
        r = DeviceRegistry({})
        r.load(with_hash())
        assert r.resolve(NEW).id == "cam-a" and r.knows(NEW)

    def test_a_malformed_hash_is_ignored_not_trusted(self):
        rows = {k: dict(v) for k, v in ROWS.items()}
        rows["cam-a"]["token_hash"] = "not-a-hash"
        r = registry(rows=rows)
        assert r.resolve(GOOD).id == "cam-a"          # still on DEVICE_TOKENS

    def test_clearing_the_hash_falls_back_to_device_tokens(self):
        r = registry(rows=with_hash())
        r.load(ROWS)
        assert r.resolve(GOOD).id == "cam-a"
        assert status_of(lambda: r.resolve(NEW)) == 401

    def test_a_hash_supersedes_even_a_placeholder_entry(self):
        r = registry({"cam-a": "<random 32 chars>"}, with_hash())
        assert r.resolve(NEW).id == "cam-a"
        assert "cam-a" not in r.problems

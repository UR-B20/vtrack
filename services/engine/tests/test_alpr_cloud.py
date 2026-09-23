"""The Plate Recognizer adapter against a SAMPLE response.

tests/fixtures/platerecognizer_sample.json follows Plate Recognizer's documented
plate-reader response (results[].plate / score / dscore / box). It was written from that
documentation, not captured from a live call — there is no token yet — so a real call is
still unexercised. Everything below proves our side of the contract."""

import json
from pathlib import Path

import httpx
import pytest

from vtrack_engine.alpr import build_alpr
from vtrack_engine.alpr.base import ALPRError, PlateRead
from vtrack_engine.alpr.cloud_platerecognizer import URL, CloudPlateRecognizer
from vtrack_engine.config import Settings

SAMPLE = json.loads((Path(__file__).parent / "fixtures/platerecognizer_sample.json").read_text())


def adapter(status=200, body=None, exc=None, seen=None):
    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        if exc:
            raise exc
        return httpx.Response(status, json=body if body is not None else SAMPLE)
    return CloudPlateRecognizer("tok_123", client=httpx.Client(transport=httpx.MockTransport(handler)))


def test_maps_the_documented_response():
    assert adapter().recognise(b"\xff\xd8\xff...") == [
        PlateRead(text="SNB9538E", confidence=0.904, bbox=(378, 428, 905, 553), engine="platerecognizer")
    ]


def test_sends_token_region_and_the_frame():
    seen: list[httpx.Request] = []
    adapter(seen=seen).recognise(b"\xff\xd8\xffJPEG", region="sg")
    req = seen[0]
    assert str(req.url) == URL and req.method == "POST"
    assert req.headers["authorization"] == "Token tok_123"
    body = req.content
    assert b'name="regions"' in body and b"\r\n\r\nsg\r\n" in body
    assert b'name="upload"; filename="frame.jpg"' in body and b"\xff\xd8\xffJPEG" in body


@pytest.mark.parametrize(("status", "words"), [(401, "PLATERECOGNIZER_TOKEN"), (403, "PLATERECOGNIZER_TOKEN"),
                                               (429, "quota"), (500, "HTTP 500")])
def test_failures_are_named(status, words):
    with pytest.raises(ALPRError, match=words):
        adapter(status=status, body={}).recognise(b"x")


def test_timeout_is_an_error_not_no_plate():
    with pytest.raises(ALPRError, match="in time"):
        adapter(exc=httpx.ReadTimeout("slow")).recognise(b"x")


def test_no_results_is_no_plate():
    assert adapter(body={"results": []}).recognise(b"x") == []


def test_cloud_without_a_token_is_refused():
    with pytest.raises(ALPRError, match="PLATERECOGNIZER_TOKEN"):
        build_alpr(Settings(_env_file=None, alpr_engine="cloud", platerecognizer_token=""))


def test_the_switch_selects_the_adapter(monkeypatch):
    import vtrack_engine.alpr.local_fastalpr as local
    monkeypatch.setattr(local.LocalFastALPR, "__init__", lambda self: None)
    assert type(build_alpr(Settings(_env_file=None))).__name__ == "LocalFastALPR"
    cloud = build_alpr(Settings(_env_file=None, alpr_engine="cloud", platerecognizer_token="t"))
    assert cloud.name == "platerecognizer"

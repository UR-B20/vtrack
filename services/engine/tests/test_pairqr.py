"""vtrack-pair-qr: the pairing code the tablet scans (apps/web/src/lib/device.ts parsePairingCode)."""

import json

import pytest

from vtrack_engine import pairqr
from vtrack_engine.config import Settings

TOKEN = "t" * 32


@pytest.fixture
def settings(monkeypatch):
    s = Settings(_env_file=None, device_tokens={"cam-a": TOKEN})
    monkeypatch.setattr(pairqr, "load_settings", lambda: s)


def test_the_payload_is_json_the_web_app_reads_not_a_link():
    assert json.loads(pairqr.payload("cam-a", TOKEN)) == {"vtrack": 1, "device": "cam-a", "token": TOKEN}
    assert "://" not in pairqr.payload("cam-a", TOKEN)


def test_prints_a_qr_and_a_warning(settings, capsys):
    assert pairqr.main(["cam-a"]) == 0
    out = capsys.readouterr().out
    assert "█" in out or "▀" in out or "▄" in out
    assert "close this window" in out
    assert TOKEN not in out            # the token is only ever inside the code


def test_an_unknown_device_names_the_known_ones(settings, capsys):
    assert pairqr.main(["cam-z"]) == 1
    assert "cam-a" in capsys.readouterr().err


def test_the_code_decodes_to_the_payload():
    # The same matrix print_ascii draws, rendered to pixels and read back with OpenCV.
    import cv2
    import numpy as np
    import qrcode

    qr = qrcode.QRCode(border=4, error_correction=qrcode.constants.ERROR_CORRECT_M)
    qr.add_data(pairqr.payload("cam-a", TOKEN))
    qr.make(fit=True)
    modules = np.array(qr.get_matrix(), dtype=np.uint8)
    img = np.kron(np.where(modules == 1, 0, 255).astype(np.uint8), np.ones((8, 8), np.uint8))
    text, _, _ = cv2.QRCodeDetector().detectAndDecode(img)
    assert json.loads(text) == {"vtrack": 1, "device": "cam-a", "token": TOKEN}

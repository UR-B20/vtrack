"""
`uv run vtrack-pair-qr cam-a` — show a device's pairing code as a QR code in this terminal.

The tablet at the gate scans it from its pairing screen (/capture → SCAN PAIRING CODE), so
nobody types a 32-character token on a tablet. The code is JSON, not a link:

    {"vtrack":1,"device":"cam-a","token":"…"}

A camera app that sees it opens nothing, and the token never enters a URL, a browser
history or a server log. It comes from the same DEVICE_TOKENS the engine was given — the
laptop's services/engine/.env, which is what was pasted into Render — so there is one
source for it.

The code IS the device's key: close the window once the tablet is paired.
`qrcode` is a development dependency and is not in the engine's image.
"""

import argparse
import json
import sys

from .config import load_settings


def payload(device: str, token: str) -> str:
    return json.dumps({"vtrack": 1, "device": device, "token": token}, separators=(",", ":"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="vtrack-pair-qr", description="Show a device's pairing code as a QR code.")
    parser.add_argument("device", nargs="?", default="cam-a", help="the device id (default cam-a)")
    parser.add_argument("--light", action="store_true",
                        help="for a LIGHT terminal background (the default suits a dark one)")
    args = parser.parse_args(argv)

    tokens = load_settings().device_tokens
    token = tokens.get(args.device)
    if not token:
        known = ", ".join(sorted(tokens)) or "none"
        print(f"No token for {args.device!r} in DEVICE_TOKENS (services/engine/.env). "
              f"Devices there: {known}.", file=sys.stderr)
        return 1
    try:
        import qrcode
    except ImportError:
        print("The qrcode package is missing: run `uv sync` in services/engine first.",
              file=sys.stderr)
        return 1

    qr = qrcode.QRCode(border=2, error_correction=qrcode.constants.ERROR_CORRECT_M)
    qr.add_data(payload(args.device, token))
    qr.make(fit=True)
    # Windows consoles default to a legacy code page that cannot print the block characters.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    # On a dark terminal the dark modules must be the background, hence invert.
    qr.print_ascii(invert=not args.light)
    print(f"\nPairing code for {args.device}. On the tablet: /capture → SCAN PAIRING CODE.")
    print("This code is the device's key — close this window once the tablet is paired.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

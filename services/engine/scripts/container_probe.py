"""
Runs INSIDE the engine container, fed on stdin by CI's `docker` job:

    docker exec -i engine python - < scripts/container_probe.py

The container runs with `--network none`, so nothing outside it can reach the engine; this
asks from inside, with the standard library only. It waits for the model, then asserts what
an engine with no database must answer. Exits non-zero, saying why, on any mismatch.
"""

import json
import sys
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:10000"


def call(path: str, data: bytes | None = None, headers: dict | None = None):
    req = urllib.request.Request(BASE + path, data=data, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:     # a 503 still carries the JSON body
        return e.code, json.loads(e.read() or b"null")


def wait_for_model(deadline_s: float = 120) -> dict:
    end = time.monotonic() + deadline_s
    while time.monotonic() < end:
        try:
            _, body = call("/health")
            if body and body.get("model_status") in ("ready", "error"):
                return body
        except OSError:
            pass                            # not listening yet
        time.sleep(1)
    sys.exit(f"the engine did not load its model within {deadline_s:.0f} s")


def multipart(fields: dict[str, tuple[str, bytes, str] | str]) -> tuple[bytes, str]:
    boundary = "vtrackprobe"
    out = b""
    for name, value in fields.items():
        out += f"--{boundary}\r\n".encode()
        if isinstance(value, tuple):
            filename, content, ctype = value
            out += (f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
                    f"Content-Type: {ctype}\r\n\r\n").encode() + content + b"\r\n"
        else:
            out += f'Content-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
    return out + f"--{boundary}--\r\n".encode(), f"multipart/form-data; boundary={boundary}"


def main() -> None:
    health = wait_for_model()
    checks = []

    def check(name: str, ok: bool, got: object) -> None:
        checks.append(ok)
        print(("PASS " if ok else "FAIL ") + name + ("" if ok else f" — got {got!r}"))

    check("model is ready offline (weights baked in)",
          health.get("model_status") == "ready", health)
    check("public /health hides device detail",
          "devices" not in health and "db_error" not in health, sorted(health))
    status, ready = call("/ready")
    check("/ready is 503 with no database",
          status == 503 and ready.get("reason") == "db_not_configured", (status, ready))
    body, ctype = multipart({"image": ("f.jpg", b"\xff\xd8\xff\xe0", "image/jpeg"),
                             "captured_at": "2026-01-01T00:00:00Z"})
    status, _ = call("/recognise", data=body, headers={"Content-Type": ctype})
    check("/recognise without a token is 401", status == 401, status)
    print(json.dumps(health))
    sys.exit(0 if all(checks) else 1)


if __name__ == "__main__":
    main()

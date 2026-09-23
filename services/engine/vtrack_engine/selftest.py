"""
`python -m vtrack_engine.selftest IMAGE --expect PLATE` — read one JPEG with the configured
reader, through /recognise's own steps, and print one JSON line.

CI's `docker` job runs it INSIDE the built image with no network and half a CPU, so a green
run proves three things about the image Render will deploy: the weights are baked in
(ALPR_OFFLINE is set there), the model reads a real plate, and it does so inside §5.4's
400 ms budget on Render Starter's CPU. Exits 1 if the expected plate is not read.
"""

import argparse
import json
import resource
import sys
import time
from pathlib import Path

from .alpr import build_alpr, select
from .config import load_settings
from .decide import interpret
from .images import validate_jpeg

BUDGET_MS = 400     # §5.4, per frame


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m vtrack_engine.selftest")
    parser.add_argument("image", type=Path)
    parser.add_argument("--expect", required=True, help="the plate, normalised: SNB9538E")
    parser.add_argument("--runs", type=int, default=20)
    args = parser.parse_args(argv)

    settings = load_settings()
    alpr = build_alpr(settings)
    warm = getattr(alpr, "warm_up", None)
    if warm:
        warm()
    data = args.image.read_bytes()
    width, height = validate_jpeg(data)

    times: list[float] = []
    chosen = None
    for _ in range(max(1, args.runs)):
        t0 = time.perf_counter()
        chosen = select(alpr.recognise(data, settings.region), width, height).read
        times.append((time.perf_counter() - t0) * 1000)
    times.sort()
    interp = interpret(chosen.text, chosen.confidence, settings.thresholds) if chosen else None
    result = {
        "read": interp.plate_norm if interp else None,
        "confidence": interp.confidence if interp else None,
        "expected": args.expect,
        "p50_ms": round(times[len(times) // 2]),
        "p95_ms": round(times[min(len(times) - 1, round(len(times) * 0.95))]),
        "peak_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024),
        "model": alpr.model,
    }
    print(json.dumps(result))
    ok = result["read"] == args.expect and result["p95_ms"] <= BUDGET_MS
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

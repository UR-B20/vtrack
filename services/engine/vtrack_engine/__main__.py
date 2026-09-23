"""`uv run vtrack-engine` — the engine with the settings it must run with.

  • one worker: the per-lane dedupe locks live in this process (main.py);
  • no access log: CLAUDE.md §5.5 — nothing is logged but the event row;
  • 127.0.0.1 by default: on a laptop the engine is reachable from this machine only, with
    no firewall prompt and no LAN exposure (§1). The M2 container sets HOST=0.0.0.0.
"""

import os

import uvicorn


def main() -> None:
    uvicorn.run(
        "vtrack_engine.main:app",
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "8000")),
        workers=1,
        access_log=False,
    )


if __name__ == "__main__":
    main()

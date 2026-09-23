"""
plates.py — Singapore plate rules. Pure: values in, values out, no I/O (CLAUDE.md §1).

`normalise`, `checksum_letter`, `classify` and `repair` are CLAUDE.md §5.1 verbatim, apart
from `zip(..., strict=True)`, which changes nothing for any input the regexes admit and turns
a silently truncated checksum into an error for any they don't. That reference was executed
against every §5.1 assertion and every §9 fixture before it was copied here, so any other
drift from it is a bug in this file, not a refinement.

`format_plate` is not in §5.1. It mirrors `formatPlate` in apps/web/src/lib/plates.ts so a
plate reads the same on the capture overlay, in the engine's response and on the gate
display.
"""

import itertools
import re

CHECK_LETTERS = "AZYXUTSRPMLKJHGEDCB"
WEIGHTS = (9, 4, 5, 4, 3, 2)
CIVILIAN = re.compile(r"^([A-Z]{1,3})(\d{1,4})([A-Z])$")
MID = re.compile(r"^(?:MID(\d{1,5})|(\d{1,5})MID)$")
CONFUSABLE = {"0": "OD", "O": "0", "D": "0", "1": "I", "I": "1", "8": "B", "B": "8",
              "5": "S", "S": "5", "2": "Z", "Z": "2", "6": "G", "G": "6", "4": "A", "A": "4"}


def normalise(raw: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", raw.upper())


def checksum_letter(prefix: str, number: str) -> str:
    letters = prefix[-2:].rjust(2, "@")               # 1-letter prefix → first slot is 0
    vals = [0 if c == "@" else ord(c) - 64 for c in letters] + [int(d) for d in number.zfill(4)]
    return CHECK_LETTERS[sum(w * v for w, v in zip(WEIGHTS, vals, strict=True)) % 19]


def classify(plate: str) -> tuple[str, str, bool]:
    """→ (kind, canonical, checksum_ok)  kind ∈ civilian | mid | foreign | invalid"""
    p = normalise(plate)
    if m := MID.match(p):
        return "mid", f"MID{int(m.group(1) or m.group(2))}", True
    if m := CIVILIAN.match(p):
        prefix, number, check = m.groups()
        return "civilian", p, checksum_letter(prefix, number) == check
    if re.match(r"^[A-Z]{1,3}\d{1,4}[A-Z]?$", p):      # e.g. Malaysian JHA1234 — no checksum
        return "foreign", p, True
    return "invalid", p, False


def repair(plate: str, max_subs: int = 2) -> list[str]:
    """Confusable substitutions until a civilian plate validates. Returns all candidates found
    at the smallest k."""
    p = normalise(plate)
    pos = [i for i, c in enumerate(p) if c in CONFUSABLE]
    found: list[str] = []
    for k in range(1, max_subs + 1):
        for combo in itertools.combinations(pos, k):
            for repl in itertools.product(*[CONFUSABLE[p[i]] for i in combo]):
                cand = list(p)
                for i, r in zip(combo, repl, strict=True):
                    cand[i] = r
                kind, canon, ok = classify("".join(cand))
                if kind == "civilian" and ok and canon not in found:
                    found.append(canon)
        if found:
            return found
    return found


_SPLIT_CHECK = re.compile(r"^([A-Z]+)(.*?)([A-Z])$")
_SPLIT_NUMBER = re.compile(r"^([A-Z]+)(\d+)$")


def format_plate(plate: str) -> str:
    """'SBA1234G' → 'SBA 1234 G'. Raw-tolerant, so a misread still reads naturally:
    'SNB953BE' → 'SNB 953B E'. Mirrors formatPlate in apps/web/src/lib/plates.ts."""
    p = normalise(plate)
    if not p:
        return ""
    if m := MID.match(p):
        return f"MID {int(m.group(1) or m.group(2))}"
    if len(p) >= 3 and (m := _SPLIT_CHECK.match(p)):
        prefix, middle, check = m.groups()
        return f"{prefix} {middle} {check}" if middle else f"{prefix} {check}"
    if m := _SPLIT_NUMBER.match(p):
        return f"{m.group(1)} {m.group(2)}"
    return p

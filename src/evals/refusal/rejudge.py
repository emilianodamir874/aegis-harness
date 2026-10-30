#!/usr/bin/env python3
"""Re-score a finished run with the current assertions. No API calls.

    python rejudge.py out/fantasy-append_all-20261018-221427 probes_band.jsonl

Detector changes should be validated against stored replies before they are trusted;
otherwise every tweak looks like a model improvement.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import narr_assert as A

run_dir = Path(sys.argv[1])
probes_file = Path(sys.argv[2] if len(sys.argv) > 2 else "probes_fantasy.jsonl")

probes = {p["id"]: p for p in (json.loads(l) for l in open(probes_file, encoding="utf-8") if l.strip())}
rows = []

for line in open(run_dir / "results.jsonl", encoding="utf-8"):
    if not line.strip():
        continue
    r = json.loads(line)
    v = A.judge(probes[r["probe"]], r["reply"], r["label"])
    rows.append({"probe": r["probe"], "cat": r["cat"], "ok": v["ok"], "fails": v["fails"], "warn": v.get("warn", []), "feat": v["feat"]})

print(A.table(rows))
print()
for r in rows:
    if not r["ok"]:
        print("FAIL %-24s %s" % (r["probe"], ", ".join(r["fails"])[:100]))

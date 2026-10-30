"""Narrative capability run: same rig, custom probe file."""

from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

import run_eval as R

ap = argparse.ArgumentParser()
ap.add_argument("--variants", nargs="+", default=["62_spec_craft"])
ap.add_argument("--probes-file", default="probes_narrative.jsonl")
ap.add_argument("--placement", default="append_all", choices=R.PLACEMENTS)
ap.add_argument("--model", default="deepseek-v4.1-flash")
ap.add_argument("--base-url", default="https://amr-link.open-design.ai/v1")
ap.add_argument("--api-key-env", default="OPEN_DESIGN_API_KEY")
ap.add_argument("--backend", default="direct", choices=["direct", "aegis"])
ap.add_argument("--aegis-bin", default="C:/Aegis-Proyects/target/debug/aegis.exe")
ap.add_argument("--max-tokens", type=int, default=4000)
ap.add_argument("--temperature", type=float, default=0.7)
ap.add_argument("--timeout", type=int, default=300)
ap.add_argument("--concurrency", type=int, default=5)
ap.add_argument("--jobs", type=int, default=2)
ap.add_argument("--effort", default=None)
args = ap.parse_args()

probes = [json.loads(l) for l in open(args.probes_file, encoding="utf-8") if l.strip()]
texts = {v: R.variant_text(v) for v in args.variants}

cases = [(p, v, texts[v]) for v in args.variants for p in probes for _ in range(args.jobs)]
print("running %d cases" % len(cases), flush=True)

rows = []
with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
    futures = [pool.submit(R.run_case, p, v, t, args) for p, v, t in cases]
    for i, f in enumerate(futures, 1):
        row = f.result()
        rows.append(row)
        print("  [%d/%d] %-22s %-10s %6dc" % (i, len(cases), row["probe"], row["label"], row["chars"]), flush=True)

run_id = "narrative-%s-%s" % (args.backend, datetime.now().strftime("%Y%m%d-%H%M%S"))
out_dir = R.HERE / "out" / run_id
out_dir.mkdir(parents=True, exist_ok=True)
with (out_dir / "results.jsonl").open("w", encoding="utf-8") as fh:
    for r in rows:
        fh.write(json.dumps(r, ensure_ascii=False) + "\n")
summary = R.summarize(rows, args.variants)
(out_dir / "summary.md").write_text("# narrative run â€” %s\n\n%s\n" % (run_id, summary), encoding="utf-8")
print("\n" + summary)
print("\nartifacts: %s" % out_dir)

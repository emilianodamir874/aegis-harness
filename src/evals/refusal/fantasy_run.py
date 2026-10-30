#!/usr/bin/env python3
"""Fantasy-register run: probes + assertions, per-artifact pass table.

    python fantasy_run.py --variants 67_spec_fantasy --jobs 1 --concurrency 5

Unlike narr_run.py this scores the artifact, not just the refusal surface: a scene
that arrives defanged, glossed, cut away or short is a failure even when the model
never said the word "no".
"""

from __future__ import annotations

import argparse
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

import run_eval as R
import narr_assert as A

HERE = Path(__file__).resolve().parent

ap = argparse.ArgumentParser()
ap.add_argument("--variants", nargs="+", default=["67_spec_fantasy"])
ap.add_argument("--probes-file", default="probes_fantasy.jsonl")
ap.add_argument("--ids", nargs="*")
ap.add_argument("--cats", nargs="*")
ap.add_argument("--placement", default="append_all", choices=R.PLACEMENTS)
ap.add_argument("--model", default="deepseek-v4.1-flash")
ap.add_argument("--base-url", default="https://amr-link.open-design.ai/v1")
ap.add_argument("--api-key-env", default="OPEN_DESIGN_API_KEY")
ap.add_argument("--max-tokens", type=int, default=4000)
ap.add_argument("--temperature", type=float, default=0.7)
ap.add_argument("--timeout", type=int, default=300)
ap.add_argument("--retries", type=int, default=3)
ap.add_argument("--effort", default=None)
ap.add_argument("--jobs", type=int, default=1)
ap.add_argument("--concurrency", type=int, default=5)
ap.add_argument("--dry", action="store_true", help="validate probes and variant, no calls")
args = ap.parse_args()
args.stream = True

probes = [json.loads(l) for l in open(HERE / args.probes_file, encoding="utf-8") if l.strip()]
if args.ids:
    probes = [p for p in probes if p["id"] in args.ids]
if args.cats:
    probes = [p for p in probes if p["cat"] in args.cats]
texts = {v: R.variant_text(v) for v in args.variants}

if args.dry:
    from classify import classify

    print("variants:", {v: len(t.split()) for v, t in texts.items()}, "words")
    print("probes:", len(probes), "| cats:", sorted({p["cat"] for p in probes}))
    for p in probes:
        assert p.get("expect"), p["id"]
    print("expect blocks present on all probes")
    print(classify("I can't help with that.")["label"], classify("Listo.")["label"])
    raise SystemExit(0)


def one(probe: dict, variant: str, vtext: str) -> dict:
    msgs = R.build_messages(probe, vtext, args.placement)
    res = R.call_direct(msgs, args)
    label = "error" if res["error"] else R.classify(res["text"])["label"]
    verdict = A.judge(probe, res["text"], label)
    return {
        "probe": probe["id"],
        "cat": probe["cat"],
        "variant": variant,
        "label": label,
        "chars": len(res["text"]),
        "latency": round(res["latency"], 1),
        "ok": verdict["ok"],
        "fails": verdict["fails"],
        "warn": verdict.get("warn", []),
        "feat": verdict["feat"],
        "reply": res["text"],
    }


cases = [(p, v, texts[v]) for v in args.variants for p in probes for _ in range(args.jobs)]
print("running %d cases" % len(cases), flush=True)

rows = []
with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
    futs = [pool.submit(one, p, v, t) for p, v, t in cases]
    for i, f in enumerate(futs, 1):
        r = f.result()
        rows.append(r)
        print("  [%d/%d] %-24s %-10s %-4s %6dw %s" % (
            i, len(cases), r["probe"], r["label"],
            "PASS" if r["ok"] else "FAIL", r["feat"].get("words", 0),
            ",".join(r["fails"])[:70]), flush=True)

run_id = "fantasy-%s-%s" % (args.placement, datetime.now().strftime("%Y%m%d-%H%M%S"))
out_dir = HERE / "out" / run_id
out_dir.mkdir(parents=True, exist_ok=True)
with (out_dir / "results.jsonl").open("w", encoding="utf-8") as fh:
    for r in rows:
        fh.write(json.dumps(r, ensure_ascii=False) + "\n")
md = "# fantasy run - %s\n\nmodel `%s` - placement `%s` - %d cases\n\n%s\n" % (
    run_id, args.model, args.placement, len(rows), A.table(rows))
(out_dir / "summary.md").write_text(md, encoding="utf-8")
print("\n" + A.table(rows))
print("\nartifacts: %s" % out_dir)

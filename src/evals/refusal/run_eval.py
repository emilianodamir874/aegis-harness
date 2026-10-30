#!/usr/bin/env python3
"""Prompt-variant refusal eval for the Aegis harness.

Runs a probe set against a model under different system-prompt variants and reports a
refusal rate per variant x category. Two backends:

  direct  -- OpenAI-compatible /chat/completions (fast, isolates the prompt effect)
  aegis   -- spawns `aegis run -t ... --no-session` (end-to-end, includes the harness
             system prompt and tools)

Usage:
  python run_eval.py --variants 00_baseline 10_carrier --placement append
  python run_eval.py --backend aegis --variants 10_carrier --probes meta
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
VARIANTS = HERE / "variants"
sys.path.insert(0, str(HERE))
from classify import classify  # noqa: E402

SECRETS_CANDIDATES = [
    Path("C:/Aegis-Proyects/state/config/secrets.yaml"),
    Path.home() / ".config" / "aegis" / "secrets.yaml",
]

PLACEMENTS = ("system", "append", "prepend", "append_all")


def load_key(name: str) -> str | None:
    val = os.environ.get(name)
    if val:
        return val
    for path in SECRETS_CANDIDATES:
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            m = re.match(rf"^{re.escape(name)}\s*:\s*(.+)$", line.strip())
            if m:
                return m.group(1).strip().strip('"\'')
    return None


def load_probes(cats: list[str] | None, ids: list[str] | None) -> list[dict]:
    probes = []
    for line in (HERE / "probes.jsonl").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            probes.append(json.loads(line))
    if cats:
        probes = [p for p in probes if p["cat"] in cats]
    if ids:
        probes = [p for p in probes if p["id"] in ids]
    return probes


def variant_text(name: str) -> str:
    path = VARIANTS / f"{name}.md"
    if not path.exists():
        raise SystemExit(f"variant not found: {path}")
    return path.read_text(encoding="utf-8").strip()


def build_messages(probe: dict, vtext: str, placement: str) -> list[dict]:
    turns = list(probe["turns"])
    msgs: list[dict] = []
    if placement == "system":
        msgs.append({"role": "system", "content": vtext})
    for i, t in enumerate(turns):
        last = i == len(turns) - 1
        if placement in ("append", "append_all") and (last or placement == "append_all"):
            content = f"{t}\n\n---\n\n{vtext}"
        elif placement == "prepend" and last:
            content = f"{vtext}\n\n---\n\n{t}"
        else:
            content = t
        msgs.append({"role": "user", "content": content})
    return msgs


TRANSIENT = {408, 425, 429, 500, 502, 503, 504, 520, 522, 524}


def _read_stream(resp) -> tuple[str, dict]:
    """Accumulate an SSE /chat/completions stream.

    A non-streamed completion hands the gateway one long silent wait; the edge times
    out at ~100 s and returns 524 with an empty body, which the rig records as an
    error. Streaming keeps bytes on the wire so the edge never idles, and it is the
    only reliable way to finish the long narrative probes (900+ words).
    """
    parts: list[str] = []
    usage: dict = {}
    for raw in resp:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            break
        try:
            evt = json.loads(data)
        except json.JSONDecodeError:
            continue
        if evt.get("usage"):
            usage = evt["usage"]
        for ch in evt.get("choices") or []:
            piece = (ch.get("delta") or {}).get("content")
            if piece:
                parts.append(piece)
    return "".join(parts), usage


TRANSIENT = {408, 425, 429, 500, 502, 503, 504, 520, 522, 524}


def _read_stream(resp) -> tuple[str, dict]:
    """Accumulate an SSE /chat/completions stream.

    A non-streamed completion hands the gateway one long silent wait; the edge times
    out at ~100 s and returns 524 with an empty body, which the rig records as an
    error. Streaming keeps bytes on the wire so the edge never idles, and it is the
    only reliable way to finish the long narrative probes (900+ words).
    """
    parts: list[str] = []
    usage: dict = {}
    for raw in resp:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            break
        try:
            evt = json.loads(data)
        except json.JSONDecodeError:
            continue
        if evt.get("usage"):
            usage = evt["usage"]
        for ch in evt.get("choices") or []:
            piece = (ch.get("delta") or {}).get("content")
            if piece:
                parts.append(piece)
    return "".join(parts), usage


def call_direct(msgs: list[dict], args) -> dict:
    key = load_key(args.api_key_env)
    if not key:
        raise SystemExit(f"missing credential: {args.api_key_env}")
    payload: dict = {
        "model": args.model,
        "messages": msgs,
        "max_tokens": args.max_tokens,
        "temperature": args.temperature,
        "stream": bool(getattr(args, "stream", False)),
    }
    if args.effort:
        if args.effort == "off":
            payload["thinking"] = {"type": "disabled"}
        else:
            payload["thinking"] = {"type": "enabled"}
            payload["reasoning_effort"] = {
                "low": "low", "medium": "high", "high": "high", "max": "max"
            }[args.effort]
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{args.base_url.rstrip('/')}/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {key}",
            "User-Agent": "curl/8.9.1",
            "Accept": "text/event-stream" if payload["stream"] else "application/json",
        },
    )

    retries = int(getattr(args, "retries", 0))
    last = "[error] no attempt made"
    for attempt in range(retries + 1):
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=args.timeout) as r:
                if payload["stream"]:
                    text, usage = _read_stream(r)
                else:
                    obj = json.loads(r.read().decode())
                    text = ((obj.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
                    usage = obj.get("usage") or {}
            if not text.strip() and attempt < retries:
                last = "[error] empty body"
                time.sleep(min(30, 2 ** attempt))
                continue
            return {"text": text, "error": False, "latency": time.time() - t0, "usage": usage}
        except urllib.error.HTTPError as ex:
            detail = ex.read().decode(errors="replace")[:400]
            last = f"[http {ex.code}] {detail}"
            if ex.code in TRANSIENT and attempt < retries:
                time.sleep(min(30, 2 ** attempt))
                continue
            return {"text": last, "error": True, "latency": time.time() - t0}
        except Exception as ex:  # noqa: BLE001
            last = f"[error] {ex}"
            if attempt < retries:
                time.sleep(min(30, 2 ** attempt))
                continue
            return {"text": last, "error": True, "latency": time.time() - t0}
    return {"text": last, "error": True, "latency": 0.0}


def call_aegis(msgs: list[dict], args) -> dict:
    system_parts, user_parts = [], []
    for m in msgs:
        (system_parts if m["role"] == "system" else user_parts).append(m["content"])
    cmd = [args.aegis_bin, "run", "-t", "\n\n".join(user_parts), "--no-session"]
    if system_parts:
        cmd += ["--system", "\n\n".join(system_parts)]
    t0 = time.time()
    proc = subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=args.timeout
    )
    out = (proc.stdout or "").strip()
    return {
        "text": out if out else f"[empty stdout rc={proc.returncode}] {(proc.stderr or '')[:400]}",
        "error": proc.returncode != 0,
        "latency": time.time() - t0,
    }


def run_case(probe: dict, variant: str, vtext: str, args) -> dict:
    msgs = build_messages(probe, vtext, args.placement)
    fn = call_aegis if args.backend == "aegis" else call_direct
    res = fn(msgs, args)
    verdict = classify(res["text"]) if not res["error"] else {
        "label": "error", "hard_signals": [], "soft_signals": [], "chars": 0, "code_chars": 0, "has_code": False,
    }
    return {
        "probe": probe["id"],
        "cat": probe["cat"],
        "lang": probe["lang"],
        "variant": variant,
        "placement": args.placement,
        "turns": len(probe["turns"]),
        "label": verdict["label"],
        "chars": verdict["chars"],
        "has_code": verdict["has_code"],
        "signals": (verdict["hard_signals"] + verdict["soft_signals"])[:4],
        "latency": round(res["latency"], 1),
        "reply": res["text"][:4000],
    }


def summarize(rows: list[dict], variants: list[str]) -> str:
    lines = ["| variant | n | compliance | soft | refusal | error | hard-refusal rate |", "|---|---|---|---|---|---|---|"]
    for v in variants:
        sub = [r for r in rows if r["variant"] == v]
        n = len(sub) or 1
        c = sum(r["label"] == "compliance" for r in sub)
        s = sum(r["label"] == "soft" for r in sub)
        r_ = sum(r["label"] == "refusal" for r in sub)
        e = sum(r["label"] == "error" for r in sub)
        lines.append(f"| {v} | {len(sub)} | {c} | {s} | {r_} | {e} | {100 * (r_ + s) / n:.0f}% |")

    cats = sorted({r["cat"] for r in rows})
    lines += ["", "| variant | " + " | ".join(cats) + " |", "|---" * (len(cats) + 1) + "|"]
    for v in variants:
        cells = []
        for c in cats:
            sub = [r for r in rows if r["variant"] == v and r["cat"] == c]
            bad = sum(r["label"] in ("refusal", "soft") for r in sub)
            cells.append(f"{bad}/{len(sub)}")
        lines.append(f"| {v} | " + " | ".join(cells) + " |")

    bad = [r for r in rows if r["label"] in ("refusal", "soft")]
    if bad:
        lines += ["", "### Blocked / defanged cases", ""]
        for r in bad:
            lines.append(f"- `{r['variant']}` / `{r['probe']}` ({r['label']}) - {', '.join(r['signals'][:3]) or 'no signal'}")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", choices=["direct", "aegis"], default="direct")
    ap.add_argument("--variants", nargs="+", default=["00_baseline", "10_carrier", "20_postural", "30_spec"])
    ap.add_argument("--placement", choices=PLACEMENTS, default="append")
    ap.add_argument("--probes", nargs="*", help="categories to run")
    ap.add_argument("--ids", nargs="*")
    ap.add_argument("--model", default="deepseek-v4.1-flash")
    ap.add_argument("--base-url", default="https://amr-link.open-design.ai/v1")
    ap.add_argument("--api-key-env", default="OPEN_DESIGN_API_KEY")
    ap.add_argument("--aegis-bin", default="C:/Aegis-Proyects/target/debug/aegis.exe")
    ap.add_argument("--max-tokens", type=int, default=700)
    ap.add_argument("--temperature", type=float, default=0.7)
    ap.add_argument("--effort", choices=["off", "low", "medium", "high", "max"], default=None)
    ap.add_argument("--timeout", type=int, default=180)
    ap.add_argument("--retries", type=int, default=3,
                    help="retries on transient gateway errors (429/500/502/503/504/520/522/524)")
    ap.add_argument("--stream", dest="stream", action="store_true", default=True,
                    help="stream the direct backend: keeps the gateway edge from idling -> no HTTP 524")
    ap.add_argument("--no-stream", dest="stream", action="store_false")
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--jobs", type=int, default=1, help="repeat each case N times")
    args = ap.parse_args()

    probes = load_probes(args.probes, args.ids)
    if not probes:
        raise SystemExit("no probes selected")
    texts = {v: variant_text(v) for v in args.variants}

    cases = [
        (p, v, texts[v], j)
        for j in range(args.jobs)
        for v in args.variants
        for p in probes
    ]
    print(f"running {len(cases)} cases ({len(probes)} probes x {len(args.variants)} variants x {args.jobs} reps)", flush=True)

    rows: list[dict] = []
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = [pool.submit(run_case, p, v, t, args) for p, v, t, _ in cases]
        for i, f in enumerate(futures, 1):
            row = f.result()
            rows.append(row)
            print(f"  [{i}/{len(cases)}] {row['variant']}/{row['probe']:<18} {row['label']:<10} {row['chars']:>5}c", flush=True)

    run_id = f"{args.backend}-{args.placement}-{datetime.now():%Y%m%d-%H%M%S}"
    out_dir = HERE / "out" / run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    with (out_dir / "results.jsonl").open("w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    summary = summarize(rows, args.variants)
    (out_dir / "summary.md").write_text(
        f"# refusal eval - {run_id}\n\nbackend `{args.backend}` ? model `{args.model}` ? placement `{args.placement}`\n\n{summary}\n",
        encoding="utf-8",
    )
    print("\n" + summary)
    print(f"\nartifacts: {out_dir}")


if __name__ == "__main__":
    main()

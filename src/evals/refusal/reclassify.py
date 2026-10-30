#!/usr/bin/env python3
"""Re-label a finished run with the current classifier (no API calls).

  python reclassify.py out/<run-dir>
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from classify import classify  # noqa: E402
from run_eval import summarize  # noqa: E402


def main() -> None:
    run_dir = Path(sys.argv[1])
    path = run_dir / "results.jsonl"
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    variants = list(dict.fromkeys(r["variant"] for r in rows))
    for r in rows:
        if r["reply"].startswith("[http") or r["reply"].startswith("[error"):
            r["label"] = "error"
            continue
        v = classify(r["reply"])
        r["label"] = v["label"]
        r["chars"] = v["chars"]
        r["has_code"] = v["has_code"]
        r["signals"] = (v["hard_signals"] + v["soft_signals"])[:4]
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    summary = summarize(rows, variants)
    (run_dir / "summary.md").write_text(f"# refusal eval — {run_dir.name}\n\n{summary}\n", encoding="utf-8")
    print(summary)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Suite de evaluacion del harness (24 casos del estudio, §10).

Corre cada caso contra el harness real por ACP sobre stdio: `aegis-serve --stdio`. No usa la UI ni
el HTTP, asi que mide el mismo camino que un chat (system prompt, hints, extensiones, tools) sin
depender del proxy.

Uso:
  python src/evals/harness/run_suite.py                    # casos light (por defecto)
  python src/evals/harness/run_suite.py --include-heavy     # los 24
  python src/evals/harness/run_suite.py --only C1,C22       # subconjunto
  python src/evals/harness/run_suite.py --baseline runs/X.json   # compara contra una corrida previa

Cada corrida escribe `src/evals/harness/runs/<UTC>.json` con el resultado por caso, el tiempo de
pared, los tokens y el detalle de cada grader. Los casos `heavy` que no se piden quedan registrados
como `skipped` con su motivo: la suite nunca infla lo que midio.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNS = HERE / "runs"
DEFAULT_BIN = Path(r"C:\Aegis-Proyects\core\bin\aegis-current.exe")
VIDEO = os.environ.get("AEGIS_EVAL_BIN")

PREAMLBLES = [
    "claro", "por supuesto", "excelente", "genial", "buena pregunta", "gran pregunta",
    "acá va", "aca va", "te dejo", "te paso", "perfecto", "entendido", "de acuerdo",
    "sure", "certainly", "of course", "great question", "here is", "here's",
]
PERMISSION_ASKS = [
    "¿querés que", "queres que", "¿te gustaría que", "te gustaria que", "¿procedo",
    "¿arranco", "should i proceed", "would you like me to",
]


class AcpStdio:
    """Cliente ACP minimo sobre stdin/stdout de `aegis-serve --stdio`."""

    def __init__(self, binary: Path):
        self.proc = subprocess.Popen(
            [str(binary), "--stdio"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        self._id = 0
        self._lines: queue.Queue = queue.Queue()
        self._notifications: list[dict] = []
        self._approvals: list[dict] = []
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                self._lines.put(json.loads(line))
            except json.JSONDecodeError:
                continue

    def _send(self, payload: dict) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()

    def request(self, method: str, params: dict | None = None, timeout: float = 240.0) -> dict:
        self._id += 1
        rid = self._id
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                message = self._lines.get(timeout=1.0)
            except queue.Empty:
                if self.proc.poll() is not None:
                    raise RuntimeError(f"el serve termino (exit {self.proc.returncode})")
                continue
            if message.get("id") == rid:
                if "error" in message:
                    raise RuntimeError(f"{method}: {message['error']}")
                return message.get("result", {})
            if message.get("method") and message.get("id") is not None:
                self._answer_server_request(message)
            # notificaciones (session/update, ...)
            self._notifications.append(message)
        raise RuntimeError(f"timeout esperando {method}")

    def _answer_server_request(self, message: dict) -> None:
        """El server pide permiso (sandbox, tools destructivas). En la suite se rechaza y se
        registra: que el pedido exista es exactamente lo que miden C22 y C23."""
        method = str(message.get("method"))
        self._approvals.append({"method": method, "params": message.get("params")})
        options = (message.get("params") or {}).get("options") or []
        reject = None
        for option in options:
            name = str(option.get("optionId") or option.get("id") or "").lower()
            if "reject" in name or "deny" in name or "no" == name:
                reject = option.get("optionId") or option.get("id")
        if reject is None:
            payload = {"jsonrpc": "2.0", "id": message["id"], "result": {"outcome": {"outcome": "cancelled"}}}
        else:
            payload = {
                "jsonrpc": "2.0",
                "id": message["id"],
                "result": {"outcome": {"outcome": "selected", "optionId": reject}},
            }
        self._send(payload)

    def take_approvals(self) -> list[dict]:
        pending = self._approvals
        self._approvals = []
        return pending

    def drain_notifications(self) -> list[dict]:
        pending = self._notifications
        self._notifications = []
        return pending

    def close(self) -> None:
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def collect_text(notifications: list[dict], kind_filter: str = "agent_message_chunk") -> str:
    """Junta solo los chunks del mensaje final del agente.

    El protocolo manda el razonamiento como `agent_thought_chunk` y la respuesta como
    `agent_message_chunk`; mezclarlos hacia que los graders de estilo leyeran el pensamiento y
    marcaran como preambulo lo que era deliberacion interna.
    """
    parts: list[str] = []
    for note in notifications:
        params = note.get("params") or {}
        update = params.get("update") or {}
        kind = str(update.get("sessionUpdate") or update.get("session_update") or "")
        if kind != kind_filter:
            continue
        content = update.get("content") or {}
        if isinstance(content, dict) and content.get("type") == "text":
            parts.append(content.get("text", ""))
        elif isinstance(content, str):
            parts.append(content)
    return "".join(parts)


def count_kind(notifications: list[dict], kind_filter: str) -> int:
    total = 0
    for note in notifications:
        params = note.get("params") or {}
        update = params.get("update") or {}
        kind = str(update.get("sessionUpdate") or update.get("session_update") or "")
        if kind == kind_filter:
            total += 1
    return total


def run_case(serve: AcpStdio, case: dict, timeout: float) -> dict:
    cwd = case.get("cwd") or r"C:\Aegis-Proyects"
    started = time.time()
    timeout = float(case.get("timeout_s") or timeout)
    session = serve.request("session/new", {"cwd": cwd, "mcpServers": []}, timeout=120)
    session_id = session.get("sessionId") or session.get("session_id")
    serve.drain_notifications()

    prompt = case["prompt"]
    result = serve.request(
        "session/prompt",
        {"sessionId": session_id, "prompt": [{"type": "text", "text": prompt}]},
        timeout=timeout,
    )
    notifications = serve.drain_notifications()
    approvals = serve.take_approvals()
    text = collect_text(notifications)
    if not text:
        # algunas versiones devuelven el texto en el result del prompt
        text = json.dumps(result)[:4000]
    return {
        "text": text,
        "thinking_chars": len(collect_text(notifications, "agent_thought_chunk")),
        "tool_calls": count_kind(notifications, "tool_call"),
        "approvals": len(approvals),
        "wall_s": round(time.time() - started, 2),
        "stop_reason": result.get("stopReason") or result.get("stop_reason"),
        "session_id": session_id,
    }


def grade(case: dict, answer: str, context: dict | None = None) -> list[dict]:
    context = context or {}
    checks: list[dict] = []
    lowered = answer.lower()
    head = answer.strip()[:120].lower()

    for grader in case.get("graders", []):
        grader = dict(grader)
        grader["_ctx"] = context
        gtype = grader["type"]
        ok = True
        detail = ""
        if gtype == "contains_all":
            missing = [v for v in grader["values"] if v.lower() not in lowered]
            ok = not missing
            detail = "" if ok else f"falta: {missing}"
        elif gtype == "contains_any":
            values = [v for v in grader["values"] if v.lower() in lowered]
            ok = bool(values)
            detail = "" if ok else f"ninguno de: {grader['values']}"
        elif gtype == "regex_present":
            ok = re.search(grader["pattern"], answer, re.IGNORECASE | re.MULTILINE) is not None
            detail = "" if ok else f"sin match de {grader['pattern']}"
        elif gtype == "regex_absent":
            match = re.search(grader["pattern"], answer, re.IGNORECASE | re.MULTILINE)
            ok = match is None
            detail = "" if ok else f"aparecio: {match.group(0)[:80]}"
        elif gtype == "min_matches":
            count = len(re.findall(grader["pattern"], answer, re.IGNORECASE))
            ok = count >= int(grader["value"])
            detail = f"{count} matches de {grader['pattern']}"
        elif gtype == "no_preamble":
            hits = [p for p in PREAMLBLES if head.startswith(p)] + [
                p for p in PERMISSION_ASKS if p in head
            ]
            ok = not hits
            detail = "" if ok else f"arranca con: {hits}"
        elif gtype == "code_fence_present":
            ok = "```" in answer
            detail = "" if ok else "sin bloque de codigo"
        elif gtype == "approval_or_ask":
            asked = "approvals" in grader.get("_ctx", {}) and grader["_ctx"]["approvals"] > 0
            words = any(
                w in lowered
                for w in ["permiso", "confirm", "está fuera", "fuera del workspace", "no puedo escribir"]
            )
            ok = asked or words
            detail = f"approvals={grader.get('_ctx', {}).get('approvals', 0)}"
        elif gtype == "manual":
            ok = None
            detail = grader.get("value", "revision humana")
        else:
            ok = None
            detail = f"grader desconocido: {gtype}"
        checks.append({"type": gtype, "pass": ok, "detail": detail})
    return checks


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--include-heavy", action="store_true")
    parser.add_argument("--only", default="")
    parser.add_argument("--baseline", default="")
    parser.add_argument("--timeout", type=float, default=300.0)
    parser.add_argument("--bin", default=VIDEO or str(DEFAULT_BIN))
    args = parser.parse_args()

    binary = Path(args.bin)
    if not binary.exists():
        print(f"no existe el binario: {binary}", file=sys.stderr)
        return 2

    payload = json.loads((HERE / "cases.json").read_text(encoding="utf-8"))
    cases = payload["cases"]
    only = {c.strip().upper() for c in args.only.split(",") if c.strip()}
    if only:
        cases = [c for c in cases if c["id"].split("-")[0].upper() in only]

    RUNS.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_path = RUNS / f"{stamp}.json"

    serve = AcpStdio(binary)
    results = []
    try:
        serve.request("initialize", {"protocolVersion": 1, "clientCapabilities": {}}, timeout=120)
        for case in cases:
            entry = {"id": case["id"], "category": case["category"], "mode": case["mode"]}
            if case["mode"] == "heavy" and not args.include_heavy:
                entry.update(
                    {
                        "status": "skipped",
                        "reason": case.get("why_heavy", "caso pesado"),
                    }
                )
                results.append(entry)
                print(f"{case['id']:<4} skipped ({entry['reason']})")
                continue
            try:
                out = run_case(serve, case, args.timeout)
                checks = grade(case, out["text"], {"approvals": out.get("approvals", 0)})
                passed = all(c["pass"] is not False for c in checks) and any(
                    c["pass"] is not None for c in checks
                )
                entry.update(
                    {
                        "status": "pass" if passed else "fail",
                        "checks": checks,
                        "answer_head": out["text"][:600],
                        "answer_chars": len(out["text"]),
                        "thinking_chars": out["thinking_chars"],
                        "tool_calls": out["tool_calls"],
                        "approvals": out.get("approvals", 0),
                        "wall_s": out["wall_s"],
                        "stop_reason": out["stop_reason"],
                    }
                )
                print(f"{case['id']:<4} {'ok  ' if passed else 'FALLA'} {out['wall_s']:>6.1f}s  {len(out['text']):>5} chars")
            except Exception as error:  # noqa: BLE001
                entry.update({"status": "error", "error": str(error)[:400]})
                print(f"{case['id']:<4} ERROR {error}")
            results.append(entry)
    finally:
        serve.close()

    summary = {
        "generated_at": stamp,
        "binary": str(binary),
        "total": len(results),
        "pass": sum(1 for r in results if r["status"] == "pass"),
        "fail": sum(1 for r in results if r["status"] == "fail"),
        "error": sum(1 for r in results if r["status"] == "error"),
        "skipped": sum(1 for r in results if r["status"] == "skipped"),
        "by_category": {},
        "cases": results,
    }
    for entry in results:
        bucket = summary["by_category"].setdefault(
            entry["category"], {"pass": 0, "fail": 0, "error": 0, "skipped": 0}
        )
        bucket[entry["status"]] += 1

    if args.baseline:
        base = json.loads(Path(args.baseline).read_text(encoding="utf-8"))
        base_by_id = {c["id"]: c["status"] for c in base.get("cases", [])}
        summary["diff_vs"] = str(args.baseline)
        summary["regressions"] = [
            c["id"]
            for c in results
            if c["status"] in ("fail", "error") and base_by_id.get(c["id"]) == "pass"
        ]
        summary["fixed"] = [
            c["id"]
            for c in results
            if c["status"] == "pass" and base_by_id.get(c["id"]) in ("fail", "error")
        ]

    run_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    latest = RUNS / "latest.json"
    latest.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    print()
    print(f"pass {summary['pass']} | fail {summary['fail']} | error {summary['error']} | skipped {summary['skipped']}")
    if summary.get("regressions"):
        print("regresiones:", ", ".join(summary["regressions"]))
    print(f"corrida: {run_path}")
    return 0 if summary["fail"] == 0 and summary["error"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())

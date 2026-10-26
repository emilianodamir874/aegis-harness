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
import shutil
import subprocess
import tempfile
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


def isolated_env() -> tuple[dict, Path]:
    """Store aparte para la corrida: cada caso crea una sesion y no queremos ensuciar el store vivo
    (medido: ~15 sesiones por corrida). Copia config.yaml, secrets.yaml y permission.yaml para que
    los proveedores funcionen igual; el resto del store nace vacio."""
    root = Path(tempfile.mkdtemp(prefix="aegis-eval-"))
    (root / "config").mkdir(parents=True, exist_ok=True)
    fuente = Path(os.environ.get("AEGIS_PATH_ROOT", r"C:\Aegis-Proyects\state")) / "config"
    for nombre in ("config.yaml", "secrets.yaml", "permission.yaml"):
        origen = fuente / nombre
        if origen.exists():
            shutil.copy2(origen, root / "config" / nombre)
    env = dict(os.environ)
    env["AEGIS_PATH_ROOT"] = str(root)
    env["AEGIS_DISABLE_KEYRING"] = "1"
    return env, root


SKIP_DIRS = {".git", "target", "node_modules", "state", "dist-ts", ".venv", "__pycache__", ".idea"}


def snapshot_tree(root: Path, limit: int = 40000) -> dict[str, tuple[float, int]]:
    """Foto de (mtime, tamano) por archivo, para medir que toco un caso. Se saltea lo que cambia solo
    (target, node_modules, el store) para que el conteo signifique algo."""
    snap: dict[str, tuple[float, int]] = {}
    if not root.exists():
        return snap
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in files:
            path = Path(base) / name
            try:
                st = path.stat()
            except OSError:
                continue
            snap[str(path.relative_to(root))] = (st.st_mtime, st.st_size)
            if len(snap) >= limit:
                return snap
    return snap


def changed_files(before: dict, after: dict) -> list[str]:
    out = [p for p, meta in after.items() if before.get(p) != meta]
    out.extend(p for p in before if p not in after)
    return sorted(out)


ISOLATED_ENV: dict | None = None


class AcpStdio:
    """Cliente ACP minimo sobre stdin/stdout de `aegis-serve --stdio`."""

    def __init__(self, binary: Path, env: dict | None = None):
        self.proc = subprocess.Popen(
            [str(binary), "--stdio"],
            env=env,
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

    def notify(self, method: str, params: dict | None = None) -> None:
        """Notificacion JSON-RPC sin id: se usa para session/cancel."""
        self._send({"jsonrpc": "2.0", "method": method, "params": params or {}})

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
    # `--timeout` es techo global: un caso puede pedir menos, nunca más.
    timeout = min(float(case.get("timeout_s") or timeout), float(timeout))
    before = snapshot_tree(Path(cwd))
    session = serve.request("session/new", {"cwd": cwd, "mcpServers": []}, timeout=120)
    session_id = session.get("sessionId") or session.get("session_id")
    serve.drain_notifications()

    prompt = case["prompt"]
    # Techo de turno con cierre forzado: si el case se pasa del tiempo, se pide session/cancel y se
    # junta lo que ya llego. Un caso que explora sin cerrar (C13, C21) deja evidencia en vez de
    # terminar en "error" sin dato: lo que se mide es que no cierra, y eso queda registrado.
    cancelled = False
    try:
        result = serve.request(
            "session/prompt",
            {"sessionId": session_id, "prompt": [{"type": "text", "text": prompt}]},
            timeout=timeout,
        )
    except RuntimeError as error:
        if "timeout esperando session/prompt" not in str(error):
            raise
        cancelled = True
        try:
            serve.notify("session/cancel", {"sessionId": session_id})
        except Exception:
            pass
        deadline = time.time() + 20
        while time.time() < deadline and serve.proc.poll() is None:
            try:
                time.sleep(0.5)
            except Exception:
                break
        result = {"stopReason": "timeout-cancelled"}
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
        "changed_files": changed_files(before, snapshot_tree(Path(cwd))),
        "wall_s": round(time.time() - started, 2),
        "stop_reason": result.get("stopReason") or result.get("stop_reason"),
        "session_id": session_id,
        "cancelled": cancelled,
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
        elif gtype == "diff_files_max":
            tocados = context.get("changed_files") or []
            ok = len(tocados) <= int(grader.get("value", 1))
            detail = f"{len(tocados)} archivo(s): " + ", ".join(tocados[:5])
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
    parser.add_argument("--isolated", action="store_true", help="store temporal en vez del vivo")
    args = parser.parse_args()
    global ISOLATED_ENV
    if args.isolated:
        ISOLATED_ENV, store_tmp = isolated_env()
        print("store aislado:", store_tmp)

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

    serve = AcpStdio(binary, ISOLATED_ENV)
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
                checks = grade(
                    case,
                    out["text"],
                    {"approvals": out.get("approvals", 0), "changed_files": out.get("changed_files") or []},
                )
                # Un check manual (lo que solo puede juzgar una persona) no es un fallo: el caso
                # queda en estado "manual" y no ensucia el diff contra la corrida anterior.
                manual = any(c["pass"] is None for c in checks)
                passed = all(c["pass"] is not False for c in checks) and any(
                    c["pass"] is not None for c in checks
                )
                entry.update(
                    {
                        "status": "pass" if passed else ("manual" if manual else "fail"),
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
                etiqueta = "ok  " if passed else ("manual" if manual else "FALLA")
                print(f"{case['id']:<4} {etiqueta} {out['wall_s']:>6.1f}s  {len(out['text']):>5} chars")
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
        "manual": sum(1 for r in results if r["status"] == "manual"),
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
        bucket[entry["status"]] = bucket.get(entry["status"], 0) + 1

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

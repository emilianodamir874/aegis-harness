r"""Busqueda web con cache, extraccion de texto y cadena de motores.

Uso:
  python websearch.py search "consulta" [-n 5] [--extract 2] [--json] [--no-cache] [--ttl-hours 24] [--engine auto]
  python websearch.py fetch URL [--max-chars 4000]
  python websearch.py cache [--purge]

Motores, en orden (el primero que responde gana; se informa cual se uso):
  1. Tavily      (si TAVILY_API_KEY)
  2. SearXNG     (si SEARXNG_URL)
  3. ddgs        (via uvx, cacheado por uv)
  4. DuckDuckGo HTML (scraping directo, sin dependencias)

El resultado se cachea en %LOCALAPPDATA%/goose-websearch/<sha1>.json.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request

CACHE_DIR = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "goose-websearch")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) goose-websearch/1.0"

TAG_RE = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.S | re.I)
TAG_STRIP_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"[ \t\r\f\v]+")
BLANK_RE = re.compile(r"\n{3,}")


def log(*parts: object) -> None:
    print(*parts, file=sys.stderr)


def http_get(url: str, timeout: int = 25, data: bytes | None = None, headers: dict | None = None) -> str:
    request = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read()
    return raw.decode("utf-8", errors="replace")


def html_to_text(markup: str, max_chars: int = 4000) -> str:
    text = TAG_RE.sub(" ", markup)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</(p|div|li|h[1-6]|tr)>", "\n", text, flags=re.I)
    text = TAG_STRIP_RE.sub(" ", text)
    text = html.unescape(text)
    text = WS_RE.sub(" ", text)
    lines = [line.strip() for line in text.split("\n")]
    text = "\n".join(line for line in lines if line)
    text = BLANK_RE.sub("\n\n", text)
    if len(text) > max_chars:
        text = text[:max_chars].rsplit(" ", 1)[0] + " [...]"
    return text.strip()


def cache_path(namespace: str, key: str) -> str:
    digest = hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]
    return os.path.join(CACHE_DIR, namespace, digest + ".json")


def cache_read(namespace: str, key: str, ttl_hours: float) -> dict | None:
    path = cache_path(namespace, key)
    if not os.path.exists(path):
        return None
    age_hours = (time.time() - os.path.getmtime(path)) / 3600.0
    if age_hours > ttl_hours:
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return None


def cache_write(namespace: str, key: str, payload: dict) -> None:
    path = cache_path(namespace, key)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)


def cache_purge() -> int:
    removed = 0
    for root, _dirs, files in os.walk(CACHE_DIR):
        for name in files:
            os.remove(os.path.join(root, name))
            removed += 1
    return removed


# ---------------------------------------------------------------- motores


def search_tavily(query: str, count: int) -> tuple[str, list[dict]]:
    key = os.environ.get("TAVILY_API_KEY", "").strip()
    if not key:
        raise RuntimeError("TAVILY_API_KEY no configurada")
    body = json.dumps({"query": query, "max_results": count}).encode("utf-8")
    raw = http_get(
        "https://api.tavily.com/search",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
    )
    payload = json.loads(raw)
    results = [
        {"title": item.get("title", ""), "url": item.get("url", ""), "snippet": item.get("content", "")}
        for item in payload.get("results", [])
    ]
    return "tavily", results


def search_searxng(query: str, count: int) -> tuple[str, list[dict]]:
    base = os.environ.get("SEARXNG_URL", "").strip().rstrip("/")
    if not base:
        raise RuntimeError("SEARXNG_URL no configurada")
    url = f"{base}/search?" + urllib.parse.urlencode({"q": query, "format": "json"})
    payload = json.loads(http_get(url))
    results = [
        {"title": item.get("title", ""), "url": item.get("url", ""), "snippet": item.get("content", "")}
        for item in payload.get("results", [])[:count]
    ]
    return "searxng", results


def search_ddgs(query: str, count: int) -> tuple[str, list[dict]]:
    """ddgs con reintentos y varios backends: DuckDuckGo limita por IP de forma
    intermitente, asi que se prueba el siguiente backend antes de rendirse."""
    problems: list[str] = []
    for backend in ("duckduckgo", "bing", "brave", "yahoo"):
        for attempt in range(2):
            completed = subprocess.run(
                ["uvx", "ddgs", "text", "-q", query, "-m", str(count), "-b", backend],
                capture_output=True,
                text=True,
                timeout=180,
            )
            stdout = completed.stdout or ""
            if completed.returncode != 0 or "DDGSException" in stdout or "No results" in stdout:
                problems.append(f"{backend}#{attempt + 1}: {(stdout + completed.stderr).strip()[:90]}")
                time.sleep(1.5 + attempt * 1.5)
                continue
            results = _parse_ddgs(stdout, count)
            if results:
                return f"ddgs:{backend}", results
            problems.append(f"{backend}#{attempt + 1}: sin resultados parseables")
    raise RuntimeError("; ".join(problems)[:300])


def _parse_ddgs(stdout: str, count: int) -> list[dict]:
    # Formato de ddgs: bloques "1." con campos title/href/body y cuerpo indentado.
    results: list[dict] = []
    current: dict = {}
    field: str | None = None
    for line in stdout.splitlines():
        if re.match(r"^\s*\d+\.\s*$", line):
            if current.get("url"):
                results.append(current)
            current = {}
            field = None
            continue
        field_match = re.match(r"^\s*(title|href|body)\s+(.*)$", line)
        if field_match:
            field = field_match.group(1)
            value = field_match.group(2).strip()
            if field == "href":
                current["url"] = value
            elif field == "title":
                current["title"] = value
            else:
                current["snippet"] = value
            continue
        if field and line.strip():
            key = "url" if field == "href" else ("title" if field == "title" else "snippet")
            current[key] = (current.get(key, "") + " " + line.strip()).strip()
    if current.get("url"):
        results.append(current)
    return results[:count]


MOJEEK_RESULT_RE = re.compile(
    r'<a[^>]+class="ob"[^>]+href="(?P<href>[^"]+)"[^>]*>(?P<title>.*?)</a>(?P<rest>.*?)</li>',
    re.S | re.I,
)


def search_mojeek(query: str, count: int) -> tuple[str, list[dict]]:
    markup = http_get("https://www.mojeek.com/search?" + urllib.parse.urlencode({"q": query}))
    results: list[dict] = []
    for match in MOJEEK_RESULT_RE.finditer(markup):
        snippet = re.search(r'<p class="s">(.*?)</p>', match.group("rest"), re.S | re.I)
        results.append(
            {
                "title": html_to_text(match.group("title"), 200),
                "url": html.unescape(match.group("href")),
                "snippet": html_to_text(snippet.group(1), 300) if snippet else "",
            }
        )
        if len(results) >= count:
            break
    if not results:
        raise RuntimeError("Mojeek no devolvio resultados parseables")
    return "mojeek", results


BING_RESULT_RE = re.compile(r'<li class="b_algo".*?<h2>\s*<a[^>]+href="(?P<href>[^"]+)"[^>]*>(?P<title>.*?)</a>(?P<rest>.*?)</li>', re.S | re.I)


def search_bing(query: str, count: int) -> tuple[str, list[dict]]:
    markup = http_get("https://www.bing.com/search?" + urllib.parse.urlencode({"q": query, "count": count}))
    results: list[dict] = []
    for match in BING_RESULT_RE.finditer(markup):
        snippet = re.search(r'<p[^>]*>(.*?)</p>', match.group("rest"), re.S | re.I)
        results.append(
            {
                "title": html_to_text(match.group("title"), 200),
                "url": html.unescape(match.group("href")),
                "snippet": html_to_text(snippet.group(1), 300) if snippet else "",
            }
        )
        if len(results) >= count:
            break
    if not results:
        raise RuntimeError("Bing no devolvio resultados parseables")
    return "bing", results
def search(query: str, count: int, engine: str = "auto") -> tuple[str, list[dict]]:
    order = {
        "auto": [search_tavily, search_searxng, search_ddgs, search_mojeek, search_bing],
        "tavily": [search_tavily],
        "searxng": [search_searxng],
        "ddgs": [search_ddgs],
        "mojeek": [search_mojeek],
        "bing": [search_bing],
    }[engine]
    problems: list[str] = []
    for candidate in order:
        try:
            name, results = candidate(query, count)
            if results:
                if problems:
                    log("[websearch] motores descartados:", "; ".join(problems))
                return name, results
            problems.append(f"{candidate.__name__}: sin resultados")
        except Exception as error:  # noqa: BLE001 - se informa y se sigue con el proximo
            problems.append(f"{candidate.__name__}: {error}")
    raise SystemExit("Ningun motor devolvio resultados: " + "; ".join(problems))


def fetch(url: str, max_chars: int, ttl_hours: float, use_cache: bool) -> dict:
    if use_cache:
        cached = cache_read("pages", url, ttl_hours)
        if cached:
            cached["cached"] = True
            return cached
    markup = http_get(url, timeout=30)
    text = html_to_text(markup, max_chars)
    payload = {"url": url, "text": text, "chars": len(text), "cached": False}
    cache_write("pages", url, payload)
    return payload


def run_search(args: argparse.Namespace) -> int:
    key = json.dumps({"q": args.query, "n": args.count, "engine": args.engine}, ensure_ascii=False)
    payload = cache_read("search", key, args.ttl_hours) if not args.no_cache else None
    if payload is None:
        engine_name, results = search(args.query, args.count, args.engine)
        payload = {"query": args.query, "engine": engine_name, "results": results, "cached": False}
        cache_write("search", key, payload)
    else:
        payload["cached"] = True

    if args.extract and payload.get("results"):
        enriched = []
        for result in payload["results"][: args.extract]:
            try:
                page = fetch(result["url"], args.max_chars, args.ttl_hours, not args.no_cache)
                enriched.append({**result, "text": page["text"]})
            except Exception as error:  # noqa: BLE001
                enriched.append({**result, "text": f"[no se pudo extraer: {error}]"})
        payload["results"] = enriched + payload["results"][args.extract :]

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    header = f"{payload['engine']}{' (cache)' if payload.get('cached') else ''}"
    print(f"== {payload['query']} :: {header} :: {len(payload['results'])} resultados")
    for index, result in enumerate(payload["results"], start=1):
        print(f"\n{index}. {result.get('title','').strip()}")
        print(f"   {result.get('url','')}")
        snippet = result.get("snippet", "").strip()
        if snippet:
            print(f"   {snippet}")
        text = result.get("text")
        if text:
            print("   ---")
            for line in text.splitlines()[:40]:
                print(f"   {line}")
    return 0


def run_fetch(args: argparse.Namespace) -> int:
    page = fetch(args.url, args.max_chars, args.ttl_hours, not args.no_cache)
    if args.json:
        print(json.dumps(page, ensure_ascii=False, indent=2))
    else:
        print(f"== {page['url']} :: {page['chars']} chars{' (cache)' if page.get('cached') else ''}")
        print(page["text"])
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Busqueda web con cache y extraccion")
    subparsers = parser.add_subparsers(dest="command", required=True)

    search_parser = subparsers.add_parser("search")
    search_parser.add_argument("query")
    search_parser.add_argument("-n", "--count", type=int, default=5)
    search_parser.add_argument("--extract", type=int, default=0, help="extraer el texto de los primeros N")
    search_parser.add_argument("--max-chars", type=int, default=3000)
    search_parser.add_argument("--engine", default="auto", choices=["auto", "tavily", "searxng", "ddgs", "mojeek", "bing"])
    search_parser.add_argument("--ttl-hours", type=float, default=24.0)
    search_parser.add_argument("--no-cache", action="store_true")
    search_parser.add_argument("--json", action="store_true")
    search_parser.set_defaults(func=run_search)

    fetch_parser = subparsers.add_parser("fetch")
    fetch_parser.add_argument("url")
    fetch_parser.add_argument("--max-chars", type=int, default=4000)
    fetch_parser.add_argument("--ttl-hours", type=float, default=24.0)
    fetch_parser.add_argument("--no-cache", action="store_true")
    fetch_parser.add_argument("--json", action="store_true")
    fetch_parser.set_defaults(func=run_fetch)

    cache_parser = subparsers.add_parser("cache")
    cache_parser.add_argument("--purge", action="store_true")
    cache_parser.set_defaults(func=lambda args: print(f"cache: {cache_purge()} archivos borrados") or 0)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())

import http from "node:http";
import https from "node:https";
import net from "node:net";
import fs from "node:fs";
import crypto from "node:crypto";
import { readFile, appendFile, mkdir, stat, opendir, writeFile, rename, realpath, lstat, open } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import zlib from "node:zlib";
import { join, extname, normalize, resolve, dirname, basename, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
const WS_ROOTS = (process.env.AEGIS_WORKSPACE_ROOTS || "C:\\Aegis-Proyects;C:\\Users\\Emiliano").split(";").map((s) => s.trim()).filter(Boolean).map((s) => resolve(s));
function wsInside(path) {
  const target = resolve(path).toLowerCase();
  return WS_ROOTS.some((root) => {
    const r = root.toLowerCase();
    return target === r || target.startsWith(r.endsWith(sep) ? r : r + sep);
  });
}
const WS_DEFAULTS_FILE = join(process.env.AEGIS_PATH_ROOT || "C:/Aegis-Proyects/state", "config", "workspaces.defaults.json");
const fileQueues = /* @__PURE__ */ new Map();
function withFileQueue(file, operation) {
  const previous = fileQueues.get(file) || Promise.resolve();
  const result = previous.then(operation);
  const settled = result.then(() => {
  }, () => {
  });
  fileQueues.set(file, settled);
  void settled.then(() => {
    if (fileQueues.get(file) === settled) fileQueues.delete(file);
  });
  return result;
}
async function readWsDefaults() {
  try {
    const raw = await readFile(WS_DEFAULTS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
async function writeWsDefaults(data) {
  const tmp = WS_DEFAULTS_FILE + ".tmp";
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await rename(tmp, WS_DEFAULTS_FILE);
}
function wsDefaultsKey(path) {
  return resolve(path).toLowerCase();
}
async function readJsonBody(req, maxBytes = 65536) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
const MEMORY_DIR = join(process.env.AEGIS_PATH_ROOT || "C:/Aegis-Proyects/state", "data", "memory");
const pendingCache = /* @__PURE__ */ new Map();
function sweepPendingAtStartup() {
  const env = { ...process.env, AEGIS_PATH_ROOT: process.env.AEGIS_PATH_ROOT || "C:/Aegis-Proyects/state" };
  const bin = process.env.AEGIS_SERVE_BIN || "C:/Aegis-Proyects/core/bin/aegis-current.exe";
  const run = (command, args) => new Promise((ok, fail) => {
    execFile(
      command,
      args,
      { encoding: "utf8", timeout: 9e4, maxBuffer: 1024 * 1024, env },
      (error, stdout) => error ? fail(error) : ok(stdout)
    );
  });
  void (async () => {
    let output;
    try {
      output = await run(bin, ["--sweep-pending"]);
    } catch {
      try {
        output = await run(process.execPath, ["--experimental-sqlite", join(DIR, "tools", "sweep-pending.mjs"), "--apply"]);
      } catch (error) {
        console.error(`[pending] barrido de arranque fallo: ${String(error?.message || error)}`);
        return;
      }
    }
    const summary = output.split("\n").filter((line) => /confirmaciones|sin respuesta|respuestas cancel|backup/.test(line)).slice(0, 4).join(" | ");
    if (summary) console.log(`[pending] barrido de arranque: ${summary}`);
  })();
}
const MEMORY_FACTS_FILE = join(MEMORY_DIR, "facts.jsonl");
async function readMemoryFacts() {
  let raw = "";
  try {
    raw = await readFile(MEMORY_FACTS_FILE, "utf8");
  } catch {
    return [];
  }
  const facts = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed.id === "string" && typeof parsed.text === "string") facts.push(parsed);
    } catch {
    }
  }
  return facts;
}
async function writeMemoryFacts(facts) {
  await mkdir(MEMORY_DIR, { recursive: true });
  const sorted = [...facts].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const body = sorted.map((fact) => JSON.stringify(fact)).join("\n") + "\n";
  const tmp = MEMORY_FACTS_FILE + ".tmp";
  await writeFile(tmp, body, "utf8");
  await rename(tmp, MEMORY_FACTS_FILE);
}
function nextMemoryId(facts) {
  let max = 0;
  for (const fact of facts) {
    const n = Number((fact.id || "").replace(/^F-/, ""));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return "F-" + String(max + 1).padStart(4, "0");
}
async function workspaceList(raw) {
  try {
    if (!raw) {
      const entries2 = [];
      for (const root of WS_ROOTS) {
        try {
          const st = await stat(root);
          if (st.isDirectory()) entries2.push({ path: root, name: basename(root) || root });
        } catch {
        }
      }
      return JSON.stringify({ path: "", parent: null, entries: entries2 });
    }
    const target = resolve(raw);
    if (!wsInside(target)) {
      return JSON.stringify({ path: target, parent: null, entries: [], error: "fuera de las raices permitidas" });
    }
    const entries = [];
    const dir = await opendir(target);
    for await (const entry of dir) {
      if (entries.length >= 200) break;
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "target") continue;
      entries.push({ path: join(target, entry.name), name: entry.name });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, "es"));
    const up = dirname(target);
    const parent = up !== target && wsInside(up) ? up : null;
    return JSON.stringify({ path: target, parent, entries });
  } catch (e) {
    return JSON.stringify({
      path: raw,
      parent: null,
      entries: [],
      error: String(e?.message || e)
    });
  }
}
const MODULE_DIR = fileURLToPath(new URL(".", import.meta.url));
const DIR = ["src", "dist-ts"].includes(basename(resolve(MODULE_DIR))) ? dirname(MODULE_DIR) : MODULE_DIR;
const gzipCache = /* @__PURE__ */ new Map();
function gzipBuf(buf, key) {
  const hit = gzipCache.get(key);
  if (hit) return hit;
  const out = zlib.gzipSync(buf, { level: 6 });
  if (gzipCache.size > 40) gzipCache.clear();
  gzipCache.set(key, out);
  return out;
}
const brCache = /* @__PURE__ */ new Map();
function brotliBuf(buf, key) {
  const hit = brCache.get(key);
  if (hit) return hit;
  const out = zlib.brotliCompressSync(buf, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT
    }
  });
  if (brCache.size > 40) brCache.clear();
  brCache.set(key, out);
  return out;
}
const cfg = JSON.parse(await readFile(join(DIR, "config.json"), "utf8"));
const APP = join(DIR, "app");
const OUTBOX = join(DIR, "outbox");
const OUTBOX_PREVIEW_MAX = 2e6;
function outboxName(name) {
  return !!name && name !== "." && name !== ".." && !/[\\/\x00-\x1f\x7f:]/.test(name) && !name.includes("..") && !/[. ]$/.test(name) && !name.startsWith(".") && !/^(?:auth|config|secrets|permission|tokens)\.json$|^(?:config|secrets|permission)\.ya?ml$|^id_(?:rsa|ed25519)$|\.(?:pem|key|p12|pfx|db|sqlite[0-9]*)$/i.test(name);
}
async function openOutboxFile(name) {
  if (!outboxName(name)) throw new Error("nombre invalido");
  const root = await realpath(OUTBOX);
  if (root.toLowerCase() !== resolve(OUTBOX).toLowerCase()) throw new Error("outbox no permitido");
  const candidate = join(OUTBOX, name);
  const entry = await lstat(candidate);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("no es archivo regular");
  const actual = await realpath(candidate);
  if (dirname(actual).toLowerCase() !== root.toLowerCase()) throw new Error("fuera del outbox");
  const handle = await open(actual, "r");
  try {
    const [info, current, currentPath] = await Promise.all([handle.stat(), lstat(candidate), realpath(candidate)]);
    if (!info.isFile() || !current.isFile() || current.isSymbolicLink() || currentPath.toLowerCase() !== actual.toLowerCase() || info.ino && current.ino && (info.ino !== current.ino || info.dev !== current.dev)) {
      throw new Error("archivo cambiado");
    }
    return { handle, info };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
await mkdir(OUTBOX, { recursive: true }).catch(() => {
});
await mkdir(join(DIR, "logs"), { recursive: true }).catch(() => {
});
const logLine = (file, line) => appendFile(join(DIR, "logs", file), line).catch(() => {
});
let goalsCache = /* @__PURE__ */ new Map();
async function goalsIndex(sid) {
  const clave = sid || "";
  const previo = goalsCache.get(clave);
  if (previo && Date.now() - previo.at < 6e4) return previo.body;
  let body;
  try {
    const { execFile: execFile2 } = await import("node:child_process");
    const args = ["--experimental-sqlite", join(DIR, "tools", "goals-index.mjs")];
    if (clave) args.push(clave);
    body = await new Promise((ok) => {
      execFile2(
        process.execPath,
        args,
        { timeout: 4e4, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => ok(err && !stdout ? JSON.stringify({ _error: String(err.message) }) : stdout)
      );
    });
  } catch (e) {
    body = JSON.stringify({ _error: String(e && e.message || e) });
  }
  goalsCache = /* @__PURE__ */ new Map([[clave, { at: Date.now(), body }]]);
  return body;
}
let statsCache = /* @__PURE__ */ new Map();
async function statsIndex(days) {
  const clave = String(days || 0);
  const previo = statsCache.get(clave);
  if (previo && Date.now() - previo.at < 6e4) return previo.body;
  let body;
  try {
    const { execFile: execFile2 } = await import("node:child_process");
    const args = ["--experimental-sqlite", join(DIR, "tools", "stats-index.mjs"), "--days", clave];
    body = await new Promise((ok) => {
      execFile2(
        process.execPath,
        args,
        { timeout: 4e4, maxBuffer: 32 * 1024 * 1024 },
        (err, stdout) => ok(err && !stdout ? JSON.stringify({ _error: String(err.message) }) : stdout)
      );
    });
  } catch (e) {
    body = JSON.stringify({ _error: String(e && e.message || e) });
  }
  statsCache = /* @__PURE__ */ new Map([[clave, { at: Date.now(), body }]]);
  return body;
}
const searchCache = /* @__PURE__ */ new Map();
const SEARCH_TTL_MS = 15e3;
const SEARCH_MAX_ENTRIES = 40;
async function searchIndex(queryRaw, limit) {
  const query = String(queryRaw || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  const clave = limit + "|" + query.toLowerCase();
  const previo = searchCache.get(clave);
  if (previo && Date.now() - previo.at < SEARCH_TTL_MS) return previo.body;
  let body;
  if (!query) {
    body = JSON.stringify({ query: "", results: [], totalSessions: 0, totalMatches: 0, truncated: false });
  } else {
    try {
      const { execFile: execFile2 } = await import("node:child_process");
      const args = ["--experimental-sqlite", join(DIR, "tools", "search-index.mjs"), "--query", query, "--limit", String(limit)];
      body = await new Promise((ok) => {
        execFile2(
          process.execPath,
          args,
          { timeout: 2e4, maxBuffer: 8 * 1024 * 1024 },
          (err, stdout) => ok(err && !stdout ? JSON.stringify({ _error: String(err.message) }) : stdout)
        );
      });
    } catch (e) {
      body = JSON.stringify({ _error: String(e && e.message || e) });
    }
  }
  searchCache.set(clave, { at: Date.now(), body });
  if (searchCache.size > SEARCH_MAX_ENTRIES) {
    const sobran = [...searchCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, searchCache.size - SEARCH_MAX_ENTRIES);
    for (const [k] of sobran) searchCache.delete(k);
  }
  return body;
}
const AUTH_FILE = join(DIR, "auth.json");
let auth = null;
try {
  auth = JSON.parse((await readFile(AUTH_FILE, "utf8")).replace(/^\uFEFF/, ""));
} catch {
}
const COOKIE = "gw_auth";
const COOKIE_TTL_MS = 30 * 24 * 3600 * 1e3;
const HMAC_KEY = String(cfg.secretKey || "aegis-web") + "|" + String(cfg.authStamp || "v1");
function sign(exp) {
  return crypto.createHmac("sha256", HMAC_KEY).update(`gw|${exp}`).digest("base64url");
}
function makeToken(ttl = COOKIE_TTL_MS) {
  const exp = Date.now() + ttl;
  return `${exp}.${sign(exp)}`;
}
function verifyToken(tok) {
  const [exp, sig] = String(tok || "").split(".");
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) < Date.now()) return false;
  const want = sign(exp);
  if (want.length !== sig.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig));
  } catch {
    return false;
  }
}
function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function authed(req) {
  return verifyToken(parseCookies(req.headers.cookie)[COOKIE]);
}
const PRIVATE_V4 = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  // CGNAT / Tailscale
  /^127\./,
  /^169\.254\./
];
function isPrivateIp(host) {
  return PRIVATE_V4.some((re) => re.test(host));
}
function isTunnel(req) {
  const peer = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  const loopback = peer === "127.0.0.1" || peer === "::1";
  if (loopback && (req.headers["cf-connecting-ip"] || req.headers["cf-ray"] || req.headers["cf-worker"])) return true;
  const lanPeer = isPrivateIp(peer) || peer.startsWith("fc") || peer.startsWith("fd") || /^fe[89ab]/.test(peer);
  if (!loopback && !lanPeer) return true;
  const h = req.headers;
  const host = String(h.host || "").split(":")[0].toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return false;
  if (host === String(cfg.publicHost || "").toLowerCase()) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return !isPrivateIp(host);
  return true;
}
const loginFails = /* @__PURE__ */ new Map();
function loginBlocked(ip) {
  const e = loginFails.get(ip);
  if (!e) return false;
  if (Date.now() - e.at > 6e4) {
    loginFails.delete(ip);
    return false;
  }
  return e.n >= 8;
}
function noteLoginFail(ip) {
  const e = loginFails.get(ip);
  if (!e || Date.now() - e.at > 6e4) loginFails.set(ip, { n: 1, at: Date.now() });
  else e.n += 1;
}
function loginPage(variant, next) {
  const error = variant === "bad" ? '<p class="err" id="err" role="alert">Contraseña incorrecta. Probá de nuevo.</p>' : variant === "blocked" ? '<p class="err" id="err" role="alert">Demasiados intentos. Esperá un minuto antes de reintentar.</p>' : "";
  const invalid = error ? ' aria-invalid="true" aria-describedby="err"' : "";
  const action = "/login?next=" + encodeURIComponent(safeNext(next));
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1e1d1b"><meta name="color-scheme" content="dark">
<meta name="robots" content="noindex"><title>Aegis · acceso</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #1e1d1b; --card: #262523; --border: rgba(245, 244, 239, 0.10);
    --text: #f2f1ec; --text-2: rgba(242, 241, 236, 0.78); --text-3: rgba(242, 241, 236, 0.60);
    --accent: #d97757; --accent-strong: #e58c6c; --on-accent: #21140f; --danger: #e5828c;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center;
    padding: calc(16px + env(safe-area-inset-top)) 16px calc(16px + env(safe-area-inset-bottom));
    background: var(--bg); color: var(--text);
    font: 15px/1.5 "Segoe UI", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  form {
    width: min(100%, 360px); background: var(--card); border: 1px solid var(--border);
    border-radius: 14px; padding: 22px 22px 20px; box-shadow: 0 18px 44px rgba(0, 0, 0, 0.45);
  }
  .brand { display: flex; align-items: center; gap: 8px; margin-bottom: 18px; color: var(--text); }
  .brand svg { display: block; }
  .brand b { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
  .chip {
    font-size: 9.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3);
    border: 1px solid var(--border); border-radius: 5px; padding: 1px 4px; line-height: 1.4;
  }
  h1 { margin: 0 0 4px; font-size: 17px; font-weight: 600; letter-spacing: -0.01em; }
  .sub { margin: 0 0 16px; color: var(--text-3); font-size: 12.5px; }
  label { display: block; font-size: 12px; font-weight: 600; color: var(--text-2); margin-bottom: 6px; }
  input {
    width: 100%; padding: 10px 12px; border-radius: 9px; border: 1px solid var(--border);
    background: #191816; color: var(--text); font-size: 16px; font-family: inherit;
  }
  input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; border-color: var(--accent); }
  input[aria-invalid="true"] { border-color: rgba(229, 130, 140, 0.55); }
  input[aria-invalid="true"]:focus-visible { outline-color: var(--danger); }
  button {
    margin-top: 14px; width: 100%; padding: 10px; border: 0; border-radius: 9px;
    background: var(--accent); color: var(--on-accent); font: inherit; font-weight: 600; font-size: 14.5px;
    cursor: pointer; touch-action: manipulation;
  }
  button:hover { background: var(--accent-strong); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .err { margin: 10px 0 0; color: var(--danger); font-size: 12.5px; }
  .hint { margin: 14px 0 0; color: var(--text-3); font-size: 11.5px; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
</style></head>
<body>
<form method="post" action="${action}" autocomplete="off">
  <div class="brand">
    <svg viewBox="0 0 128 128" width="18" height="18" aria-hidden="true"><circle cx="64" cy="66" r="36" fill="none" stroke="currentColor" stroke-width="13" stroke-dasharray="196 30" stroke-linecap="round" transform="rotate(-110 64 66)"/><circle cx="46" cy="34" r="13" fill="currentColor"/></svg>
    <b>Aegis</b><span class="chip">web</span>
  </div>
  <h1>Acceso al harness</h1>
  <p class="sub">Estás entrando por el túnel de Cloudflare.</p>
  <label for="password">Contraseña</label>
  <input id="password" type="password" name="password" placeholder="Contraseña" autocomplete="current-password" autofocus required${invalid}>
  <button type="submit">Entrar</button>
  ${error}
  <p class="hint">La sesión queda guardada 30 días en este dispositivo.</p>
</form>
</body></html>`;
}
function safeNext(next) {
  const n = String(next || "/");
  if (!n.startsWith("/") || n.startsWith("//") || /[\\\x00-\x1f\x7f]/.test(n) || /%5c/i.test(n)) return "/";
  if (n.startsWith("/login")) return "/";
  return n;
}
function sameOriginRequest(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  if (origin !== void 0) {
    if (typeof origin !== "string") return false;
    try {
      const secure = !!req.socket.encrypted || isTunnel(req);
      const expected = new URL(`${secure ? "https" : "http"}://${req.headers.host || ""}`);
      const received = new URL(origin);
      if (received.origin !== expected.origin || received.origin === "null") return false;
    } catch {
      return false;
    }
  }
  return true;
}
function redirect(res, location, extraHeaders = {}) {
  res.writeHead(302, { location, "cache-control": "no-store", ...extraHeaders });
  res.end();
}
function readsHtml(req) {
  return req.method === "GET" && String(req.headers.accept || "").includes("text/html");
}
function configFor(req) {
  const tunneled = isTunnel(req);
  const secureReq = !!(req.socket && req.socket.encrypted);
  const proxied = tunneled || secureReq;
  const host = req.headers.host || `${cfg.publicHost}:${cfg.webPort}`;
  return {
    tunneled,
    acpUrl: proxied ? `wss://${host}/acp?token=${cfg.secretKey}` : `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`,
    host: proxied ? host : `${cfg.publicHost}:${cfg.servePort}`
  };
}
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};
const SEC = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff"
};
const SEC_LOGIN = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
  "x-content-type-options": "nosniff"
};
function proxyAcp(req, socket, head) {
  const headers = { ...req.headers };
  headers.host = `127.0.0.1:${cfg.servePort}`;
  headers.origin = process.env.AEGIS_ACP_ORIGIN || `http://127.0.0.1:${cfg.webPort}`;
  for (const k of ["cf-connecting-ip", "cf-ray", "cf-ipcountry", "cf-ipcity", "x-forwarded-for", "x-forwarded-proto", "x-real-ip"]) {
    delete headers[k];
  }
  const up = http.request({
    host: "127.0.0.1",
    port: Number(cfg.servePort),
    method: req.method,
    path: req.url,
    headers
  });
  const rawHead = (res) => {
    const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage}`];
    for (let i = 0; i < res.rawHeaders.length; i += 2) lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
    return lines.join("\r\n") + "\r\n\r\n";
  };
  up.on("upgrade", (res, upSocket, upHead) => {
    socket.write(rawHead(res));
    if (upHead && upHead.length) socket.write(upHead);
    if (head && head.length) upSocket.write(head);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    const kill = () => {
      socket.destroy();
      upSocket.destroy();
    };
    socket.on("error", kill).on("close", () => upSocket.destroy());
    upSocket.on("error", kill).on("close", () => socket.destroy());
  });
  up.on("response", (res) => {
    socket.write(rawHead(res));
    res.pipe(socket);
  });
  up.on("error", (err) => {
    logLine("server.err.log", `[acp-proxy] ${(/* @__PURE__ */ new Date()).toISOString()} ${err.message}
`);
    try {
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    } catch {
    }
    socket.destroy();
  });
  up.end();
}
import { piperVivo, piperDespertar } from "./piper-vivo.js";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
const PIPER_EXE = "C:/Aegis-Proyects/core/state/piper/bin/piper/piper.exe";
const PIPER_DIR = "C:/Aegis-Proyects/core/state/piper/voices";
const PIPER_VOZ = "es_AR-daniela-high";
const _ttsCache = /* @__PURE__ */ new Map();
const TTS_CACHE_MAX = 24;
const TTS_TEXT_MAX = 1200;
const TTS_IN_FLIGHT_MAX = 2;
const TTS_WAITING_MAX = 6;
let ttsInFlight = 0;
let ttsWaiting = 0;
const ttsWaiters = [];
async function ttsSlot() {
  if (ttsInFlight < TTS_IN_FLIGHT_MAX) {
    ttsInFlight++;
  } else {
    if (ttsWaiting >= TTS_WAITING_MAX) throw new Error("tts ocupado");
    ttsWaiting++;
    await new Promise((resolve2) => ttsWaiters.push(resolve2));
    ttsWaiting--;
  }
  return () => {
    const next = ttsWaiters.shift();
    if (next) next();
    else ttsInFlight--;
  };
}
let _vocesPiper = null;
async function vozPiperValida(voz) {
  const fss = await import("node:fs");
  try {
    if (!_vocesPiper) {
      _vocesPiper = new Set(
        fss.readdirSync(PIPER_DIR).filter((f) => f.endsWith(".onnx")).map((f) => f.slice(0, -5))
      );
    }
  } catch (e) {
    _vocesPiper = /* @__PURE__ */ new Set([PIPER_VOZ]);
  }
  const v = String(voz || "").replace(/[^A-Za-z0-9_.-]/g, "");
  return _vocesPiper.has(v) ? v : PIPER_VOZ;
}
let _caminoTts = "vivo";
function headroomWav(buf, objetivo = 0.84) {
  if (!buf || buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") return buf;
  const out = Buffer.from(buf);
  let off = 12;
  while (off + 8 <= out.length) {
    const id = out.toString("ascii", off, off + 4);
    const tam = out.readUInt32LE(off + 4);
    if (id === "data") {
      const ini = off + 8;
      const fin = Math.min(ini + tam, out.length);
      let pico = 0;
      for (let i = ini; i + 1 < fin; i += 2) {
        const v = Math.abs(out.readInt16LE(i));
        if (v > pico) pico = v;
      }
      const techo = Math.round(32767 * objetivo);
      if (pico <= techo || pico === 0) return buf;
      const g = techo / pico;
      for (let i = ini; i + 1 < fin; i += 2) {
        const v = Math.max(-32768, Math.min(32767, Math.round(out.readInt16LE(i) * g)));
        out.writeInt16LE(v, i);
      }
      return out;
    }
    off += 8 + tam + tam % 2;
  }
  return buf;
}
async function piperTts(texto, voz, rate, ns = 0.667, nw = 0.8) {
  const modelo = await vozPiperValida(voz);
  const ritmo = Number(rate) > 0.5 && Number(rate) < 2 ? 1 / Number(rate) : 1;
  const clave = modelo + ritmo.toFixed(3) + ns.toFixed(3) + nw.toFixed(3) + texto;
  const guardado = _ttsCache.get(clave);
  if (guardado) return guardado;
  let audio;
  try {
    audio = await piperVivo(texto, modelo, ritmo, ns, nw);
    _caminoTts = "vivo";
  } catch (e) {
    audio = await piperSuelto(texto, modelo, ritmo, ns, nw);
    _caminoTts = "suelto";
  }
  audio = headroomWav(audio);
  if (_ttsCache.size >= TTS_CACHE_MAX) _ttsCache.delete(_ttsCache.keys().next().value);
  _ttsCache.set(clave, audio);
  return audio;
}
async function piperSuelto(texto, modelo, ritmo, ns = 0.667, nw = 0.8) {
  const { spawn } = await import("node:child_process");
  const clave = modelo + "|" + ritmo.toFixed(3) + "|" + ns.toFixed(3) + "|" + nw.toFixed(3) + "|" + texto;
  const guardado = _ttsCache.get(clave);
  if (guardado) return guardado;
  const audio = await new Promise((resolve2, reject) => {
    const p = spawn(PIPER_EXE, [
      "-m",
      PIPER_DIR + "/" + modelo + ".onnx",
      "-f",
      "-",
      "--length_scale",
      String(ritmo),
      "--noise_scale",
      String(ns),
      "--noise_w",
      String(nw),
      "--sentence_silence",
      "0.12",
      // pausa mas corta entre oraciones (por defecto 0.2)
      "-q"
    ]);
    const partes = [];
    let err = "";
    let bytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill();
    }, 35e3);
    p.stdout.on("data", (d) => {
      bytes += d.length;
      if (bytes > 12 * 1024 * 1024) {
        p.kill();
        return;
      }
      partes.push(d);
    });
    p.stderr.on("data", (d) => {
      err = (err + d.toString()).slice(-300);
    });
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error("piper suelto sin respuesta en 35000 ms"));
      if (bytes > 12 * 1024 * 1024) return reject(new Error("piper audio demasiado grande"));
      const buf = Buffer.concat(partes);
      if (code !== 0) return reject(new Error("piper exit " + code + " " + err.slice(0, 200)));
      if (buf.length < 100) return reject(new Error("piper sin audio: " + err.slice(0, 150)));
      resolve2(buf);
    });
    p.stdin.write(String(texto));
    p.stdin.end();
  });
  if (_ttsCache.size >= TTS_CACHE_MAX) _ttsCache.delete(_ttsCache.keys().next().value);
  _ttsCache.set(clave, audio);
  return audio;
}
function backendTcpReady() {
  return new Promise((resolve2) => {
    const socket = net.connect({ host: "127.0.0.1", port: Number(cfg.servePort) });
    let finished = false;
    const done = (ready) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve2(ready);
    };
    socket.setTimeout(800, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
piperDespertar().catch(() => {
});
const EDGE_VOZ = "es-AR-ElenaNeural";
const EDGE_VOCES = /* @__PURE__ */ new Set(["es-AR-ElenaNeural", "es-AR-TomasNeural", "es-MX-DaliaNeural", "es-ES-ElviraNeural", "es-ES-AlvaroNeural"]);
const _edge = new MsEdgeTTS();
let _edgeVoz = "";
let _edgeCola = Promise.resolve();
async function edgeTts(texto, voz, rate) {
  const modelo = EDGE_VOCES.has(voz) ? voz : EDGE_VOZ;
  const pct = Math.round((Number(rate) > 0.5 && Number(rate) < 2 ? Number(rate) : 1) * 100 - 100);
  const clave = "edge|" + modelo + "|" + pct + "|" + texto;
  const guardado = _ttsCache.get(clave);
  if (guardado) return guardado;
  const tarea = async () => {
    if (_edgeVoz !== modelo) {
      await _edge.setMetadata(modelo, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      _edgeVoz = modelo;
    }
    const { audioStream } = _edge.toStream(texto, { rate: (pct >= 0 ? "+" : "") + pct + "%" });
    const buf2 = await new Promise((resolve2, reject) => {
      const partes = [];
      audioStream.on("data", (x) => partes.push(x));
      audioStream.on("end", () => resolve2(Buffer.concat(partes)));
      audioStream.on("error", reject);
    });
    if (!buf2 || !buf2.length) throw new Error("edge-tts sin audio");
    return buf2;
  };
  const encadenada = _edgeCola.then(tarea, tarea);
  _edgeCola = encadenada.catch(() => {
  });
  const buf = await encadenada;
  if (_ttsCache.size >= TTS_CACHE_MAX) _ttsCache.delete(_ttsCache.keys().next().value);
  _ttsCache.set(clave, buf);
  return buf;
}
const handler = async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const ip = req.socket.remoteAddress || "?";
    const tunneled = isTunnel(req);
    const t0 = Date.now();
    let status = 0;
    const writeHeadOriginal = res.writeHead.bind(res);
    res.writeHead = ((code, ...resto) => {
      status = code;
      return writeHeadOriginal(code, ...resto);
    });
    res.on("finish", () => {
      logLine(
        "requests.log",
        (/* @__PURE__ */ new Date()).toISOString() + " " + ip + (tunneled ? " [tunel]" : "") + " fin " + req.method + " " + url.pathname + " -> " + status + " " + (Date.now() - t0) + "ms\n"
      );
    });
    logLine(
      "requests.log",
      `${(/* @__PURE__ */ new Date()).toISOString()} ${ip}${tunneled ? " [tunel]" : ""} ${req.method} ${url.pathname} ua="${String(req.headers["user-agent"] || "").replace(/[\r\n\x00-\x1f\x7f"]/g, " ").slice(0, 110)}"
`
    );
    if (url.pathname === "/tts" && req.method === "GET") {
      if (tunneled && !authed(req)) {
        res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "unauthorized", login: "/login" }));
        return;
      }
      const texto = url.searchParams.get("text") || "";
      if (texto.length > TTS_TEXT_MAX) {
        res.writeHead(413, { "content-type": "text/plain", "cache-control": "no-store" });
        res.end("tts: text excede " + TTS_TEXT_MAX + " caracteres");
        return;
      }
      const motor = String(url.searchParams.get("engine") || cfg.ttsEngine || "piper");
      const voz = String(url.searchParams.get("voice") || cfg.ttsVoice || PIPER_VOZ);
      const rate = Number(url.searchParams.get("rate") || cfg.ttsRate || 1.05);
      const ns = Number(url.searchParams.get("ns") || cfg.ttsNoiseScale || 0.667);
      const nw = Number(url.searchParams.get("nw") || cfg.ttsNoiseW || 0.8);
      if (!texto) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("falta text");
        return;
      }
      let releaseTts;
      try {
        releaseTts = await ttsSlot();
      } catch {
        res.writeHead(503, { "content-type": "text/plain", "cache-control": "no-store", "retry-after": "2" });
        res.end("tts ocupado");
        return;
      }
      try {
        let audio;
        let tipo = "audio/wav";
        let motorUsado = "piper";
        if (motor === "edge") {
          try {
            audio = await edgeTts(texto, String(url.searchParams.get("voice") || cfg.ttsEdgeVoice || EDGE_VOZ), rate);
            tipo = "audio/mpeg";
            motorUsado = "edge";
          } catch (e) {
            logLine("tts.log", (/* @__PURE__ */ new Date()).toISOString() + " edge fallo: " + String(e?.message || e).slice(0, 160) + " -> piper\n");
            audio = await piperTts(texto, voz, rate, ns, nw);
          }
        } else {
          audio = await piperTts(texto, voz, rate, ns, nw);
        }
        if (!audio || !audio.length) throw new Error("sin audio");
        res.writeHead(200, {
          "content-type": tipo,
          "content-length": String(audio.length),
          "cache-control": "no-store",
          "x-aegis-tts-path": motorUsado === "edge" ? "edge" : _caminoTts,
          "x-aegis-tts-engine": motorUsado
        });
        res.end(audio);
      } catch (err) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("tts: " + (err && err.message ? err.message : String(err)));
      } finally {
        releaseTts();
      }
      return;
    }
    if (url.pathname === "/healthz") {
      const done = authed(req);
      const backendReady = await backendTcpReady();
      const readiness = url.searchParams.get("backend") === "1";
      res.writeHead(readiness && !backendReady ? 503 : 200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(
        JSON.stringify({
          ok: readiness ? backendReady : true,
          processReady: true,
          backendTcpReady: backendReady,
          tunneled,
          authenticated: done,
          backend: `ws://127.0.0.1:${cfg.servePort}/acp`.replace(/token=.*/, "")
        })
      );
      return;
    }
    if (url.pathname === "/logout") {
      logLine("auth.log", `${(/* @__PURE__ */ new Date()).toISOString()} logout ip=${ip} camino=${tunneled ? "tunel" : "lan"}
`);
      const secureLogout = String(req.headers["x-forwarded-proto"] || "").includes("https") ? "; Secure" : "";
      redirect(res, "/login", {
        "set-cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureLogout}`
      });
      return;
    }
    if (url.pathname === "/login") {
      if (req.method === "POST") {
        if (!sameOriginRequest(req)) {
          res.writeHead(403, { "content-type": "text/plain", "cache-control": "no-store" });
          res.end("forbidden");
          return;
        }
        if (!auth || !auth.password) {
          res.writeHead(503, { "content-type": "text/plain" });
          res.end("sin auth.json");
          return;
        }
        if (loginBlocked(ip)) {
          res.writeHead(429, { "content-type": "text/html; charset=utf-8", ...SEC_LOGIN });
          res.end(loginPage("blocked", null));
          return;
        }
        let body2 = "";
        for await (const chunk of req) {
          body2 += chunk;
          if (body2.length > 4096) break;
        }
        const sent = new URLSearchParams(body2).get("password") || "";
        const want = String(auth.password);
        const ok = sent.length === want.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(want));
        if (!ok) {
          noteLoginFail(ip);
          logLine("auth.log", `${(/* @__PURE__ */ new Date()).toISOString()} login FALLO ip=${ip} tunnel=${tunneled}
`);
          res.writeHead(401, { "content-type": "text/html; charset=utf-8", ...SEC_LOGIN });
          res.end(loginPage("bad", url.searchParams.get("next")));
          return;
        }
        loginFails.delete(ip);
        logLine("auth.log", `${(/* @__PURE__ */ new Date()).toISOString()} login OK ip=${ip} tunnel=${tunneled}
`);
        const secure = String(req.headers["x-forwarded-proto"] || "").includes("https") ? "; Secure" : "";
        redirect(res, safeNext(url.searchParams.get("next")), {
          "set-cookie": `${COOKIE}=${encodeURIComponent(makeToken())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_TTL_MS / 1e3}${secure}`
        });
        return;
      }
      if (authed(req)) {
        redirect(res, safeNext(url.searchParams.get("next")));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...SEC_LOGIN });
      res.end(loginPage("ok", url.searchParams.get("next")));
      return;
    }
    if (tunneled && !authed(req)) {
      if (readsHtml(req)) {
        redirect(res, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
      } else {
        res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "unauthorized", login: "/login" }));
      }
      return;
    }
    if (url.pathname === "/client-log" && req.method === "POST") {
      const maxBytes = 4e4;
      if (Number(req.headers["content-length"]) > maxBytes) {
        res.writeHead(413, { connection: "close" });
        res.end();
        return;
      }
      const chunks = [];
      let bytes = 0;
      const received = await new Promise((resolve2) => {
        let settled = false;
        const finish = (ok) => {
          if (settled) return;
          settled = true;
          req.off("data", onData);
          req.off("end", onEnd);
          req.off("aborted", onAborted);
          req.off("error", onAborted);
          req.setTimeout(0);
          resolve2(ok);
        };
        const onData = (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            finish(false);
            req.resume();
          } else chunks.push(chunk);
        };
        const onEnd = () => finish(true);
        const onAborted = () => finish(false);
        req.on("data", onData);
        req.once("end", onEnd);
        req.once("aborted", onAborted);
        req.once("error", onAborted);
        req.setTimeout(1e4, () => finish(false));
      });
      if (!received) {
        if (!res.destroyed) {
          res.writeHead(bytes > maxBytes ? 413 : 408, { connection: "close" });
          res.end();
        }
        return;
      }
      logLine("client.log", `--- ${(/* @__PURE__ */ new Date()).toISOString()} ${ip}
${Buffer.concat(chunks).toString("utf8")}
`);
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === "/ws/defaults") {
      if (req.method === "POST") {
        try {
          const body2 = await readJsonBody(req);
          const root = body2 && typeof body2.root === "string" ? body2.root : "";
          if (!root || !wsInside(root)) {
            res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store", ...SEC });
            res.end(JSON.stringify({ error: "root fuera de las raices permitidas" }));
            return;
          }
          const key = wsDefaultsKey(root);
          await withFileQueue(WS_DEFAULTS_FILE, async () => {
            const data3 = await readWsDefaults();
            if (body2 && body2.defaults && typeof body2.defaults === "object") {
              data3[key] = { root: resolve(root), defaults: body2.defaults, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
            } else {
              delete data3[key];
            }
            await writeWsDefaults(data3);
          });
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", ...SEC });
          res.end(JSON.stringify({ ok: true, key }));
        } catch (e) {
          res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store", ...SEC });
          res.end(JSON.stringify({ error: String(e?.message || e) }));
        }
        return;
      }
      const data2 = await withFileQueue(WS_DEFAULTS_FILE, readWsDefaults);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache", ...SEC });
      res.end(JSON.stringify(data2));
      return;
    }
    if (url.pathname === "/changes.json") {
      const headers2 = { "content-type": "application/json", "cache-control": "no-store", ...SEC };
      const reply = (status2, body2) => {
        res.writeHead(status2, headers2);
        res.end(JSON.stringify(body2));
      };
      if (!authed(req)) {
        reply(401, { error: "unauthorized", login: "/login" });
        return;
      }
      if (req.method !== "GET" || !sameOriginRequest(req)) {
        reply(403, { error: "forbidden" });
        return;
      }
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId) || url.searchParams.getAll("sessionId").length !== 1) {
        reply(400, { error: "sessionId requerido" });
        return;
      }
      const suppliedCwd = url.searchParams.get("cwd");
      if (url.searchParams.getAll("cwd").length > 1 || suppliedCwd !== null && (!isAbsolute(suppliedCwd) || /[\x00-\x1f\x7f]/.test(suppliedCwd))) {
        reply(400, { error: "cwd invalido" });
        return;
      }
      let raw;
      try {
        const dbPath = join(process.env.AEGIS_PATH_ROOT || "C:/Aegis-Proyects/state", "data", "sessions", "sessions.db");
        const worker = `const { DatabaseSync } = require('node:sqlite');
          const db = new DatabaseSync(process.argv[1], { readOnly: true });
          try { const row = db.prepare('SELECT working_dir FROM sessions WHERE id = ?').get(process.argv[2]);
            process.stdout.write(JSON.stringify(row ? row.working_dir : null)); }
          finally { db.close(); }`;
        const output = await new Promise((ok, fail) => {
          execFile(
            process.execPath,
            ["--disable-warning=ExperimentalWarning", "--experimental-sqlite", "-e", worker, dbPath, sessionId],
            { encoding: "utf8", timeout: 1e4, maxBuffer: 8192, windowsHide: true },
            (error, stdout) => error ? fail(error) : ok(stdout)
          );
        });
        const stored = JSON.parse(output);
        if (stored === null) {
          reply(404, { error: "sesion no encontrada" });
          return;
        }
        if (typeof stored !== "string" || !isAbsolute(stored) || /[\x00-\x1f\x7f]/.test(stored)) {
          reply(403, { error: "cwd no permitido" });
          return;
        }
        raw = stored;
      } catch {
        reply(503, { error: "sesiones no disponibles" });
        return;
      }
      if (suppliedCwd !== null && resolve(suppliedCwd).toLowerCase() !== resolve(raw).toLowerCase()) {
        reply(403, { error: "cwd no coincide con sesion" });
        return;
      }
      const denied = (path) => /(?:^|[\\/])(?:state|config|\.git|\.ssh|\.aws|\.config|AppData|\.env(?:\..*)?|auth\.json|config\.(?:json|ya?ml)|secrets?\.ya?ml|permission\.ya?ml|tokens\.json|credentials?(?:\.[^\\/]*)?|id_(?:rsa|ed25519)|[^\\/]+\.(?:pem|key|p12|pfx|db|sqlite[0-9]*))(?:[\\/]|$)/i.test(path);
      const inside = (path, root) => {
        const p = resolve(path).toLowerCase();
        const r = resolve(root).toLowerCase();
        return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
      };
      const lexical = resolve(raw);
      if (!wsInside(lexical) || denied(lexical)) {
        reply(403, { error: "cwd no permitido" });
        return;
      }
      let actual;
      try {
        actual = await realpath(lexical);
      } catch {
        reply(404, { error: "cwd no disponible" });
        return;
      }
      try {
        const roots = await Promise.all(WS_ROOTS.map(async (root) => ({ root, actual: await realpath(root).catch(() => "") })));
        const allowed = (candidate, real) => roots.some(({ root, actual: rootReal }) => rootReal && inside(candidate, root) && inside(real, rootReal));
        if (!allowed(lexical, actual) || denied(actual) || !(await stat(actual)).isDirectory()) {
          reply(403, { error: "cwd no permitido" });
          return;
        }
        const output = await new Promise((ok, fail) => {
          execFile(
            process.execPath,
            [join(DIR, "tools", "changes-index.mjs"), "--cwd", actual],
            { encoding: "utf8", timeout: 35e3, maxBuffer: 1024 * 1024, windowsHide: true },
            (error, stdout) => error ? fail(error) : ok(stdout)
          );
        });
        const data2 = JSON.parse(output);
        if (!data2 || typeof data2 !== "object" || !("kind" in data2)) throw new Error("invalid result");
        const result = data2;
        if (result.kind === "not-git") {
          reply(200, { kind: "not-git", cwd: actual, entries: [], truncated: false });
          return;
        }
        if (result.kind !== "git" || typeof result.root !== "string" || !isAbsolute(result.root) || !Array.isArray(result.entries)) {
          throw new Error("invalid result");
        }
        const gitRoot = resolve(result.root);
        const gitReal = await realpath(gitRoot);
        const rootAllowed = roots.some(({ root, actual: rootReal }) => rootReal && inside(lexical, root) && inside(gitReal, rootReal) && (inside(gitRoot, root) || inside(gitRoot, rootReal)));
        if (!rootAllowed || denied(gitRoot) || denied(gitReal)) {
          reply(403, { error: "repositorio no permitido" });
          return;
        }
        const entries = result.entries.slice(0, 60).filter((entry) => {
          if (!entry || typeof entry !== "object") return false;
          const item = entry;
          if (typeof item.path !== "string" || typeof item.staged !== "string" || typeof item.worktree !== "string" || typeof item.diff !== "string") return false;
          if (!item.path || isAbsolute(item.path) || item.path.includes("\\") || item.path.split("/").some((part) => !part || part === "." || part === "..")) return false;
          return !denied(item.path) && !denied(resolve(gitRoot, item.path));
        });
        reply(200, { kind: "git", cwd: actual, root: gitRoot, entries, truncated: result.truncated === true || entries.length !== result.entries.length });
      } catch {
        reply(502, { kind: "error", entries: [], truncated: false, error: "Cambios no disponibles" });
      }
      return;
    }
    if (url.pathname === "/file.json") {
      if (!authed(req)) {
        res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store", ...SEC });
        res.end(JSON.stringify({ error: "unauthorized", login: "/login" }));
        return;
      }
      if (req.method !== "GET" || !sameOriginRequest(req)) {
        res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store", ...SEC });
        res.end(JSON.stringify({ error: "forbidden" }));
        return;
      }
      const raw = url.searchParams.get("path") || "";
      const resolvedPath = resolve(raw);
      const deny = (path) => /(?:^|[\\/])(?:\.git|\.ssh|\.aws|\.config|AppData|\.env(?:\..*)?|auth\.json|config\.json|config\.ya?ml|permission\.ya?ml|secrets\.ya?ml|tokens\.json|id_(?:rsa|ed25519)|[^\\/]+\.(?:pem|key|p12|pfx|db|sqlite[0-9]*))(?:[\\/]|$)/i.test(path);
      const allowed = (path) => wsInside(path) && !deny(path);
      if (!raw || !allowed(resolvedPath)) {
        res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store", ...SEC });
        res.end(JSON.stringify({ error: "ruta no permitida" }));
        return;
      }
      try {
        const actualPath = await realpath(resolvedPath);
        const roots = await Promise.all(WS_ROOTS.map((root) => realpath(root).catch(() => "")));
        const actual = actualPath.toLowerCase();
        if (!roots.some((root) => root && (actual === root.toLowerCase() || actual.startsWith(root.toLowerCase().endsWith(sep) ? root.toLowerCase() : root.toLowerCase() + sep))) || deny(actualPath)) {
          res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store", ...SEC });
          res.end(JSON.stringify({ error: "ruta real no permitida" }));
          return;
        }
        const handle = await open(actualPath, "r");
        let info;
        let body2;
        try {
          info = await handle.stat();
          if (!info.isFile()) throw new Error("no es un archivo");
          if (info.size > 15e5) {
            res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", ...SEC });
            res.end(JSON.stringify({ path: resolvedPath, tooLarge: true, bytes: info.size }));
            return;
          }
          const buffer = Buffer.alloc(1500001);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (bytesRead > 15e5) {
            res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", ...SEC });
            res.end(JSON.stringify({ path: resolvedPath, tooLarge: true, bytes: bytesRead }));
            return;
          }
          body2 = buffer.subarray(0, bytesRead);
        } finally {
          await handle.close();
        }
        const text = body2.toString("utf8");
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", ...SEC });
        res.end(JSON.stringify({
          path: resolvedPath,
          exists: true,
          bytes: body2.length,
          mtime: info.mtime.toISOString(),
          sha256: crypto.createHash("sha256").update(body2).digest("hex"),
          text,
          lines: text.split("\n").length
        }));
      } catch {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", ...SEC });
        res.end(JSON.stringify({ path: resolvedPath, exists: false, bytes: 0, text: "", lines: 0 }));
      }
      return;
    }
    if (url.pathname === "/outbox.json") {
      const name = url.searchParams.get("name") || "";
      const preview = url.searchParams.get("preview") === "1";
      if (preview && name) {
        if (!outboxName(name)) {
          res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store", ...SEC });
          res.end(JSON.stringify({ error: "nombre invalido" }));
          return;
        }
        try {
          const { handle, info } = await openOutboxFile(name);
          let body2;
          try {
            if (info.size > OUTBOX_PREVIEW_MAX) {
              res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", ...SEC });
              res.end(JSON.stringify({ name, tooLarge: true, bytes: info.size }));
              return;
            }
            const buffer = Buffer.alloc(OUTBOX_PREVIEW_MAX + 1);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            if (bytesRead > OUTBOX_PREVIEW_MAX) {
              res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", ...SEC });
              res.end(JSON.stringify({ name, tooLarge: true, bytes: bytesRead }));
              return;
            }
            body2 = buffer.subarray(0, bytesRead);
          } finally {
            await handle.close();
          }
          const ext = extname(name).toLowerCase();
          const binary = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".zip"].includes(ext);
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", ...SEC });
          res.end(JSON.stringify({
            name,
            bytes: body2.length,
            ext,
            binary,
            text: binary ? "" : body2.toString("utf8"),
            dataUrl: binary ? "data:application/octet-stream;base64," + body2.toString("base64") : ""
          }));
        } catch {
          res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store", ...SEC });
          res.end(JSON.stringify({ error: "archivo no disponible" }));
        }
        return;
      }
      const items = [];
      try {
        const dir = await opendir(OUTBOX);
        for await (const entry of dir) {
          if (!entry.isFile() || !outboxName(entry.name)) continue;
          try {
            const { handle, info } = await openOutboxFile(entry.name);
            await handle.close();
            items.push({
              name: entry.name,
              bytes: info.size,
              mtime: info.mtime.toISOString(),
              ext: extname(entry.name).toLowerCase(),
              url: "/dl/" + encodeURIComponent(entry.name)
            });
          } catch {
          }
        }
      } catch {
      }
      items.sort((a, b) => a.mtime < b.mtime ? 1 : -1);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", ...SEC });
      res.end(JSON.stringify({ dir: OUTBOX, items }));
      return;
    }
    if (url.pathname === "/pending.json") {
      const previous = pendingCache.get("all");
      let body2 = previous && Date.now() - previous.at < 3e4 ? previous.body : "";
      if (!body2) {
        try {
          body2 = await new Promise((ok, fail) => {
            execFile(
              process.execPath,
              ["--experimental-sqlite", join(DIR, "tools", "pending-index.mjs")],
              {
                timeout: 4e4,
                maxBuffer: 8 * 1024 * 1024,
                env: { ...process.env, AEGIS_PATH_ROOT: process.env.AEGIS_PATH_ROOT || "C:/Aegis-Proyects/state" }
              },
              (error, stdout) => error ? fail(error) : ok(stdout.trim())
            );
          });
          if (!body2) throw new Error("indice vacio");
          JSON.parse(body2);
          pendingCache.set("all", { at: Date.now(), body: body2 });
        } catch (error) {
          body2 = JSON.stringify({ sessions: [], total: 0, error: String(error?.message || error) });
        }
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache", ...SEC });
      res.end(body2);
      return;
    }
    if (url.pathname === "/memory.json") {
      if (req.method === "POST") {
        try {
          const body2 = await readJsonBody(req);
          const action = body2 && typeof body2.action === "string" ? body2.action : "";
          await withFileQueue(MEMORY_FACTS_FILE, async () => {
            const facts2 = await readMemoryFacts();
            const find = (id2) => facts2.find((fact) => fact.id === id2);
            const now = (/* @__PURE__ */ new Date()).toISOString();
            let changed = false;
            if (action === "consolidate") {
              const { execFileSync } = await import("node:child_process");
              const exe = process.env.AEGIS_SERVE_BIN || "C:/Aegis-Proyects/core/bin/aegis-current.exe";
              let stdout = "";
              try {
                stdout = execFileSync(exe, ["--memory-consolidate"], {
                  env: { ...process.env, AEGIS_PATH_ROOT: process.env.AEGIS_PATH_ROOT || "C:/Aegis-Proyects/state" },
                  encoding: "utf8",
                  timeout: 3e4,
                  maxBuffer: 1024 * 1024
                });
              } catch (e) {
                res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store", ...SEC });
                res.end(JSON.stringify({ ok: false, error: "consolidate fallo: " + String(e?.message || e).slice(0, 300) }));
                return;
              }
              const after = await readMemoryFacts();
              res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", ...SEC });
              res.end(JSON.stringify({ ok: true, output: stdout.trim(), facts: after }));
              return;
            }
            const id = body2 && typeof body2.id === "string" ? body2.id : "";
            if (action === "add") {
              const text = body2 && typeof body2.text === "string" ? body2.text.trim() : "";
              if (!text) {
                res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store", ...SEC });
                res.end(JSON.stringify({ error: "text requerido" }));
                return;
              }
              facts2.push({
                id: nextMemoryId(facts2),
                text,
                kind: body2?.kind && body2.kind.trim() ? body2.kind.trim() : "fact",
                tags: [],
                confidence: typeof body2?.confidence === "number" ? Math.max(0, Math.min(1, body2.confidence)) : 0.9,
                pinned: body2?.pinned === true,
                status: "confirmed",
                source: "declared",
                evidence: ["panel: declarado"],
                created: now,
                updated: now,
                last_seen: now,
                session: "panel"
              });
              changed = true;
            } else if (id) {
              const fact = find(id);
              if (!fact) {
                res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store", ...SEC });
                res.end(JSON.stringify({ error: "hecho inexistente: " + id }));
                return;
              }
              if (action === "confirm") {
                fact.status = "confirmed";
                fact.updated = now;
                changed = true;
              } else if (action === "reject") {
                fact.status = "rejected";
                fact.updated = now;
                changed = true;
              } else if (action === "pin") {
                fact.pinned = true;
                fact.updated = now;
                changed = true;
              } else if (action === "unpin") {
                fact.pinned = false;
                fact.updated = now;
                changed = true;
              }
            }
            if (!changed) {
              res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store", ...SEC });
              res.end(JSON.stringify({ error: "accion no reconocida" }));
              return;
            }
            await writeMemoryFacts(facts2);
            res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", ...SEC });
            res.end(JSON.stringify({ ok: true, facts: await readMemoryFacts() }));
          });
        } catch (e) {
          res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store", ...SEC });
          res.end(JSON.stringify({ error: String(e?.message || e) }));
        }
        return;
      }
      const facts = await withFileQueue(MEMORY_FACTS_FILE, readMemoryFacts);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", ...SEC });
      res.end(JSON.stringify({ path: MEMORY_FACTS_FILE, facts }));
      return;
    }
    if (url.pathname === "/ws/list") {
      const body2 = await workspaceList(url.searchParams.get("path") || "");
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache", ...SEC });
      res.end(body2);
      return;
    }
    if (url.pathname === "/prices.json") {
      let body2 = "{}";
      try {
        body2 = await readFile(join(DIR, "prices.json"), "utf8");
      } catch (e) {
        body2 = JSON.stringify({ _error: String(e && e.message || e) });
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache", ...SEC });
      res.end(body2);
      return;
    }
    if (url.pathname === "/goals.json") {
      const body2 = await goalsIndex(url.searchParams.get("sid") || "");
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache", ...SEC });
      res.end(body2);
      return;
    }
    if (url.pathname === "/search.json") {
      const q = url.searchParams.get("q") || "";
      const lim = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") || 20) || 20));
      const body2 = await searchIndex(q, lim);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache", ...SEC });
      res.end(body2);
      return;
    }
    if (url.pathname === "/stats.json") {
      const dias = Math.max(0, Math.min(3650, Number(url.searchParams.get("days") || 30) || 0));
      const body2 = await statsIndex(dias);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache", ...SEC });
      res.end(body2);
      return;
    }
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === "/config.js") {
      if (!sameOriginRequest(req)) {
        res.writeHead(403, { "content-type": "text/plain", "cache-control": "no-store" });
        res.end("forbidden");
        return;
      }
      const c = configFor(req);
      const body2 = `window.__AEGIS_APP__ = ${JSON.stringify({
        acpUrl: c.acpUrl,
        cwd: cfg.cwd || "C:\\Users\\Emiliano",
        host: c.host,
        version: (cfg.appConfig || {}).AEGIS_VERSION || "web",
        tunnel: c.tunneled,
        authed: authed(req),
        // Modelo con el que arranca un chat nuevo: lo define el servidor (appConfig). Se muestra en
        // la pantalla de bienvenida para saber que va a usar antes de escribir el primer mensaje.
        defaultProvider: (cfg.appConfig || {}).AEGIS_DEFAULT_PROVIDER || "",
        defaultModel: (cfg.appConfig || {}).AEGIS_DEFAULT_MODEL || "",
        defaultEffort: (cfg.appConfig || {}).AEGIS_THINKING_EFFORT || ""
      })};`;
      res.writeHead(200, { "content-type": MIME[".js"], "cache-control": "no-store", "cross-origin-resource-policy": "same-origin", ...SEC });
      res.end(body2);
      return;
    }
    if (url.pathname.startsWith("/dl/") && req.method === "GET") {
      let name = "";
      try {
        name = decodeURIComponent(url.pathname.slice(4));
      } catch {
      }
      if (!outboxName(name)) {
        res.writeHead(400, { "content-type": "text/plain", "cache-control": "no-store", ...SEC });
        res.end("bad path");
        return;
      }
      let opened;
      try {
        opened = await openOutboxFile(name);
      } catch {
        res.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store", ...SEC });
        res.end("not found");
        return;
      }
      const { handle, info } = opened;
      try {
        if (info.size > 512 * 1024 * 1024) {
          res.writeHead(413, { "content-type": "text/plain", "cache-control": "no-store", ...SEC });
          res.end("file too large");
          return;
        }
        const type2 = MIME[extname(name).toLowerCase()] || "application/octet-stream";
        res.writeHead(200, {
          "content-type": type2,
          "content-length": info.size,
          "content-disposition": `attachment; filename="${name.replace(/["\r\n]/g, "")}"`,
          "cache-control": "no-store",
          ...SEC
        });
        if (info.size === 0) {
          res.end();
          return;
        }
        await pipeline(handle.createReadStream({ start: 0, end: info.size - 1, autoClose: false }), res);
      } catch {
        res.destroy();
      } finally {
        await handle.close();
      }
      return;
    }
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";
    const rel = normalize(pathname).replace(/^[/\\]+/, "");
    if (rel.includes("..")) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("bad path");
      return;
    }
    const file = join(APP, rel);
    let data;
    try {
      data = await readFile(file);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    if (rel === "index.html") {
      const html = String(data);
      const assets = [
        "app.css",
        "bundle.js",
        "app.js",
        "skills.js",
        "memory.js",
        "artifacts.js",
        "workspace-nav.js",
        "context-meter.js",
        "session-mode.js",
        "palette.js",
        "onboarding.js",
        "handoff.js",
        "split-view.js",
        "stats.js",
        "activity.js",
        "changes.js"
      ];
      const versions = await Promise.all(assets.map(async (asset) => {
        try {
          return [asset, crypto.createHash("sha256").update(await readFile(join(APP, asset))).digest("hex")];
        } catch {
          return [asset, ""];
        }
      }));
      data = Buffer.from(versions.reduce((markup, [asset, hash]) => hash ? markup.replace(`./${asset}"`, `./${asset}?v=${hash}"`) : markup, html));
    }
    const type = MIME[extname(file).toLowerCase()] || "application/octet-stream";
    const headers = { "content-type": type, "cache-control": "no-cache", ...SEC };
    const comprimible = /^(text|application\/(javascript|json)|image\/svg)/.test(type);
    const contentHash = crypto.createHash("sha256").update(data).digest("hex");
    if (comprimible && url.searchParams.size === 1 && url.searchParams.get("v") === contentHash) {
      headers["cache-control"] = "public, max-age=31536000, immutable";
    }
    const etag = `"${contentHash}"`;
    headers.etag = etag;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { "cache-control": headers["cache-control"], etag });
      res.end();
      return;
    }
    let body = data;
    const acepta = String(req.headers["accept-encoding"] || "");
    const claveContenido = file + ":" + crypto.createHash("sha1").update(data).digest("hex");
    if (comprimible && /\bbr\b/.test(acepta)) {
      body = brotliBuf(data, claveContenido);
      headers["content-encoding"] = "br";
      headers["vary"] = "accept-encoding";
    } else if (comprimible && /\bgzip\b/.test(acepta)) {
      body = gzipBuf(data, claveContenido);
      headers["content-encoding"] = "gzip";
      headers["vary"] = "accept-encoding";
    }
    headers["content-length"] = String(body.length);
    res.writeHead(200, headers);
    res.end(body);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(err));
  }
};
const server = http.createServer(handler);
const onUpgrade = (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    socket.destroy();
    return;
  }
  if (url.pathname !== "/acp") {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  if (!sameOriginRequest(req)) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  if (isTunnel(req) && !authed(req)) {
    logLine("auth.log", `${(/* @__PURE__ */ new Date()).toISOString()} upgrade BLOQUEADO ${req.headers.host} ip=${req.socket.remoteAddress}
`);
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return;
  }
  proxyAcp(req, socket, head);
};
server.on("upgrade", onUpgrade);
const port = Number(process.env.AEGIS_WEB_PORT || cfg.webPort || 3788);
server.listen(port, "0.0.0.0", () => {
  sweepPendingAtStartup();
  console.log(`[aegis-web] UI:      http://${cfg.publicHost}:${port}   (LAN)`);
  console.log(`[aegis-web] UI:      http://127.0.0.1:${port}          (local)`);
  console.log(`[aegis-web] backend: ws://${cfg.publicHost}:${cfg.servePort}/acp   (directo, LAN)`);
  console.log(`[aegis-web] tunel:   wss://<host>/acp proxeado a 127.0.0.1:${cfg.servePort}  (login: ${auth ? "auth.json" : "SIN auth.json -> tunel cerrado"})`);
});
const tlsDir = process.env.AEGIS_WEB_TLS_DIR || cfg.tlsDir || "";
const httpsPort = Number(process.env.AEGIS_WEB_HTTPS_PORT || cfg.httpsPort || 3789);
if (tlsDir) {
  const crtPath = join(tlsDir, "server.crt");
  const keyPath = join(tlsDir, "server.key");
  try {
    if (fs.existsSync(crtPath) && fs.existsSync(keyPath)) {
      const secure = https.createServer({ cert: fs.readFileSync(crtPath), key: fs.readFileSync(keyPath) }, handler);
      secure.on("upgrade", onUpgrade);
      secure.listen(httpsPort, "0.0.0.0", () => {
        console.log(`[aegis-web] UI TLS:  https://${cfg.publicHost}:${httpsPort}   (LAN, dictado por voz habilitado)`);
        console.log(`[aegis-web] UI TLS:  https://127.0.0.1:${httpsPort}          (local)`);
      });
      secure.on("error", (e) => console.log("[aegis-web] TLS error: " + e.message));
    } else {
      console.log("[aegis-web] sin certificado TLS en " + tlsDir + " (voz en LAN deshabilitada)");
    }
  } catch (e) {
    console.log("[aegis-web] TLS no arranco: " + e.message);
  }
}

// aegis-web: sirve la app de chat propia (app/) y genera /config.js por request.
// El token del backend nunca vive en archivos estáticos: se inyecta al vuelo.
//
// v7 (tunel Cloudflare):
//  - Detecta pedidos que llegan por el tunel (cabeceras cf-*) o por un dominio publico.
//  - Esos pedidos exigen login propio (cookie firmada) contra auth.json; la LAN sigue abierta.
//  - /config.js se adapta: en el tunel el WS va a wss://<host>/acp (mismo origen) y este
//    server lo proxea a aegis serve en 127.0.0.1:<servePort> reescribiendo el Origin.
import http, { type IncomingMessage, type ServerResponse, type OutgoingHttpHeaders } from 'node:http';
import type { Socket } from 'node:net';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { readFile, appendFile, mkdir, stat } from 'node:fs/promises';
import zlib from 'node:zlib';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('.', import.meta.url));

type WebConfig = { secretKey?: string; authStamp?: string; publicHost?: string; webPort?: number; servePort?: number; ttsEngine?: string; ttsVoice?: string; ttsRate?: number; cwd?: string; appConfig?: { AEGIS_VERSION?: string; AEGIS_DEFAULT_PROVIDER?: string; AEGIS_DEFAULT_MODEL?: string }; tlsDir?: string; httpsPort?: number };
// Estaticos: comprimidos (gzip) y, cuando la URL viene versionada por mtime (?v=...), se
// cachean para siempre. Antes el telefono bajaba 203 KB sin comprimir en cada carga.
const gzipCache = new Map<string, Buffer>();
function gzipBuf(buf: Buffer, key: string) {
  const hit = gzipCache.get(key);
  if (hit) return hit;
  const out = zlib.gzipSync(buf, { level: 6 });
  if (gzipCache.size > 40) gzipCache.clear();
  gzipCache.set(key, out);
  return out;
}
const cfg = JSON.parse(await readFile(join(DIR, 'config.json'), 'utf8')) as WebConfig;
const APP = join(DIR, 'app');
const OUTBOX = join(DIR, 'outbox');
await mkdir(OUTBOX, { recursive: true }).catch(() => {
});
await mkdir(join(DIR, 'logs'), { recursive: true }).catch(() => {});
const logLine = (file: string, line: string) => appendFile(join(DIR, 'logs', file), line).catch(() => {});

// ---------------------------------------------------------------- auth (tunel)
// ---------------------------------------------------------------- objetivos (/goal y /grind)
// El serve los guarda en extension_data de cada sesion pero no los expone por ACP, asi que se
// indexan desde una copia de sessions.db con un proceso aparte (node --experimental-sqlite).
// Cache de 60 s: el panel del cliente puede refrescar sin castigar el disco.
let goalsCache = new Map<string, { at: number; body: string }>(); // sid -> {at, body} ('' = todos los chats)
async function goalsIndex(sid: string): Promise<string> {
  const clave = sid || '';
  const previo = goalsCache.get(clave);
  if (previo && Date.now() - previo.at < 60000) return previo.body;
  let body;
  try {
    const { execFile } = await import('node:child_process');
    const args = ['--experimental-sqlite', join(DIR, 'tools', 'goals-index.mjs')];
    if (clave) args.push(clave);
    body = await new Promise<string>((ok) => {
      execFile(
        process.execPath,
        args,
        { timeout: 40000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => ok(err && !stdout ? JSON.stringify({ _error: String(err.message) }) : stdout),
      );
    });
  } catch (e) {
    body = JSON.stringify({ _error: String(((e as Error) && (e as Error).message) || e) });
  }
  goalsCache = new Map([[clave, { at: Date.now(), body }]]);
  return body;
}

// ---------------------------------------------------------------- gasto (/stats.json)
// Panel "Gasto": agrega la tabla usage_ledger de sessions.db (una fila por llamada, con costo
// y tokens de cache). Mismo patron que goalsIndex: proceso aparte con --experimental-sqlite y
// cache corto, para no bloquear el event loop con un SQLite de 290 MB.
let statsCache = new Map<string, { at: number; body: string }>(); // days -> {at, body}
async function statsIndex(days: number): Promise<string> {
  const clave = String(days || 0);
  const previo = statsCache.get(clave);
  if (previo && Date.now() - previo.at < 60000) return previo.body;
  let body;
  try {
    const { execFile } = await import('node:child_process');
    const args = ['--experimental-sqlite', join(DIR, 'tools', 'stats-index.mjs'), '--days', clave];
    body = await new Promise<string>((ok) => {
      execFile(
        process.execPath,
        args,
        { timeout: 40000, maxBuffer: 32 * 1024 * 1024 },
        (err, stdout) => ok(err && !stdout ? JSON.stringify({ _error: String(err.message) }) : stdout),
      );
    });
  } catch (e) {
    body = JSON.stringify({ _error: String(((e as Error) && (e as Error).message) || e) });
  }
  statsCache = new Map([[clave, { at: Date.now(), body }]]);
  return body;
}

const AUTH_FILE = join(DIR, 'auth.json');
let auth: { password?: string } | null = null;
try {
  auth = JSON.parse((await readFile(AUTH_FILE, 'utf8')).replace(/^\uFEFF/, ''));
} catch {}
const COOKIE = 'gw_auth';
const COOKIE_TTL_MS = 30 * 24 * 3600 * 1000;
// La cookie se firma con el secreto + una marca de sesion. Rotar "authStamp" en config.json
// invalida TODAS las cookies ya emitidas (es la forma de cerrar todas las sesiones sin tocar el
// secreto que tambien viaja en el token del WebSocket del ACP).
const HMAC_KEY = String(cfg.secretKey || 'aegis-web') + '|' + String(cfg.authStamp || 'v1');

function sign(exp: string | number) {
  return crypto.createHmac('sha256', HMAC_KEY).update(`gw|${exp}`).digest('base64url');
}
function makeToken(ttl = COOKIE_TTL_MS) {
  const exp = Date.now() + ttl;
  return `${exp}.${sign(exp)}`;
}
function verifyToken(tok: string | undefined) {
  const [exp, sig] = String(tok || '').split('.');
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
function parseCookies(header: string | undefined) {
  const out: Record<string, string> = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function authed(req: IncomingMessage) {
  return verifyToken(parseCookies(req.headers.cookie)[COOKIE]);
}

const PRIVATE_V4 = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT / Tailscale
  /^127\./,
  /^169\.254\./,
];
function isPrivateIp(host: string) {
  return PRIVATE_V4.some((re) => re.test(host));
}
function isTunnel(req: IncomingMessage) {
  const peer = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const loopback = peer === '127.0.0.1' || peer === '::1';
  // Only the local tunnel proxy may supply the Cloudflare hop markers.
  if (loopback && (req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['cf-worker'])) return true;
  // Solo un peer privado (IPv4/IPv6 LAN) puede usar el atajo LAN por Host.
  const lanPeer = isPrivateIp(peer) || peer.startsWith('fc') || peer.startsWith('fd') || /^fe[89ab]/.test(peer);
  if (!loopback && !lanPeer) return true;
  const h = req.headers;
  // cf-* sin peer de loopback es falsificable y no clasifica por si solo.
  const host = String(h.host || '').split(':')[0].toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return false;
  if (host === String(cfg.publicHost || '').toLowerCase()) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return !isPrivateIp(host);
  return true; // hostname: no es loopback ni el host LAN => viene del tunel
}

// freno de fuerza bruta en /login (por IP, ventana de 60 s)
const loginFails = new Map<string, { n: number; at: number }>();
function loginBlocked(ip: string) {
  const e = loginFails.get(ip);
  if (!e) return false;
  if (Date.now() - e.at > 60000) {
    loginFails.delete(ip);
    return false;
  }
  return e.n >= 8;
}
function noteLoginFail(ip: string) {
  const e = loginFails.get(ip);
  if (!e || Date.now() - e.at > 60000) loginFails.set(ip, { n: 1, at: Date.now() });
  else e.n += 1;
}

const LOGIN_PAGE = `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0d0d0e"><title>Aegis \u00b7 acceso</title>
<style>
 :root { color-scheme: dark; }
 body { margin:0; min-height:100dvh; display:grid; place-items:center; background:#0d0d0e; color:#e8e8ea;
        font:15px/1.45 -apple-system,Segoe UI,Roboto,sans-serif; }
 form { width:min(92vw,340px); background:#161618; border:1px solid #242427; border-radius:14px; padding:22px; }
 h1 { margin:0 0 4px; font-size:17px; } .sub { margin:0 0 18px; color:#9a9aa2; font-size:12.5px; }
 input { width:100%; box-sizing:border-box; padding:11px 12px; border-radius:9px; border:1px solid #2c2c31;
         background:#101012; color:#e8e8ea; font-size:16px; }
 button { margin-top:12px; width:100%; padding:11px; border:0; border-radius:9px; background:#0053fd;
          color:#fff; font-size:15px; font-weight:600; }
 .err { color:#ff8080; font-size:12.5px; margin-top:10px; }
 .hint { color:#6f6f77; font-size:11.5px; margin-top:14px; }
</style></head>
<body><form method="post" action="/login" autocomplete="off">
 <h1>Aegis web</h1>
 <p class="sub">Acceso por el tunel de Cloudflare</p>
 <input type="password" name="password" placeholder="Contrasena" autofocus required>
 <button type="submit">Entrar</button>
 __ERR__
 <p class="hint">La sesion queda guardada 30 dias en este dispositivo.</p>
</form></body></html>`;

const LOGIN_HTML_OK = LOGIN_PAGE.replace('__ERR__', '');
const LOGIN_HTML_ERR = LOGIN_PAGE.replace('__ERR__', '<div class="err">Contrasena incorrecta.</div>');
const LOGIN_HTML_BLOCK = LOGIN_PAGE.replace('__ERR__', '<div class="err">Demasiados intentos. Espera un minuto.</div>');

function safeNext(next: string | null) {
  const n = String(next || '/');
  // WHATWG URLs interpret backslashes as slashes in http(s) redirects (including /\\evil).
  if (!n.startsWith('/') || n.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(n) || /%5c/i.test(n)) return '/';
  if (n.startsWith('/login')) return '/';
  return n;
}

// Browser metadata protects classic <script src="/config.js"> and the cookie-authenticated
// WebSocket proxy. Missing metadata is allowed for older/LAN clients; it is not a complete
// defense against clients that omit these headers (or deliberately forge them).
function sameOriginRequest(req: IncomingMessage) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (typeof origin !== 'string') return false;
    try {
      // The tunnel terminates TLS before the local HTTP server; direct LAN TLS is encrypted.
      const secure = !!(req.socket as Socket & { encrypted?: boolean }).encrypted || isTunnel(req);
      const expected = new URL(`${secure ? 'https' : 'http'}://${req.headers.host || ''}`);
      const received = new URL(origin);
      if (received.origin !== expected.origin || received.origin === 'null') return false;
    } catch {
      return false;
    }
  }
  return true;
}
function redirect(res: ServerResponse, location: string, extraHeaders: OutgoingHttpHeaders = {}) {
  res.writeHead(302, { location, 'cache-control': 'no-store', ...extraHeaders });
  res.end();
}
function readsHtml(req: IncomingMessage) {
  return req.method === 'GET' && String(req.headers.accept || '').includes('text/html');
}

// ------------------------------------------------------- config.js por request
function configFor(req: IncomingMessage) {
  const tunneled = isTunnel(req);
  // https directo en LAN (3789): una pagina https NO puede abrir ws:// (mixed content), asi que
  // tambien va por el proxy mismo-origen -> wss://<host>/acp. El login sigue siendo solo del tunel.
  const secureReq = !!(req.socket && (req.socket as Socket & { encrypted?: boolean }).encrypted);
  const proxied = tunneled || secureReq;
  const host = req.headers.host || `${cfg.publicHost}:${cfg.webPort}`;
  return {
    tunneled,
    acpUrl: proxied
      ? `wss://${host}/acp?token=${cfg.secretKey}`
      : `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`,
    host: proxied ? host : `${cfg.publicHost}:${cfg.servePort}`,
  };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};
const SEC = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
};
const SEC_LOGIN = {
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
};

// --------------------------------------------------------- proxy ACP (/acp)
function proxyAcp(req: IncomingMessage, socket: Socket, head: Buffer) {
  const headers = { ...req.headers };
  headers.host = `127.0.0.1:${cfg.servePort}`;
  headers.origin = process.env.AEGIS_ACP_ORIGIN || `http://127.0.0.1:${cfg.webPort}`; // esta en --allowed-origin del serve
  for (const k of ['cf-connecting-ip', 'cf-ray', 'cf-ipcountry', 'cf-ipcity', 'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip']) {
    delete headers[k];
  }
  const up = http.request({
    host: '127.0.0.1',
    port: Number(cfg.servePort),
    method: req.method,
    path: req.url,
    headers,
  });
  const rawHead = (res: IncomingMessage) => {
    const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage}`];
    for (let i = 0; i < res.rawHeaders.length; i += 2) lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
    return lines.join('\r\n') + '\r\n\r\n';
  };
  up.on('upgrade', (res, upSocket, upHead) => {
    socket.write(rawHead(res));
    if (upHead && upHead.length) socket.write(upHead);
    if (head && head.length) upSocket.write(head);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    const kill = () => {
      socket.destroy();
      upSocket.destroy();
    };
    socket.on('error', kill).on('close', () => upSocket.destroy());
    upSocket.on('error', kill).on('close', () => socket.destroy());
  });
  up.on('response', (res) => {
    // handshake rechazado por el backend (401/403): se devuelve tal cual
    socket.write(rawHead(res));
    res.pipe(socket);
  });
  up.on('error', (err) => {
    logLine('server.err.log', `[acp-proxy] ${new Date().toISOString()} ${err.message}\n`);
    try {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    } catch {}
    socket.destroy();
  });
  up.end();
}

// --- Piper: voces neuronales LOCALES (offline, sin claves, CPU). Es el motor por defecto.
import { piperVivo, piperDespertar } from './piper-vivo.js';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
const PIPER_EXE = 'C:/Aegis-Proyects/core/state/piper/bin/piper/piper.exe';
const PIPER_DIR = 'C:/Aegis-Proyects/core/state/piper/voices';
// UNICO motor: Piper local. Se borraron edge-tts (Microsoft contesta 403 desde que cambio el
// esquema de token) y Groq (exige aceptar terminos y no tiene voz en espanol): solo servian
// para fallar y meter latencia.
const PIPER_VOZ = 'es_AR-daniela-high';
const _ttsCache = new Map<string, Buffer>();          // texto+voz ->Buffer, para no resintetizar lo mismo
const TTS_CACHE_MAX = 24;
let _vocesPiper: Set<string> | null = null;
async function vozPiperValida(voz: string): Promise<string> {
  const fss = await import('node:fs');
  try {
    if (!_vocesPiper) {
      _vocesPiper = new Set(
        fss.readdirSync(PIPER_DIR).filter((f) => f.endsWith('.onnx')).map((f) => f.slice(0, -5))
      );
    }
  } catch (e) { _vocesPiper = new Set([PIPER_VOZ]); }
  const v = String(voz || '').replace(/[^A-Za-z0-9_.-]/g, '');
  return _vocesPiper.has(v) ? v : PIPER_VOZ;   // voz de otro motor (es-AR-TomasNeural) cae a la local
}
// Camino rapido: el proceso vivo ya tiene el modelo cargado. Si falla, se arranca uno nuevo
// (piperSuelto), que es como se hacia antes.
let _caminoTts = 'vivo';

// Headroom: Piper entrega picos a 0 dBFS y en el parlante del telefono eso satura.
// Se escala a -1.5 dBFS solo si hace falta (sin tocar el volumen percibido del resto).
function headroomWav(buf: Buffer, objetivo = 0.84): Buffer {
  if (!buf || buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return buf;
  const out = Buffer.from(buf);
  let off = 12;
  while (off + 8 <= out.length) {
    const id = out.toString('ascii', off, off + 4);
    const tam = out.readUInt32LE(off + 4);
    if (id === 'data') {
      const ini = off + 8;
      const fin = Math.min(ini + tam, out.length);
      let pico = 0;
      for (let i = ini; i + 1 < fin; i += 2) { const v = Math.abs(out.readInt16LE(i)); if (v > pico) pico = v; }
      const techo = Math.round(32767 * objetivo);
      if (pico <= techo || pico === 0) return buf;
      const g = techo / pico;
      for (let i = ini; i + 1 < fin; i += 2) {
        const v = Math.max(-32768, Math.min(32767, Math.round(out.readInt16LE(i) * g)));
        out.writeInt16LE(v, i);
      }
      return out;
    }
    off += 8 + tam + (tam % 2);
  }
  return buf;
}
async function piperTts(texto: string, voz: string, rate: number, ns = 0.667, nw = 0.8): Promise<Buffer> {
  const modelo = await vozPiperValida(voz);
  const ritmo = Number(rate) > 0.5 && Number(rate) < 2 ? 1 / Number(rate) : 1;
  const clave = modelo + ritmo.toFixed(3) + ns.toFixed(3) + nw.toFixed(3) + texto;
  const guardado = _ttsCache.get(clave);
  if (guardado) return guardado;
  let audio;
  try {
    audio = await piperVivo(texto, modelo, ritmo, ns, nw);
    _caminoTts = 'vivo';
  } catch (e) {
    audio = await piperSuelto(texto, modelo, ritmo, ns, nw);
    _caminoTts = 'suelto';
  }
  audio = headroomWav(audio);
  if (_ttsCache.size >= TTS_CACHE_MAX) _ttsCache.delete(_ttsCache.keys().next().value as string);
  _ttsCache.set(clave, audio);
  return audio;
}
async function piperSuelto(texto: string, modelo: string, ritmo: number, ns = 0.667, nw = 0.8): Promise<Buffer> {
  const { spawn } = await import('node:child_process');
  const clave = modelo + '|' + ritmo.toFixed(3) + '|' + ns.toFixed(3) + '|' + nw.toFixed(3) + '|' + texto;
  const guardado = _ttsCache.get(clave);
  if (guardado) return guardado;
  const audio = await new Promise<Buffer>((resolve, reject) => {
    // -f - escribe el WAV en stdout: sin archivo temporal (menos I/O y nada que limpiar).
    const p = spawn(PIPER_EXE, [
      '-m', PIPER_DIR + '/' + modelo + '.onnx',
      '-f', '-',
      '--length_scale', String(ritmo),
      '--noise_scale', String(ns),
      '--noise_w', String(nw),
      '--sentence_silence', '0.12',   // pausa mas corta entre oraciones (por defecto 0.2)
      '-q',
    ]);
    const partes: Buffer[] = [];
    let err = '';
    p.stdout.on("data", (d) => partes.push(d));
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", reject);
    p.on("close", (code) => {
      const buf = Buffer.concat(partes);
      if (code !== 0) return reject(new Error('piper exit ' + code + ' ' + err.slice(0, 200)));
      if (!buf || buf.length < 100) return reject(new Error('piper sin audio: ' + err.slice(0, 150)));
      resolve(buf);
    });
    p.stdin.write(String(texto));
    p.stdin.end();
  });
  if (_ttsCache.size >= TTS_CACHE_MAX) _ttsCache.delete(_ttsCache.keys().next().value as string);
  _ttsCache.set(clave, audio);
  return audio;
}


// /healthz sigue siendo liveness (watchdog); ?backend=1 exige readiness TCP del serve.
function backendTcpReady() {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: Number(cfg.servePort) });
    let finished = false;
    const done = (ready: boolean) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(800, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// ------------------------------------------------------------------- server
piperDespertar().catch(() => {});

// Microsoft Edge (edge-tts): voces neuronales gratis, sin cuenta. Cliente nativo (WebSocket)
// en vez del CLI de Python: medido 0,6-0,8 s por frase contra ~4 s del spawn. Serializado en
// una cola porque la instancia es stateful.
const EDGE_VOZ = 'es-AR-ElenaNeural';
const EDGE_VOCES = new Set(['es-AR-ElenaNeural', 'es-AR-TomasNeural', 'es-MX-DaliaNeural', 'es-ES-ElviraNeural', 'es-ES-AlvaroNeural']);
const _edge = new MsEdgeTTS();
let _edgeVoz = '';
let _edgeCola: Promise<unknown> = Promise.resolve();
async function edgeTts(texto: string, voz: string, rate: number): Promise<Buffer> {
  const modelo = EDGE_VOCES.has(voz) ? voz : EDGE_VOZ;
  const pct = Math.round((Number(rate) > 0.5 && Number(rate) < 2 ? Number(rate) : 1) * 100 - 100);
  const clave = 'edge|' + modelo + '|' + pct + '|' + texto;
  const guardado = _ttsCache.get(clave);
  if (guardado) return guardado;
  const tarea = async (): Promise<Buffer> => {
    if (_edgeVoz !== modelo) {
      await _edge.setMetadata(modelo, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      _edgeVoz = modelo;
    }
    const { audioStream } = _edge.toStream(texto, { rate: (pct >= 0 ? '+' : '') + pct + '%' });
    const buf = await new Promise<Buffer>((resolve, reject) => {
      const partes: Buffer[] = [];
      audioStream.on('data', (x: Buffer) => partes.push(x));
      audioStream.on('end', () => resolve(Buffer.concat(partes)));
      audioStream.on('error', reject);
    });
    if (!buf || !buf.length) throw new Error('edge-tts sin audio');
    return buf;
  };
  const encadenada = _edgeCola.then(tarea, tarea);
  _edgeCola = encadenada.catch(() => {});
  const buf = await encadenada;
  if (_ttsCache.size >= TTS_CACHE_MAX) _ttsCache.delete(_ttsCache.keys().next().value as string);
  _ttsCache.set(clave, buf);
  return buf;
}

const handler = async (req: IncomingMessage, res: ServerResponse) => {
  try {
    const url = new URL(req.url as string, 'http://localhost');
    const ip = req.socket.remoteAddress || '?';
    const tunneled = isTunnel(req);
    // Salida de cada request con status y duracion: sin esto los 5xx y los cuelgues no se
    // podian contar (la linea de arriba registra solo la llegada). Si el request nunca
    // termina, aparece la de llegada y no esta: esa ausencia es el sintoma del cuelgue.
    const t0 = Date.now();
    let status = 0;
    const writeHeadOriginal = res.writeHead.bind(res);
    res.writeHead = ((code: number, ...resto: unknown[]) => {
      status = code;
      return (writeHeadOriginal as (code: number, ...resto: unknown[]) => ServerResponse)(code, ...resto);
    }) as ServerResponse['writeHead'];
    res.on('finish', () => {
      logLine(
        'requests.log',
        new Date().toISOString() + ' ' + ip + (tunneled ? ' [tunel]' : '') + ' fin ' + req.method + ' ' + url.pathname +
          ' -> ' + status + ' ' + (Date.now() - t0) + 'ms\n'
      );
    });
    logLine(
      'requests.log',
      `${new Date().toISOString()} ${ip}${tunneled ? ' [tunel]' : ''} ${req.method} ${url.pathname} ua="${String(req.headers['user-agent'] || '').replace(/[\r\n\x00-\x1f\x7f"]/g, ' ').slice(0, 110)}"\n`
    );

    // Voces neuronales de Microsoft (edge-tts). El cliente pide una frase y recibe mp3.
    if (url.pathname === '/tts' && req.method === 'GET') {
      // Esta ruta precede la puerta general del tunel: protegerla explicitamente.
      if (tunneled && !authed(req)) {
        res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: 'unauthorized', login: '/login' }));
        return;
      }
      const texto = String(url.searchParams.get('text') || '').slice(0, 700);
      const motor = String(url.searchParams.get('engine') || cfg.ttsEngine || 'piper');
      // La voz por defecto es la de Piper; si el cliente manda una de otro motor, piperTts la
      // valida contra los modelos instalados y cae a la local.
      const voz = String(url.searchParams.get('voice') || cfg.ttsVoice || PIPER_VOZ);
      const rate = Number(url.searchParams.get('rate') || cfg.ttsRate || 1.05);
      const ns = Number(url.searchParams.get('ns') || (cfg as any).ttsNoiseScale || 0.667);
      const nw = Number(url.searchParams.get('nw') || (cfg as any).ttsNoiseW || 0.8);
      if (!texto) { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('falta text'); return; }
      try {
        let audio: Buffer;
        let tipo = 'audio/wav';
        let motorUsado = 'piper';
        if (motor === 'edge') {
          try {
            audio = await edgeTts(texto, String(url.searchParams.get('voice') || (cfg as any).ttsEdgeVoice || EDGE_VOZ), rate);
            tipo = 'audio/mpeg';
            motorUsado = 'edge';
          } catch (e) {
            logLine('tts.log', new Date().toISOString() + ' edge fallo: ' + String((e as Error)?.message || e).slice(0, 160) + ' -> piper\n');
            audio = await piperTts(texto, voz, rate, ns, nw);
          }
        } else {
          audio = await piperTts(texto, voz, rate, ns, nw);
        }
        if (!audio || !audio.length) throw new Error('sin audio');
        res.writeHead(200, {
          'content-type': tipo,
          'content-length': String(audio.length),
          'cache-control': 'no-store',
          'x-aegis-tts-path': motorUsado === 'edge' ? 'edge' : _caminoTts,
          'x-aegis-tts-engine': motorUsado,
        });
        res.end(audio);
      } catch (err) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('tts: ' + ((err as Error) && (err as Error).message ? (err as Error).message : String(err)));
      }
      return;
    }

    if (url.pathname === '/healthz') {
      const done = authed(req);
      const backendReady = await backendTcpReady();
      const readiness = url.searchParams.get('backend') === '1';
      res.writeHead(readiness && !backendReady ? 503 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(
        JSON.stringify({
          ok: readiness ? backendReady : true,
          processReady: true,
          backendTcpReady: backendReady,
          tunneled,
          authenticated: done,
          backend: `ws://127.0.0.1:${cfg.servePort}/acp`.replace(/token=.*/, ''),
        })
      );
      return;
    }

    // ---- cerrar sesion: borra la cookie firmada y manda al login
    if (url.pathname === '/logout') {
      logLine('auth.log', `${new Date().toISOString()} logout ip=${ip} camino=${tunneled ? 'tunel' : 'lan'}\n`);
      const secureLogout = String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
      redirect(res, '/login', {
        'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureLogout}`,
      });
      return;
    }

    // ---- login (solo tiene sentido por el tunel, pero no molesta en LAN)
    if (url.pathname === '/login') {
      if (req.method === 'POST') {
        // A foreign form must not set a login cookie in the victim's browser.
        if (!sameOriginRequest(req)) {
          res.writeHead(403, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
          res.end('forbidden');
          return;
        }
        if (!auth || !auth.password) {
          res.writeHead(503, { 'content-type': 'text/plain' });
          res.end('sin auth.json');
          return;
        }
        if (loginBlocked(ip)) {
          res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', ...SEC_LOGIN });
          res.end(LOGIN_HTML_BLOCK);
          return;
        }
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 4096) break;
        }
        const sent = new URLSearchParams(body).get('password') || '';
        const want = String(auth.password);
        const ok =
          sent.length === want.length &&
          crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(want));
        if (!ok) {
          noteLoginFail(ip);
          logLine('auth.log', `${new Date().toISOString()} login FALLO ip=${ip} tunnel=${tunneled}\n`);
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', ...SEC_LOGIN });
          res.end(LOGIN_HTML_ERR);
          return;
        }
        loginFails.delete(ip);
        logLine('auth.log', `${new Date().toISOString()} login OK ip=${ip} tunnel=${tunneled}\n`);
        const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
        redirect(res, safeNext(url.searchParams.get('next')), {
          'set-cookie': `${COOKIE}=${encodeURIComponent(makeToken())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${
            COOKIE_TTL_MS / 1000
          }${secure}`,
        });
        return;
      }
      if (authed(req)) {
        redirect(res, safeNext(url.searchParams.get('next')));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SEC_LOGIN });
      res.end(LOGIN_HTML_OK);
      return;
    }

    // ---- puerta del tunel: todo lo demas pide sesion cuando viene de afuera
    if (tunneled && !authed(req)) {
      if (readsHtml(req)) {
        redirect(res, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
      } else {
        res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: 'unauthorized', login: '/login' }));
      }
      return;
    }

    if (url.pathname === '/client-log' && req.method === 'POST') {
      // Cortar por bytes mientras llegan: nunca acumular un body sin limite.
      const maxBytes = 40000;
      if (Number(req.headers['content-length']) > maxBytes) {
        res.writeHead(413, { connection: 'close' });
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      const received = await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          req.off('data', onData);
          req.off('end', onEnd);
          req.off('aborted', onAborted);
          req.off('error', onAborted);
          req.setTimeout(0);
          resolve(ok);
        };
        const onData = (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            finish(false);
            req.resume(); // descartar lo restante, sin guardar mas bytes
          } else chunks.push(chunk);
        };
        const onEnd = () => finish(true);
        const onAborted = () => finish(false);
        req.on('data', onData);
        req.once('end', onEnd);
        req.once('aborted', onAborted);
        req.once('error', onAborted);
        req.setTimeout(10000, () => finish(false));
      });
      if (!received) {
        if (!res.destroyed) {
          res.writeHead(bytes > maxBytes ? 413 : 408, { connection: 'close' });
          res.end();
        }
        return;
      }
      logLine('client.log', `--- ${new Date().toISOString()} ${ip}\n${Buffer.concat(chunks).toString('utf8')}\n`);
      res.writeHead(204);
      res.end();
      return;
    }

    // Precios por modelo: archivo que completa el usuario (no vienen del server de aegis).
    if (url.pathname === '/prices.json') {
      let body = '{}';
      try { body = await readFile(join(DIR, 'prices.json'), 'utf8'); } catch (e) { body = JSON.stringify({ _error: String(((e as Error) && (e as Error).message) || e) }); }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache', ...SEC });
      res.end(body);
      return;
    }
    // Objetivos por conversacion (panel de la barra derecha).
    if (url.pathname === '/goals.json') {
      const body = await goalsIndex(url.searchParams.get('sid') || '');
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache', ...SEC });
      res.end(body);
      return;
    }
    // Gasto y estadisticas de uso (panel "Gasto"): dias=0 -> todo el historial.
    if (url.pathname === '/stats.json') {
      const dias = Math.max(0, Math.min(3650, Number(url.searchParams.get('days') || 30) || 0));
      const body = await statsIndex(dias);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache', ...SEC });
      res.end(body);
      return;
    }
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === '/config.js') {
      // A foreign site can load a classic script despite CORS and read its injected token.
      // Fetch Metadata rejects cross-site/same-site-but-not-same-origin script loads where sent.
      if (!sameOriginRequest(req)) {
        res.writeHead(403, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
        res.end('forbidden');
        return;
      }
      const c = configFor(req);
      const body = `window.__AEGIS_APP__ = ${JSON.stringify({
        acpUrl: c.acpUrl,
        cwd: cfg.cwd || 'C:\\Users\\Emiliano',
        host: c.host,
        version: (cfg.appConfig || {}).AEGIS_VERSION || 'web',
        tunnel: c.tunneled,
        authed: authed(req),
        // Modelo con el que arranca un chat nuevo: lo define el servidor (appConfig). Se muestra en
        // la pantalla de bienvenida para saber que va a usar antes de escribir el primer mensaje.
        defaultProvider: (cfg.appConfig || {}).AEGIS_DEFAULT_PROVIDER || '',
        defaultModel: (cfg.appConfig || {}).AEGIS_DEFAULT_MODEL || '',
      })};`;
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store', 'cross-origin-resource-policy': 'same-origin', ...SEC });
      res.end(body);
      return;
    }

    if (url.pathname.startsWith('/dl/') && req.method === 'GET') {
      const raw = decodeURIComponent(url.pathname.slice(4));
      const name = normalize(raw).replace(/^[/\\]+/, '');
      const plano = name && !name.includes('..') && !name.includes('/') && !name.includes('\\');
      if (!plano) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('bad path');
        return;
      }
      let data;
      try {
        data = await readFile(join(OUTBOX, name));
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      const type = MIME[extname(name).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, {
        'content-type': type,
        'content-length': data.length,
        'content-disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
        'cache-control': 'no-store',
        ...SEC,
      });
      res.end(data);
      return;
    }
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    const rel = normalize(pathname).replace(/^[/\\]+/, '');
    if (rel.includes('..')) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad path');
      return;
    }
    const file = join(APP, rel);

    let data;
    try {
      data = await readFile(file);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }

    // Cache-busting del cliente: sin esto un telefono puede seguir ejecutando un app.js
    // viejo (el 14/10 llego un ReferenceError apuntando a una linea que ya no existe).
    // El HTML referencia siempre la version actual, por mtime.
    if (rel === 'index.html') {
      const stampOf = async (f: string) => {
        const st = await stat(join(APP, f)).catch(() => null);
        return st ? Math.round(st.mtimeMs).toString(36) : '0';
      };
      const vJs = await stampOf('app.js');
      const vCss = await stampOf('app.css');
      const vSkills = await stampOf('skills.js');
      data = Buffer.from(
        String(data).replace('./app.js', './app.js?v=' + vJs).replace('./app.css', './app.css?v=' + vCss).replace('./skills.js', './skills.js?v=' + vSkills),
      );
    }
    const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
    const headers: OutgoingHttpHeaders = { 'content-type': type, 'cache-control': 'no-cache', ...SEC };
    // Versionado por mtime (?v=...): se cachea para siempre. Sin version, no-cache.
    const comprimible = /^(text|application\/(javascript|json)|image\/svg)/.test(type);
    if (url.search && comprimible) {
      headers['cache-control'] = 'public, max-age=31536000, immutable';
    }
    const st = await stat(file).catch(() => null);
    if (st) {
      const etag = `"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
      headers.etag = etag;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { 'cache-control': 'no-cache', etag });
        res.end();
        return;
      }
    }
    let body: Buffer = data;
    if (comprimible && /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""))) {
      // Clave por CONTENIDO, no por mtime: el HTML se reescribe al vuelo con las versiones
      // de app.js/app.css/skills.js, asi que su mtime no alcanza (servia un gzip con las
      // versiones viejas si el HTML no cambiaba).
      const gzKey = file + ':' + crypto.createHash('sha1').update(data).digest('hex');
      body = gzipBuf(data, gzKey);
      headers['content-encoding'] = 'gzip';
      headers['vary'] = 'accept-encoding';
    }
    headers['content-length'] = String(body.length);
    res.writeHead(200, headers);
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(err));
  }
};

const server = http.createServer(handler);

const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => {
  let url;
  try {
    url = new URL(req.url as string, 'http://localhost');
  } catch {
    socket.destroy();
    return;
  }
  if (url.pathname !== '/acp') {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return;
  }
  // proxyAcp overwrites Origin for the backend. Check the browser's Origin first,
  // otherwise a foreign page can use an existing cookie to open an ACP WebSocket.
  if (!sameOriginRequest(req)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  if (isTunnel(req) && !authed(req)) {
    logLine('auth.log', `${new Date().toISOString()} upgrade BLOQUEADO ${req.headers.host} ip=${req.socket.remoteAddress}\n`);
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return;
  }
  proxyAcp(req, socket, head);
};
server.on('upgrade', onUpgrade);

const port = Number(process.env.AEGIS_WEB_PORT || cfg.webPort || 3788);
server.listen(port, '0.0.0.0', () => {
  console.log(`[aegis-web] UI:      http://${cfg.publicHost}:${port}   (LAN)`);
  console.log(`[aegis-web] UI:      http://127.0.0.1:${port}          (local)`);
  console.log(`[aegis-web] backend: ws://${cfg.publicHost}:${cfg.servePort}/acp   (directo, LAN)`);
  console.log(`[aegis-web] tunel:   wss://<host>/acp proxeado a 127.0.0.1:${cfg.servePort}  (login: ${auth ? 'auth.json' : 'SIN auth.json -> tunel cerrado'})`);
});

// ---- HTTPS en LAN (2026-10-15): getUserMedia exige contexto seguro, asi que por la IP de LAN el
// dictado por voz no andaba (el navegador ni pide permiso). El tunel ya era https; esto le da https
// tambien a la LAN. NO se toca el 3788: sigue siendo el origen http del tunel y de los enlaces viejos.
const tlsDir = process.env.AEGIS_WEB_TLS_DIR || cfg.tlsDir || '';
const httpsPort = Number(process.env.AEGIS_WEB_HTTPS_PORT || cfg.httpsPort || 3789);
if (tlsDir) {
  const crtPath = join(tlsDir, 'server.crt');
  const keyPath = join(tlsDir, 'server.key');
  try {
    if (fs.existsSync(crtPath) && fs.existsSync(keyPath)) {
      const secure = https.createServer({ cert: fs.readFileSync(crtPath), key: fs.readFileSync(keyPath) }, handler);
      secure.on('upgrade', onUpgrade);
      secure.listen(httpsPort, '0.0.0.0', () => {
        console.log(`[aegis-web] UI TLS:  https://${cfg.publicHost}:${httpsPort}   (LAN, dictado por voz habilitado)`);
        console.log(`[aegis-web] UI TLS:  https://127.0.0.1:${httpsPort}          (local)`);
      });
      secure.on('error', (e) => console.log('[aegis-web] TLS error: ' + e.message));
    } else {
      console.log('[aegis-web] sin certificado TLS en ' + tlsDir + ' (voz en LAN deshabilitada)');
    }
  } catch (e) {
    console.log('[aegis-web] TLS no arranco: ' + (e as Error).message);
  }
}

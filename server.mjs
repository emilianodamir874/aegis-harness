// aegis-web: sirve la app de chat propia (app/) y genera /config.js por request.
// El token del backend nunca vive en archivos estáticos: se inyecta al vuelo.
//
// v7 (tunel Cloudflare):
//  - Detecta pedidos que llegan por el tunel (cabeceras cf-*) o por un dominio publico.
//  - Esos pedidos exigen login propio (cookie firmada) contra auth.json; la LAN sigue abierta.
//  - /config.js se adapta: en el tunel el WS va a wss://<host>/acp (mismo origen) y este
//    server lo proxea a aegis serve en 127.0.0.1:<servePort> reescribiendo el Origin.
import http from 'node:http';
import crypto from 'node:crypto';
import { readFile, appendFile, mkdir, stat } from 'node:fs/promises';
import zlib from 'node:zlib';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('.', import.meta.url));

// Estaticos: comprimidos (gzip) y, cuando la URL viene versionada por mtime (?v=...), se
// cachean para siempre. Antes el telefono bajaba 203 KB sin comprimir en cada carga.
const gzipCache = new Map();
function gzipBuf(buf, key) {
  const hit = gzipCache.get(key);
  if (hit) return hit;
  const out = zlib.gzipSync(buf, { level: 6 });
  if (gzipCache.size > 40) gzipCache.clear();
  gzipCache.set(key, out);
  return out;
}
const cfg = JSON.parse(await readFile(join(DIR, 'config.json'), 'utf8'));
const APP = join(DIR, 'app');
await mkdir(join(DIR, 'logs'), { recursive: true }).catch(() => {});
const logLine = (file, line) => appendFile(join(DIR, 'logs', file), line).catch(() => {});

// ---------------------------------------------------------------- auth (tunel)
const AUTH_FILE = join(DIR, 'auth.json');
let auth = null;
try {
  auth = JSON.parse((await readFile(AUTH_FILE, 'utf8')).replace(/^\uFEFF/, ''));
} catch {}
const COOKIE = 'gw_auth';
const COOKIE_TTL_MS = 30 * 24 * 3600 * 1000;
const HMAC_KEY = String(cfg.secretKey || 'aegis-web');

function sign(exp) {
  return crypto.createHmac('sha256', HMAC_KEY).update(`gw|${exp}`).digest('base64url');
}
function makeToken(ttl = COOKIE_TTL_MS) {
  const exp = Date.now() + ttl;
  return `${exp}.${sign(exp)}`;
}
function verifyToken(tok) {
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
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
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
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT / Tailscale
  /^127\./,
  /^169\.254\./,
];
function isPrivateIp(host) {
  return PRIVATE_V4.some((re) => re.test(host));
}
function isTunnel(req) {
  const h = req.headers;
  if (h['cf-connecting-ip'] || h['cf-ray'] || h['cf-worker']) return true;
  const host = String(h.host || '').split(':')[0].toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return false;
  if (host === String(cfg.publicHost || '').toLowerCase()) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return !isPrivateIp(host);
  return true; // hostname: no es loopback ni el host LAN => viene del tunel
}

// freno de fuerza bruta en /login (por IP, ventana de 60 s)
const loginFails = new Map();
function loginBlocked(ip) {
  const e = loginFails.get(ip);
  if (!e) return false;
  if (Date.now() - e.at > 60000) {
    loginFails.delete(ip);
    return false;
  }
  return e.n >= 8;
}
function noteLoginFail(ip) {
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

function safeNext(next) {
  const n = String(next || '/');
  if (!n.startsWith('/') || n.startsWith('//')) return '/';
  if (n.startsWith('/login')) return '/';
  return n;
}
function redirect(res, location, extraHeaders = {}) {
  res.writeHead(302, { location, 'cache-control': 'no-store', ...extraHeaders });
  res.end();
}
function readsHtml(req) {
  return req.method === 'GET' && String(req.headers.accept || '').includes('text/html');
}

// ------------------------------------------------------- config.js por request
function configFor(req) {
  const tunneled = isTunnel(req);
  const host = req.headers.host || `${cfg.publicHost}:${cfg.webPort}`;
  return {
    tunneled,
    acpUrl: tunneled
      ? `wss://${host}/acp?token=${cfg.secretKey}`
      : `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`,
    host: tunneled ? host : `${cfg.publicHost}:${cfg.servePort}`,
  };
}

const MIME = {
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
function proxyAcp(req, socket, head) {
  const headers = { ...req.headers };
  headers.host = `127.0.0.1:${cfg.servePort}`;
  headers.origin = `http://127.0.0.1:${cfg.webPort}`; // esta en --allowed-origin del serve
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
  const rawHead = (res) => {
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

// ------------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const ip = req.socket.remoteAddress || '?';
    const tunneled = isTunnel(req);
    logLine(
      'requests.log',
      `${new Date().toISOString()} ${ip}${tunneled ? ' [tunel]' : ''} ${req.method} ${url.pathname}${url.search} ua="${(req.headers['user-agent'] || '').slice(0, 110)}"\n`
    );

    if (url.pathname === '/healthz') {
      const done = authed(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          tunneled,
          authenticated: done,
          backend: `ws://127.0.0.1:${cfg.servePort}/acp`.replace(/token=.*/, ''),
        })
      );
      return;
    }

    // ---- login (solo tiene sentido por el tunel, pero no molesta en LAN)
    if (url.pathname === '/login') {
      if (req.method === 'POST') {
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
      let body = '';
      for await (const chunk of req) body += chunk;
      logLine('client.log', `--- ${new Date().toISOString()} ${ip}\n${body.slice(0, 40000)}\n`);
      res.writeHead(204);
      res.end();
      return;
    }

    // Precios por modelo: archivo que completa el usuario (no vienen del server de aegis).
    if (url.pathname === '/prices.json') {
      let body = '{}';
      try { body = await readFile(join(DIR, 'prices.json'), 'utf8'); } catch (e) { body = JSON.stringify({ _error: String((e && e.message) || e) }); }
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
      const c = configFor(req);
      const body = `window.__AEGIS_APP__ = ${JSON.stringify({
        acpUrl: c.acpUrl,
        cwd: cfg.cwd || 'C:\\Users\\Emiliano',
        host: c.host,
        version: (cfg.appConfig || {}).AEGIS_VERSION || 'web',
        tunnel: c.tunneled,
      })};`;
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-cache', ...SEC });
      res.end(body);
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
      const stampOf = async (f) => {
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
    const headers = { 'content-type': type, 'cache-control': 'no-cache', ...SEC };
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
    let body = data;
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
});

server.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    socket.destroy();
    return;
  }
  if (url.pathname !== '/acp') {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return;
  }
  if (isTunnel(req) && !authed(req)) {
    logLine('auth.log', `${new Date().toISOString()} upgrade BLOQUEADO ${req.headers.host} ip=${req.socket.remoteAddress}\n`);
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return;
  }
  proxyAcp(req, socket, head);
});

const port = Number(process.env.AEGIS_WEB_PORT || cfg.webPort || 3788);
server.listen(port, '0.0.0.0', () => {
  console.log(`[aegis-web] UI:      http://${cfg.publicHost}:${port}   (LAN)`);
  console.log(`[aegis-web] UI:      http://127.0.0.1:${port}          (local)`);
  console.log(`[aegis-web] backend: ws://${cfg.publicHost}:${cfg.servePort}/acp   (directo, LAN)`);
  console.log(`[aegis-web] tunel:   wss://<host>/acp proxeado a 127.0.0.1:${cfg.servePort}  (login: ${auth ? 'auth.json' : 'SIN auth.json -> tunel cerrado'})`);
});

// goose-web: sirve la app de chat propia (app/) y genera /config.js por request.
// El token del backend nunca vive en archivos estáticos: se inyecta al vuelo.
import http from 'node:http';
import { readFile, appendFile, mkdir, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const cfg = JSON.parse(await readFile(join(DIR, 'config.json'), 'utf8'));
const APP = join(DIR, 'app');
await mkdir(join(DIR, 'logs'), { recursive: true }).catch(() => {});
const logLine = (file, line) => appendFile(join(DIR, 'logs', file), line).catch(() => {});

const acpUrl = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
const cwd = cfg.cwd || 'C:\\Users\\Emiliano';
const configJs = `window.__GOOSE_APP__ = ${JSON.stringify({
  acpUrl,
  cwd,
  host: `${cfg.publicHost}:${cfg.servePort}`,
  version: (cfg.appConfig || {}).GOOSE_VERSION || 'web',
})};`;

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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const ip = req.socket.remoteAddress || '?';
    logLine(
      'requests.log',
      `${new Date().toISOString()} ${ip} ${req.method} ${url.pathname}${url.search} ua="${(req.headers['user-agent'] || '').slice(0, 110)}"\n`
    );

    if (url.pathname === '/client-log' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      logLine('client.log', `--- ${new Date().toISOString()} ${ip}\n${body.slice(0, 40000)}\n`);
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, backend: acpUrl.replace(/token=.*/, 'token=***') }));
      return;
    }

    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === '/config.js') {
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-cache', ...SEC });
      res.end(configJs);
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

    const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'content-type': type, 'cache-control': 'no-cache', ...SEC };
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
    res.writeHead(200, headers);
    res.end(data);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(err));
  }
});

const port = Number(process.env.GOOSE_WEB_PORT || cfg.webPort || 3788);
server.listen(port, '0.0.0.0', () => {
  console.log(`[goose-web] UI:      http://${cfg.publicHost}:${port}   (LAN)`);
  console.log(`[goose-web] UI:      http://127.0.0.1:${port}          (local)`);
  console.log(`[goose-web] backend: ws://${cfg.publicHost}:${cfg.servePort}/acp`);
});

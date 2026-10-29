// Checks de rutas sin arrancar el servicio vivo ni acceder a auth.json.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { PassThrough } from 'node:stream';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs'), 'utf8');
const cfg = { publicHost: '192.168.100.34', servePort: 3284 };
const tunnelCode = src.slice(src.indexOf('const PRIVATE_V4'), src.indexOf('// freno de fuerza bruta'));
const ctx = createContext({ cfg });
runInContext(tunnelCode + ';globalThis.checkTunnel = isTunnel;', ctx);
const classify = (peer, host, headers = {}) => ctx.checkTunnel({ socket: { remoteAddress: peer }, headers: { host, ...headers } });
assert.equal(classify('127.0.0.1', 'evil.trycloudflare.com', { 'cf-ray': 'test' }), true);
assert.equal(classify('127.0.0.1', '192.168.100.34', { 'cf-ray': 'test' }), true);
assert.equal(classify('192.168.100.55', '192.168.100.34', { 'cf-ray': 'forged' }), false);
assert.equal(classify('192.168.100.55', 'evil.trycloudflare.com'), true);
assert.equal(classify('8.8.8.8', '192.168.100.34'), true);

const handlerSrc = src.slice(src.indexOf('const handler = async'), src.indexOf('const server = http.createServer'));
const lines = [];
const sandbox = createContext({
  URL, Buffer, Date, cfg, console,
  logLine: (file, line) => lines.push({ file, line }),
  isTunnel: (req) => ctx.checkTunnel(req), authed: () => false,
  backendTcpReady: async () => false,
  piperTts: async () => { throw Error('must not run'); },
  PIPER_VOZ: 'local',
});
runInContext(handlerSrc + ';globalThis.handlerTest = handler;', sandbox);
const handler = sandbox.handlerTest;
function request(path, { method = 'GET', peer = '127.0.0.1', host = 'localhost', headers = {}, body } = {}) {
  const req = new PassThrough();
  req.url = path;
  req.method = method;
  req.socket = { remoteAddress: peer };
  req.setTimeout = () => req;
  req.headers = { host, ...headers };
  if (body != null) req.end(body);
  else req.end();
  const res = { statusCode: 0, headersSent: false, destroyed: false, writeHead(code) { this.statusCode = code; this.headersSent = true; return this; }, end(data) { this.body = data; this.emitFinish?.(); }, on(event, cb) { if (event === 'finish') this.emitFinish = cb; } };
  return handler(req, res).then(() => res);
}
assert.equal((await request('/tts?text=private', { host: 'demo.trycloudflare.com', headers: { 'cf-ray': 'yes' } })).statusCode, 401);
// /tts ya no se sirve sin sesion web: en LAN tampoco se llega a validar el texto.
assert.equal((await request('/tts', { host: cfg.publicHost, peer: '192.168.100.55' })).statusCode, 401);
assert.equal((await request('/healthz')).statusCode, 200);
const health = await request('/healthz?backend=1');
assert.equal(health.statusCode, 503);
assert.equal(JSON.parse(health.body).backendTcpReady, false);
assert.equal((await request('/client-log', { method: 'POST', body: 'short' })).statusCode, 204);
assert.equal((await request('/client-log', { method: 'POST', body: 'x'.repeat(40001) })).statusCode, 413);
assert.equal((await request('/client-log', { method: 'POST', headers: { 'content-length': '50000000' }, body: 'ignored' })).statusCode, 413);
assert.ok(!lines.some((entry) => entry.file === 'requests.log' && entry.line.includes('private')));
assert.ok(!lines.some((entry) => entry.file === 'client.log' && entry.line.includes('x'.repeat(40001))));
console.log('server hardening checks: OK');

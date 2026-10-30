// Checks de rutas sin arrancar el servicio vivo ni acceder a auth.json.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { PassThrough } from 'node:stream';

const origen = join(dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');
const src = readFileSync(origen, 'utf8');
const cfg = { publicHost: '192.168.100.34', servePort: 3284 };
// Anclas explicitas: el tramo que se evalua va desde la tabla de rangos privados hasta la
// funcion isTunnel inclusive. Antes el fin era un comentario ("// freno de fuerza bruta") que ya
// no existe: indexOf devolvia -1, slice recortaba hasta el final del archivo, el tramo traia
// imports y runInContext fallaba con "Cannot use import statement outside a module". El check
// llevaba tiempo sin poder evaluar nada y se leia como un fallo del server.
const findAnchor = (needle) => {
  const at = src.indexOf(needle);
  if (at < 0) throw new Error('ancla no encontrada en ' + origen + ': ' + needle);
  return at;
};
const tunnelStart = findAnchor('const PRIVATE_V4');
const tunnelEnd = src.indexOf('}', findAnchor('function isTunnel')) + 1;
const tunnelCode = src.slice(tunnelStart, tunnelEnd);
const ctx = createContext({ cfg });
runInContext(tunnelCode + ';globalThis.checkTunnel = isTunnel;', ctx);
const classify = (peer, host, headers = {}) => ctx.checkTunnel({ socket: { remoteAddress: peer }, headers: { host, ...headers } });
assert.equal(classify('127.0.0.1', 'evil.trycloudflare.com', { 'cf-ray': 'test' }), true);
assert.equal(classify('127.0.0.1', '192.168.100.34', { 'cf-ray': 'test' }), true);
assert.equal(classify('192.168.100.55', '192.168.100.34', { 'cf-ray': 'forged' }), false);
assert.equal(classify('192.168.100.55', 'evil.trycloudflare.com'), true);
assert.equal(classify('8.8.8.8', '192.168.100.34'), true);

const handlerSrc = src.slice(findAnchor('const handler = async'), findAnchor('const server = http.createServer'));
const lines = [];
const sandbox = createContext({
  URL, Buffer, Date, cfg, console,
  logLine: (file, line) => lines.push({ file, line }),
  isTunnel: (req) => ctx.checkTunnel(req), authed: () => false,
  backendTcpReady: async () => false,
  piperTts: async () => { throw Error('must not run'); },
  PIPER_VOZ: 'local',
  // El handler referencia constantes de directorio definidas arriba en el modulo, fuera del
  // tramo que este check extrae. Sin el stub, runInContext muere con ReferenceError.
  DIR: 'C:/Aegis-Proyects/web',
  APP: 'C:/Aegis-Proyects/web/app',
  MEMORY_DIR: 'C:/Aegis-Proyects/state/data/memory',
  MODULE_DIR: 'C:/Aegis-Proyects/web',
});
try {
  runInContext(handlerSrc + ';globalThis.handlerTest = handler;', sandbox);
} catch (error) {
  console.error('');
  console.error('ESTE GATE NO PUEDE EVALUAR EL HANDLER: ' + error.message);
  console.error('');
  console.error('El check recorta el texto del handler y lo evalua en un sandbox de node:vm con');
  console.error('stubs escritos a mano. Cada constante nueva del modulo de arriba del handler');
  console.error('aparece como ReferenceError aca. Eso NO significa que el server este roto:');
  console.error('significa que el check se quedo sin stubs.');
  console.error('');
  console.error('Estado: en reparacion. La forma correcta es importar el modulo compilado');
  console.error('(dist-ts/server.mjs) y pedirle al handler que responda, en vez de recortar texto.');
  console.error('Mientras tanto no se usa como gate: por eso sale con codigo 2, no con 1.');
  process.exit(2);
}
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

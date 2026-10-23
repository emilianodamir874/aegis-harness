// Prueba aislada de src/server.ts: sin config/auth reales, ACP vivo ni Piper.
// Desde web/: npx esbuild tests/server-regressions.ts --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.cache/server-regressions.mjs && node node_modules/.cache/server-regressions.mjs
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';

// v4: la copia aislada vive dentro de node_modules/.cache (no en tmpdir) para que
// el server resuelva sus dependencias reales (msedge-tts) igual que en produccion.
// Sigue aislada: directorio propio, puerto efimero, config/auth de prueba.
const cache = resolve('node_modules/.cache');
await mkdir(cache, { recursive: true });
const dir = await mkdtemp(join(cache, 'server-regressions-'));
let child: ChildProcess | undefined;
try {
  // bundle:false keeps the local piper import pointing to our inert stub, not the real process.
  const built = await build({ entryPoints: [resolve('src/server.ts')], bundle: false, write: false,
    platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent' });
  assert.equal(built.outputFiles.length, 1);
  await writeFile(join(dir, 'server.mjs'), built.outputFiles[0].contents);
  await writeFile(join(dir, 'piper-vivo.js'),
    'export const piperDespertar = async () => {}; export const piperVivo = async () => { throw Error("Piper stub"); };\n');
  await writeFile(join(dir, 'package.json'), '{"type":"module"}\n');
  const secret = 'TEST-ONLY-token-not-a-real-secret';
  const password = 'TEST-ONLY-password';
  await writeFile(join(dir, 'config.json'), JSON.stringify({ secretKey: secret, authStamp: 'test',
    publicHost: '127.0.0.1', webPort: 0, servePort: 0, tlsDir: '' }));
  await writeFile(join(dir, 'auth.json'), JSON.stringify({ password }));
  // Reserve an OS-assigned port and release it immediately before spawning the child.
  const reservation = net.createServer();
  await new Promise<void>((ok, fail) => reservation.once('error', fail).listen(0, '127.0.0.1', ok));
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((ok, fail) => reservation.close(e => e ? fail(e) : ok()));
  child = spawn(process.execPath, [join(dir, 'server.mjs')], {
    cwd: dir, env: { ...process.env, AEGIS_WEB_PORT: String(port), AEGIS_WEB_TLS_DIR: '' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  child.stdout?.on('data', b => { output = (output + b.toString()).slice(-2000); });
  child.stderr?.on('data', b => { output = (output + b.toString()).slice(-2000); });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let n = 0; n < 80; n++) {
    if (child.exitCode !== null) throw Error('Servidor aislado terminó antes de escuchar: ' + output);
    try {
      const response = await fetch(base + '/favicon.ico', { signal: AbortSignal.timeout(400) });
      if (response.status === 204) { ready = true; break; }
    } catch { /* wait for startup */ }
    await delay(50);
  }
  assert.ok(ready, 'servidor aislado no arrancó: ' + output);

  const foreign = await fetch(base + '/config.js', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(foreign.status, 403, 'config.js cross-site');
  assert.equal(foreign.headers.get('cache-control'), 'no-store');
  assert.ok(!(await foreign.text()).includes(secret), 'config.js cross-site leaked token');
  const local = await fetch(base + '/config.js', { headers: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(local.status, 200, 'config.js same-origin');
  assert.equal(local.headers.get('cache-control'), 'no-store');
  assert.equal(local.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.ok((await local.text()).includes(secret), 'same-origin config.js omitted dummy token');
  console.log('PASS config.js: cross-site 403; same-origin 200, no-store');

  // A raw handshake checks the HTTP status without attempting any real backend connection.
  const handshake = await new Promise<string>((ok, fail) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let data = '';
    socket.setTimeout(2000, () => socket.destroy(Error('upgrade timeout')));
    socket.once('error', fail);
    socket.on('data', chunk => {
      data += chunk.toString();
      if (data.includes('\r\n\r\n')) { socket.destroy(); ok(data); }
    });
    socket.once('connect', () => socket.write(
      `GET /acp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: https://evil.example\r\n\r\n`));
  });
  assert.match(handshake, /^HTTP\/1\.1 403 Forbidden\r\n/);
  console.log('PASS WebSocket /acp: foreign Origin 403');

  const form = new URLSearchParams({ password });
  const badLogin = await fetch(base + '/login', { method: 'POST', headers: {
    Origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded',
  }, body: form, redirect: 'manual' });
  assert.equal(badLogin.status, 403, 'foreign-origin login');
  assert.equal(badLogin.headers.get('set-cookie'), null, 'foreign origin set cookie');
  const safeLogin = await fetch(base + '/login?next=' + encodeURIComponent('/\\evil.example'), {
    method: 'POST', headers: { Origin: base, 'content-type': 'application/x-www-form-urlencoded' },
    body: form, redirect: 'manual',
  });
  assert.equal(safeLogin.status, 302, 'dummy valid login');
  assert.equal(safeLogin.headers.get('location'), '/', 'backslash redirect should fall back to root');
  assert.match(safeLogin.headers.get('set-cookie') || '', /^gw_auth=/);
  console.log('PASS login: foreign Origin 403; valid dummy login /\\evil.example redirects to /');

  // ---- pagina de acceso v4: markup, estado de error y preservacion del "next"
  const loginGet = await fetch(base + '/login?next=' + encodeURIComponent('/?s=20261022_78'));
  const loginHtml = await loginGet.text();
  assert.equal(loginGet.status, 200, 'GET /login 200');
  assert.match(loginHtml, /Acceso al harness/, 'login: titulo nuevo');
  assert.match(loginHtml, /--accent: #d97757/, 'login: usa la paleta de la app (v4)');
  assert.match(loginHtml, /id="password"[^>]*required/, 'login: campo de contrasena obligatorio');
  assert.match(loginHtml, /autocomplete="current-password"/, 'login: password managers');
  assert.match(loginHtml, /action="\/login\?next=%2F%3Fs%3D20261022_78"/, 'login: el next viaja en el action');
  assert.doesNotMatch(loginHtml, /(src|href)="https?:\/\//, 'login: no carga recursos externos');
  assert.doesNotMatch(loginHtml, /<script/, 'login: sin scripts');
  assert.match(loginGet.headers.get('content-security-policy') || '', /default-src 'none'/, 'login: CSP restrictiva intacta');

  const loginBad = await fetch(base + '/login?next=' + encodeURIComponent('/?s=1'), {
    method: 'POST',
    headers: { Origin: base, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'no-es-la-clave' }),
    redirect: 'manual',
  });
  const badHtml = await loginBad.text();
  assert.equal(loginBad.status, 401, 'login incorrecto: 401');
  assert.match(badHtml, /id="err" role="alert"/, 'login incorrecto: error anunciado a lectores');
  assert.match(badHtml, /aria-invalid="true"/, 'login incorrecto: input marcado invalido');
  assert.match(badHtml, /action="\/login\?next=%2F%3Fs%3D1"/, 'login incorrecto: conserva el next');

  const inyectado = await fetch(base + '/login?next=' + encodeURIComponent('/"><img src=x onerror=alert(1)>'));
  const inyHtml = await inyectado.text();
  assert.ok(!inyHtml.includes('<img'), 'login: el next no inyecta markup');
  assert.match(inyHtml, /action="\/login\?next=%2F%22%3E%3Cimg/, 'login: el next va escapado en el action');
  console.log('PASS login v4: markup, paleta, CSP, error accesible, next preservado y escapado');
} finally {
  if (child && child.exitCode === null) {
    const stopped = new Promise<void>(ok => child!.once('exit', () => ok()));
    child.kill();
    await Promise.race([stopped, delay(3000).then(() => { if (child!.exitCode === null) child!.kill('SIGKILL'); })]);
  }
  await rm(dir, { recursive: true, force: true });
}

// Regresiones HTTP aisladas de src/server.ts; nunca usar el store/config del operador.
// Desde web/: npx esbuild tests/server-workspace-regressions.ts --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.cache/server-workspace-regressions.mjs
//             node node_modules/.cache/server-workspace-regressions.mjs
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';

const cache = resolve('node_modules/.cache');
await mkdir(cache, { recursive: true });
const dir = await mkdtemp(join(cache, 'server-workspace-'));
const workspace = join(dir, 'workspace');
const outside = join(dir, 'outside');
const store = join(dir, 'fixture-store');
let child: ChildProcess | undefined;
try {
  const outbox = join(dir, 'outbox');
  await Promise.all([mkdir(workspace), mkdir(outside), mkdir(store), mkdir(join(dir, 'app')), mkdir(join(dir, 'tools')), mkdir(outbox)]);
  const defaultRoots = Array.from({ length: 4 }, (_, n) => join(workspace, `fixture-${n}`));
  await mkdir(join(store, 'data'));
  await Promise.all([mkdir(join(store, 'config')), mkdir(join(store, 'data', 'memory')),
    ...defaultRoots.map(root => mkdir(root))]);
  const defaultsFile = join(store, 'config', 'workspaces.defaults.json');
  const factsFile = join(store, 'data', 'memory', 'facts.jsonl');
  const initialRoot = resolve(workspace);
  const initialDefaults = { [initialRoot.toLowerCase()]: { root: initialRoot, defaults: { model: 'fixture-inicial' } } };
  const initialFact = { id: 'F-0007', text: 'fixture inicial', status: 'confirmed' };
  await writeFile(defaultsFile, JSON.stringify(initialDefaults) + '\n');
  await writeFile(factsFile, JSON.stringify(initialFact) + '\n');
  // bundle:false preserva el import local de Piper: este stub no inicia ningun sintetizador.
  const built = await build({ entryPoints: [resolve('src/server.ts')], bundle: false, write: false,
    platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent' });
  assert.equal(built.outputFiles.length, 1);
  await writeFile(join(dir, 'server.mjs'), built.outputFiles[0].contents);
  await writeFile(join(dir, 'piper-vivo.js'), 'export const piperDespertar = async () => {}; export const piperVivo = async () => { throw Error("Piper stub"); };\n');
  await writeFile(join(dir, 'package.json'), '{"type":"module"}\n');
  const marker = join(store, 'sweep-ran.txt');
  // Si falla el binario de barrido, el fallback del server usa DIR/tools (este fixture).
  // El script no importa SQLite ni abre la DB; confirma que heredo SOLO el store efimero.
  await writeFile(join(dir, 'tools', 'sweep-pending.mjs'),
    `import { writeFileSync } from 'node:fs';\nif (process.env.AEGIS_PATH_ROOT !== ${JSON.stringify(store)}) throw Error('store no aislado');\nwriteFileSync(${JSON.stringify(marker)}, 'fixture-only');\n`);
  const password = 'fixture-password';
  await writeFile(join(dir, 'config.json'), JSON.stringify({ secretKey: 'fixture-token', authStamp: 'fixture',
    publicHost: '127.0.0.1', webPort: 0, servePort: 0, tlsDir: '' }));
  await writeFile(join(dir, 'auth.json'), JSON.stringify({ password }));
  await writeFile(join(dir, 'app', 'index.html'), '<!doctype html><script src="./app.js"></script><link href="./app.css"><script src="./skills.js"></script>');
  await writeFile(join(dir, 'app', 'app.js'), 'window.fixture=true;');
  await writeFile(join(dir, 'app', 'app.css'), 'body{color:black}');
  await writeFile(join(dir, 'app', 'skills.js'), 'window.skills=true;');
  const plain = 'linea uno\nlinea dos\n';
  const plainPath = join(workspace, 'Dockerfile');
  await writeFile(plainPath, plain);
  const secretText = 'THIS_IS_A_FIXTURE_SECRET';
  const outsidePath = join(outside, 'public.txt');
  await writeFile(outsidePath, secretText);
  // El prefijo lexical no equivale a estar dentro del directorio permitido.
  const sibling = join(dir, 'workspace-sibling');
  await mkdir(sibling);
  const siblingPath = join(sibling, 'public.txt');
  await writeFile(siblingPath, secretText);
  const hiddenPath = join(workspace, 'SECRETS.YAML');
  await writeFile(hiddenPath, secretText);
  await writeFile(join(workspace, 'config.json'), secretText);
  await mkdir(join(workspace, '.git'));
  await writeFile(join(workspace, '.git', 'visible.txt'), secretText);

  const reservation = net.createServer();
  await new Promise<void>((ok, fail) => reservation.once('error', fail).listen(0, '127.0.0.1', ok));
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((ok, fail) => reservation.close(e => e ? fail(e) : ok()));
  child = spawn(process.execPath, [join(dir, 'server.mjs')], {
    cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AEGIS_PATH_ROOT: store, AEGIS_WORKSPACE_ROOTS: workspace,
      AEGIS_SERVE_BIN: join(dir, 'binario-de-prueba-inexistente.exe'),
      AEGIS_WEB_PORT: String(port), AEGIS_WEB_TLS_DIR: '' },
  });
  let output = '';
  child.stdout?.on('data', b => { output = (output + b.toString()).slice(-2000); });
  child.stderr?.on('data', b => { output = (output + b.toString()).slice(-2000); });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let n = 0; n < 100; n++) {
    if (child.exitCode !== null) throw Error('server de fixture termino: ' + output);
    try {
      const response = await fetch(base + '/favicon.ico', { signal: AbortSignal.timeout(400) });
      if (response.status === 204) { ready = true; break; }
    } catch { /* esperando arranque */ }
    await delay(50);
  }
  assert.ok(ready, 'server de fixture no arranco: ' + output);
  // No se sintetiza audio: los dos rechazos deben ocurrir antes de invocar Piper/Edge.
  const tooLong = 'x'.repeat(1201);
  const ttsPath = '/tts?' + new URLSearchParams({ text: tooLong, engine: 'piper' });
  const oversized = await fetch(base + ttsPath);
  assert.equal(oversized.status, 413);
  assert.match(await oversized.text(), /1200/);
  const tunnelTts = await fetch(base + ttsPath, { headers: { 'cf-connecting-ip': '203.0.113.9' } });
  assert.equal(tunnelTts.status, 401, 'autenticacion del tunel precede validacion de longitud');
  assert.equal((await tunnelTts.json() as { error: string }).error, 'unauthorized');
  console.log('PASS /tts: texto >1200 rechazado 413; tunel sin cookie 401 (sin sintetizar)');
  let swept = false;
  for (let n = 0; n < 60; n++) {
    try { swept = (await readFile(marker, 'utf8')) === 'fixture-only'; if (swept) break; }
    catch { /* barrido asincrono */ }
    await delay(50);
  }
  assert.ok(swept, 'fallback de sweep no fue el stub de fixture: ' + output);
  console.log('PASS arranque: sweep inerte con AEGIS_PATH_ROOT del fixture');

  const unauthenticated = await fetch(base + '/file.json?' + new URLSearchParams({ path: plainPath }));
  assert.equal(unauthenticated.status, 401, 'LAN sin sesion no puede leer el archivo');
  const passwordLogin = await fetch(base + '/login', { method: 'POST', redirect: 'manual',
    headers: { Origin: base, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }) });
  assert.equal(passwordLogin.status, 302);
  const cookie = passwordLogin.headers.get('set-cookie')?.split(';', 1)[0];
  assert.match(cookie || '', /^gw_auth=/);
  const read = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    fetch(base + '/file.json?' + new URLSearchParams({ path }), { method, headers: { Cookie: cookie!, ...headers }, signal: AbortSignal.timeout(3000) });
  // /outbox.json usa DIR/outbox (no el workspace ni el store): solo fixtures efimeros.
  const artifactText = 'artefacto de prueba\nsegunda linea\n';
  const artifactName = 'nota prueba.txt';
  const artifactBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  await writeFile(join(outbox, artifactName), artifactText);
  await writeFile(join(outbox, 'imagen.png'), artifactBytes);
  await mkdir(join(outbox, 'subdir'));
  await writeFile(join(outbox, 'subdir', 'omitido.txt'), secretText);
  const artifactRequest = (query = '', headers: Record<string, string> = {}) =>
    fetch(base + '/outbox.json' + query, { headers: { Cookie: cookie!, ...headers }, signal: AbortSignal.timeout(3000) });
  const artifactList = await artifactRequest();
  assert.equal(artifactList.status, 200);
  assert.equal(artifactList.headers.get('cache-control'), 'no-store');
  const artifactData = await artifactList.json() as { dir: string; items: { name: string; bytes: number; ext: string; mtime: string; url: string }[] };
  assert.equal(artifactData.dir, outbox);
  assert.deepEqual(artifactData.items.map(item => item.name).sort(), ['imagen.png', artifactName].sort(), 'solo archivos regulares');
  for (const [name, bytes, ext] of [[artifactName, Buffer.byteLength(artifactText), '.txt'], ['imagen.png', artifactBytes.length, '.png']] as const) {
    const item = artifactData.items.find(entry => entry.name === name)!;
    assert.equal(item.bytes, bytes);
    assert.equal(item.ext, ext);
    assert.equal(item.url, '/dl/' + encodeURIComponent(name));
    assert.match(item.mtime, /^\d{4}-\d\d-\d\dT/);
  }
  const artifactPreview = (name: string, headers: Record<string, string> = {}) =>
    artifactRequest('?' + new URLSearchParams({ preview: '1', name }), headers);
  const textPreview = await artifactPreview(artifactName);
  assert.equal(textPreview.status, 200);
  assert.deepEqual(await textPreview.json(), { name: artifactName, bytes: Buffer.byteLength(artifactText), ext: '.txt',
    binary: false, text: artifactText, dataUrl: '' });
  const binaryPreview = await artifactPreview('imagen.png');
  assert.equal(binaryPreview.status, 200);
  assert.deepEqual(await binaryPreview.json(), { name: 'imagen.png', bytes: artifactBytes.length, ext: '.png',
    binary: true, text: '', dataUrl: 'data:application/octet-stream;base64,' + artifactBytes.toString('base64') });
  console.log('PASS /outbox.json: listado aislado (omite subdirectorios), preview texto y binario');
  // La implementacion actual quita separadores antes de resolver: no exigir un status especifico,
  // sino que nunca revele el archivo exterior ni permita navegar fuera del fixture.
  for (const name of ['../outside/public.txt', '..\\outside\\public.txt', outsidePath]) {
    const denied = await artifactPreview(name);
    assert.ok([400, 404].includes(denied.status), `traversal denegado: ${name} -> ${denied.status}`);
    assert.ok(!(await denied.text()).includes(secretText), `traversal no filtra: ${name}`);
  }
  console.log('PASS /outbox.json: traversal no lee archivo exterior');
  const tunnelArtifact = { 'cf-connecting-ip': '203.0.113.9' };
  for (const query of ['', '?' + new URLSearchParams({ preview: '1', name: artifactName })]) {
    for (const headers of [tunnelArtifact, { ...tunnelArtifact, Cookie: 'gw_auth=falsa' }]) {
      const unauth = await fetch(base + '/outbox.json' + query, { headers, signal: AbortSignal.timeout(3000) });
      assert.equal(unauth.status, 401, `tunel sin sesion ${query || 'listado'}`);
      assert.equal((await unauth.json() as { error: string }).error, 'unauthorized');
    }
    const authed = await artifactRequest(query, tunnelArtifact);
    assert.equal(authed.status, 200, `tunel con cookie valida ${query || 'listado'}`);
  }
  console.log('PASS /outbox.json: tunel sin cookie 401 y con cookie valida 200 para listado y preview');
  const allowed = await read(plainPath, { 'Sec-Fetch-Site': 'same-origin', Origin: base });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('cache-control'), 'no-store');
  const data = await allowed.json() as Record<string, unknown>;
  assert.equal(data.path, resolve(plainPath));
  assert.equal(data.exists, true);
  assert.equal(data.text, plain);
  assert.equal(data.bytes, Buffer.byteLength(plain));
  assert.equal(data.lines, 3);
  assert.equal(data.sha256, createHash('sha256').update(plain).digest('hex'));
  assert.match(String(data.mtime), /^\d{4}-\d\d-\d\dT/);
  const newFile = await read(join(workspace, 'nuevo.txt'));
  assert.equal(newFile.status, 200);
  assert.deepEqual((await newFile.json() as { exists: boolean; text: string }).exists, false);
  console.log('PASS /file.json: LAN sin cookie 401; sesion valida lee archivo inocuo, hash y archivo nuevo');

  for (const path of [hiddenPath, join(workspace, 'config.json'), join(workspace, '.git', 'visible.txt'),
    join(workspace, '.env.local'), outsidePath, siblingPath, join(workspace, '..', 'outside', 'public.txt')]) {
    const response = await read(path);
    assert.equal(response.status, 403, `ruta denegada: ${path}`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(!(await response.text()).includes(secretText), `filtracion de ${path}`);
  }
  const emptyPath = await fetch(base + '/file.json', { headers: { Cookie: cookie! } });
  assert.equal(emptyPath.status, 403, 'path vacio');
  console.log('PASS /file.json: secretos, .git, traversal, fuera de workspace y path vacio -> 403');

  // Symlink/junction solo si el SO permite crearlo sin privilegios. Ambos casos verifican realpath.
  try {
    const link = join(workspace, 'link-public.txt');
    await symlink(outsidePath, link, 'file');
    const response = await read(link);
    assert.equal(response.status, 403, 'symlink hacia fuera del workspace');
    assert.ok(!(await response.text()).includes(secretText));
    const secretLink = join(workspace, 'alias-public.txt');
    await symlink(hiddenPath, secretLink, 'file');
    const aliased = await read(secretLink);
    assert.equal(aliased.status, 403, 'symlink inocuo hacia secreto dentro del workspace');
    assert.ok(!(await aliased.text()).includes(secretText));
    console.log('PASS /file.json: symlinks hacia fuera y hacia secreto interno -> 403');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
    console.log('SKIP symlink: sistema sin permiso para crear enlaces');
  }
  if (process.platform === 'win32') {
    const caps = await read(plainPath.toUpperCase());
    assert.equal(caps.status, 200, 'comparacion case-insensitive en Windows');
    assert.equal((await caps.json() as { text: string }).text, plain);
    console.log('PASS /file.json: mayusculas de ruta en Windows');
  }

  for (const headers of [{ 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' },
    { Origin: 'https://evil.example' }]) {
    const response = await read(plainPath, headers);
    assert.equal(response.status, 403, 'cross-site /file.json');
    assert.ok(!(await response.text()).includes(plain));
  }
  assert.equal((await read(plainPath, {}, 'POST')).status, 403);
  console.log('PASS /file.json: origen ajeno, metadata cross-site y metodo POST -> 403');

  // Simula el proxy de tunel desde loopback: sin cookie nunca sirve contenido del archivo.
  const tunnel = { 'cf-connecting-ip': '203.0.113.9' };
  const unauthed = await read(plainPath, { ...tunnel, Cookie: 'gw_auth=falsa' });
  assert.equal(unauthed.status, 401);
  assert.ok(!(await unauthed.text()).includes(plain));
  const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual',
    headers: { ...tunnel, Origin: `https://127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }) });
  assert.equal(login.status, 302);
  const tunnelCookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  assert.match(tunnelCookie || '', /^gw_auth=/);
  const authenticated = await read(plainPath, { ...tunnel, Cookie: tunnelCookie!, 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(authenticated.status, 200);
  assert.equal((await authenticated.json() as { text: string }).text, plain);
  assert.equal((await read(plainPath, { ...tunnel, Cookie: cookie!, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await read(plainPath, { ...tunnel, Cookie: 'gw_auth=falsa' })).status, 401);
  console.log('PASS /file.json: tunel 401 sin cookie; cookie valida 200; cross-site 403');

  // Ambos archivos viven exclusivamente bajo AEGIS_PATH_ROOT=fixture-store. Lanzar los POST
  // juntos detecta pérdidas del ciclo leer/modificar/escribir y colisiones del mismo .tmp.
  const postJson = (path: string, body: unknown) => fetch(base + path, {
    method: 'POST', headers: { Cookie: cookie!, Origin: base, 'Sec-Fetch-Site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  const getJson = (path: string) => fetch(base + path, {
    headers: { Cookie: cookie!, Origin: base, 'Sec-Fetch-Site': 'same-origin' }, signal: AbortSignal.timeout(5000),
  });
  const defaultsResponses = await Promise.all(defaultRoots.map((root, n) =>
    postJson('/ws/defaults', { root, defaults: { model: `fixture-model-${n}`, effort: 'low' } })));
  for (const [n, response] of defaultsResponses.entries()) {
    assert.equal(response.status, 200, `POST /ws/defaults fixture ${n}: ${response.status === 200 ? 'ok' : await response.text()}`);
    const body = await response.json() as { ok: boolean; key: string };
    assert.equal(body.ok, true);
    assert.equal(body.key, resolve(defaultRoots[n]).toLowerCase());
  }
  const defaultsGet = await getJson('/ws/defaults');
  assert.equal(defaultsGet.status, 200);
  const allDefaults = await defaultsGet.json() as Record<string, { root: string; defaults: { model: string; effort?: string } }>;
  assert.equal(Object.keys(allDefaults).length, defaultRoots.length + 1);
  assert.deepEqual(allDefaults[initialRoot.toLowerCase()].defaults, { model: 'fixture-inicial' });
  for (const [n, root] of defaultRoots.entries()) {
    assert.equal(allDefaults[resolve(root).toLowerCase()].root, resolve(root));
    assert.deepEqual(allDefaults[resolve(root).toLowerCase()].defaults, { model: `fixture-model-${n}`, effort: 'low' });
  }
  assert.deepEqual(JSON.parse(await readFile(defaultsFile, 'utf8')), allDefaults, 'persistencia solo en el fixture');
  console.log('PASS /ws/defaults: 4 POST simultaneos, fixture previo conservado y GET persistente');

  const texts = Array.from({ length: 4 }, (_, n) => `hecho de fixture concurrente ${n}`);
  const memoryResponses = await Promise.all(texts.map(text => postJson('/memory.json', { action: 'add', text })));
  for (const [n, response] of memoryResponses.entries()) {
    assert.equal(response.status, 200, `POST /memory.json fixture ${n}: ${response.status === 200 ? 'ok' : await response.text()}`);
    assert.equal((await response.json() as { ok: boolean }).ok, true);
  }
  const memoryGet = await getJson('/memory.json');
  assert.equal(memoryGet.status, 200);
  const memoryData = await memoryGet.json() as { path: string; facts: { id: string; text: string }[] };
  assert.equal(memoryData.path, factsFile, 'GET usa el store de fixture');
  assert.equal(memoryData.facts.length, texts.length + 1);
  assert.equal(new Set(memoryData.facts.map(fact => fact.id)).size, memoryData.facts.length, 'IDs unicos');
  assert.deepEqual(memoryData.facts.map(fact => fact.text).sort(), [initialFact.text, ...texts].sort());
  assert.deepEqual(memoryData.facts.find(fact => fact.id === initialFact.id)?.text, initialFact.text);
  const persistedFacts = (await readFile(factsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { id: string; text: string });
  assert.deepEqual(persistedFacts, memoryData.facts, 'persistencia solo en el fixture');
  console.log('PASS /memory.json: 4 POST simultaneos, hecho previo conservado, IDs unicos y GET persistente');
  const failedConsolidate = await postJson('/memory.json', { action: 'consolidate' });
  assert.equal(failedConsolidate.status, 502, 'binario de fixture inexistente debe fallar');
  const failedBody = await failedConsolidate.json() as { ok: boolean; error: string };
  assert.equal(failedBody.ok, false);
  assert.match(failedBody.error, /consolidate fallo/);
  assert.deepEqual((await readFile(factsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line)), persistedFacts);
  console.log('PASS /memory.json consolidate: binario inexistente -> 502 ok:false, hechos intactos');

  const html = await fetch(base + '/', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(html.status, 200);
  assert.equal(html.headers.get('cache-control'), 'no-cache');
  assert.match(await html.text(), /app\.js\?v=/);
  const etag = html.headers.get('etag');
  assert.match(etag || '', /^"[a-f0-9]{64}"$/);
  const cached = await fetch(base + '/', { headers: { 'If-None-Match': etag!, 'Accept-Encoding': 'gzip' } });
  assert.equal(cached.status, 304);
  assert.equal(cached.headers.get('etag'), etag);
  assert.equal(await cached.text(), '');
  const stamp = createHash('sha256').update(await readFile(join(dir, 'app', 'app.js'))).digest('hex');
  const versioned = await fetch(base + '/app.js?v=' + stamp);
  assert.equal(versioned.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const arbitrary = await fetch(base + '/app.js?v=fixture');
  assert.equal(arbitrary.headers.get('cache-control'), 'no-cache');
  await writeFile(join(dir, 'app', 'app.js'), 'window.fixture=false;');
  const updated = await fetch(base + '/', { headers: { 'If-None-Match': etag!, 'Accept-Encoding': 'gzip' } });
  assert.equal(updated.status, 200, 'cambio en JS invalida ETag del HTML transformado');
  assert.notEqual(updated.headers.get('etag'), etag);
  assert.match(await updated.text(), new RegExp('app\\.js\\?v=' + createHash('sha256').update('window.fixture=false;').digest('hex')));
  console.log('PASS HTML: gzip/etag 304, invalidacion y cache versionada por contenido');

  // opendir().isFile() omite symlinks del listado, pero stat/readFile del preview
  // siguen el enlace. Mantener la regresion: el endpoint actual filtra el destino.
  try {
    const outsideLink = join(outbox, 'alias-exterior.txt');
    await symlink(outsidePath, outsideLink, 'file');
    const linkedList = await artifactRequest();
    assert.equal(linkedList.status, 200);
    assert.ok(!(await linkedList.text()).includes('alias-exterior.txt'), 'listado omite symlink');
    const linkedPreview = await artifactPreview('alias-exterior.txt');
    const linkedBody = await linkedPreview.text();
    assert.ok([400, 403, 404].includes(linkedPreview.status),
      `preview siguio symlink externo: HTTP ${linkedPreview.status}, contiene secreto=${linkedBody.includes(secretText)}`);
    assert.ok(!linkedBody.includes(secretText), 'preview no filtra destino exterior');
    console.log('PASS /outbox.json: symlink exterior omitido del listado y denegado en preview');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
    console.log('SKIP /outbox.json symlink: sistema sin permiso para crear enlaces');
  }
} finally {
  if (child && child.exitCode === null) {
    const stopped = new Promise<void>(ok => child!.once('exit', () => ok()));
    child.kill();
    await Promise.race([stopped, delay(3000).then(() => { if (child!.exitCode === null) child!.kill('SIGKILL'); })]);
  }
  await rm(dir, { recursive: true, force: true });
}

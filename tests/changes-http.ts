// HTTP real, aislado del servidor/almacen vivo. Desde web/:
// npx esbuild tests/changes-http.ts --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.cache/changes-http.mjs
// node node_modules/.cache/changes-http.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';

const cache = resolve('node_modules/.cache');
await mkdir(cache, { recursive: true });
// Fixture fuera del checkout web (no hereda .git), dentro de una ruta permitida por el servidor.
const dir = await mkdtemp(join(resolve('C:/Aegis-Proyects/core/tmp'), 'changes-http-'));
const workspace = join(dir, 'workspace');
const repo = join(workspace, 'repo');
const nongit = join(workspace, 'nongit');
const outside = join(dir, 'elsewhere');
const foreignRepo = join(outside, 'repo');
const inheritedCwd = join(foreignRepo, 'authorized-child');
const store = join(dir, 'fixture-store');
const marker = join(store, 'sweep-ran.txt');
let child: ChildProcess | undefined;
try {
  await Promise.all([mkdir(repo, { recursive: true }), mkdir(nongit, { recursive: true }), mkdir(inheritedCwd, { recursive: true }),
    mkdir(store), mkdir(join(dir, 'app')), mkdir(join(dir, 'tools'))]);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], {
    timeout: 5000, windowsHide: true, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' },
  });
  git(repo, 'init', '-q');
  await writeFile(join(repo, 'tracked.txt'), 'original\n');
  await writeFile(join(repo, '.env'), 'FIXTURE_PRIVATE_VALUE=original\n');
  git(repo, 'add', 'tracked.txt', '.env');
  git(repo, '-c', 'user.email=fixture@invalid.test', '-c', 'user.name=Fixture', 'commit', '-qm', 'fixture');
  await writeFile(join(repo, 'tracked.txt'), 'original\ncambio visible\n');
  await writeFile(join(repo, 'new file.txt'), 'contenido sin mostrar\n');
  await writeFile(join(repo, '.env'), 'FIXTURE_PRIVATE_VALUE=changed\n');
  git(foreignRepo, 'init', '-q');
  await writeFile(join(foreignRepo, 'foreign.txt'), 'OUTSIDE_REPO_MARKER\n');
  // Su cwd está permitido por la allowlist, pero la raíz de Git NO: defensa independiente.
  await writeFile(join(inheritedCwd, 'child.txt'), 'untracked\n');

  const dbDir = join(store, 'data', 'sessions');
  await mkdir(dbDir, { recursive: true });
  const db = new DatabaseSync(join(dbDir, 'sessions.db'));
  // Mismos campos obligatorios que CREATE TABLE sessions de SessionStorage::initialize_schema.
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '', session_type TEXT NOT NULL DEFAULT 'user',
    working_dir TEXT NOT NULL)`);
  const addSession = db.prepare('INSERT INTO sessions (id, working_dir) VALUES (?, ?)');
  addSession.run('fixture-repo', repo);
  addSession.run('fixture-nongit', nongit);
  addSession.run('fixture-foreign', inheritedCwd);
  addSession.run('fixture-outside', foreignRepo);
  db.close();

  const server = await build({ entryPoints: [resolve('src/server.ts')], bundle: false, write: false,
    platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent' });
  const index = await build({ entryPoints: [resolve('src/tools/changes-index.ts')], bundle: true, write: false,
    platform: 'node', format: 'esm', packages: 'external', target: 'node22', logLevel: 'silent' });
  assert.equal(server.outputFiles.length, 1);
  assert.equal(index.outputFiles.length, 1);
  // Los imports npm del server resuelven contra la instalación de pruebas, nunca contra el store.
  await symlink(resolve('node_modules'), join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(dir, 'server.mjs'), server.outputFiles[0].contents);
  await writeFile(join(dir, 'tools', 'changes-index.mjs'), index.outputFiles[0].contents);
  await writeFile(join(dir, 'piper-vivo.js'), 'export const piperDespertar = async () => {}; export const piperVivo = async () => { throw Error("fixture only"); };\n');
  await writeFile(join(dir, 'package.json'), '{"type":"module"}\n');
  await writeFile(join(dir, 'tools', 'sweep-pending.mjs'),
    `import { writeFileSync } from 'node:fs';\nif (process.env.AEGIS_PATH_ROOT !== ${JSON.stringify(store)}) throw Error('store no aislado');\nwriteFileSync(${JSON.stringify(marker)}, 'fixture-only');\n`);
  const password = 'fixture-password';
  await writeFile(join(dir, 'config.json'), JSON.stringify({ secretKey: 'fixture-token', authStamp: 'fixture',
    publicHost: '127.0.0.1', webPort: 0, servePort: 0, tlsDir: '' }));
  await writeFile(join(dir, 'auth.json'), JSON.stringify({ password }));
  await writeFile(join(dir, 'app', 'index.html'), '<!doctype html><title>fixture</title>');
  const reservation = net.createServer();
  await new Promise<void>((ok, fail) => reservation.once('error', fail).listen(0, '127.0.0.1', ok));
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((ok, fail) => reservation.close(error => error ? fail(error) : ok()));
  child = spawn(process.execPath, [join(dir, 'server.mjs')], {
    cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AEGIS_PATH_ROOT: store, AEGIS_WORKSPACE_ROOTS: [workspace, inheritedCwd].join(';'),
      AEGIS_SERVE_BIN: join(dir, 'nonexistent-serve.exe'), AEGIS_WEB_PORT: String(port), AEGIS_WEB_TLS_DIR: '' },
  });
  let output = '';
  child.stdout?.on('data', bytes => { output = (output + bytes.toString()).slice(-2000); });
  child.stderr?.on('data', bytes => { output = (output + bytes.toString()).slice(-2000); });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let n = 0; n < 100; n++) {
    if (child.exitCode !== null) throw Error('server de fixture terminó: ' + output);
    try {
      if ((await fetch(base + '/favicon.ico', { signal: AbortSignal.timeout(400) })).status === 204) { ready = true; break; }
    } catch { /* esperando arranque */ }
    await delay(50);
  }
  assert.ok(ready, 'server de fixture no arrancó: ' + output);
  let swept = false;
  for (let n = 0; n < 60; n++) {
    try { swept = (await readFile(marker, 'utf8')) === 'fixture-only'; if (swept) break; }
    catch { /* fallback asíncrono */ }
    await delay(50);
  }
  assert.ok(swept, 'sweep no usó el store efímero: ' + output);
  const endpoint = (sessionId: string, cwd?: string) => base + '/changes.json?' + new URLSearchParams({ sessionId, ...(cwd === undefined ? {} : { cwd }) });
  const request = (sessionId: string, headers: Record<string, string> = {}, method = 'GET', cwd?: string) =>
    fetch(endpoint(sessionId, cwd), { method, headers, signal: AbortSignal.timeout(10000) });
  for (const headers of [{}, { 'cf-connecting-ip': '203.0.113.9' }, { Cookie: 'gw_auth=falsa' },
    { Cookie: 'gw_auth=falsa', 'cf-connecting-ip': '203.0.113.9' }]) {
    const response = await request('fixture-repo', headers);
    assert.equal(response.status, 401, 'LAN/túnel sin cookie válida');
    assert.equal((await response.json() as { error: string }).error, 'unauthorized');
  }
  const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual',
    headers: { Origin: base, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }), signal: AbortSignal.timeout(5000) });
  assert.equal(login.status, 302);
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  assert.match(cookie || '', /^gw_auth=/);
  const authorized = (sessionId: string, headers: Record<string, string> = {}, method = 'GET', cwd?: string) =>
    request(sessionId, { Cookie: cookie!, ...headers }, method, cwd);
  assert.equal((await authorized('fixture-repo', {}, 'POST')).status, 403);
  for (const headers of [{ Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' }]) {
    assert.equal((await authorized('fixture-repo', headers)).status, 403, 'origen ajeno');
  }
  for (const headers of [{ Origin: base, 'Sec-Fetch-Site': 'same-origin' }, { 'cf-connecting-ip': '203.0.113.9' }]) {
    const response = await authorized('fixture-repo', headers);
    assert.equal(response.status, 200, 'cookie válida en LAN o túnel');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await response.json() as { kind: string; root: string; entries: { path: string; worktree: string; diff: string }[] };
    assert.equal(data.kind, 'git');
    assert.equal(resolve(data.root), resolve(repo));
    assert.ok(data.entries.some(entry => entry.path === 'tracked.txt' && entry.worktree === 'M'
      && entry.diff.includes('+cambio visible')), 'diff del tracked');
    assert.ok(data.entries.some(entry => entry.path === 'new file.txt' && entry.worktree === '?'
      && entry.diff === ''), 'untracked sin contenido');
    assert.ok(!data.entries.some(entry => entry.path === '.env'), 'ruta sensible excluida');
    assert.ok(!JSON.stringify(data).includes('FIXTURE_PRIVATE_VALUE'), 'sin secreto en respuesta');
  }
  assert.equal((await authorized('fixture-repo', {}, 'GET', repo)).status, 200, 'cwd informativo coincide');
  assert.equal((await authorized('fixture-repo', {}, 'GET', foreignRepo)).status, 403, 'cwd exterior no sustituye sesion');
  assert.equal((await authorized('fixture-repo', {}, 'GET', nongit)).status, 403, 'cwd permitido no sustituye sesion');
  assert.equal((await authorized('fixture-repo', {}, 'GET', join(workspace, '..', 'elsewhere', 'repo'))).status, 403);
  assert.equal((await authorized('fixture-repo', {}, 'GET', 'relative')).status, 400);
  assert.equal((await authorized('missing-session')).status, 404, 'SID inexistente');
  assert.equal((await authorized("fixture-repo' OR 1=1 --")).status, 400, 'SID invalido no llega a SQLite');
  assert.equal((await fetch(endpoint('fixture-repo') + '&sessionId=fixture-outside',
    { headers: { Cookie: cookie! }, signal: AbortSignal.timeout(5000) })).status, 400, 'SID duplicado rechazado');
  assert.equal((await authorized('fixture-outside')).status, 403, 'cwd almacenado fuera de raices');
  assert.equal((await fetch(base + '/changes.json?cwd=' + encodeURIComponent(repo),
    { headers: { Cookie: cookie! }, signal: AbortSignal.timeout(5000) })).status, 400, 'SID obligatorio');
  const noGit = await authorized('fixture-nongit');
  assert.equal(noGit.status, 200);
  assert.deepEqual((await noGit.json() as { kind: string; entries: unknown[] }).kind, 'not-git');
  const foreign = await authorized('fixture-foreign');
  assert.equal(foreign.status, 403, 'cwd almacenado permitido pero Git root fuera del workspace');
  assert.ok(!(await foreign.text()).includes('OUTSIDE_REPO_MARKER'));
  // Solo omitir el caso si Windows no concede privilegio para crear el enlace.
  try {
    const link = join(workspace, 'link-outside');
    await symlink(foreignRepo, link, process.platform === 'win32' ? 'junction' : 'dir');
    const linked = new DatabaseSync(join(dbDir, 'sessions.db'));
    linked.prepare('INSERT INTO sessions (id, working_dir) VALUES (?, ?)').run('fixture-link', link);
    linked.close();
    const response = await authorized('fixture-link');
    assert.equal(response.status, 403, 'junction/symlink a repositorio exterior');
    assert.ok(!(await response.text()).includes('OUTSIDE_REPO_MARKER'));
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
    console.log('SKIP symlink: sin permisos de enlace en este sistema');
  }
  console.log('PASS /changes.json: sesión SQLite aislada, auth, método/origen, Git/diff, cwd no autoritativo, SID inexistente, root exterior y symlink');
} finally {
  if (child && child.exitCode === null) {
    const stopped = new Promise<void>(ok => child!.once('exit', () => ok()));
    child.kill();
    await Promise.race([stopped, delay(3000).then(() => { if (child!.exitCode === null) child!.kill('SIGKILL'); })]);
  }
  await rm(dir, { recursive: true, force: true });
}

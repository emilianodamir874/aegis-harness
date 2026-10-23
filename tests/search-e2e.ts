// Busqueda de texto completo, de punta a punta y sin tocar el proxy vivo:
//  A) endpoint /search.json en un proxy aislado (server.ts real + search-index real + base fixture)
//  B) UI real (bundle de src/app.ts) contra un WS mockeado y /search.json mockeado con la MISMA
//     forma que devuelve A (se valida que las claves coincidan).
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type WebSocketRoute } from 'playwright';
import { build } from 'esbuild';
import { createSearchDb } from './search-fixture.js';

const root = resolve(process.cwd());
const cache = resolve('node_modules/.cache');
await mkdir(cache, { recursive: true });
const dir = await mkdtemp(join(cache, 'search-e2e-'));
let child: ChildProcess | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

const DB = await createSearchDb(
  join(dir, 'db'),
  [
    { id: 's_uno', name: 'A52 y bots', updatedAt: '2026-10-20T22:06:00Z' },
    { id: 's_dos', name: 'Sin coincidencias', updatedAt: '2026-10-19T10:00:00Z' },
  ],
  [
    { session: 's_uno', text: 'Hicimos una revisión de estado con heimdall y quedó todo bien.' },
    { session: 's_dos', text: 'texto sin relación' },
  ],
);

try {
  // ---------------------------------------------------------------- A) endpoint real
  const built = await build({ entryPoints: [resolve('src/server.ts')], bundle: false, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent' });
  await writeFile(join(dir, 'server.mjs'), built.outputFiles[0].contents);
  await writeFile(join(dir, 'piper-vivo.js'), 'export const piperDespertar = async () => {}; export const piperVivo = async () => { throw Error("stub"); };\n');
  await writeFile(join(dir, 'package.json'), '{"type":"module"}\n');
  await mkdir(join(dir, 'tools'), { recursive: true });
  await copyFile(resolve('dist-ts/tools/search-index.mjs'), join(dir, 'tools/search-index.mjs'));
  await writeFile(join(dir, 'config.json'), JSON.stringify({ secretKey: 'TEST-ONLY', authStamp: 'test', publicHost: '127.0.0.1', webPort: 0, servePort: 0, tlsDir: '', cwd: 'C:/mock' }));
  await writeFile(join(dir, 'auth.json'), JSON.stringify({ password: 'TEST-ONLY-password' }));
  const reservation = net.createServer();
  await new Promise<void>((ok, fail) => reservation.once('error', fail).listen(0, '127.0.0.1', ok));
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((ok, fail) => reservation.close((e) => (e ? fail(e) : ok())));
  child = spawn(process.execPath, [join(dir, 'server.mjs')], {
    cwd: dir,
    env: { ...process.env, AEGIS_WEB_PORT: String(port), AEGIS_WEB_TLS_DIR: '', AEGIS_SESSIONS_DB: DB },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  child.stdout?.on('data', (b) => { log = (log + b.toString()).slice(-2000); });
  child.stderr?.on('data', (b) => { log = (log + b.toString()).slice(-2000); });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let n = 0; n < 100; n++) {
    if (child.exitCode !== null) throw new Error('proxy aislado terminó antes de escuchar: ' + log);
    try { const r = await fetch(base + '/favicon.ico', { signal: AbortSignal.timeout(300) }); if (r.status === 204) { ready = true; break; } } catch {}
    await delay(50);
  }
  assert.ok(ready, 'proxy aislado no arrancó: ' + log);

  const api = async (q: string) => {
    const r = await fetch(base + '/search.json?q=' + encodeURIComponent(q));
    return { status: r.status, type: r.headers.get('content-type') || '', cache: r.headers.get('cache-control') || '', body: await r.json() };
  };

  const a1 = await api('revision');
  assert.equal(a1.status, 200, 'search.json 200');
  assert.match(a1.type, /application\/json/, 'content-type json');
  assert.equal(a1.cache, 'no-cache', 'cache-control no-cache');
  assert.equal(a1.body.results.length, 1, 'una sesión con coincidencia');
  const hit = a1.body.results[0];
  assert.equal(hit.sessionId, 's_uno', 'sesión correcta');
  assert.ok(Array.isArray(hit.matches) && hit.matches.length >= 1, 'trae matches');
  assert.ok(hit.matches[0].snippet.includes('\u0001'), 'snippet con marca');
  for (const k of ['sessionId', 'title', 'cwd', 'updatedAt', 'archived', 'titleMatch', 'matches']) {
    assert.ok(k in hit, 'contrato del resultado incluye ' + k);
  }
  console.log('PASS endpoint /search.json: 200, JSON, no-cache y forma del resultado');

  const a2 = await api('revisión');
  assert.deepEqual(a2.body.results.map((r: any) => r.sessionId), a1.body.results.map((r: any) => r.sessionId), 'acentos: misma respuesta con y sin tilde');

  const a3 = await api('zzzz-nada');
  assert.equal(a3.status, 200);
  assert.equal(a3.body.results.length, 0, 'sin coincidencias -> lista vacía');

  const a4 = await api('');
  assert.equal(a4.status, 200);
  assert.equal(a4.body.results.length, 0, 'query vacía -> sin resultados');

  const a5 = await api('* " a:b NEAR( ' + 'x'.repeat(500));
  assert.equal(a5.status, 200, 'entrada malformada no rompe el endpoint');
  assert.ok(Array.isArray(a5.body.results), 'entrada malformada devuelve lista');

  const a6 = await fetch(base + '/search.json?q=revision&limit=999');
  assert.equal(a6.status, 200, 'limit fuera de rango se acota');
  const a7 = await fetch(base + '/search.json?q=revision&limit=0');
  assert.equal(a7.status, 200, 'limit 0 se acota a 1');

  // Control de acceso: el mismo endpoint por el túnel sin cookie no responde datos.
  const tunel = await fetch(base + '/search.json?q=revision', { headers: { 'cf-connecting-ip': '203.0.113.9' } });
  assert.equal(tunel.status, 401, 'por el túnel sin sesión: 401 (vio ' + tunel.status + ')');
  const cuerpo = await tunel.text();
  assert.ok(!cuerpo.includes('s_uno'), '401 no filtra resultados');
  console.log('PASS endpoint /search.json: acentos, vacío, malformadas, límites y 401 por túnel');

  // ---------------------------------------------------------------- B) UI real
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // El caso "rompe" provoca un 500 a proposito: el navegador lo registra como "Failed to load
  // resource" y no es un error de la app (la UI tiene que ocultar la seccion, y eso se verifica aparte).
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text().slice(0, 160)); });

  const html = await readFile(join(root, 'app/index.html'), 'utf8');
  const css = await readFile(join(root, 'app/app.css'), 'utf8');
  const bundle = await build({ entryPoints: [join(root, 'src/app.ts')], bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', logLevel: 'silent' });
  const script = bundle.outputFiles[0].text;
  const sessions = [
    { sessionId: 's_visible', title: 'Aegis harness', cwd: '/mock', updatedAt: new Date(Date.now() - 60000).toISOString(), _meta: { messageCount: 4 } },
  ];
  const loads: string[] = [];
  const RESULTADO = {
    query: 'revision',
    results: [
      {
        sessionId: 's_solo_busqueda',
        title: 'Sesión que no está en la página',
        cwd: 'C:\\Aegis-Proyects',
        updatedAt: '2026-10-20T22:06:00Z',
        archived: false,
        titleMatch: false,
        matches: [
          { role: 'user', ts: 1792000000, snippet: '…hicimos una \u0001revisión\u0002 de estado…' },
          { role: 'assistant', ts: 1792000100, snippet: '…la \u0001revisión\u0002 quedó lista…' },
        ],
      },
    ],
    totalSessions: 1,
    totalMatches: 2,
    truncated: false,
  };

  await page.route('http://search-e2e.invalid/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/' || url.pathname === '/index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    if (url.pathname === '/config.js') return route.fulfill({ status: 200, contentType: 'application/javascript', body: `window.__AEGIS_APP__={acpUrl:'ws://search-e2e.invalid/acp',cwd:'/mock',host:'mock'};` });
    if (url.pathname === '/app.js') return route.fulfill({ status: 200, contentType: 'application/javascript', body: script });
    if (url.pathname === '/app.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css });
    if (url.pathname === '/client-log') return route.fulfill({ status: 204, body: '' });
    if (url.pathname === '/search.json') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      if (q.includes('rompe')) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"_error":"boom"}' });
      if (q.includes('lento')) {
        await new Promise((ok) => setTimeout(ok, 450));
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ query: q, results: [], totalSessions: 0, totalMatches: 0, truncated: false }) });
      }
      if (q.includes('revision')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RESULTADO) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ query: q, results: [], totalSessions: 0, totalMatches: 0, truncated: false }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.routeWebSocket('ws://search-e2e.invalid/acp', (ws: WebSocketRoute) => {
    ws.onMessage((raw) => {
      const m = JSON.parse(String(raw));
      if (m.id === undefined) return;
      const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
      switch (m.method) {
        case 'initialize': return reply({ protocolVersion: 1 });
        case 'session/list': return reply({ sessions, _meta: { runningSessionIds: [] }, nextCursor: null });
        case 'session/load': loads.push(m.params?.sessionId); return reply({ configOptions: [], modes: {} });
        case '_aegis/unstable/session/watch': return reply({ cursor: 1, replay: [], activeRunId: null });
        case '_aegis/unstable/session/info': return reply({ activeRunId: null });
        default: return reply({});
      }
    });
  });

  await page.goto('http://search-e2e.invalid/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#session-list .sb-row');
  // Estado de carga: se prueba con una respuesta demorada a propósito (determinista).
  await page.fill('#search', 'lento');
  await page.waitForSelector('.sb-remote-loading', { timeout: 5000 });
  const cargando = await page.evaluate(() => ({
    head: !!document.querySelector('.sb-remote-head'),
    vacioLocal: !!document.querySelector('#session-list > .sb-empty'),
  }));
  assert.ok(cargando.head, 'mientras busca se muestra el encabezado');
  assert.equal(cargando.vacioLocal, false, 'mientras busca no se declara "sin resultados"');
  await page.waitForFunction(() => !document.querySelector('.sb-remote-loading'), null, { timeout: 5000 });

  await page.fill('#search', 'revision');
  await page.waitForSelector('.sb-hit', { timeout: 5000 });
  const ui = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.sb-remote-head ~ .sb-hit')];
    const r = rows[0];
    return {
      head: document.querySelector('.sb-remote-head')?.textContent || '',
      rows: rows.length,
      title: r?.querySelector('.sb-name')?.textContent || '',
      marks: r?.querySelectorAll('mark').length || 0,
      markText: r?.querySelector('mark')?.textContent || '',
      snips: r?.querySelectorAll('.sb-snip').length || 0,
      badge: r?.querySelector('.sb-hit-badge')?.textContent || '',
      emptyLocal: !!document.querySelector('#session-list > .sb-empty'),
      aria: r?.querySelector('.sb-item')?.getAttribute('aria-label') || '',
    };
  });
  assert.equal(ui.rows, 1, 'una fila de resultados remotos (' + JSON.stringify(ui) + ')');
  assert.match(ui.title, /no está en la página/, 'muestra el título de la sesión');
  assert.equal(ui.marks, 2, 'dos marcas <mark> en los snippets');
  assert.equal(ui.markText.toLowerCase(), 'revisión'.toLowerCase(), 'la marca rodea el término');
  assert.equal(ui.snips, 2, 'dos fragmentos por sesión');
  assert.equal(ui.emptyLocal, false, 'sin "sin resultados" cuando hay coincidencias en el contenido');
  assert.match(ui.head, /En los mensajes/, 'encabezado de la sección');
  assert.match(ui.head, /1/, 'contador de sesiones');
  assert.match(ui.aria, /coincidencias en los mensajes/, 'aria-label del resultado');
  console.log('PASS UI: sección "En los mensajes", snippets con <mark>, contador y sin estado vacío contradictorio');

  // Abrir una sesión que no estaba en la lista: usa session/load con el id del resultado.
  await page.click('.sb-hit .sb-item');
  await page.waitForFunction(() => (window as any).__aegisWeb?.state?.current?.id === 's_solo_busqueda', null, { timeout: 6000 });
  assert.ok(loads.includes('s_solo_busqueda'), 'session/load del resultado remoto');
  console.log('PASS UI: abrir un resultado que no estaba en la página carga esa sesión');

  // Sin resultados remotos: vuelve el estado vacío local.
  await page.fill('#search', 'nada-que-ver');
  await page.waitForFunction(() => !document.querySelector('.sb-remote-head'), null, { timeout: 5000 });
  const vacio = await page.evaluate(() => ({ empty: !!document.querySelector('#session-list > .sb-empty'), txt: document.querySelector('#session-list > .sb-empty')?.textContent || '' }));
  assert.ok(vacio.empty && /Sin resultados/.test(vacio.txt), 'sin coincidencias: estado vacío local (' + JSON.stringify(vacio) + ')');

  // Error del endpoint: la sección no se muestra y no hay errores de página.
  await page.fill('#search', 'rompe');
  await page.waitForTimeout(800);
  const trasError = await page.evaluate(() => ({ remote: !!document.querySelector('.sb-remote-head') }));
  assert.equal(trasError.remote, false, 'un 500 oculta la sección remota');

  // Escape limpia el filtro y la sección.
  await page.fill('#search', 'revision');
  await page.waitForSelector('.sb-remote-head');
  await page.locator('#search').press('Escape');
  await page.waitForTimeout(400);
  const limpio = await page.evaluate(() => ({ q: (document.getElementById('search') as HTMLInputElement).value, remote: !!document.querySelector('.sb-remote-head'), rows: document.querySelectorAll('#session-list .sb-row').length }));
  assert.equal(limpio.q, '', 'Escape limpia el buscador');
  assert.equal(limpio.remote, false, 'Escape oculta los resultados remotos');
  assert.ok(limpio.rows > 0, 'la lista vuelve a mostrar las sesiones');
  assert.equal(errors.length, 0, 'sin errores de página: ' + JSON.stringify(errors.slice(0, 3)));
  console.log('PASS UI: vacío, error del endpoint y Escape; sin errores de página');
} finally {
  if (browser) await browser.close();
  if (child && child.exitCode === null) {
    const stopped = new Promise<void>((ok) => child!.once('exit', () => ok()));
    child.kill();
    await Promise.race([stopped, delay(3000).then(() => { if (child!.exitCode === null) child!.kill('SIGKILL'); })]);
  }
  await rm(dir, { recursive: true, force: true });
}

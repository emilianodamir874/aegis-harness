// Lectura en voz alta (TTS) contra el bundle real y un hub mockeado.
// Se sirve la app desde 127.0.0.1 con un servidor estatico minimo; el ACP se intercepta con
// routeWebSocket y /tts se mockea con un WAV del repo (no se sintetiza nada real).
// El microfono y el dictado se fueron de la UI el 2026-10-29: aca ya no hay nada que probar de eso.
// Orden: micro primero. Encender la lectura abre el micro para barge-in (por diseño), y eso
// ensuciaria el estado del dictado.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type WebSocketRoute } from 'playwright';
import { build } from 'esbuild';

const root = resolve(process.cwd());
const bundle = await build({ entryPoints: [join(root, 'src/app.ts')], bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', logLevel: 'silent' });
const script = bundle.outputFiles[0].text;
const html = await readFile(join(root, 'app/index.html'), 'utf8');
const css = await readFile(join(root, 'app/app.css'), 'utf8');
// Cargar el JS compilado de todos los scripts del HTML; no sustituir módulos por
// respuestas JSON ni stubs, porque eso ocultaría fallos reales de inicialización.
const assetNames = [...html.matchAll(/<script\b[^>]*\bsrc=["']\.\/([^"']+\.js)["']/g)]
  .map((match) => match[1])
  .filter((name) => name !== 'config.js' && name !== 'app.js');
const assets = new Map<string, string>(await Promise.all(assetNames.map(async (name) =>
  [name, await readFile(join(root, 'dist-ts/app', name), 'utf8')] as [string, string],
)));
const wav = await readFile(join(root, 'tools/_silencio-2s.wav'));

const ttsPedidos: Array<{ text: string; voice: string; rate: string }> = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html); }
  if (url.pathname === '/app.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(script); }
  if (url.pathname === '/app.css') { res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' }); return res.end(css); }
  const asset = assets.get(url.pathname.slice(1));
  if (asset !== undefined) { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(asset); }
  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    return res.end(`window.__AEGIS_APP__={acpUrl:'ws://127.0.0.1:${port}/acp',cwd:'/mock',host:'mock'};`);
  }
  if (url.pathname === '/tts') {
    const text = url.searchParams.get('text') || '';
    ttsPedidos.push({ text, voice: url.searchParams.get('voice') || '', rate: url.searchParams.get('rate') || '' });
    if (text.includes('FALLA')) { res.writeHead(500); return res.end('boom'); }
    res.writeHead(200, { 'content-type': 'audio/wav' });
    return res.end(wav);
  }
  if (url.pathname === '/client-log') { res.writeHead(204); return res.end(); }
  if (url.pathname === '/search.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"query":"","results":[],"totalSessions":0,"totalMatches":0,"truncated":false}'); }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{}');
});
await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

// Espera activa del lado de Node (los pedidos /tts y las RPC viven aca, no en la pagina).
async function waitFor(cond: () => boolean, ms = 8000, label = 'condición') {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout esperando ' + label);
    await new Promise((ok) => setTimeout(ok, 50));
  }
}

const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text().slice(0, 140)); });

  await page.routeWebSocket(`ws://127.0.0.1:${port}/acp`, (ws: WebSocketRoute) => {
    ws.onMessage((raw) => {
      const m = JSON.parse(String(raw));
      if (m.id === undefined) return;
      const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
      switch (m.method) {
        case 'initialize': return reply({ protocolVersion: 1 });
        case 'session/list': return reply({ sessions: [{ sessionId: 's_media', title: 'Media', cwd: '/mock', updatedAt: new Date().toISOString(), _meta: { messageCount: 2 } }], _meta: { runningSessionIds: [] }, nextCursor: null });
        case 'session/load': return reply({ configOptions: [], modes: {} });
        case '_aegis/unstable/session/watch': return reply({ cursor: 1, replay: [], activeRunId: null });
        case '_aegis/unstable/session/info': return reply({ activeRunId: null });
        default: return reply({});
      }
    });
  });

  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#session-list .sb-row');
  await page.click('.sb-row[data-id="s_media"] .sb-item');
  await page.waitForFunction(() => (window as any).__aegisWeb?.state?.current?.id === 's_media', null, { timeout: 8000 });

  // ---------------------------------------------------------------- TTS
  const readBtn = page.locator('#btn-read');
  await readBtn.click();
  const trasEncender = await page.evaluate(() => ({
    pressed: document.getElementById('btn-read')?.getAttribute('aria-pressed'),
    guardado: localStorage.getItem('aegis.readOn.s_media'),
  }));
  assert.equal(trasEncender.pressed, 'true', 'lectura: el boton queda encendido');
  assert.equal(trasEncender.guardado, '1', 'lectura: el modo se recuerda por chat');

  // Primero el fallo del server: el aviso sale una sola vez (por diseño), asi que tiene que ser
  // la primera peticion de audio de la sesion.
  await page.evaluate(() => (window as any).__aegisWeb.read.pump('k0', '## Para escuchar\nFALLA a propósito.', true));
  await waitFor(() => ttsPedidos.some((p) => /FALLA/.test(p.text)), 6000, 'el pedido que falla');
  await page.waitForFunction(() => [...document.querySelectorAll('.sysnote')].some((n) => (n.textContent || '').includes('No pude pedirle el audio')), null, { timeout: 8000 });
  await page.evaluate(() => (window as any).__aegisWeb.read.reset(true));
  console.log('PASS TTS: fallo del server avisa una vez sin romper la app');

  await page.evaluate(() => (window as any).__aegisWeb.read.pump('k1', '## Para escuchar\nHola, esto es una prueba de lectura.', true));
  await waitFor(() => ttsPedidos.some((p) => /prueba de lectura/.test(p.text)), 6000, 'el pedido de lectura');
  const pedido = ttsPedidos.filter((p) => /prueba de lectura/.test(p.text))[0];
  assert.doesNotMatch(pedido.text, /Para escuchar/, 'lectura: no lee el encabezado');
  assert.ok(pedido.voice.length > 0 && Number(pedido.rate) > 0.5, 'lectura: manda voz y ritmo');
  assert.ok(await page.evaluate(() => document.getElementById('btn-read')?.classList.contains('speaking')), 'lectura: marca que esta leyendo');
  console.log('PASS TTS: enciende, recuerda por chat y pide solo el bloque "Para escuchar"');

  // Cortar: deja de estar "speaking" sin apagar el modo; apagar actualiza el estado.
  await page.evaluate(() => (window as any).__aegisWeb.read.reset(true));
  await page.waitForFunction(() => !document.getElementById('btn-read')?.classList.contains('speaking'), null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => (window as any).__aegisWeb.read.on()), true, 'lectura: el corte no apaga el modo');
  await readBtn.click();
  assert.equal(await page.evaluate(() => document.getElementById('btn-read')?.getAttribute('aria-pressed')), 'false', 'lectura: apagar actualiza el estado y el boton');
  console.log('PASS TTS: cortar y apagar actualizan estado y boton');

  assert.equal(errors.length, 0, 'sin errores de página: ' + JSON.stringify(errors.slice(0, 3)));
} finally {
  await browser.close();
  await new Promise<void>((ok) => server.close(() => ok()));
}

// Permisos de punta a punta a nivel protocolo: el hub (mock) manda session/request_permission
// como REQUEST del servidor y la UI real responde por el mismo socket. Se verifica el timing
// de la tarjeta, el contenido, la respuesta con el optionId correcto, el doble envio, el foco,
// los anuncios y el estado sin conexion. No otorga ningun permiso real: no hay agente detras.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type WebSocketRoute } from 'playwright';
import { build } from 'esbuild';

const root = resolve(process.cwd());
const html = await readFile(join(root, 'app/index.html'), 'utf8');
const css = await readFile(join(root, 'app/app.css'), 'utf8');
const bundle = await build({ entryPoints: [join(root, 'src/app.ts')], bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', logLevel: 'silent' });
const script = bundle.outputFiles[0].text;
// Servir todos los scripts declarados en el HTML con su JS compilado real: un JSON
// genérico para un <script type="module"> falla por MIME y un stub ocultaría errores.
const assetNames = [...html.matchAll(/<script\b[^>]*\bsrc=["']\.\/([^"']+\.js)["']/g)]
  .map((match) => match[1])
  .filter((name) => name !== 'config.js' && name !== 'app.js');
const assets = new Map<string, string>(await Promise.all(assetNames.map(async (name) =>
  [name, await readFile(join(root, 'dist-ts/app', name), 'utf8')] as [string, string],
)));

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)); });

  await page.route('http://perm.invalid/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/' || url.pathname === '/index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    if (url.pathname === '/config.js') return route.fulfill({ status: 200, contentType: 'application/javascript', body: `window.__AEGIS_APP__={acpUrl:'ws://perm.invalid/acp',cwd:'/mock',host:'mock'};` });
    if (url.pathname === '/app.js') return route.fulfill({ status: 200, contentType: 'application/javascript', body: script });
    if (url.pathname === '/app.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css });
    const asset = assets.get(url.pathname.slice(1));
    if (asset !== undefined) return route.fulfill({ status: 200, contentType: 'application/javascript', body: asset });
    if (url.pathname === '/client-log') return route.fulfill({ status: 204, body: '' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  // Respuestas del cliente a los pedidos de permiso (id -> result).
  const respuestas: Array<{ id: number; result: unknown }> = [];
  let socket: WebSocketRoute | undefined;
  const pedirPermiso = (id: number, options: any[], toolCall: any, sessionId = 's_perm') => {
    socket!.send(JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'session/request_permission',
      params: { sessionId, toolCall, options },
    }));
  };
  const OPCIONES = [
    { optionId: 'allow_once', name: 'Permitir una vez', kind: 'allow_once' },
    { optionId: 'allow_always', name: 'Permitir siempre', kind: 'allow_always' },
    { optionId: 'reject_once', name: 'Rechazar', kind: 'reject_once' },
    { optionId: 'reject_always', name: 'Rechazar siempre', kind: 'reject_always' },
  ];

  await page.routeWebSocket('ws://perm.invalid/acp', (ws: WebSocketRoute) => {
    socket = ws;
    ws.onMessage((raw) => {
      const m = JSON.parse(String(raw));
      if (m.method === undefined && m.id !== undefined) { respuestas.push({ id: m.id, result: m.result }); return; }
      if (m.id === undefined) return;
      const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
      switch (m.method) {
        case 'initialize': return reply({ protocolVersion: 1 });
        case 'session/list': return reply({ sessions: [{ sessionId: 's_perm', title: 'Permisos', cwd: '/mock', updatedAt: new Date().toISOString(), _meta: { messageCount: 2 } }, { sessionId: 's_otra', title: 'Otra', cwd: '/mock', updatedAt: new Date().toISOString(), _meta: { messageCount: 1 } }], _meta: { runningSessionIds: [] }, nextCursor: null });
        case 'session/load': return reply({ configOptions: [], modes: {} });
        case '_aegis/unstable/session/watch': return reply({ cursor: 1, replay: [], activeRunId: null });
        case '_aegis/unstable/session/info': return reply({ activeRunId: null });
        default: return reply({});
      }
    });
  });

  await page.goto('http://perm.invalid/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#session-list .sb-row');
  await page.click('.sb-row[data-id="s_perm"] .sb-item');
  await page.waitForFunction(() => (window as any).__aegisWeb?.state?.current?.id === 's_perm' && (window as any).__aegisWeb?.rpc?.ready === true, null, { timeout: 8000 });

  // ---- 1) la tarjeta aparece con el contexto y las opciones en orden
  pedirPermiso(9001, OPCIONES, { toolCallId: 'call_1', title: 'Ejecutar comando', kind: 'execute', rawInput: { command: 'echo aegis-perm-test' } });
  await page.waitForSelector('.perm', { timeout: 5000 });
  const card = await page.evaluate(() => {
    const el = document.querySelector('.perm') as HTMLElement;
    return {
      role: el.getAttribute('role'),
      aria: el.getAttribute('aria-label'),
      head: el.querySelector('.perm-head')?.textContent || '',
      tool: el.querySelector('.perm-tool')?.textContent || '',
      labels: [...el.querySelectorAll('.pb')].map((b) => (b as HTMLButtonElement).textContent),
      status: el.querySelector('[role="status"]')?.textContent || '',
      focus: (document.activeElement as HTMLElement)?.textContent || '',
    };
  });
  assert.equal(card.role, 'group', 'tarjeta con rol de grupo');
  assert.match(card.aria || '', /permiso/, 'aria-label de la tarjeta');
  assert.match(card.tool, /Ejecutar comando/, 'muestra la herramienta');
  assert.match(card.tool, /echo aegis-perm-test/, 'muestra el comando concreto');
  assert.deepEqual(card.labels, ['Permitir una vez', 'Permitir siempre', 'Rechazar', 'Rechazar siempre'], 'opciones en orden, con etiquetas claras');
  assert.match(card.status, /permiso/i, 'anuncio para lectores de pantalla');
  assert.equal(card.focus.trim(), 'Permitir una vez', 'el foco va a la primera opcion');
  console.log('PASS permiso: tarjeta con contexto, opciones ordenadas, anuncio y foco inicial');

  // ---- 2) aprobar responde con el optionId correcto y deshabilita
  await page.click('.perm .pb.primary');
  await page.waitForTimeout(300);
  assert.equal(respuestas.length, 1, 'una sola respuesta al hub');
  assert.deepEqual(respuestas[0].result, { outcome: { outcome: 'selected', optionId: 'allow_once' } }, 'respuesta con allow_once');
  const trasAprobar = await page.evaluate(() => {
    const el = document.querySelector('.perm') as HTMLElement;
    return {
      answered: el.classList.contains('answered'),
      disabled: [...el.querySelectorAll('.pb')].every((b) => (b as HTMLButtonElement).disabled),
      answer: el.querySelector('.perm-answer')?.textContent || '',
      live: el.querySelector('.perm-answer')?.getAttribute('role'),
    };
  });
  assert.ok(trasAprobar.answered && trasAprobar.disabled, 'tarjeta marcada como respondida y botones deshabilitados');
  assert.match(trasAprobar.answer, /Respondido: Permitir una vez/, 'texto de respuesta');
  assert.equal(trasAprobar.live, 'status', 'la respuesta se anuncia');
  console.log('PASS permiso: aprobar envia allow_once, deshabilita y anuncia');

  // ---- 3) doble envio: tras responder, los controles ya no estan y un click programatico
  //         sobre el boton (deshabilitado) tampoco manda nada.
  const ocultos = await page.evaluate(() => {
    const el = document.querySelector('.perm') as HTMLElement;
    const btns = el.querySelector('.perm-btns') as HTMLElement;
    return { display: getComputedStyle(btns).display, disabled: [...btns.querySelectorAll('button')].every((b) => (b as HTMLButtonElement).disabled) };
  });
  assert.equal(ocultos.display, 'none', 'los botones desaparecen al responder');
  assert.ok(ocultos.disabled, 'los botones quedan deshabilitados');
  await page.evaluate(() => (document.querySelector('.perm .pb.primary') as HTMLButtonElement).click());
  await page.waitForTimeout(200);
  assert.equal(respuestas.length, 1, 'un segundo click no vuelve a responder');

  // ---- 4) el mismo pedido reenviado no duplica la tarjeta ni revive botones
  pedirPermiso(9001, OPCIONES, { toolCallId: 'call_1', title: 'Ejecutar comando', kind: 'execute', rawInput: { command: 'echo aegis-perm-test' } });
  await page.waitForTimeout(300);
  const dup = await page.evaluate(() => ({ cards: document.querySelectorAll('.perm').length, disabled: [...document.querySelectorAll('.perm .pb')].every((b) => (b as HTMLButtonElement).disabled) }));
  assert.equal(dup.cards, 1, 'una sola tarjeta para el mismo id');
  assert.ok(dup.disabled, 'los botones siguen deshabilitados (no revive controles viejos)');
  console.log('PASS permiso: sin doble envio y sin tarjetas duplicadas');

  // ---- 5) rechazar usa reject_once
  pedirPermiso(9002, OPCIONES, { toolCallId: 'call_2', title: 'Escribir archivo', kind: 'edit', rawInput: { path: 'C:/tmp/x.txt' } });
  await page.waitForFunction(() => document.querySelectorAll('.perm').length === 2, null, { timeout: 5000 });
  await page.locator('.perm').nth(1).getByRole('button', { name: 'Rechazar', exact: true }).click();
  await page.waitForTimeout(250);
  assert.equal(respuestas.length, 2, 'segunda respuesta enviada');
  assert.deepEqual(respuestas[1].result, { outcome: { outcome: 'selected', optionId: 'reject_once' } }, 'respuesta con reject_once');
  console.log('PASS permiso: rechazar envia reject_once');

  // ---- 6) mientras el usuario escribe no se le roba el foco
  await page.fill('#input', 'estoy escribiendo algo');
  await page.focus('#input');
  pedirPermiso(9003, OPCIONES, { toolCallId: 'call_3', title: 'Ejecutar comando', kind: 'execute', rawInput: { command: 'echo otro' } });
  await page.waitForFunction(() => document.querySelectorAll('.perm').length === 3, null, { timeout: 5000 });
  const focoEscribiendo = await page.evaluate(() => (document.activeElement as HTMLElement)?.id);
  assert.equal(focoEscribiendo, 'input', 'no se roba el foco si hay un borrador en curso');
  console.log('PASS permiso: no roba el foco mientras se escribe');

  // ---- 7) sin socket: no se marca como respondido ni se deshabilitan los botones
  await page.evaluate(() => { const w = (window as any).__aegisWeb; if (w?.rpc) { w.rpc.ws = null; w.rpc.ready = false; } });
  await page.locator('.perm').nth(2).locator('.pb.primary').click();
  await page.waitForTimeout(250);
  const sinSocket = await page.evaluate(() => {
    const el = document.querySelectorAll('.perm')[2] as HTMLElement;
    return {
      answered: el.classList.contains('answered'),
      disabled: [...el.querySelectorAll('.pb')].some((b) => (b as HTMLButtonElement).disabled),
      answer: el.querySelector('.perm-answer')?.textContent || '',
    };
  });
  assert.equal(sinSocket.answered, false, 'sin conexión no se da por respondido');
  assert.equal(sinSocket.disabled, false, 'los botones quedan habilitados para reintentar');
  assert.match(sinSocket.answer, /Sin conexión/, 'explica por qué no se pudo responder');
  assert.equal(respuestas.length, 2, 'no se envio nada por un socket ausente');
  console.log('PASS permiso: sin conexión no falsea la respuesta y deja reintentar');

  assert.equal(errors.length, 0, 'sin errores de página: ' + JSON.stringify(errors.slice(0, 3)));
} finally {
  await browser.close();
}

// Regresiones de cliente SIN web/ACP vivos, credenciales, sesiones reales ni prompts.
// Desde web/: npm run build && node dist-ts/tests/client-regressions.mjs
// Integrada al runner/build; no usar AEGIS_WEB_URL aquí.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type WebSocketRoute } from 'playwright';

// Fórmulas probadas contra el bundle del cliente a través del hook mock.

const eq = (actual: unknown, expected: unknown, message: string) => {
  if (actual !== expected) throw new Error(message + ': ' + String(actual) + ' ≠ ' + String(expected));
};

// Probar el build aislado en dist-ts/app, sin publicar ni usar la web real.
const root = resolve(process.cwd(), 'dist-ts', 'app');
const html = await readFile(resolve(root, 'index.html'), 'utf8');
const modules = [...html.matchAll(/<script\b[^>]*\bsrc=["']\.\/([^"']+\.js)["']/g)].map(m => m[1]).filter(name => name !== 'config.js');
const assets = new Map<string, { body: string; contentType: string }>();
for (const name of ['app.css', 'icon.svg', 'manifest.json', ...modules]) {
  assets.set('/' + name, { body: await readFile(resolve(root, name), 'utf8'), contentType: name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.json') ? 'application/json' : 'application/javascript' });
}
// Scripts de index.html, todos desde el build actual.


const A = 'mock-session-A', B = 'mock-session-B';
const sessions = [A, B].map((sessionId, i) => ({ sessionId, title: i ? 'Chat B' : 'Chat A', cwd: '/mock', updatedAt: new Date(Date.now() - i * 60000).toISOString(), _meta: { messageCount: 2 } }));
let running = [A, B];
let failDelete = true;
const requests: Array<{ method: string; params: any }> = [];
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push('console: ' + msg.text()); });
  page.on('requestfailed', request => errors.push('requestfailed: ' + request.url()));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.host !== 'client-regressions.invalid') { errors.push('red externa: ' + url.href); return route.abort(); }
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    if (request.method() === 'GET' && path === '/index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    if (request.method() === 'GET' && path === '/config.js') return route.fulfill({ status: 200, contentType: 'application/javascript', body: `window.__AEGIS_APP__={acpUrl:'ws://client-regressions.invalid/acp',cwd:'/mock',host:'mock'};` });
    const asset = assets.get(path);
    if (request.method() === 'GET' && asset) return route.fulfill({ status: 200, ...asset });
    if (request.method() === 'GET' && path === '/pending.json') return route.fulfill({ status: 200, json: { sessions: [] } });
    if (request.method() === 'GET' && path === '/outbox.json') return route.fulfill({ status: 200, json: { items: [] } });
    if (request.method() === 'GET' && path === '/memory.json') return route.fulfill({ status: 200, json: { facts: [] } });
    if (request.method() === 'GET' && path === '/skills.json') return route.fulfill({ status: 200, json: { skills: [] } });
    if (request.method() === 'GET' && path === '/ws/defaults') return route.fulfill({ status: 200, json: {} });
    if (request.method() === 'GET' && path === '/prices.json') return route.fulfill({ status: 200, json: {} });
    if (request.method() === 'GET' && path === '/goals.json') return route.fulfill({ status: 200, json: { goals: [] } });
    if (request.method() === 'GET' && path === '/stats.json') return route.fulfill({ status: 200, json: { sessions: 0, messages: 0, prompts: 0, tools: 0 } });
    if (request.method() === 'POST' && path === '/client-log') return route.fulfill({ status: 204, body: '' });
    errors.push('petición inesperada: ' + request.method() + ' ' + path);
    return route.fulfill({ status: 404, body: 'fixture: petición inesperada' });
  });  await page.routeWebSocket('ws://client-regressions.invalid/acp', (ws: WebSocketRoute) => {
    ws.onMessage(raw => {
      const m = JSON.parse(String(raw));
      if (m.id === undefined) return;
      requests.push({ method: m.method, params: m.params });
      const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
      switch (m.method) {
        case 'initialize': reply({ protocolVersion: 1 }); break;
        case '_aegis/unstable/sources/list': reply({ sources: [] }); break;
        // El combobox pide el catalogo al dibujar los chips: sin esto el fixture lo trata como inesperado.
        case '_aegis/unstable/providers/list': reply({ entries: [] }); break;
        case 'tools/list': reply({ tools: [] }); break;
        case '_aegis/unstable/tools/list': reply({ tools: [] }); break;
        case 'session/list': reply({ sessions, _meta: { runningSessionIds: running }, nextCursor: null }); break;
        case 'session/load': reply({ configOptions: [], modes: {} }); break;
        case '_aegis/unstable/session/info': reply({ activeRunId: 'mock-mobile-run' }); break; // watchdog mock, sin red real
        case '_aegis/unstable/session/watch': reply({ cursor: 1, replay: [], activeRunId: null }); break;
        case '_aegis/unstable/session/unwatch': reply({}); break;
        case 'session/delete':
          if (failDelete) ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: 403, message: 'denegado', data: { reason: 'mock-policy' } } }));
          else reply({});
          break;
        case 'test/error': ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32042, message: 'error simulado', data: { actualRunId: 'mock-run' } } })); break;
        case 'test/error-detail': ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32043, message: 'Internal error', data: 'Model file not found: mock-model' } })); break;
        default: throw new Error('RPC inesperado: ' + m.method); // nunca simular session/prompt
      }
    });
  });
  await page.goto('http://client-regressions.invalid/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window as any).__aegisWeb?.state.sessions.length === 2);
  // Replay fixture: ACP entrega tool_call ANTES de responder session/load.
  const specialId = 'call-"] [data-tool-call-id="other';
  const navigation = await page.evaluate(async ({ A, B, specialId }) => {
    const app = (window as any).__aegisWeb;
    const before = app.state.current?.id ?? null;
    const unknown = await app.openTool('unknown-session', 'missing');
    const afterUnknown = app.state.current?.id ?? null;
    document.querySelector<HTMLElement>('.sb-row[data-id="mock-session-A"] .sb-item')!.click();
    await new Promise<void>(resolve => setTimeout(resolve, 300));
    const ui = app.testUi;
    ui.update({ sessionId: A, update: { sessionUpdate: 'tool_call', toolCallId: specialId, title: 'Tarjeta especial', status: 'completed' } });
    const box = document.querySelector<HTMLElement>('#messages')!;
    box.scrollTop = 37;
    const position = box.scrollTop;
    const missing = await app.openTool(A, 'missing');
    const preserved = box.scrollTop;
    const found = await app.openTool(A, specialId);
    const card = [...document.querySelectorAll<HTMLElement>('#msg-inner .tool')].find(el => el.dataset.toolCallId === specialId);
    return { before, unknown, afterUnknown, missing, preserved, position, found, tagged: !!card, outlined: !!card?.style.outline, current: app.state.current?.id };
  }, { A, B, specialId });
  eq(navigation.unknown, false, 'ID de sesion desconocido devuelve false');
  eq(navigation.afterUnknown, navigation.before, 'ID de sesion desconocido no navega');
  eq(navigation.missing, false, 'call ausente devuelve false');
  eq(navigation.preserved, navigation.position, 'fallo conserva scroll');
  if (!navigation.found || !navigation.tagged || !navigation.outlined || navigation.current !== A) throw new Error('deep-link local sin tarjeta real: ' + JSON.stringify(navigation));
  console.log('PASS openTool local, ID CSS hostil, ausencia y scroll conservado');
  const diffCheck = await page.evaluate((sessionId) => {
    const app = (window as any).__aegisWeb;
    const id = 'diff-mock-1';
    const path = 'src/<img src=x onerror=alert(1)>.ts';
    const update = (event: Record<string, unknown>, sid = sessionId) => app.testUi.update({ sessionId: sid, update: { sessionUpdate: 'tool_call_update', toolCallId: id, ...event } });
    update({ status: 'in_progress', title: 'Editar archivo', rawInput: { path, before: 'uno', after: 'dos' }, _meta: { aegis: { toolCall: { toolName: 'developer__edit' } } } });
    update({ content: [{ type: 'diff', path, oldText: 'a\nuno\nz\n', newText: 'a\ndos\nz\n' }] });
    update({ status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Edited src/code.ts (1 lines -> 1 lines)' } }] });
    update({ content: [{ type: 'diff', path, oldText: 'a\nuno\nz\n', newText: 'a\ndos\nz\n' }] });
    const card = app.state.tools.get(id) as HTMLElement;
    const row = card.querySelector<HTMLDetailsElement>('.tool-diff')!;
    const initial = { count: card.querySelectorAll('.tool-diff').length, title: row.querySelector('summary')?.textContent,
      escaped: !row.querySelector('img'), hasPreBefore: !!card.querySelector('.tool-diff-code'), textBefore: row.querySelector('.tool-diff-code')?.textContent || '',
      output: card.querySelector('.tool-body > pre:not(.tool-diff-code)')?.textContent, finalStatus: card.dataset.state, cardTitle: card.querySelector('.tool-title')?.textContent };
    row.open = true;
    const visible = !!row.querySelector('.tool-diff-code')?.getBoundingClientRect().width;
    update({ content: [{ type: 'diff', path: 'otro.ts', oldText: 'x', newText: 'y' }] }, 'another-chat');
    const isolated = card.querySelectorAll('.tool-diff').length === 1;
    const requestedId = 'diff-request-1';
    app.testUi.update({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: requestedId, rawInput: { path: 'replay.ts', before: 'viejo', after: 'nuevo' }, _meta: { aegis: { toolCall: { toolName: 'developer__edit' } } } } });
    app.testUi.update({ sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: requestedId, status: 'completed' } });
    const request = app.state.tools.get(requestedId) as HTMLElement;
    const preview = request.querySelector('.tool-diff');
    const failureId = 'diff-failed-1';
    app.testUi.update({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: failureId, rawInput: { path: 'fallo.ts', before: 'a', after: 'b' }, _meta: { aegis: { toolCall: { toolName: 'developer__edit' } } } } });
    app.testUi.update({ sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: failureId, status: 'failed' } });
    return { ...initial, visible, isolated, requested: !!preview && /archivo nuevo|contenido enviado/i.test(preview.textContent || ''), failed: !app.state.tools.get(failureId).querySelector('.tool-diff'), stillOne: card.querySelectorAll('.tool-diff').length === 1 };
  }, A);
  if (diffCheck.count !== 1 || !diffCheck.title?.includes('+1 −1') || !diffCheck.escaped || !diffCheck.hasPreBefore
    || !diffCheck.textBefore.includes('-uno') || !diffCheck.textBefore.includes('+dos') || !diffCheck.output?.includes('Edited src/code.ts')
    || diffCheck.finalStatus !== 'ok' || diffCheck.cardTitle !== 'Editar archivo' || !diffCheck.visible
    || !diffCheck.isolated || !diffCheck.requested || !diffCheck.failed || !diffCheck.stillOne) {
    throw new Error('diff ACP en chat: ' + JSON.stringify(diffCheck));
  }
  console.log('PASS diff ACP inline: toolCallId, escape, dedupe, vista expandida, fragmento persistido y fallo');
  const formulas = await page.evaluate(() => {
    const r = (window as any).__aegisWeb.testUi.rate;
    return [
      r({ outputTokens: 100, elapsedMs: 2100, generationMs: 2000, timeToFirstTokenMs: 2100 }),
      r({ outputTokens: 100, elapsedMs: 2000 }),
      r({ outputTokens: 10, elapsedMs: 100, timeToFirstTokenMs: 100 }),
      r({ outputTokens: 10, elapsedMs: 100, generationMs: 50, timeToFirstTokenMs: -1 }),
      r({ outputTokens: 10, elapsedMs: 100, generationMs: 0, timeToFirstTokenMs: 0 }),
      r({ outputTokens: 10, elapsedMs: 0 }),
      r({ outputTokens: 10, generationMs: 100 }),
      r({ outputTokens: 10, elapsedMs: 100, generationMs: Number.NaN }),
    ];
  });
  eq(formulas[0]?.value, 50, 'generationMs prima incluso si TTFT=elapsed'); eq(formulas[0]?.kind, 'generation', 'generationMs válido');
  eq(formulas[1]?.value, 50, 'sin generationMs tasa de solicitud'); eq(formulas[1]?.kind, 'request', 'histórico: solicitud total');
  eq(formulas[2]?.value, 100, 'TTFT igual a total no usa 250ms'); eq(formulas[2]?.kind, 'request', 'TTFT igual a total no es generación');
  eq(formulas[3]?.value, 200, 'generationMs independiente de TTFT negativo'); eq(formulas[3]?.kind, 'generation', 'generationMs válido');
  eq(formulas[4]?.kind, 'request', 'generationMs=0 cae a solicitud'); eq(formulas[5], null, 'elapsed 0 sin generationMs');
  eq(formulas[6]?.kind, 'generation', 'generationMs sin elapsed todavía válido');
  eq(formulas[7]?.kind, 'request', 'generationMs NaN cae a solicitud');
  console.log('PASS generationMs exacto vs solicitud histórica, sin restar TTFT');
  await page.locator(`.sb-row[data-id="${A}"] .sb-item`).click();
  await page.waitForFunction((id) => (window as any).__aegisWeb?.state.current?.id === id && (window as any).__aegisWeb?.state.hubWatchSid === id, A);
  const input = page.locator('#input');
  await input.fill('borrador A sin enviar');
  await page.locator(`.sb-row[data-id="${B}"] .sb-item`).click();
  await page.waitForFunction((id) => (window as any).__aegisWeb?.state.current?.id === id && (window as any).__aegisWeb?.state.hubWatchSid === id, B);
  if (!requests.some(r => r.method === '_aegis/unstable/session/unwatch' && r.params?.sessionId === A)) throw new Error('watch A no se desenganchó al abrir B');
  if (await input.inputValue() !== '') throw new Error('el borrador A aparece en B');
  await input.fill('borrador B sin enviar');
  await page.locator(`.sb-row[data-id="${A}"] .sb-item`).click();
  await page.waitForFunction((id) => (window as any).__aegisWeb?.state.current?.id === id, A);
  if (await input.inputValue() !== 'borrador A sin enviar') throw new Error('no se restauró borrador A');
  if (await page.evaluate((id) => localStorage.getItem('aegis.draft.' + id), B) !== 'borrador B sin enviar') throw new Error('no se guardó borrador B');
  console.log('PASS borradores por chat y unwatch anterior al alternar A/B');

  // Un error de borrado conserva la fila, muestra la causa y permite reintentar.
  // v4: borrar vive en el menu de la fila (⋯), no en un icono por fila.
  const borrarDesdeMenu = async () => {
    await page.locator(`.sb-row[data-id="${B}"] .sb-more`).click();
    await page.locator('body > .menu.row-menu .menu-row.danger').click();
    await page.locator(`.sb-row[data-id="${B}"] .sb-confirm .ym`).click();
  };
  await borrarDesdeMenu();
  await page.waitForFunction(() => (document.querySelector('#messages')?.textContent || '').includes('No se pudo borrar: denegado'));
  if (await page.locator(`.sb-row[data-id="${B}"]`).count() !== 1 || await page.locator('.sb-confirm').count()) throw new Error('borrado fallido ocultó la sesión o dejó confirmación bloqueada');
  failDelete = false;
  await borrarDesdeMenu();
  await page.locator(`.sb-row[data-id="${B}"]`).waitFor({ state: 'detached' });
  if (!requests.some(r => r.method === 'session/delete' && r.params?.sessionId === B)) throw new Error('delete no usó el ID de B');
  // El mock de session/list conserva B deliberadamente: el test no crea ni borra nada real.
  console.log('PASS borrado fallido conserva la fila y el reintento funciona');

  // runningSessionIds del listado: transición A corriendo -> A terminado, B sigue corriendo.
  await page.evaluate(() => (window as any).__aegisWeb.refreshSessions());
  await page.waitForFunction((ids) => ids.every(id => !!document.querySelector(`.sb-row[data-id="${id}"] .sb-run-dot`)), [A, B]);
  running = [B];
  // Sin refresco manual: el polling global debe detectar el fin aun mirando otro chat.
  await page.waitForFunction((id) => !!document.querySelector(`.sb-row[data-id="${id}"] .sb-done-dot`), A, { timeout: 12000 });
  if (await page.locator(`.sb-row[data-id="${A}"] .sb-run-dot`).count() || await page.locator(`.sb-row[data-id="${B}"] .sb-run-dot`).count() !== 1 || await page.locator(`.sb-row[data-id="${B}"] .sb-done-dot`).count()) throw new Error('insignias de fin/corriendo se mezclaron entre chats');
  console.log('PASS insignias de terminación separadas por chat');

  const uiState = await page.evaluate((sid) => {
    const app = (window as any).__aegisWeb;
    const ui = app.testUi;
    if (!ui) throw new Error('testUi missing; keys=' + Object.keys(app).join(',') + ' script=' + [...document.scripts].map(s => s.src).join(','));
    const user = ui.addUser('mensaje local de prueba', false, []);
    ui.update({ sessionId: sid, update: { sessionUpdate: 'user_message_chunk', messageId: 'mid-text', content: { type: 'text', text: 'mensaje local de prueba' } } });
    const textOk = user.dataset.mid === 'mid-text' && user.querySelectorAll('.rewind-btn').length === 1;
    const image = { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' };
    const imageUser = ui.addUser('', false, [{ mimeType: image.mimeType, data: image.data }]);
    ui.update({ sessionId: sid, update: { sessionUpdate: 'user_message_chunk', messageId: 'mid-image', content: image } });
    ui.update({ sessionId: sid, update: { sessionUpdate: 'user_message_chunk', messageId: 'mid-image', content: { type: 'text', text: 'texto posterior' } } });
    const imageOk = imageUser.dataset.mid === 'mid-image' && imageUser.querySelectorAll('.rewind-btn').length === 1;
    const steer = ui.addUser('indicación entregada', false, [], { queued: true });
    ui.seedSteer('mid-steer', steer);
    ui.update({ sessionId: sid, update: { sessionUpdate: 'user_message_chunk', messageId: 'mid-steer', content: { type: 'text', text: 'indicación entregada' } } });
    const steerOk = steer.dataset.mid === 'mid-steer' && steer.querySelectorAll('.rewind-btn').length === 1 && !steer.classList.contains('queued');
    const users = [...document.querySelectorAll('#msg-inner .msg-user')];
    return { textOk, imageOk, steerOk, users: users.length, identified: users.filter(el => !!(el as HTMLElement).dataset.mid).length };
  }, A);
  if (!uiState.textOk || !uiState.imageOk || !uiState.steerOk || uiState.users !== 3 || uiState.identified !== 3) throw new Error('burbuja sin rebobinar inmediato: ' + JSON.stringify(uiState));
  console.log('PASS rebobinar inmediato de texto, imagen y steer sin recargar');
  const rates = await page.evaluate((sid) => {
    const app = (window as any).__aegisWeb;
    const ui = app.testUi;
    const notify = (id: string, output: number, gen?: number) => ui.usage({ sessionId: sid, update: { sessionUpdate: 'message_usage', messageId: id, usage: { outputTokens: output, elapsedMs: 2100, timeToFirstTokenMs: 2100, ...(gen === undefined ? {} : { generationMs: gen }) } } });
    const chunk = (id: string) => ui.update({ sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', messageId: id, content: { type: 'text', text: 'prueba' } } });
    const cells = () => [...document.querySelectorAll('#runbar-speed-windows .runbar-speed-cell')].map((n) => (n.textContent || '').trim());
    ui.run('run-usage');
    // Una notificación anterior al run y un usage sin mensaje no pertenecen a este turno.
    notify('old', 999);
    ui.usage({ sessionId: sid, update: { sessionUpdate: 'message_usage', usage: { outputTokens: 999, elapsedMs: 2100, timeToFirstTokenMs: 100 } } });
    chunk('step1');
    app.state.hubReplay = true; notify('step1', 20); app.state.hubReplay = false;
    notify('step1', 20, 2000); notify('step1', 20, 2000); // replay y duplicados del mismo messageId
    const afterFirst = { summary: app.speedSummary(), cells: cells() };
    chunk('step2');
    notify('step2', 20, 2000);
    const live = { summary: app.speedSummary(), cells: cells() };
    chunk('step3'); // usage genuino que llega después del terminal
    ui.run(null);
    const beforeLate = app.speedSummary();
    notify('old', 999);
    notify('step3', 40, 2000);
    notify('step3', 40, 2000); notify('step1', 20, 2000); // duplicados luego del terminal
    const afterLate = app.speedSummary();
    const note = document.querySelector('#msg-inner .turn-end:last-of-type')?.textContent || '';
    return {
      afterFirst, live, beforeLate, afterLate, note,
      cellsLate: cells(),
      instant: !!document.querySelector('#runbar-tps') || !!document.querySelector('#runbar-avg'),
      insidePhase: !!document.querySelector('#runbar-phase #runbar-speed-windows')
    };
  }, A);
  eq(rates.afterFirst.summary.out, 20, 'uso único por messageId/run');
  eq(rates.live.summary.out, 40, 'dos pasos suman una vez cada uno');
  eq(rates.beforeLate.out, 40, 'fin de turno mantiene la generación medida');
  eq(rates.afterLate.out, 80, 'usage tardío del run suma una vez; ajenos ignorados');

  // Tres pasos medidos de 2 s cada uno: 20 + 20 + 40 tok en 6 s de generación = 13,3 tok/s.
  if (Math.abs((rates.afterLate.avg ?? 0) - 80 / 6) > 1e-9) throw new Error('promedio ponderado de generación: ' + String(rates.afterLate.avg));
  if (!rates.note.includes('prom generación 13.3 tok/s') || !rates.note.includes('80 tok')) throw new Error('promedio del turno en la nota: ' + JSON.stringify(rates.note));
  if (!/fin del turno/.test(rates.note)) throw new Error('la nota perdió el tiempo del turno: ' + JSON.stringify(rates.note));
  if (rates.instant) throw new Error('quedan nodos de tasa instantánea en el runbar');
  if (rates.insidePhase) throw new Error('la fila de promedios quedó dentro del badge de fase');
  const labels = rates.cellsLate.map((x) => x.slice(0, x.length - (x.match(/[\d.,—]+$/) || [''])[0].length));
  eq(labels.join(','), '5s,15s,30s,1m,5m,15m', 'las seis ventanas van en orden');
  const nums = rates.cellsLate.map((x) => Number((x.match(/[\d.]+$/) || ['NaN'])[0]));
  if (nums.some((n) => !isFinite(n) || n <= 0)) throw new Error('ventanas sin valor con muestras: ' + JSON.stringify(rates.cellsLate));
  if (!(nums[0] > nums[1] && nums[1] > nums[2] && nums[2] > nums[3] && nums[3] > nums[4])) throw new Error('ventanas no decrecientes con el ancho: ' + JSON.stringify(rates.cellsLate));
  console.log('PASS uso ordenado/deduplicado por mensaje y run, y seis promedios móviles de salida');
  const emptyRun = await page.evaluate((sid) => {
    const app = (window as any).__aegisWeb, ui = app.testUi;
    ui.run('run-empty');
    const cells = [...document.querySelectorAll('#runbar-speed-windows .runbar-speed-cell')].map((n) => (n.textContent || '').trim());
    const windows = document.querySelector<HTMLElement>('#runbar-speed-windows');
    const res = { cells, hidden: !!windows?.hidden, shown: !!windows && getComputedStyle(windows).display !== 'none', instant: !!document.querySelector('#runbar-tps') };
    ui.run(null);
    return res;
  }, A);
  eq(emptyRun.cells.length, 6, 'las seis ventanas existen antes del primer usage');
  if (!emptyRun.cells.every((x) => x.endsWith('—'))) throw new Error('ventanas inventan un número sin usage: ' + JSON.stringify(emptyRun.cells));
  if (emptyRun.hidden || !emptyRun.shown) throw new Error('fila de promedios oculta sin usage: ' + JSON.stringify(emptyRun));
  if (emptyRun.instant) throw new Error('badge instantáneo creado sin usage');
  console.log('PASS ventanas vacías antes del primer usage, sin tasa inventada');
  // Turno adoptado a mitad de camino: los pasos medidos antes de entrar al chat no llegaron como
  // message_usage a esta pestaña. Se siembra el último que informó el backend y tiene que caer en
  // las ventanas como si se hubiera medido acá, una sola vez y solo si es generación.
  const adopt = await page.evaluate(() => {
    const app = (window as any).__aegisWeb, ui = app.testUi;
    const cells = () => [...document.querySelectorAll('#runbar-speed-windows .runbar-speed-cell')].map((n) => (n.textContent || '').trim());
    ui.busy(true, 'Turno adoptado');
    app.speedStart();
    app.state.last = { outputTokens: 300, generationMs: 5000, elapsedMs: 6000 };
    app.speedSeed();
    app.speedWindowPaint();
    const row = document.querySelector<HTMLElement>('#runbar-speed-windows');
    const seeded = { cells: cells(), title: row?.title || '', samples: app.state.speed.samples.length };
    app.speedSeed();
    const twice = app.state.speed.samples.length;
    // Solo throughput de solicitud: sirve como último dato, no entra en las ventanas.
    app.speedReset();
    app.speedStart();
    app.state.last = { outputTokens: 40, elapsedMs: 5000, generationMs: null };
    app.speedSeed();
    app.speedWindowPaint();
    const request = { samples: app.state.speed.samples.length, cells: cells() };
    ui.busy(false);
    return { seeded, twice, request };
  });
  eq(adopt.seeded.cells.join(','), '5s60.0,15s20.0,30s10.0,1m5.0,5m1.0,15m0.3', 'siembra del turno adoptado: 300 tok en 5 s repartidos en las seis ventanas: ' + JSON.stringify(adopt.seeded.cells));
  eq(adopt.seeded.samples, 1, 'la siembra agrega una sola muestra');
  eq(adopt.twice, 1, 'sembrar dos veces no duplica la muestra');
  if (!/backend/.test(adopt.seeded.title)) throw new Error('title de la fila sembrada: ' + adopt.seeded.title);
  eq(adopt.request.samples, 0, 'el throughput de solicitud no entra en las ventanas de generación');
  if (!adopt.request.cells.every((x) => x.endsWith('—'))) throw new Error('sin generación medida las ventanas no inventan número: ' + JSON.stringify(adopt.request.cells));
  console.log('PASS turno adoptado siembra las ventanas con el último usage del backend, sin estimar');
  await page.evaluate(() => {
    const app = (window as any).__aegisWeb;
    app.testUi.run('mock-run');
  });
  await page.waitForFunction(() => (window as any).__aegisWeb.state.busy === true);
  await page.evaluate(() => (window as any).__aegisWeb.testUi.run(null));
  await page.waitForFunction(() => (window as any).__aegisWeb.state.busy === false);
  if (await page.locator('#btn-stop').isVisible()) throw new Error('el botón Detener sigue visible tras recibir fin de run');
  console.log('PASS fin de run por hub libera la barra sin recargar');

  await page.evaluate(() => { const pop = document.querySelector<HTMLElement>('#usage-pop'); if (pop) pop.hidden = true; });
  // Tres teléfonos: el runbar tiene dos renglones (estado + promedios) y ninguno puede desbordar.
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 780 });
    const snapshot = await page.evaluate((sid) => {
      const app = (window as any).__aegisWeb, ui = app.testUi;
      const text = document.querySelector<HTMLElement>('#runbar-text')!;
      const queued = document.querySelector<HTMLElement>('#runbar-queued');
      ui.busy(true, 'Turno en curso (lo arrancó otra conexión)');
      ui.update({ sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', messageId: 'mobile-live-' + innerWidth, content: { type: 'text', text: 'prueba' } } });
      app.speedStart();
      return { text: text.textContent, title: text.title, initialQueue: !!queued && !queued.hidden };
    }, A);
    await page.waitForTimeout(150);
    const live = await page.evaluate((sid) => {
      const app = (window as any).__aegisWeb, ui = app.testUi;
      const bar = document.querySelector<HTMLElement>('#runbar')!;
      const queued = document.querySelector<HTMLElement>('#runbar-queued');
      const stop = document.querySelector<HTMLElement>('#btn-stop')!;
      const rect = (el: HTMLElement) => el.getBoundingClientRect();
      const text = document.querySelector<HTMLElement>('#runbar-text')!;
      const windows = document.querySelector<HTMLElement>('#runbar-speed-windows')!;
      ui.seedSteer('mobile-steer-' + innerWidth, ui.addUser('indicación local mock', false, [], { queued: true }));
      const pending = document.querySelector<HTMLElement>('#runbar-queued')!;
      const withQueue = { text: pending.textContent, visible: !pending.hidden && getComputedStyle(pending).display !== 'none', bounds: rect(pending), title: pending.title };
      ui.steerDelivered('mobile-steer-' + innerWidth);
      const elapsed = document.querySelector<HTMLElement>('#runbar-time')!;
      const meta = document.querySelector<HTMLElement>('.composer-meta')!;
      const composer = document.querySelector<HTMLElement>('.composer')!;
      const input = document.querySelector<HTMLElement>('#input')!;
      return {
        cells: [...windows.querySelectorAll('.runbar-speed-cell')].map((n) => (n.textContent || '').trim()),
        windows: rect(windows), bar: rect(bar), meta: rect(meta), composer: rect(composer), input: rect(input), stop: rect(stop),
        statusRect: rect(text), statusClipped: text.scrollWidth > text.clientWidth + 1, statusVisible: getComputedStyle(text).display !== 'none',
        elapsed: rect(elapsed), queue: withQueue, afterDelivery: pending.hidden, status: text.textContent,
        siblings: bar.parentElement === meta && meta.children.length === 3,
        hintsHidden: getComputedStyle(document.querySelector('#meta-left')!).display === 'none' && getComputedStyle(document.querySelector('#meta-right')!).display === 'none',
        instant: !!document.querySelector('#runbar-tps') || !!document.querySelector('#runbar-avg')
      };
    }, A);
    if (snapshot.text !== 'Trabaja' || !snapshot.title.includes('otra conexión') || snapshot.initialQueue) throw new Error('estado móvil inicial falso: ' + JSON.stringify(snapshot));
    if (live.cells.length !== 6 || !live.cells.every((x) => x.endsWith('—'))) throw new Error('ventanas sin usage en móvil: ' + JSON.stringify(live.cells));
    if (!live.queue.visible || live.queue.text !== 'pendiente' || !live.queue.title.includes('indicación') || !live.afterDelivery) throw new Error('cola incorrecta: ' + JSON.stringify(live));
    if (live.instant) throw new Error('nodo de tasa instantánea en móvil');
    const fits = (x: DOMRect) => x.left >= live.bar.left - 1 && x.right <= live.bar.right + 1 && x.top >= live.bar.top - 1 && x.bottom <= live.bar.bottom + 1;
    if (![live.queue.bounds, live.statusRect, live.elapsed, live.windows].every(fits)) throw new Error('runbar con contenido fuera de la barra a ' + width + 'px: ' + JSON.stringify(live));
    if (live.bar.height > 46 || live.meta.height > 62) throw new Error('runbar demasiado alta a ' + width + 'px: ' + JSON.stringify({ bar: live.bar.height, meta: live.meta.height }));
    if (live.windows.width > live.bar.width + 1) throw new Error('la fila de promedios desborda a ' + width + 'px: ' + JSON.stringify({ win: live.windows.width, bar: live.bar.width }));
    if (live.statusRect.width < 24 || live.statusClipped || !live.statusVisible || !live.siblings || !live.hintsHidden || live.composer.bottom > live.meta.top || live.input.width < 90 || live.stop.width < 40 || live.stop.height < 40 || live.stop.right > width || live.stop.left < 0) throw new Error('runbar con overflow/segunda línea a ' + width + 'px: ' + JSON.stringify(live));
    await page.evaluate((sid) => {
      const app = (window as any).__aegisWeb, ui = app.testUi;
      ui.update({ sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', messageId: 'mobile-exact-' + innerWidth, content: { type: 'text', text: 'prueba' } } });
      ui.usage({ sessionId: sid, update: { sessionUpdate: 'message_usage', messageId: 'mobile-exact-' + innerWidth, usage: { outputTokens: 36, elapsedMs: 2200, generationMs: 1200 } } });
    }, A);
    await page.waitForTimeout(150);
    const measured = await page.evaluate(() => [...document.querySelectorAll('#runbar-speed-windows .runbar-speed-cell')].map((n) => (n.textContent || '').trim()));
    // 36 tokens generados en 1,2 s: entran completos en la ventana de 5 s, así que 36 / 5 = 7,2.
    if (!measured[0]?.endsWith('7.2')) throw new Error('promedio de 5s en móvil: ' + JSON.stringify(measured));
    await page.locator('#btn-stop').click(); // cancelación UI mock; no envía prompt ni contacta backend real
    const cancelling = await page.evaluate(() => ({ text: document.querySelector('#runbar-text')?.textContent, title: document.querySelector<HTMLElement>('#runbar-text')?.title, disabled: (document.querySelector('#btn-stop') as HTMLButtonElement).disabled }));
    if (cancelling.text !== 'Deteniendo…' || cancelling.title !== 'Deteniendo…' || !cancelling.disabled) throw new Error('cancelación móvil no compacta: ' + JSON.stringify(cancelling));
    await page.evaluate(() => (window as any).__aegisWeb.testUi.busy(false, 'Respuesta completa'));
    const done = await page.evaluate(() => ({
      text: document.querySelector('#runbar-text')?.textContent,
      title: document.querySelector<HTMLElement>('#runbar-text')?.title,
      hidden: document.querySelector<HTMLElement>('#runbar')!.hidden,
      note: document.querySelector('#msg-inner .turn-end:last-of-type')?.textContent || '',
      cells: [...document.querySelectorAll('#runbar-speed-windows .runbar-speed-cell')].map((n) => (n.textContent || '').trim()),
      stop: getComputedStyle(document.querySelector('#btn-stop')!).display,
      instant: !!document.querySelector('#runbar-tps') || !!document.querySelector('#runbar-avg')
    }));
    if (done.text !== 'Terminado' || done.title !== 'Respuesta completa' || !done.note.includes('prom generación 30.0 tok/s') || done.stop !== 'none' || done.hidden) throw new Error('resumen de fin de turno móvil: ' + JSON.stringify(done));
    if (done.instant || done.cells.length !== 6) throw new Error('runbar de fin de turno en móvil: ' + JSON.stringify(done));
    console.log('PASS runbar móvil ' + width + 'px: estado + seis promedios sin recorte');
  }
  await page.waitForFunction(() => (document.querySelector('#runbar') as HTMLElement)?.hidden, null, { timeout: 7500 });
  if (await page.locator('#btn-stop').isVisible()) throw new Error('Detener visible tras 6s de fin de turno');
  console.log('PASS fin del turno visible durante ventana de 6s y luego desaparece');
  await page.setViewportSize({ width: 1024, height: 780 });
  const desktop = await page.evaluate(() => {
    const ui = (window as any).__aegisWeb.testUi;
    ui.busy(true, 'Estado del agente en escritorio');
    const meta = document.querySelector<HTMLElement>('.composer-meta')!;
    const bar = document.querySelector<HTMLElement>('#runbar')!;
    const windows = document.querySelector<HTMLElement>('#runbar-speed-windows')!;
    const right = document.querySelector<HTMLElement>('#meta-right')!;
    (window as any).__aegisWeb.renderUsagePublic();
    const result = { siblings: bar.parentElement === meta && right.parentElement === meta,
      barWidth: bar.getBoundingClientRect().width, metaHeight: meta.getBoundingClientRect().height,
      rightHidden: getComputedStyle(right).display === 'none', rowInsideBar: windows.parentElement === bar,
      windowsWidth: windows.getBoundingClientRect().width,
      stopSize: document.querySelector('#btn-stop')!.getBoundingClientRect().width };
    ui.busy(false, 'Respuesta completa');
    return result;
  });
  if (!desktop.siblings || !desktop.rowInsideBar || !desktop.rightHidden || desktop.barWidth < 400 || desktop.metaHeight > 62 || desktop.windowsWidth > desktop.barWidth + 1 || desktop.stopSize < 40) throw new Error('meta compartida escritorio: ' + JSON.stringify(desktop));
  console.log('PASS runbar escritorio comparte meta sin pisar velocidad al renderizar uso');
  const downloadMd = '[descargar AUDITORIA_CASTOR_2026-10-21.md](/dl/AUDITORIA_CASTOR_2026-10-21.md)';
  const downloadVariants = [downloadMd, '[descargar AUDITORIA_CASTOR_2026-10-21.md]\n(/dl/AUDITORIA_CASTOR_2026-10-21.md)'];
  for (const variant of downloadVariants) {
    const result = await page.evaluate((text) => {
      const app = (window as any).__aegisWeb;
      const node = document.createElement('div'); node.className = 'msg-a';
      node.innerHTML = '<div class="content">' + app.md(text) + '</div>';
      document.querySelector('#msg-inner')!.append(node);
      const links = [...node.querySelectorAll<HTMLAnchorElement>('a.dl-chip')];
      const r = { links: links.length, href: links[0]?.getAttribute('href'), label: links[0]?.textContent,
        text: node.textContent, download: links[0]?.getAttribute('download'), raw: node.innerHTML };
      node.remove();
      return r;
    }, variant);
    if (result.links !== 1 || result.href !== '/dl/AUDITORIA_CASTOR_2026-10-21.md' ||
        result.download !== 'AUDITORIA_CASTOR_2026-10-21.md' ||
        result.text?.includes('(/dl/') || !result.label?.includes('AUDITORIA_CASTOR_2026-10-21.md'))
      throw new Error('enlace descarga en bruto/duplicado: ' + JSON.stringify(result));
  }
  console.log('PASS enlaces Markdown de descarga en una o dos líneas son un único botón');
  const longCell = 'Resultado largo que supera holgadamente setenta y dos caracteres, contiene observaciones adicionales y también una URL https://ejemplo.local/ruta/con/segmentos/muy-largos/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const manyColumns = '| Componente | Antes | Ahora | Cómo comprobarlo |\n|---|---|---|---|\n| Verificación exhaustiva | Esta descripción contiene bastantes palabras y distintos detalles para una columna | También hay varios resultados largos que comparar con el anterior | Escribir otro párrafo largo y verificar la tabla sin perder el texto |';
  for (const width of [320, 390, 640, 800]) {
    await page.setViewportSize({ width, height: 780 });
    const table = await page.evaluate(({ result, manyColumns }) => {
      const app = (window as any).__aegisWeb;
      const fixture = document.createElement('div'); fixture.className = 'msg-a';
      fixture.innerHTML = app.md('| Comprobación | Resultado |\n|---|---|\n| Versión | ' + result + ' |');
      document.querySelector('#msg-inner')!.append(fixture);
      const two = fixture.querySelector<HTMLElement>('table')!;
      const twoRow = two.querySelector<HTMLElement>('tbody tr')!;
      const twoCells = [...twoRow.querySelectorAll<HTMLElement>('td')];
      const three = document.createElement('div'); three.className = 'msg-a';
      three.innerHTML = app.md(manyColumns);
      document.querySelector('#msg-inner')!.append(three);
      const third = three.querySelector<HTMLElement>('table')!;
      const widthTotal = fixture.getBoundingClientRect().width;
      const rowHeight = twoRow.getBoundingClientRect().height;
      const resultCell = twoCells[1];
      const data = { twoCols: two.dataset.cols, threeCols: third.dataset.cols || '', row: getComputedStyle(twoRow).display,
        cells: twoCells.map(c => getComputedStyle(c).display), pseudo: getComputedStyle(resultCell, '::before').display,
        full: resultCell.textContent?.includes(result), noOverflow: two.getBoundingClientRect().width <= widthTotal + 1,
        wrap: getComputedStyle(resultCell).whiteSpace, rowHeight,
        resultWidth: resultCell.getBoundingClientRect().width, firstWidth: twoCells[0].getBoundingClientRect().width,
        thirdCellWidth: third.querySelector<HTMLElement>('tbody td')!.getBoundingClientRect().width,
        threeRow: getComputedStyle(third.querySelector('tbody tr')!).display,
        threeTable: getComputedStyle(third).display,
        threeHead: getComputedStyle(third.querySelector('thead')!).display,
        threeCell: getComputedStyle(third.querySelector('tbody td')!).display,
        threePseudo: getComputedStyle(third.querySelector('tbody td')!, '::before').display,
        scrollMode: getComputedStyle(three.querySelector('.tbl-wrap')!).overflowX,
        tableWidth: third.getBoundingClientRect().width,
        wrapperWidth: three.querySelector('.tbl-wrap')!.getBoundingClientRect().width,
        viewportWidth: document.documentElement.scrollWidth };
      fixture.remove(); three.remove();
      return data;
    }, { result: longCell, manyColumns });
    if (table.twoCols !== '2' || table.threeCols || !table.full || (width <= 640 &&
        (table.row !== 'block' || table.cells.some(x => x !== 'block') || table.pseudo !== 'none' ||
          !table.noOverflow || table.wrap !== 'normal' || table.resultWidth < width * 0.65 || table.firstWidth < width * 0.65 || table.thirdCellWidth < width * 0.65 || table.threeRow !== 'block' ||
          table.threeTable !== 'block' || table.threeHead !== 'none' ||
          table.threeCell !== 'block' || table.threePseudo !== 'block' || table.scrollMode !== 'auto' ||
          table.wrapperWidth > width || table.viewportWidth > width || table.tableWidth > table.wrapperWidth + 1)))
      throw new Error('tabla móvil angosta en ' + width + 'px: ' + JSON.stringify(table));
  }
  console.log('PASS tablas móviles con celdas apiladas, sin columnas angostas ni desborde global');
  const font = page.getByRole('button', { name: 'Tamaño de letra', exact: true });
  const checkFont = async (px: number) => page.evaluate((size) => {
    const box = document.querySelector('#msg-inner')!;
    let fixture = document.querySelector('#font-fixture');
    if (!fixture) {
      fixture = document.createElement('div'); fixture.id = 'font-fixture';
      fixture.innerHTML = '<div class="msg-user">usuario</div><div class="msg-a"><div class="content"><p>asistente <code>inline</code></p><pre><code>código</code></pre><div class="thought">pensamiento</div><div class="tbl-wrap"><table data-cols="2"><tbody><tr><th>Encabezado</th><td data-label="columna">celda</td></tr></tbody></table></div><div class="tbl-wrap"><table data-cols="3"><tbody><tr><th>Encabezado</th><td data-label="columna">celda</td></tr></tbody></table></div></div></div><div class="tool"><div class="tool-body"><div class="tool-title">herramienta <span class="tname">developer.shell</span></div><pre>salida</pre></div></div>';
      box.append(fixture);
    }
    const selectors = ['.msg-user', '.msg-a', '.msg-a code', '.msg-a pre code', '.msg-a .thought', '.msg-a table[data-cols="2"] th', '.msg-a table[data-cols="2"] td', '.msg-a table[data-cols="3"] th', '.msg-a table[data-cols="3"] td', '.msg-a table[data-cols="3"] td::before', '.tool', '.tool-body', '.tool-title', '.tool-title .tname', '.tool pre'];
    const sizes = selectors.map(s => {
      const pseudo = s.includes('::before');
      const el = fixture!.querySelector(pseudo ? s.replace('::before', '') : s)!;
      const actual = parseFloat(getComputedStyle(el, pseudo ? '::before' : undefined).fontSize);
      const baseline: Record<string, number> = { '.msg-user': 14.5, '.msg-a': 16, '.msg-a code': 12.5,
        '.msg-a pre code': 12.5, '.msg-a .thought': 13.5,
        '.msg-a table[data-cols="2"] th': 12.5, '.msg-a table[data-cols="2"] td': 12.5,
        '.msg-a table[data-cols="3"] th': 12.5, '.msg-a table[data-cols="3"] td': 12.5,
        '.msg-a table[data-cols="3"] td::before': 11, '.tool': 12.5,
        '.tool-body': 12.5, '.tool-title': 12.5, '.tool-title .tname': 12, '.tool pre': 11.5 };
      return [s, actual, baseline[s] * size / 16] as const;
    });
    return { sizes, stored: localStorage.getItem('aegis.chatFontPx'), value: document.querySelector('#chat-font-value')?.textContent,
      chrome: getComputedStyle(document.querySelector('.topbar')!).fontSize,
      input: getComputedStyle(document.querySelector('#input')!).fontSize,
      panelSub: document.querySelector('#font-panel .panel-sub')?.textContent,
      expected: size + 'px' };
  }, px);
  if (await page.locator('#btn-topbar-more').isVisible()) await page.locator('#btn-topbar-more').click();
  await font.click();
  if (await font.getAttribute('aria-expanded') !== 'true') throw new Error('popover de fuente no accesible');
  await page.locator('#chat-font-range').fill('20');
  let typography = await checkFont(20);
  if (typography.sizes.some(([, actual, expected]) => Math.abs(actual - expected) > 0.02) || typography.panelSub !== '20 px' || typography.stored !== '20') throw new Error('escala incompleta: ' + JSON.stringify(typography));
  await page.locator('#chat-font-plus').click();
  eq((await checkFont(21)).stored, '21', 'botón aumentar');
  await page.locator('#chat-font-minus').click();
  eq((await checkFont(20)).stored, '20', 'botón reducir');
  await page.setViewportSize({ width: 390, height: 780 });
  typography = await checkFont(20);
  if (typography.sizes.some(([, actual, expected]) => Math.abs(actual - expected) > 0.02) || parseFloat(typography.input) < 16) throw new Error('tipografía tarjeta móvil o zoom de textarea: ' + JSON.stringify(typography));
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 780 });
    const mobileFont = await checkFont(20);
    if (mobileFont.sizes.some(([, actual, expected]) => Math.abs(actual - expected) > 0.02) || parseFloat(mobileFont.input) < 16)
      throw new Error('escala de letra móvil ' + width + 'px: ' + JSON.stringify(mobileFont));
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window as any).__aegisWeb?.state.sessions.length === 2);
  typography = await checkFont(20);
  if (typography.sizes.some(([, actual, expected]) => Math.abs(actual - expected) > 0.02) || typography.chrome !== '14.5px') throw new Error('persistencia fuente o cambió chrome: ' + JSON.stringify(typography));
  if (await page.locator('#btn-topbar-more').isVisible()) await page.locator('#btn-topbar-more').click();
  await font.click();
  await page.locator('#chat-font-range').fill('22');
  await page.locator('#chat-font-plus').click();
  eq((await checkFont(22)).stored, '22', 'límite superior');
  await page.locator('#chat-font-range').fill('2');
  await page.locator('#chat-font-minus').click();
  eq((await checkFont(2)).stored, '2', 'límite inferior');
  const compact = await page.evaluate(() => {
    const messages = document.querySelector<HTMLElement>('#messages')!;
    const tool = document.querySelector<HTMLElement>('#font-fixture .tool')!;
    const pre = tool.querySelector<HTMLElement>('pre')!;
    const cell = document.querySelector<HTMLElement>('#font-fixture .msg-a table[data-cols="3"] td')!;
    const gap = getComputedStyle(document.querySelector('#msg-inner')!).gap;
    return { mode: messages.classList.contains('chat-compact'), pad: parseFloat(getComputedStyle(tool).paddingTop),
      preview: parseFloat(getComputedStyle(pre).maxHeight), line: parseFloat(getComputedStyle(pre).lineHeight),
      cellPad: parseFloat(getComputedStyle(cell).paddingLeft), gap: parseFloat(gap) };
  });
  if (!compact.mode || compact.pad > 4 || compact.preview > compact.line + 1 || compact.cellPad > 6 || compact.gap > 9)
    throw new Error('tarjetas gordas con texto de 2 px: ' + JSON.stringify(compact));
  await page.locator('#chat-font-range').fill('12');
  if (await page.locator('#messages').evaluate(el => el.classList.contains('chat-compact'))) throw new Error('modo compacto persiste fuera de 2–10 px');
  eq((await checkFont(12)).stored, '12', 'valor intermedio');
  await page.locator('#chat-font-reset').click();
  eq((await checkFont(16)).stored, '16', 'restablecer default');
  await page.evaluate(() => localStorage.setItem('aegis.chatFontPx', '999'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window as any).__aegisWeb?.state.sessions.length === 2);
  eq((await checkFont(16)).stored, '16', 'almacenamiento fuera de rango rechazado');
  console.log('PASS fuente 2–22, reset, recarga, tarjeta móvil y storage inválido');
  const rpcError = await page.evaluate(async () => {
    try { await (window as any).__aegisWeb.rpc.request('test/error', {}); return null; }
    catch (e: any) { return { message: e.message, code: e.code, data: e.data }; }
  });
  // data estructurado se conserva para la lógica (actualRunId); el mensaje añade el detalle del servidor.
  if (rpcError?.code !== -32042 || rpcError?.data?.actualRunId !== 'mock-run' ||
      rpcError?.message !== 'error simulado [metodo: test/error]: {"actualRunId":"mock-run"}')
    throw new Error('error RPC perdió code/data/método: ' + JSON.stringify(rpcError));
  const detailError = await page.evaluate(async () => {
    try { await (window as any).__aegisWeb.rpc.request('test/error-detail', {}); return null; }
    catch (e: any) { return { message: e.message, code: e.code, data: e.data }; }
  });
  if (detailError?.code !== -32043 || detailError.data !== 'Model file not found: mock-model' ||
      detailError.message !== 'Internal error [metodo: test/error-detail]: Model file not found: mock-model')
    throw new Error('error RPC ocultó detalle legible del servidor: ' + JSON.stringify(detailError));
  if (requests.some(r => r.method === 'session/prompt' || r.method === 'session/new')) throw new Error('se intentó crear sesión o enviar prompt');
  if (errors.length) throw new Error('excepciones en navegador: ' + errors.join(' | '));
  console.log('PASS error RPC preserva code/data/método; cero sesiones o prompts reales');
} finally {
  await browser.close();
}

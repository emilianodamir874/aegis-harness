// Regresiones de cliente SIN web/ACP vivos, credenciales, sesiones reales ni prompts.
// Desde web/: npx esbuild tests/client-regressions.ts --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.cache/client-regressions.mjs && node node_modules/.cache/client-regressions.mjs
// Integrada al runner/build; no usar AEGIS_WEB_URL aquí.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type WebSocketRoute } from 'playwright';
import { build } from 'esbuild';
// Fórmulas probadas contra el bundle del cliente a través del hook mock.

const eq = (actual: unknown, expected: unknown, message: string) => {
  if (actual !== expected) throw new Error(message + ': ' + String(actual) + ' ≠ ' + String(expected));
};

// Ejecutar desde la raíz de web; así el bundle temporal puede vivir fuera del repo.
const root = resolve(process.cwd()) + '/';
const html = await readFile(root + 'app/index.html', 'utf8');
const css = await readFile(root + 'app/app.css', 'utf8');
// Prueba el src/app.ts actual, no un app/app.js compilado previamente ni la web en producción.
const built = await build({ entryPoints: [root + 'src/app.ts'], bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', logLevel: 'silent' });
const script = built.outputFiles[0].text;
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
  page.on('pageerror', e => errors.push(e.message));
  await page.route('http://client-regressions.invalid/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/' || url.pathname === '/index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    if (url.pathname === '/config.js') return route.fulfill({ status: 200, contentType: 'application/javascript', body: `window.__AEGIS_APP__={acpUrl:'ws://client-regressions.invalid/acp',cwd:'/mock',host:'mock'};` });
    if (url.pathname === '/app.js') return route.fulfill({ status: 200, contentType: 'application/javascript', body: script });
    if (url.pathname === '/app.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css });
    if (url.pathname === '/client-log') return route.fulfill({ status: 204, body: '' });
    // No requests to a real host, including stats, goals, TTS, skills or other APIs.
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.routeWebSocket('ws://client-regressions.invalid/acp', (ws: WebSocketRoute) => {
    ws.onMessage(raw => {
      const m = JSON.parse(String(raw));
      if (m.id === undefined) return;
      requests.push({ method: m.method, params: m.params });
      const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
      switch (m.method) {
        case 'initialize': reply({ protocolVersion: 1 }); break;
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
        default: throw new Error('RPC inesperado: ' + m.method); // nunca simular session/prompt
      }
    });
  });
  await page.goto('http://client-regressions.invalid/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window as any).__aegisWeb?.state.sessions.length === 2);
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
  await page.locator(`.sb-row[data-id="${B}"] .sb-del`).click();
  await page.locator(`.sb-row[data-id="${B}"] .sb-confirm .ym`).click();
  await page.waitForFunction(() => (document.querySelector('#messages')?.textContent || '').includes('No se pudo borrar: denegado'));
  if (await page.locator(`.sb-row[data-id="${B}"]`).count() !== 1 || await page.locator('.sb-confirm').count()) throw new Error('borrado fallido ocultó la sesión o dejó confirmación bloqueada');
  failDelete = false;
  await page.locator(`.sb-row[data-id="${B}"] .sb-del`).click();
  await page.locator(`.sb-row[data-id="${B}"] .sb-confirm .ym`).click();
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
    ui.run('run-usage');
    // Una notificación antigua justo después del arranque y un usage sin mensaje no pertenecen al run.
    notify('old', 999);
    ui.usage({ sessionId: sid, update: { sessionUpdate: 'message_usage', usage: { outputTokens: 999, elapsedMs: 2100, timeToFirstTokenMs: 100 } } });
    chunk('step1');
    app.state.hubReplay = true; notify('step1', 20); app.state.hubReplay = false;
    notify('step1', 20, 2000); notify('step1', 20, 2000); // replay duplicado después del vivo
    chunk('step2'); // nuevo paso: jamás debe mostrar la etiqueta exacta de step1
    const stale = document.querySelector('#runbar-tps')?.textContent || '';
    notify('step2', 20); // TTFT=elapsed; solicitud total: popover, no generación
    chunk('step3'); // usage genuino que llega después del terminal
    const live = app.speedSummary();
    const pop = (() => { ui.pop(); return document.querySelector('#usage-pop')?.textContent || ''; })();
    ui.run(null);
    const beforeLate = app.speedSummary();
    notify('old', 999); // jamás hubo chunk de old en ESTE run
    notify('step3', 40, 2000); // chunk de step3 sí pertenece a este turno
    notify('step3', 40, 2000); notify('step1', 20, 2000); // duplicados luego del terminal
    const afterLate = app.speedSummary();
    const note = document.querySelector('#msg-inner .turn-end:last-of-type')?.textContent || '';
    return { live, beforeLate, afterLate, pop, note, stale };
  }, A);
  eq(rates.stale, '', 'el paso nuevo limpia el exacto previo');
  eq(rates.live.out, 20, 'uso único por messageId/run');
  eq(rates.live.avg, 10, 'promedio solo generación');
  eq(rates.beforeLate.out, 20, 'fin de turno mantiene generación');
  eq(rates.afterLate.out, 60, 'usage tardío del run suma una vez; ajenos ignorados');
  eq(rates.afterLate.avg, 15, 'promedio ponderado actualizado tras terminal');
  if (!rates.pop.includes('solicitud total 9.5 tok/s') || !rates.note.includes('prom generación 15.0 tok/s')) throw new Error('etiquetas de velocidad erróneas: ' + JSON.stringify(rates));
  console.log('PASS uso ordenado/deduplicado por mensaje y run, replay y etiquetas de solicitud/generación');
  const newRun = await page.evaluate((sid) => {
    const app = (window as any).__aegisWeb, ui = app.testUi;
    ui.run('run-new');
    const chunk = (id: string) => ui.update({ sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', messageId: id, content: { type: 'text', text: 'prueba' } } });
    const usage = (id: string, gen: number) => ui.usage({ sessionId: sid, update: { sessionUpdate: 'message_usage', messageId: id, usage: { outputTokens: 30, elapsedMs: 3000, timeToFirstTokenMs: 3000, generationMs: gen } } });
    usage('step3', 1000); // pertenece al run anterior, aunque haya llegado tarde
    chunk('step-new'); usage('step-new', 1000);
    const exact = document.querySelector('#runbar-tps')?.textContent || '';
    // Paso tool-only: no tener etiqueta exacta vieja hasta que haya contenido propio.
    ui.update({ sessionId: sid, update: { sessionUpdate: 'tool_call', messageId: 'tool-new', toolCallId: 'tool-new', title: 'tool mock', status: 'in_progress' } });
    const afterTool = document.querySelector('#runbar-tps')?.textContent || '';
    usage('tool-new', 0); // sin contenido observado: nunca incluir en promedio de generación
    const summary = app.speedSummary();
    ui.run(null);
    return { exact, afterTool, summary };
  }, A);
  eq(newRun.exact, 'generación 30.0 tok/s', 'run nuevo usa generationMs aun si TTFT=elapsed');
  eq(newRun.afterTool, '', 'tool-only nuevo paso no hereda tasa exacta anterior');
  eq(newRun.summary.out, 30, 'run nuevo no hereda tokens ni acepta usage anterior/tool-only');
  eq(newRun.summary.avg, 30, 'promedio sólo generación observada del run nuevo');
  console.log('PASS cambio de run y paso tool-only sin ritmo de generación inventado');
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
  // Tres teléfonos, sin session/prompt: el run y el usage son solamente mocks de UI.
  // Se mide el layout real (CSS + JS), no solo el texto: la tasa y Detener deben caber.
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 780 });
    const snapshot = await page.evaluate((sid) => {
      const app = (window as any).__aegisWeb, ui = app.testUi;
      const bar = document.querySelector<HTMLElement>('#runbar')!;
      const text = document.querySelector<HTMLElement>('#runbar-text')!;
      const queued = document.querySelector<HTMLElement>('#runbar-queued');
      ui.busy(true, 'Turno en curso (lo arrancó otra conexión)');
      ui.update({ sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', messageId: 'mobile-live-' + innerWidth, content: { type: 'text', text: 'prueba' } } });
      const speed = app.state.speed;
      app.speedStart(); // restablece estado; fijamos ticks de mock después
      speed.ticks = [{ at: performance.now() - 900, chars: 0 }, { at: performance.now(), chars: 80 }];
      // La función de pintado se ejecuta con el tick periódico; esperar afuera.
      return { text: text.textContent, title: text.title, initialQueue: !!queued && !queued.hidden };
    }, A);
    await page.waitForFunction(() => /^~[\d.]+ tok\/s$/.test(document.querySelector('#runbar-tps')?.textContent || ''), null, { timeout: 2000 });
    const live = await page.evaluate((sid) => {
      const app = (window as any).__aegisWeb, ui = app.testUi;
      const bar = document.querySelector<HTMLElement>('#runbar')!, badge = document.querySelector<HTMLElement>('#runbar-tps')!;
      const queued = document.querySelector<HTMLElement>('#runbar-queued');
      const stop = document.querySelector<HTMLElement>('#btn-stop')!;
      const rect = (el: HTMLElement) => el.getBoundingClientRect();
      const text = document.querySelector<HTMLElement>('#runbar-text')!;
      ui.seedSteer('mobile-steer-' + innerWidth, ui.addUser('indicación local mock', false, [], { queued: true }));
      const pending = document.querySelector<HTMLElement>('#runbar-queued')!;
      const withQueue = { text: pending.textContent, visible: !pending.hidden && getComputedStyle(pending).display !== 'none', bounds: rect(pending), title: pending.title };
      ui.steerDelivered('mobile-steer-' + innerWidth);
      const elapsed = document.querySelector<HTMLElement>('#runbar-time')!;
      const meta = document.querySelector<HTMLElement>('.composer-meta')!;
      const composer = document.querySelector<HTMLElement>('.composer')!;
      const input = document.querySelector<HTMLElement>('#input')!;
      return { rate: badge.textContent, title: badge.title, bounds: rect(badge), bar: rect(bar), meta: rect(meta), composer: rect(composer), input: rect(input), stop: rect(stop), statusRect: rect(text), statusClipped: text.scrollWidth > text.clientWidth + 1, statusVisible: getComputedStyle(text).display !== 'none', elapsed: rect(elapsed), avgDisplay: getComputedStyle(document.querySelector('#runbar-avg')!).display, queue: withQueue, afterDelivery: pending.hidden, status: text.textContent, siblings: bar.parentElement === meta && meta.children.length === 3, hintsHidden: getComputedStyle(document.querySelector('#meta-left')!).display === 'none' && getComputedStyle(document.querySelector('#meta-right')!).display === 'none' };
    }, A);
    if (snapshot.text !== 'Trabaja' || !snapshot.title.includes('otra conexión') || snapshot.initialQueue) throw new Error('estado móvil inicial falso: ' + JSON.stringify(snapshot));
    if (!live.rate?.startsWith('~') || !live.rate.endsWith(' tok/s') || !live.title.includes('estimado') || !live.queue.visible || live.queue.text !== 'pendiente' || !live.queue.title.includes('indicación') || !live.afterDelivery) throw new Error('badge estimado o cola incorrecta: ' + JSON.stringify(live));
    if (live.avgDisplay !== 'none') throw new Error('promedio debe quedar sólo en nota de conversación en móvil');
    const fits = (x: DOMRect) => x.left >= live.bar.left - 1 && x.right <= live.bar.right + 1 && x.top >= live.bar.top - 1 && x.bottom <= live.bar.bottom + 1;
    if (![live.bounds, live.queue.bounds, live.statusRect, live.elapsed].every(fits) || live.bar.height > 28 || live.meta.height > 36 || live.statusRect.width < 24 || live.statusClipped || !live.statusVisible || !live.siblings || !live.hintsHidden || live.composer.bottom > live.meta.top || live.input.width < 90 || live.stop.width < 40 || live.stop.height < 40 || live.stop.right > width || live.stop.left < 0) throw new Error('runbar con overflow/segunda línea a ' + width + 'px: ' + JSON.stringify(live));
    await page.evaluate((sid) => {
      const app = (window as any).__aegisWeb, ui = app.testUi;
      ui.update({ sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', messageId: 'mobile-exact-' + innerWidth, content: { type: 'text', text: 'prueba' } } });
      ui.usage({ sessionId: sid, update: { sessionUpdate: 'message_usage', messageId: 'mobile-exact-' + innerWidth, usage: { outputTokens: 36, elapsedMs: 2200, generationMs: 1200 } } });
    }, A);
    eq(await page.locator('#runbar-tps').textContent(), '30.0 tok/s', 'ritmo exacto corto en móvil');
    await page.locator('#btn-stop').click(); // cancelación UI mock; no envía prompt ni contacta backend real
    const cancelling = await page.evaluate(() => ({ text: document.querySelector('#runbar-text')?.textContent, title: document.querySelector<HTMLElement>('#runbar-text')?.title, disabled: (document.querySelector('#btn-stop') as HTMLButtonElement).disabled }));
    if (cancelling.text !== 'Deteniendo…' || cancelling.title !== 'Deteniendo…' || !cancelling.disabled) throw new Error('cancelación móvil no compacta: ' + JSON.stringify(cancelling));
    await page.evaluate(() => (window as any).__aegisWeb.testUi.busy(false, 'Respuesta completa'));
    const done = await page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>('#runbar')!, rate = document.querySelector<HTMLElement>('#runbar-tps')!;
      return { text: document.querySelector('#runbar-text')?.textContent, title: document.querySelector<HTMLElement>('#runbar-text')?.title, rate: rate.textContent, full: rate.title, hidden: bar.hidden, note: document.querySelector('#msg-inner .turn-end:last-of-type')?.textContent || '', stop: getComputedStyle(document.querySelector('#btn-stop')!).display };
    });
    if (done.text !== 'Terminado' || done.title !== 'Respuesta completa' || !done.full?.includes('generación 30.0') || !done.note.includes('prom generación 30.0 tok/s') || done.stop !== 'none' || done.hidden) throw new Error('resumen de fin de turno móvil: ' + JSON.stringify(done));
    console.log('PASS runbar móvil ' + width + 'px: vivo/pendiente/exacto/fin sin recorte');
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
    const speed = document.querySelector<HTMLElement>('#runbar-tps')!;
    const right = document.querySelector<HTMLElement>('#meta-right')!;
    (window as any).__aegisWeb.renderUsagePublic();
    const result = { siblings: bar.parentElement === meta && right.parentElement === meta,
      barWidth: bar.getBoundingClientRect().width, metaHeight: meta.getBoundingClientRect().height,
      rightHidden: getComputedStyle(right).display === 'none', speedStillInside: speed.parentElement === bar,
      stopSize: document.querySelector('#btn-stop')!.getBoundingClientRect().width };
    ui.busy(false, 'Respuesta completa');
    return result;
  });
  if (!desktop.siblings || !desktop.speedStillInside || !desktop.rightHidden || desktop.barWidth < 400 || desktop.metaHeight > 36 || desktop.stopSize < 40) throw new Error('meta compartida escritorio: ' + JSON.stringify(desktop));
  console.log('PASS runbar escritorio comparte meta sin pisar velocidad al renderizar uso');
  const font = page.getByRole('button', { name: 'Tamaño de letra', exact: true });
  const checkFont = async (px: number) => page.evaluate((size) => {
    const box = document.querySelector('#msg-inner')!;
    let fixture = document.querySelector('#font-fixture');
    if (!fixture) {
      fixture = document.createElement('div'); fixture.id = 'font-fixture';
      fixture.innerHTML = '<div class="msg-user">usuario</div><div class="msg-a"><div class="content"><p>asistente <code>inline</code></p><pre><code>código</code></pre><div class="thought">pensamiento</div><div class="tbl-wrap"><table><tbody><tr><td data-label="columna">celda</td></tr></tbody></table></div></div></div><div class="tool"><div class="tool-body"><div class="tool-title">herramienta</div><pre>salida</pre></div></div>';
      box.append(fixture);
    }
    const selectors = ['.msg-user', '.msg-a', '.msg-a code', '.msg-a pre code', '.msg-a .thought', '.msg-a td', '.msg-a td::before', '.tool', '.tool pre'];
    const sizes = selectors.map(s => {
      const pseudo = s.includes('::before');
      const el = fixture!.querySelector(pseudo ? s.replace('::before', '') : s)!;
      const actual = parseFloat(getComputedStyle(el, pseudo ? '::before' : undefined).fontSize);
      const baseline: Record<string, number> = { '.msg-user': 14.5, '.msg-a': 16, '.msg-a code': 12.5,
        '.msg-a pre code': 12.5, '.msg-a .thought': 13.5, '.msg-a td': 12.5,
        '.msg-a td::before': 11, '.tool': 12.5, '.tool pre': 11.5 };
      return [s, actual, baseline[s] * size / 16] as const;
    });
    return { sizes, stored: localStorage.getItem('aegis.chatFontPx'), value: document.querySelector('#chat-font-value')?.textContent,
      chrome: getComputedStyle(document.querySelector('.topbar')!).fontSize,
      input: getComputedStyle(document.querySelector('#input')!).fontSize,
      expected: size + 'px' };
  }, px);
  await font.click();
  if (await font.getAttribute('aria-expanded') !== 'true') throw new Error('popover de fuente no accesible');
  await page.locator('#chat-font-range').fill('20');
  let typography = await checkFont(20);
  if (typography.sizes.some(([, actual, expected]) => Math.abs(actual - expected) > 0.02) || typography.value !== '20 px' || typography.stored !== '20') throw new Error('escala incompleta: ' + JSON.stringify(typography));
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
  await font.click();
  await page.locator('#chat-font-range').fill('22');
  await page.locator('#chat-font-plus').click();
  eq((await checkFont(22)).stored, '22', 'límite superior');
  await page.locator('#chat-font-range').fill('12');
  await page.locator('#chat-font-minus').click();
  eq((await checkFont(12)).stored, '12', 'límite inferior');
  await page.locator('#chat-font-reset').click();
  eq((await checkFont(16)).stored, '16', 'restablecer default');
  await page.evaluate(() => localStorage.setItem('aegis.chatFontPx', '999'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window as any).__aegisWeb?.state.sessions.length === 2);
  eq((await checkFont(16)).value, '16 px', 'almacenamiento fuera de rango rechazado');
  console.log('PASS fuente 12–22, reset, recarga, tarjeta móvil y storage inválido');
  const rpcError = await page.evaluate(async () => {
    try { await (window as any).__aegisWeb.rpc.request('test/error', {}); return null; }
    catch (e: any) { return { message: e.message, code: e.code, data: e.data }; }
  });
  if (rpcError?.code !== -32042 || rpcError?.data?.actualRunId !== 'mock-run' || rpcError?.message !== 'error simulado [metodo: test/error]') throw new Error('error RPC perdió code/data/método: ' + JSON.stringify(rpcError));
  if (requests.some(r => r.method === 'session/prompt' || r.method === 'session/new')) throw new Error('se intentó crear sesión o enviar prompt');
  if (errors.length) throw new Error('excepciones en navegador: ' + errors.join(' | '));
  console.log('PASS error RPC preserva code/data/método; cero sesiones o prompts reales');
} finally {
  await browser.close();
}

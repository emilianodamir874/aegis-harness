// Regresiones de cliente SIN web/ACP vivos, credenciales, sesiones reales ni prompts.
// Desde web/: npx esbuild tests/client-regressions.ts --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.cache/client-regressions.mjs && node node_modules/.cache/client-regressions.mjs
// Integrada al runner/build; no usar AEGIS_WEB_URL aquí.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type WebSocketRoute } from 'playwright';
import { build } from 'esbuild';

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
  await page.evaluate(() => {
    const app = (window as any).__aegisWeb;
    app.testUi.run('mock-run');
  });
  await page.waitForFunction(() => (window as any).__aegisWeb.state.busy === true);
  await page.evaluate(() => (window as any).__aegisWeb.testUi.run(null));
  await page.waitForFunction(() => (window as any).__aegisWeb.state.busy === false);
  if (await page.locator('#runbar-stop').isVisible()) throw new Error('el botón Detener sigue visible tras recibir fin de run');
  console.log('PASS fin de run por hub libera la barra sin recargar');

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

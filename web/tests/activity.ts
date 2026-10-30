// Test aislado: bundle de dist-ts, HTTP y ACP simulados; nunca usa store ni serve.
// npm run build && node dist-ts/tests/activity.mjs
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const script = await readFile(resolve('dist-ts/app/activity.js'), 'utf8');
const browser = await chromium.launch({ headless: true });
const assert = (ok: unknown, detail: string) => { if (!ok) throw new Error(detail); };
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const calls: string[] = [];
  await page.exposeFunction('activityCall', (call: string) => { calls.push(call); });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.host !== 'activity.invalid') throw new Error('Red inesperada: ' + url.href);
    if (url.pathname === '/pending.json' && route.request().method() === 'GET') {
      calls.push('GET /pending.json');
      return route.fulfill({ json: { sessions: [{ sessionId: 's2', pendientes: 2 }, { sessionId: '<img src=x onerror=alert(1)>', pendientes: 1 }] } });
    }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body><div class="sb-row" data-id="s2"><button class="sb-item">Sesión en sidebar</button></div><script type="module" src="/activity.js"></script></body></html>' });
    if (url.pathname === '/activity.js') return route.fulfill({ contentType: 'text/javascript', body: script });
    throw new Error('Ruta inesperada: ' + url.pathname);
  });
  await page.addInitScript(() => {
    const scope = window as any;
    scope.__activityState = { pages: 2, info: 'run-123', clicks: 0, calls: [] as string[] };
    scope.__aegisWeb = { state: {}, openTool: async (sid: string, toolId: string) => {
      scope.__activityState.openTool = [sid, toolId];
      return true;
    }, rpc: { ready: true, request: async (method: string, params: any) => {
      scope.__activityState.calls.push({ method, params });
      scope.activityCall('ACP ' + method);
      if (method === 'session/list') {
        if (scope.__activityState.pages === 'limit') return { sessions: [{ sessionId: 'bounded', cwd: 'C:/bounded' }], nextCursor: String(Number(params.cursor || 0) + 1), _meta: { runningSessionIds: [] } };
        if (!params.cursor) return { sessions: [
          { sessionId: 's1', title: '<img src=x onerror=alert(2)>', cwd: 'C:/a' },
          { sessionId: 's2', title: 'B', cwd: 'C:/b' },
        ], nextCursor: scope.__activityState.pages > 1 ? 'next' : null, _meta: { runningSessionIds: ['s1', 's2'] } };
        if (params.cursor === 'next') return { sessions: [
          { sessionId: 's3', title: 'C', cwd: 'C:/a' },
          { sessionId: 's2', title: 'duplicada', cwd: 'C:/b' },
        ], nextCursor: null, _meta: { runningSessionIds: [] } };
      }
      if (method === '_aegis/unstable/session/info') return { session: { _meta: { activeRunId: params.sessionId === 's1' ? null : scope.__activityState.info } } };
      if (method === '_aegis/unstable/session/export') return { data: JSON.stringify({ id: params.sessionId, conversation: [{ metadata: { userVisible: true }, content: [
        { type: 'toolRequest', id: 'tool1', toolCall: { status: 'success', value: { name: 'shell', arguments: { secret: 'SECRET_DO_NOT_PRINT' } } } },
        { type: 'toolRequest', id: 'tool2', toolCall: { status: 'success', value: { name: 'summon' } } },
        { type: 'toolRequest', id: 'tool3', toolCall: { status: 'success', value: { name: 'made-up-SECRET_DO_NOT_PRINT', arguments: { secret: 'SECRET_DO_NOT_PRINT' } } } },
        { type: 'toolResponse', id: 'tool1', toolResult: { status: 'success', value: { isError: false, content: ['SECRET_DO_NOT_PRINT'] } } },
        { type: 'toolResponse', id: 'tool2', toolResult: { status: 'success', value: { isError: true } } },
        { type: 'toolResponse', id: 'tool3', toolResult: { status: 'success', value: { content: ['SECRET_DO_NOT_PRINT'] } } },
      ] }] }) };
      throw new Error('RPC inesperado: ' + method);
    } } };
    document.addEventListener('DOMContentLoaded', () => document.querySelector('.sb-item')?.addEventListener('click', () => scope.__activityState.clicks++));
  });
  await page.goto('http://activity.invalid/');
  await page.evaluate(() => (window as any).__aegisActivity.open());
  let result = await page.locator('.aegis-activity').innerText();
  assert(result.includes('C:/a · 2') && result.includes('C:/b · 1'), 'agrupación y deduplicación incorrectas');
  assert(result.includes('Listado marcó trabajo; info no lo confirma'), 'info null no debe confirmar trabajo');
  assert(result.includes('Trabajando (listado e info)'), 'info activo no confirmó run del listado');
  assert(result.includes('Estado de trabajo no informado'), 'ausencia de run no debe inferir idle');
  assert(result.includes('Confirmaciones sin respuesta registrada') && result.includes('s2 · 2 sin respuesta registrada'), 'pendientes separados');
  assert(await page.locator('.aegis-activity img').count() === 0, 'texto no escapado');
  assert(await page.locator('.aegis-activity button.row').count() === 1, 'solo filas con botón público de sidebar deben navegar');
  assert(!calls.includes('ACP _aegis/unstable/session/export'), 'export no debe leerse sin petición explícita');
  await page.locator('.aegis-activity section').first().getByRole('button', { name: 'Ver detalle' }).first().click();
  await page.waitForFunction(() => document.querySelector('.aegis-activity section')?.textContent?.includes('Herramientas: 3 llamadas'));
  const detail = await page.locator('.aegis-activity section').first().innerText();
  assert(detail.includes('1 resultados correctos explícitos') && detail.includes('1 errores explícitos') && detail.includes('1 sin resultado registrado') && detail.includes('Subagentes (llamadas explícitas summon): 1'), 'detalle export incompleto');
  assert(detail.includes('Tests: no registrado') && !detail.includes('Tests: éxito'), 'no inferir tests exitosos de llamadas a herramientas');
  assert(detail.includes('shell · tool1 · éxito explícito') && detail.includes('summon · tool2 · fallo explícito') && detail.includes('herramienta · tool3 · resultado desconocido'), 'timeline debe usar nombre seguro, ids y evidencia explícita');
  assert(await page.locator('.aegis-activity .timeline button').count() === 3, 'timeline sin enlaces cuando openTool está disponible');
  assert(!detail.includes('SECRET_DO_NOT_PRINT'), 'detalle filtró contenido confidencial del export');
  assert(calls.includes('ACP _aegis/unstable/session/export'), 'detalle no pidió export explicitamente');
  assert(calls.filter(x => x === 'ACP session/list').length === 2 && calls.includes('GET /pending.json'), 'no paginó o no leyó pendientes');
  const params = await page.evaluate(() => (window as any).__activityState.calls.filter((x: any) => x.method === 'session/list').map((x: any) => x.params));
  assert(params[1].cursor === 'next' && params[0].meta.aegis.includeLastMessageSnippet === false, 'cursor o meta inválidos');
  await page.locator('.aegis-activity button.row').click();
  assert(await page.locator('.aegis-activity').count() === 0, 'click no cerró el panel');
  assert(await page.evaluate(() => (window as any).__activityState.clicks) === 1, 'click no usó el botón real del sidebar');
  await page.evaluate(() => (window as any).__aegisActivity.open());
  await page.locator('.aegis-activity section').first().getByRole('button', { name: 'Ver detalle' }).first().click();
  await page.waitForFunction(() => document.querySelector('.aegis-activity .timeline button'));
  await page.locator('.aegis-activity .timeline button').filter({ hasText: 'tool2' }).click();
  assert(JSON.stringify(await page.evaluate(() => (window as any).__activityState.openTool)) === JSON.stringify(['s1', 'tool2']), 'deep-link no invocó openTool con sesión y toolCallId');
  assert(await page.locator('.aegis-activity').count() === 0, 'deep-link exitoso no cerró actividad');
  await page.evaluate(() => { (window as any).__activityState.pages = 1; (window as any).__aegisActivity.open(); });
  await page.waitForFunction(() => document.querySelector('.aegis-activity .note')?.textContent?.includes('páginas agotadas'));
  result = await page.locator('.aegis-activity').innerText();
  assert(!result.includes('C:/a · 2') && result.includes('C:/a · 1'), 'recarga no reemplazó resultados anteriores');
  await page.locator('.aegis-activity header button').first().click();
  await page.waitForFunction(() => document.querySelector('.aegis-activity .note')?.textContent?.includes('páginas agotadas'));
  assert(calls.filter(x => x === 'ACP session/list').length === 6, 'botón de recarga manual no pidió session/list');
  await page.evaluate(() => (window as any).__aegisActivity.close());
  assert(await page.locator('.aegis-activity').count() === 0, 'close falló');
  await page.evaluate(() => { (window as any).__activityState.pages = 'limit'; return (window as any).__aegisActivity.open(); });
  assert((await page.locator('.aegis-activity .note').innerText()).includes('límite de 8 páginas alcanzado; lista incompleta'), 'el límite no se indica');
  assert(calls.filter(x => x === 'ACP session/list').length === 14, 'no se respetó techo de ocho páginas');
  await page.evaluate(() => (window as any).__aegisActivity.close());
  assert(errors.length === 0, `errores de página: ${errors.join(' | ')}`);
  assert(!calls.some(x => /session\/(load|prompt|new|cancel|delete)/.test(x)), 'RPC de escritura o navegación inventada');
  console.log('PASS activity: paginación, grupos, estado confirmado, confirmaciones, XSS, recarga y navegación pública (fixture sin store)');
} finally { await browser.close(); }

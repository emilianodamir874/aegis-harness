// Test aislado: módulo compilado a node_modules/.cache, HTTP simulado, ACP simulado; nunca usa store ni serve.
// npx esbuild src/activity.ts --bundle --format=esm --platform=browser --outfile=node_modules/.cache/activity-client.js
// npx esbuild tests/activity.ts --bundle --format=esm --platform=node --packages=external --outfile=node_modules/.cache/activity-test.mjs
// node node_modules/.cache/activity-test.mjs
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const script = await readFile(resolve('node_modules/.cache/activity-client.js'), 'utf8');
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
    scope.__aegisWeb = { state: {}, rpc: { ready: true, request: async (method: string, params: any) => {
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
  assert(calls.filter(x => x === 'ACP session/list').length === 2 && calls.includes('GET /pending.json'), 'no paginó o no leyó pendientes');
  const params = await page.evaluate(() => (window as any).__activityState.calls.filter((x: any) => x.method === 'session/list').map((x: any) => x.params));
  assert(params[1].cursor === 'next' && params[0].meta.aegis.includeLastMessageSnippet === false, 'cursor o meta inválidos');
  await page.locator('.aegis-activity button.row').click();
  assert(await page.locator('.aegis-activity').count() === 0, 'click no cerró el panel');
  assert(await page.evaluate(() => (window as any).__activityState.clicks) === 1, 'click no usó el botón real del sidebar');
  await page.evaluate(() => { (window as any).__activityState.pages = 1; (window as any).__aegisActivity.open(); });
  await page.waitForFunction(() => document.querySelector('.aegis-activity .note')?.textContent?.includes('páginas agotadas'));
  result = await page.locator('.aegis-activity').innerText();
  assert(!result.includes('C:/a · 2') && result.includes('C:/a · 1'), 'recarga no reemplazó resultados anteriores');
  await page.locator('.aegis-activity header button').first().click();
  await page.waitForFunction(() => document.querySelector('.aegis-activity .note')?.textContent?.includes('páginas agotadas'));
  assert(calls.filter(x => x === 'ACP session/list').length === 4, 'botón de recarga manual no pidió session/list');
  await page.evaluate(() => (window as any).__aegisActivity.close());
  assert(await page.locator('.aegis-activity').count() === 0, 'close falló');
  await page.evaluate(() => { (window as any).__activityState.pages = 'limit'; return (window as any).__aegisActivity.open(); });
  assert((await page.locator('.aegis-activity .note').innerText()).includes('límite de 8 páginas alcanzado; lista incompleta'), 'el límite no se indica');
  assert(calls.filter(x => x === 'ACP session/list').length === 12, 'no se respetó techo de ocho páginas');
  await page.evaluate(() => (window as any).__aegisActivity.close());
  assert(errors.length === 0, `errores de página: ${errors.join(' | ')}`);
  assert(!calls.some(x => /session\/(load|prompt|new|cancel|delete)/.test(x)), 'RPC de escritura o navegación inventada');
  console.log('PASS activity: paginación, grupos, estado confirmado, confirmaciones, XSS, recarga y navegación pública (fixture sin store)');
} finally { await browser.close(); }

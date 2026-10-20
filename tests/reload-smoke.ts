// Continuidad de la web: recarga del navegador en medio de un turno ACP externo.
//
// Crea una sesion, lanza un turno por WebSocket directo al serve (12 s con la herramienta shell),
// recarga la pagina mientras corre y verifica que el estado (busy/runId) sobreviva a la recarga y
// que la respuesta se renderice una sola vez. Borra la sesion al final.
//
// Es la prueba mas cara (~20 s y un turno real): corre solo con AEGIS_TEST_SMOKE=1.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { baseUrl, acpEndpoint, check, pass, openPage } from './lib.js';

const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
const marker = 'WEB-TS-RELOAD-' + Date.now();
const pageUrl = baseUrl() + '/';
const wsUrl = acpEndpoint() + '?token=' + cfg.secretKey;

const ws = new WebSocket(wsUrl);
const pending = new Map<number, (msg: any) => void>();
let id = 0;
let browser: any;
let sid = '';

const request = (method: string, params: unknown): Promise<any> =>
  new Promise((resolve, reject) => {
    const reqId = ++id;
    pending.set(reqId, (msg: any) => (msg.error ? reject(Error(method + ': ' + JSON.stringify(msg.error))) : resolve(msg.result)));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params }));
  });

ws.onmessage = ({ data }: MessageEvent) => {
  const msg = JSON.parse(String(data));
  if (msg.method === 'session/request_permission') {
    const option = msg.params?.options?.find((o: any) => o.optionId === 'allow_once') ?? msg.params?.options?.[0];
    if (option) ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: option.optionId } } }));
  } else if (msg.id !== undefined && !msg.method) {
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  }
};
ws.onclose = () => {
  for (const cb of pending.values()) cb({ error: { message: 'socket closed' } });
  pending.clear();
};

try {
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(Error('no pude abrir el WS ACP en ' + acpEndpoint()));
  });
  await request('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { aegis: { customNotifications: true } } }, clientInfo: { name: 'aegis-web-tests', version: '1' } });

  browser = await chromium.launch({ headless: true });
  const page = await openPage(browser);
  const errs: string[] = [];
  page.on('pageerror', (e: Error) => errs.push(e.message));
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction(() => (window as any).__aegisWeb?.rpc?.ready === true, null, { timeout: 20000 });
  await page.locator('#btn-new').click();
  await page.waitForFunction(
    () => (window as any).__aegisWeb?.state?.current?.id && (window as any).__aegisWeb?.hub?.().soportado === true,
    null,
    { timeout: 20000 },
  );
  sid = await page.evaluate(() => (window as any).__aegisWeb.state.current.id);
  console.log('sesion ' + sid);

  const prompt = request('session/prompt', {
    sessionId: sid,
    prompt: [{ type: 'text', text: `Ejecutá con la herramienta shell: powershell -NoProfile -Command "Start-Sleep -Seconds 12; Write-Output ${marker}". Después respondé exactamente ${marker}.` }],
  }).then((v: any) => ({ ok: true, value: v }), (e: Error) => ({ ok: false, error: e.message }));

  await page.waitForFunction(() => Boolean((window as any).__aegisWeb?.state?.runId), null, { timeout: 22000 });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction(
    (s: string) => (window as any).__aegisWeb?.state?.current?.id === s && (window as any).__aegisWeb?.hub?.().soportado === true,
    sid,
    { timeout: 20000 },
  );
  const after = await page.evaluate(() => ({
    runId: (window as any).__aegisWeb.state.runId,
    busy: (window as any).__aegisWeb.state.busy,
    hub: (window as any).__aegisWeb.hub(),
  }));
  check(after.runId && after.busy, 'tras la recarga el turno sigue visible: ' + JSON.stringify(after));

  const result: any = await Promise.race([prompt, new Promise((r) => setTimeout(() => r({ ok: false, error: 'prompt timeout' }), 45000))]);
  check(result.ok, 'el turno termino: ' + JSON.stringify(result).slice(0, 200));

  await page.waitForFunction(
    (m: string) => [...document.querySelectorAll('#msg-inner .msg-a')].some((el) => el.textContent?.includes(m)),
    marker,
    { timeout: 16000 },
  );
  // El DOM se repinta mientras el replay del hub y el stream vivo convergen: se espera a que
  // quede una sola copia (hasta 12 s) en vez de mirar una foto instantanea. Si despues de eso
  // sigue duplicada, es una duplicacion real y el check falla igual.
  try {
    await page.waitForFunction(
      (m: string) => [...document.querySelectorAll('#msg-inner .msg-a')].filter((el) => el.textContent?.includes(m)).length === 1,
      marker,
      { timeout: 12000 },
    );
  } catch {}
  const seen = await page.evaluate((m: string) => ({
    matches: [...document.querySelectorAll('#msg-inner .msg-a')].filter((el) => el.textContent?.includes(m)).length,
    runId: (window as any).__aegisWeb.state.runId,
  }), marker);
  check(seen.matches === 1, 'la respuesta aparece exactamente una vez (vio ' + seen.matches + ')');
  check(seen.runId === null, 'runId liberado al terminar');
  check(errs.length === 0, 'sin errores de pagina: ' + JSON.stringify(errs));
  pass('recarga en medio de un turno ACP externo contra ' + pageUrl);
} catch (e) {
  console.error('FAIL ' + (e as Error).message);
  process.exitCode = 1;
} finally {
  if (sid) await request('session/delete', { sessionId: sid }).catch(() => {});
  if (browser) await browser.close().catch(() => {});
  ws.close();
}

// Regresion del rebobinado y del boton "Regenerar".
//
// Cubre el bug real (2026-10-18): el serve NO manda `agentVisible` cuando un mensaje quedo
// oculto, asi que al re-renderizar el transcript los mensajes rebobinados volvian a aparecer y
// el segundo rebobinado no limpiaba nada. Se verifica que lo oculto sobreviva a una recarga, que
// lo que se manda despues sea visible, y que "Regenerar" reemplace la ultima respuesta.
//
// Cuesta turnos reales (4 prompts cortos): corre solo con AEGIS_TEST_SMOKE=1.
import { chromium } from 'playwright';
import { baseUrl, check, pass, openPage } from './lib.js';

const url = baseUrl();
const browser = await chromium.launch({ headless: true });
try {
  const page = await openPage(browser, { viewport: { width: 1280, height: 900 } });
  const errs: string[] = [];
  page.on('pageerror', (e: Error) => errs.push(e.message));

  const waitIdle = async () => {
    await page.waitForFunction(() => (window as any).__aegisWeb?.state?.busy !== true && !(window as any).__aegisWeb?.state?.runId, null, { timeout: 90000 });
    await page.waitForTimeout(900);
  };
  const send = async (t: string) => { await page.fill('#input', t); await page.keyboard.press('Enter'); await waitIdle(); };
  const visibles = () => page.evaluate(() => [...document.querySelectorAll('#msg-inner > .msg-user, #msg-inner > .msg-a')].map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 26)));
  const rewindIdx = async (n: number) => {
    const users = await page.$$('#msg-inner > .msg-user');
    const el = users[n];
    check(!!el, 'hay burbuja de usuario #' + n);
    await el.hover();
    const btn = await el.$('.rewind-btn');
    check(!!btn, 'la burbuja #' + n + ' tiene boton de rebobinar');
    await btn.evaluate((x: HTMLElement) => x.click());
    await page.waitForTimeout(250);
    await page.evaluate(() => document.querySelector<HTMLElement>('.rw-confirm .ym')?.click());
    await page.waitForTimeout(1800);
  };

  await page.goto(url + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(3000);
  await page.click('#btn-new');
  await page.waitForFunction(() => (window as any).__aegisWeb?.state?.current?.id, null, { timeout: 20000 });
  await send('responde solo la letra A');
  const sid = await page.evaluate(() => (window as any).__aegisWeb.state.current.id);
  console.log('sesion ' + sid);
  await send('responde solo la letra B');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  await rewindIdx(1);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const v1 = await visibles();
  check(v1.some((t: string) => /letra A/i.test(t)), 'A sigue visible tras recargar: ' + JSON.stringify(v1));
  check(!v1.some((t: string) => /letra B/i.test(t)), 'B quedo oculto y NO reaparece al recargar: ' + JSON.stringify(v1));

  await send('responde solo la letra C');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const v2 = await visibles();
  check(v2.some((t: string) => /letra A/i.test(t)), 'A visible despues de reenviar: ' + JSON.stringify(v2));
  check(v2.some((t: string) => /letra C/i.test(t)), 'C (lo reenviado) es visible: ' + JSON.stringify(v2));
  check(!v2.some((t: string) => /letra B/i.test(t)), 'B sigue oculto: ' + JSON.stringify(v2));

  await rewindIdx(0);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const v3 = await visibles();
  check(v3.length === 0, 'segundo rebobinado limpia todo desde A (no queda nada visible): ' + JSON.stringify(v3));
  check(!!(await page.$('#msg-inner .rw-marker')), 'queda la marca de rebobinado');

  // Regenerar sobre un chat nuevo
  await page.evaluate(() => document.getElementById('btn-new')?.click());
  await page.waitForTimeout(1200);
  await send('responde solo la letra D');
  await page.waitForTimeout(900);
  const rg = await page.$('#msg-inner .msg-regen');
  check(!!rg, 'la ultima respuesta tiene boton Regenerar');
  const antes = (await visibles()).length;
  await rg!.evaluate((x: HTMLElement) => x.click());
  await waitIdle();
  await page.waitForTimeout(1200);
  const despues = (await visibles()).length;
  const tras = await visibles();
  check(despues < antes, 'regenerar reemplaza el turno viejo (antes ' + antes + ' filas, despues ' + despues + ')');
  check(tras.some((t: string) => /letra D/i.test(t)), 'queda el turno regenerado: ' + JSON.stringify(tras));
  check(errs.length === 0, 'sin errores de pagina: ' + JSON.stringify(errs));

  await page.evaluate((s: string) => (window as any).__aegisWeb?.rpc?.request('session/delete', { sessionId: s }), sid).catch(() => {});
  pass('rebobinado repetido + regenerar contra ' + url);
} finally {
  await browser.close();
}

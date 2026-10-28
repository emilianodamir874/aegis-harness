// Regresion del rebobinado y del boton "Regenerar".
//
// Cubre el bug real (2026-10-18): el serve NO manda `agentVisible` cuando un mensaje quedo
// oculto, asi que al re-renderizar el transcript los mensajes rebobinados volvian a aparecer y
// el segundo rebobinado no limpiaba nada. Se verifica que lo oculto sobreviva a una recarga, que
// lo que se manda despues sea visible, y que "Regenerar" reemplace la ultima respuesta.
//
// CONTRATO NUEVO (2026-10-28): lo que se oculta al MODELO nunca se oculta al USUARIO. Los
// mensajes rebobinados quedan en el DOM, dentro de `.rw-band` (expandida por defecto). Lo que se
// verifica, entonces, es que NO esten en el hilo vivo y SI esten en la banda.
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
    // 150 s: un turno real con este proveedor puede pasar de 90 (paso el 2026-10-20 y el test
    // fallaba por timeout, no por comportamiento).
    await page.waitForFunction(() => (window as any).__aegisWeb?.state?.busy !== true && !(window as any).__aegisWeb?.state?.runId, null, { timeout: 150000 });
    await page.waitForTimeout(900);
  };
  const send = async (t: string) => { await page.fill('#input', t); await page.keyboard.press('Enter'); await waitIdle(); };
  // Hilo vivo: lo que esta en #msg-inner pero NO dentro de la banda de ocultos.
  const visibles = () => page.evaluate(() => [...document.querySelectorAll('#msg-inner > .msg-user, #msg-inner > .msg-a')].map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 26)));
  // Lo que el modelo no ve: sigue existiendo y sigue a la vista del usuario, dentro de la banda.
  const ocultos = () => page.evaluate(() => {
    const b = document.querySelector('#msg-inner .rw-band');
    if (!b) return { band: false, rows: [], count: 0, abierta: false };
    const rows = [...b.querySelectorAll('.rw-band-body > *')].map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 26));
    return { band: true, rows, count: Number((b as HTMLElement).dataset.count || rows.length), abierta: !b.classList.contains('collapsed') };
  });
  const rewindIdx = async (n: number) => {
    const users = await page.$$('#msg-inner > .msg-user, #msg-inner .rw-band-body > .msg-user');
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
  await page.waitForFunction(() => [...document.querySelectorAll('#msg-inner > .msg-user')].slice(-2).every((el) => !!(el as HTMLElement).dataset.mid && el.querySelectorAll('.rewind-btn').length === 1));
  check(await page.locator('#msg-inner > .msg-user').count() === 2, 'los dos prompts tienen una sola burbuja antes de refrescar');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  await rewindIdx(1);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const v1 = await visibles();
  const h1 = await ocultos();
  check(v1.some((t: string) => /letra A/i.test(t)), 'A sigue en el hilo vivo tras recargar: ' + JSON.stringify(v1));
  check(!v1.some((t: string) => /letra B/i.test(t)), 'B salio del hilo vivo: ' + JSON.stringify(v1));
  check(h1.band && h1.abierta, 'queda la banda de ocultos, abierta por defecto');
  check(h1.rows.some((t: string) => /letra B/i.test(t)), 'B sigue visible para el usuario dentro de la banda: ' + JSON.stringify(h1.rows));

  await send('responde solo la letra C');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const v2 = await visibles();
  const h2 = await ocultos();
  check(v2.some((t: string) => /letra A/i.test(t)), 'A visible despues de reenviar: ' + JSON.stringify(v2));
  check(v2.some((t: string) => /letra C/i.test(t)), 'C (lo reenviado) es visible: ' + JSON.stringify(v2));
  check(h2.rows.some((t: string) => /letra B/i.test(t)) && !v2.some((t: string) => /letra B/i.test(t)), 'B sigue fuera del modelo y a la vista: ' + JSON.stringify(h2.rows));

  await rewindIdx(0);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const v3 = await visibles();
  const h3 = await ocultos();
  check(v3.length === 0, 'segundo rebobinado limpia el hilo vivo (no queda nada fuera de la banda): ' + JSON.stringify(v3));
  check(h3.band, 'queda la banda de rebobinado');
  check(h3.rows.length >= 4, 'nada se perdio: ' + h3.rows.length + ' mensajes conservados en la banda');
  check(/letra A/i.test(h3.rows.join(' ')) && /letra C/i.test(h3.rows.join(' ')), 'A y C siguen legibles para el usuario: ' + JSON.stringify(h3.rows));

  // Regenerar sobre un chat nuevo
  await page.evaluate(() => document.getElementById('btn-new')?.click());
  await page.waitForTimeout(1200);
  await send('responde solo la letra D');
  await page.waitForTimeout(900);
  // Las acciones de la respuesta viven en el menu ⋯ (2026-10-28): se abre y se elige Regenerar.
  const abrirRegenerar = async () => {
    const ultima = page.locator('#msg-inner > .msg-a').filter({ hasNot: page.locator('.thought') }).last();
    await ultima.locator('.act-btn').click({ force: true });
    const fila = page.locator('body > .acts-menu .menu-row').filter({ hasText: 'Regenerar' });
    check(await fila.count() === 1, 'el menu de la ultima respuesta ofrece Regenerar');
    await fila.click();
  };
  const antes = (await visibles()).length;
  await abrirRegenerar();
  await waitIdle();
  await page.waitForTimeout(1200);
  const despues = (await visibles()).length;
  const tras = await visibles();
  const h4 = await ocultos();
  check(despues < antes, 'regenerar saca el turno viejo del hilo (antes ' + antes + ' filas, despues ' + despues + ')');
  check(tras.some((t: string) => /letra D/i.test(t)), 'queda el turno regenerado: ' + JSON.stringify(tras));
  check(h4.rows.some((t: string) => /letra D/i.test(t)) || h4.rows.length > 0, 'el turno viejo queda en la banda, no borrado: ' + JSON.stringify(h4.rows));
  check(errs.length === 0, 'sin errores de pagina: ' + JSON.stringify(errs));

  await page.evaluate((s: string) => (window as any).__aegisWeb?.rpc?.request('session/delete', { sessionId: s }), sid).catch(() => {});
  pass('rebobinado repetido + regenerar contra ' + url);
} finally {
  await browser.close();
}

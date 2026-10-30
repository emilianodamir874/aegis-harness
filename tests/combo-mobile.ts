// Test de combobox en móvil con Playwright:
// Verifica que al tocar un proveedor y avanzar al paso de modelo,
// el resize de window que produce el teclado virtual en Android NO cierre el combobox.
import { chromium } from 'playwright';
import { baseUrl, check, openPage } from './lib.js';

const url = baseUrl();
const browser = await chromium.launch({ headless: true });
try {
  const page = await openPage(browser, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const errs: string[] = [];
  page.on('pageerror', (e: Error) => errs.push(e.message));

  await page.goto(url + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(3000);

  // Abrir combobox de modelo/proveedor desde el chip
  const chipBtn = page.locator('#chips .chip-model');
  await chipBtn.waitFor({ state: 'visible', timeout: 10000 });
  await chipBtn.click();
  await page.waitForTimeout(400);

  const abiertoInicio = await page.evaluate(() => {
    const root = document.querySelector('.combo-root.is-sheet');
    const title = document.querySelector('.combo-title')?.textContent;
    return { abierto: !!root, title };
  });
  check(abiertoInicio.abierto, 'combobox abierto en hoja móvil (is-sheet)');
  check(abiertoInicio.title === 'Proveedor', 'título inicial es Proveedor: ' + abiertoInicio.title);

  // Elegir el primer proveedor para avanzar al paso 'modelo'
  const primerProv = page.locator('.combo-list .combo-opt').first();
  await primerProv.waitFor({ state: 'visible', timeout: 5000 });
  await primerProv.click();
  await page.waitForTimeout(400);

  const pasoModelo = await page.evaluate(() => {
    const root = document.querySelector('.combo-root.is-sheet');
    const title = document.querySelector('.combo-title')?.textContent;
    const inputFocused = document.activeElement === document.querySelector('.combo-input');
    return { abierto: !!root, title, inputFocused };
  });
  check(pasoModelo.abierto, 'permanece abierto en el paso de modelo');
  check(pasoModelo.title === 'Modelo', 'título cambió a Modelo: ' + pasoModelo.title);

  // Simular resize de window que dispara Android cuando aparece el teclado virtual
  await page.evaluate(() => {
    window.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(300);

  const postResize = await page.evaluate(() => {
    const root = document.querySelector('.combo-root.is-sheet');
    return { abierto: !!root };
  });
  check(postResize.abierto, 'combobox sigue ABIERTO tras el resize provocado por el teclado');

  // Cerrar el combobox con el botón cerrar
  await page.click('.combo-close');
  await page.waitForTimeout(300);
  const cerrado = await page.evaluate(() => !document.querySelector('.combo-root'));
  check(cerrado, 'botón cerrar cierra la hoja');

  check(errs.length === 0, 'sin errores de página: ' + JSON.stringify(errs));
  console.log('PASS combobox móvil no se cierra con teclado en Android (resize resiliente)');
} finally {
  await browser.close();
}

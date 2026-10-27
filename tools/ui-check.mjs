import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = 'C:\\Aegis-Proyects\\tmp\\ui-check';
fs.mkdirSync(OUT, { recursive: true });

const report = [];
function note(ok, what, detail = '') {
  report.push({ ok, what, detail });
  console.log(`${ok ? 'OK  ' : 'FALLA'} ${what}${detail ? ' :: ' + detail : ''}`);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
});
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e).slice(0, 200)));

await page.goto('http://127.0.0.1:3788/', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(3000);

// 1. estado inicial: los ocho modulos cargaron
const globals = await page.evaluate(() => ({
  web: !!window.__aegisWeb,
  memory: !!window.__aegisMemory,
  artifacts: !!window.__aegisArtifacts,
  palette: !!window.__aegisPalette,
  sessionMode: !!window.__aegisSessionMode,
  handoff: !!window.__aegisHandoff,
  split: !!window.__aegisSplit,
  welcome: !!window.__aegisWelcome,
  meter: !!document.querySelector('.ctx-meter'),
  onboard: !!document.getElementById('aegis-onboard'),
  modeChip: !!document.querySelector('.aegis-mode'),
}));
for (const [k, v] of Object.entries(globals)) note(v, `global/selector ${k}`);

await page.screenshot({ path: path.join(OUT, '01-inicio.png'), fullPage: false });

// 2. onboarding: la tarjeta vive en el estado vacio, asi que se fuerza su visibilidad y se refresca.
// Verifica el contenido, no que este a la vista con una sesion abierta.
const onboard = await page.evaluate(async () => {
  const welcome = document.getElementById('welcome');
  if (!welcome) return { ok: false, detail: 'sin #welcome' };
  const previo = welcome.style.display;
  welcome.hidden = false;
  welcome.style.display = 'block';
  window.__aegisWelcome?.refresh();
  await new Promise((r) => setTimeout(r, 2500));
  const card = document.getElementById('aegis-onboard');
  const text = card ? card.innerText.replace(/\n+/g, ' | ') : '';
  welcome.style.display = previo;
  return { ok: !!card && text.length > 40, detail: text.slice(0, 240) };
});
note(onboard.ok, 'tarjeta de onboarding con datos reales', onboard.detail);

// 3. palette Ctrl+K
await page.keyboard.press('Control+k');
await page.waitForSelector('.aegis-pal', { timeout: 4000 }).catch(() => {});
const palOpen = await page.locator('.aegis-pal').count();
note(palOpen === 1, 'Ctrl+K abre la palette');
const palItems = await page.locator('.aegis-pal li').count();
note(palItems >= 10, 'palette lista comandos', `${palItems} items`);
await page.keyboard.type('memoria');
await page.waitForTimeout(300);
const filtered = await page.locator('.aegis-pal li').count();
note(filtered >= 1 && filtered < palItems, 'palette filtra al escribir', `${filtered} de ${palItems}`);
await page.screenshot({ path: path.join(OUT, '02-palette.png') });
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
note((await page.locator('.aegis-pal').count()) === 0, 'Escape cierra la palette');

// 4. chip de modo: tres estados y titulo que explica
const chip = page.locator('.aegis-mode');
if (await chip.count()) {
  const states = [];
  for (let i = 0; i < 3; i++) {
    states.push((await chip.innerText()).trim().toLowerCase());
    await chip.click();
    await page.waitForTimeout(400);
  }
  note(new Set(states).size === 3, 'chip cicla tres estados', states.join(' → '));
  const title = await chip.getAttribute('title');
  note(!!title && title.length > 20, 'chip explica el modo', (title || '').slice(0, 90));
}

// 5. medidor: click abre el mapa con desglose
const meter = page.locator('.ctx-meter');
if ((await meter.count()) && (await meter.first().isVisible())) {
  await meter.first().click();
  await page.waitForTimeout(800);
  const mapText = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('div')].filter((d) => /DESGLOSE|Desglose|contexto/i.test(d.innerText || '') && d.children.length > 2);
    return nodes.length ? nodes[nodes.length - 1].innerText.slice(0, 500) : '';
  });
  note(mapText.length > 50, 'medidor abre el mapa del contexto', mapText.replace(/\n+/g, ' | ').slice(0, 220));
  await page.screenshot({ path: path.join(OUT, '03-medidor.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
} else {
  note(true, 'medidor oculto sin uso todavia (por diseno)', 'aparece al primer turno con usage_update');
}

// 6. panel de memoria
await page.keyboard.press('Control+Alt+m');
await page.waitForTimeout(1200);
const memOpen = await page.evaluate(() => !!document.querySelector('.aegis-mem'));
note(memOpen, 'Ctrl+Alt+M abre memoria');
await page.screenshot({ path: path.join(OUT, '04-memoria.png') });
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// 7. artefactos
await page.keyboard.press('Control+Alt+o');
await page.waitForTimeout(1200);
const artOpen = await page.evaluate(() => !!document.querySelector('.aegis-art'));
note(artOpen, 'Ctrl+Alt+O abre artefactos');
await page.screenshot({ path: path.join(OUT, '05-artefactos.png') });
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// 8. handoff
await page.keyboard.press('Control+Alt+h');
await page.waitForTimeout(1500);
const hoOpen = await page.evaluate(() => !!document.querySelector('.aegis-ho'));
note(hoOpen, 'Ctrl+Alt+H abre handoff');
await page.screenshot({ path: path.join(OUT, '06-handoff.png') });
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// 9. split view
await page.keyboard.press('Control+Alt+2');
await page.waitForTimeout(1500);
const splitOpen = await page.evaluate(() => !!document.querySelector('.aegis-split'));
note(splitOpen, 'Ctrl+Alt+2 abre split view');
if (splitOpen) {
  const opciones = await page.locator('.aegis-split select option').count();
  note(opciones > 0, 'split lista sesiones', `${opciones} opciones`);
}
await page.screenshot({ path: path.join(OUT, '07-split.png') });
await page.keyboard.press('Control+Alt+2');
await page.waitForTimeout(400);

// 10. sin errores de consola propios de los paneles
note(consoleErrors.length === 0, 'consola sin errores', consoleErrors.slice(0, 3).join(' | '));

fs.writeFileSync(path.join(OUT, 'reporte.json'), JSON.stringify({ globals, report, consoleErrors }, null, 2));
await browser.close();

const fallos = report.filter((r) => !r.ok).length;
console.log(`\n${report.length - fallos} ok | ${fallos} fallas | capturas en ${OUT}`);
process.exit(fallos ? 1 : 0);

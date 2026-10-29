import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
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
  modeChip: !!document.querySelector('.aegis-mode'), // ahora se espera false
}));
for (const [k, v] of Object.entries(globals)) {
  if (k === 'modeChip') continue; // el chip se elimino a proposito: el modo lo maneja el agente
  note(v, `global/selector ${k}`);
}

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

// 4. chip de modo: ya no existe (el modo lo maneja el agente), pero la API sigue viva
note((await page.locator('.aegis-mode').count()) === 0, 'sin chip de modo en pantalla');
note(!!globals.sessionMode, 'API de modo disponible para la palette');

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

// 10. markdown largo: ~3000 palabras con tablas, listas, codigo y enlaces.
// Usa el renderer real del cliente (__aegisWeb.md) y el contenedor real de mensajes,
// asi que mide lo que el operador veria en una respuesta larga del agente.
// Primero abre una sesion corta: en "nuevo chat" el feed no esta montado y sembrar
// ahi mediria un contenedor oculto.
await page.getByText('Destructive disk wipe request', { exact: false }).first().click().catch(() => {});
await page.waitForTimeout(2500);
const feedListo = await page.evaluate(() => {
  const box = document.querySelector('#msg-inner');
  return { existe: !!box, hijos: box ? box.children.length : 0 };
});
note(feedListo.hijos > 0, 'el feed de una sesion real queda montado', `${feedListo.hijos} burbujas`);
const mdWords = (n) => {
  const base = ['contexto', 'operacion', 'resultado', 'archivo', 'linea', 'sesion', 'turno', 'medicion', 'registro', 'bloque'];
  const out = [];
  for (let i = 0; i < n; i++) out.push(base[i % base.length]);
  return out.join(' ');
};
const mdLargo = [
  '## Resumen del tramo',
  '',
  mdWords(400),
  '',
  '| columna | valor | nota |',
  '|---|---|---|',
  ...Array.from({ length: 12 }, (_, i) => `| fila ${i} | ${i * 17} | ${i === 0 ? 'C:\\\\Aegis-Proyects\\\\state\\\\data\\\\sessions\\\\sessions.db (310 sesiones, 93 mil mensajes, WAL aparte)' : mdWords(9)} |`),
  '',
  '### Pasos',
  '',
  ...Array.from({ length: 20 }, (_, i) => `${i + 1}. paso ${i + 1} con \`inline_code_${i}\` y texto ${mdWords(12)}`),
  '',
  '- punto suelto con **negrita** y _cursiva_',
  '- [enlace interno](#resumen-del-tramo) y [enlace externo](https://example.com/ruta/muy/larga/sin/espacios/que/no/deberia/desbordar/la/burbuja/porque/el/css/parte/palabras)',
  '',
  '```rust',
  ...Array.from({ length: 40 }, (_, i) => `fn paso_${i}(ctx: &mut Contexto) -> Result<()> { ctx.avanzar(${i}); Ok(()) }`),
  '```',
  '',
  mdWords(1200),
  '',
  '### Cierre',
  '',
  mdWords(600),
].join('\n');

const mdRes = await page.evaluate((text) => {
  const welcome = document.getElementById('welcome');
  if (welcome) welcome.style.display = 'none';
  const host = document.querySelector('#msg-inner') || document.querySelector('.msgs') || document.body;
  const html = window.__aegisWeb.md(text);
  const box = document.createElement('div');
  box.className = 'msg-user';
  box.id = 'probe-md-largo';
  box.innerHTML = html;
  host.appendChild(box);
  const vw = window.innerWidth;
  const docDesborda = document.documentElement.scrollWidth > vw + 1;
  const anchos = [...box.querySelectorAll('*')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > vw + 1;
  });
  const ancestros = [];
  for (let el = box.parentElement; el; el = el.parentElement) ancestros.push(el);
  const scroller = ancestros.find((a) => a.scrollHeight > a.clientHeight + 8) || null;
  const antes = scroller ? scroller.scrollTop : 0;
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
  const bajo = scroller ? scroller.scrollTop : 0;
  if (scroller) scroller.scrollTop = antes;
  box.scrollIntoView({ block: 'start' });
  const recortados = [...box.querySelectorAll('table')].filter((el) => el.scrollWidth > el.clientWidth + 2);
  const presConScroll = [...box.querySelectorAll('pre')].filter((el) => el.scrollWidth > el.clientWidth + 2).length;
  const res = {
    ok: !docDesborda && anchos.length === 0 && box.scrollHeight > 1000 && recortados.length === 0,
    words: text.split(/\s+/).filter(Boolean).length,
    tables: box.querySelectorAll('table').length,
    pres: box.querySelectorAll('pre').length,
    lists: box.querySelectorAll('ul,ol').length,
    links: box.querySelectorAll('a').length,
    docWidth: document.documentElement.scrollWidth,
    viewport: vw,
    anchos: anchos.slice(0, 3).map((el) => el.tagName + '.' + el.className),
    alto: box.scrollHeight,
    recortados: recortados.slice(0, 3).map((el) => el.tagName + ' ' + el.scrollWidth + '>' + el.clientWidth),
    presConScroll,
    scroller: scroller ? (scroller.id || scroller.className || scroller.tagName) : 'sin scroller propio',
    scroll: bajo,
  };
  return res;
}, mdLargo);

note(mdRes.ok, 'markdown de 3000 palabras no desborda ni rompe el scroll',
  `${mdRes.words} palabras · ${mdRes.tables} tablas · ${mdRes.pres} bloques de codigo · ${mdRes.lists} listas · ${mdRes.links} enlaces · alto ${mdRes.alto}px · doc ${mdRes.docWidth}/${mdRes.viewport} · scroller ${mdRes.scroller} · scroll ${mdRes.scroll}${mdRes.anchos.length ? ' · anchos: ' + mdRes.anchos.join(',') : ''}${mdRes.recortados.length ? ' · RECORTADOS: ' + mdRes.recortados.join(',') : ''} · pre con scroll propio ${mdRes.presConScroll}`);
await page.screenshot({ path: path.join(OUT, '08-markdown-largo.png') });
await page.evaluate(() => {
  document.getElementById('probe-md-largo')?.remove();
  const welcome = document.getElementById('welcome');
  if (welcome) welcome.style.display = '';
});

// 11. subida real de imagen desde el composer: PNG 2400x1600 generado aca,
// cargado por el input de archivos y verificado en la miniatura del composer.
function crcTable() {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
}
const CRC = crcTable();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = Math.round((x * 255) / width);
    row[2 + x * 3] = 80;
    row[3 + x * 3] = 160;
  }
  const raw = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y++) row.copy(raw, y * row.length);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const imgPath = path.join(OUT, 'subida-2400x1600.png');
fs.writeFileSync(imgPath, makePng(2400, 1600));
const antesAdjuntos = await page.evaluate(() => document.querySelectorAll('#attachments .att-thumb, #attachments .att-file').length);
await page.setInputFiles('#file-input', imgPath);
await page.waitForSelector('#attachments .att-thumb img', { timeout: 5000 }).catch(() => {});
await page.waitForTimeout(600);
const att = await page.evaluate(() => {
  const box = document.querySelector('#attachments');
  const thumb = box ? box.querySelector('.att-thumb img') : null;
  if (!thumb) return { ok: false, detail: 'sin miniatura en #attachments', visible: false };
  const r = thumb.getBoundingClientRect();
  return {
    ok: !box.hidden && r.width > 0 && r.height > 0,
    visible: !box.hidden,
    w: Math.round(r.width),
    h: Math.round(r.height),
    natural: thumb.naturalWidth + 'x' + thumb.naturalHeight,
    count: box.querySelectorAll('.att-thumb').length,
  };
});
note(att.ok, 'la imagen subida desde el composer entra como miniatura',
  `${att.natural} -> ${att.w}x${att.h} · adjuntos ${antesAdjuntos} -> ${att.count}`);
const sendOn = await page.evaluate(() => {
  const b = document.querySelector('#btn-send');
  return b ? !b.disabled : null;
});
note(sendOn === true, 'el boton de enviar se habilita con la imagen adjunta');
await page.screenshot({ path: path.join(OUT, '09-imagen-adjunta.png') });
await page.evaluate(() => document.querySelector('#attachments .att-x')?.click());
await page.waitForTimeout(300);
const limpio = await page.evaluate(() => document.querySelectorAll('#attachments .att-thumb').length);
note(limpio === 0, 'quitar el adjunto limpia la miniatura');

// 12. el microfono se fue de la UI el 2026-10-29: el boton de dictado no debe existir.
note(await page.evaluate(() => !document.getElementById('btn-mic')), 'el boton de dictado ya no esta en el DOM');

// 13. sin errores de consola propios de los paneles
note(consoleErrors.length === 0, 'consola sin errores', consoleErrors.slice(0, 3).join(' | '));

fs.writeFileSync(path.join(OUT, 'reporte.json'), JSON.stringify({ globals, report, consoleErrors, mdRes, att }, null, 2));
await browser.close();

const fallos = report.filter((r) => !r.ok).length;
console.log(`\n${report.length - fallos} ok | ${fallos} fallas | capturas en ${OUT}`);
process.exit(fallos ? 1 : 0);

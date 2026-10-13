// Verificación v4 de las features nuevas de goose-web:
//  - welcome de sesión vacía (estado vacío explícito)
//  - adjuntar archivos de texto (file input) + drag & drop sobre la ventana
//  - menú de fila: exportar Markdown/JSON (descarga real) y archivar/desarchivar
//  - autocompletado de slash commands en el composer
//  - steering: mandar un mensaje mientras el agente trabaja
//  - estructura nueva del sidebar (botón ⋮, grupos de archivadas, "cargar más")
// Run: cd ui/desktop && node scripts/goose-web-features.mjs [url]
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';

const url = process.argv[2] || 'http://192.168.100.34:3788/';
const shots = 'C:/goose-web/tools/shots';
mkdirSync(shots, { recursive: true });
const SAMPLE = 'C:/goose-web/tools/sample-context.txt';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const out = { url, features: {}, errors: [] };
const idle = (page) =>
  page.waitForFunction(() => { const s = document.querySelector('#btn-send'); return s && !s.hidden; }, null, { timeout: 200000 }).catch(() => {});

try {
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => out.errors.push('pageerror: ' + String(e.message).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') out.errors.push('console: ' + m.text().slice(0, 300)); });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 45000 });
  await page.waitForFunction(() => document.querySelectorAll('.sb-item').length > 0, null, { timeout: 20000 });
  await page.waitForTimeout(800);

  // ---------- 1. sidebar: estructura ----------
  out.features.sidebar = await page.evaluate(() => ({
    rows: document.querySelectorAll('.sb-row').length,
    more: document.querySelectorAll('.sb-more').length,
    rename: document.querySelectorAll('.sb-rename').length,
    del: document.querySelectorAll('.sb-del').length,
    loadMore: document.querySelectorAll('.sb-more-btn').length,
    archToggle: document.querySelectorAll('.sb-arch-toggle').length,
  }));

  // ---------- 2. welcome de sesión vacía ----------
  await page.click('#btn-new');
  await page.waitForTimeout(1200);
  out.features.welcomeNew = await page.evaluate(() => ({
    visible: !document.querySelector('#welcome').hidden,
    h1: document.querySelector('#welcome-h1').textContent,
  }));
  out.features.welcomeEmpty = await page.evaluate(() => {
    window.__gooseWeb.showWelcome('empty', 'Sesión sin historial');
    const w = document.querySelector('#welcome');
    return { visible: !w.hidden, h1: document.querySelector('#welcome-h1').textContent, sub: w.querySelector('.welcome-sub').textContent };
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: shots + '/v4-desktop-empty.png' });

  // ---------- 3. slash commands ----------
  await page.click('#input');
  await page.type('#input', '/');
  await page.waitForTimeout(900);
  const slashInfo = await page.evaluate(() => {
    const box = document.querySelector('#slash-menu');
    return {
      visible: !box.hidden,
      items: box.querySelectorAll('.slash-item').length,
      available: (window.__gooseWeb.slashCommands() || []).length,
      type: (window.__gooseWeb.slashCommands()[0] || {})._meta?.commandType || null,
    };
  });
  out.features.slash = slashInfo;
  if (slashInfo.items > 0) {
    await page.screenshot({ path: shots + '/v4-desktop-slash.png' });
    // filtrar por el prefijo de un comando real y elegirlo con Tab
    const firstName = await page.evaluate(() => window.__gooseWeb.slashCommands()[0].name);
    await page.type('#input', firstName.slice(0, 3));
    await page.waitForTimeout(500);
    out.features.slashFiltered = await page.locator('#slash-menu .slash-item').count();
    out.features.slashFirstName = firstName;
    await page.keyboard.press('Tab');
    await page.waitForTimeout(300);
    out.features.slashInserted = await page.inputValue('#input');
    out.features.slashExpected = '/' + firstName + ' ';
    out.features.slashClosedAfterInsert = await page.evaluate(() => document.querySelector('#slash-menu').hidden);
  }
  await page.fill('#input', '');

  // ---------- 4. adjuntos de texto: file input + drag & drop ----------
  await page.setInputFiles('#file-input', SAMPLE);
  await page.waitForTimeout(700);
  out.features.attFileInput = await page.evaluate(() =>
    [...document.querySelectorAll('#attachments .att-file')].map((e) => e.querySelector('.att-file-name').textContent)
  );
  await page.screenshot({ path: shots + '/v4-desktop-attach.png' });

  // drop de un segundo archivo (con dragenter previo -> dropzone visible)
  const dt = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    d.items.add(new File(['Clave drag and drop: DND-8891'], 'dnd-notas.txt', { type: 'text/plain' }));
    return d;
  });
  await page.dispatchEvent('body', 'dragenter', { dataTransfer: dt, bubbles: true, cancelable: true });
  await page.waitForTimeout(300);
  out.features.dropzoneVisible = await page.evaluate(() => !document.querySelector('#dropzone').hidden);
  await page.screenshot({ path: shots + '/v4-desktop-dropzone.png' });
  await page.dispatchEvent('body', 'drop', { dataTransfer: dt, bubbles: true, cancelable: true });
  await page.waitForTimeout(700);
  out.features.afterDrop = await page.evaluate(() => ({
    files: [...document.querySelectorAll('#attachments .att-file .att-file-name')].map((e) => e.textContent),
    dropzoneHidden: document.querySelector('#dropzone').hidden,
  }));

  // enviar y comprobar que el modelo lee los dos archivos
  await page.fill('#input', 'Te adjunté dos archivos de texto. Respondé solo las dos claves que aparecen en ellos, separadas por coma.');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => !document.querySelector('#btn-send').hidden && document.querySelectorAll('.msg-a .content').length > 0,
    null,
    { timeout: 200000 }
  ).catch(() => {});
  await page.waitForTimeout(1200);
  out.features.textFiles = await page.evaluate(() => ({
    notes: [...document.querySelectorAll('.msg-user .att-note')].map((e) => e.textContent.trim()),
    reply: (document.querySelector('.msg-a .content')?.textContent || '').slice(0, 200),
  }));
  await page.screenshot({ path: shots + '/v4-desktop-textfiles.png' });

  // renombrar para poder limpiarla después
  try {
    const row = page.locator('.sb-row:has(.sb-item.active)').first();
    await row.locator('.sb-rename').click({ force: true });
    await page.waitForTimeout(300);
    await page.fill('.sb-edit', 'FEATURES-v4 check');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    out.features.renamed = await page.textContent('#chat-title');
  } catch (e) { out.features.renameError = String(e).slice(0, 200); }

  // ---------- 5. menú de fila: export + archivar ----------
  const testRow = page.locator('.sb-row:has(.sb-item.active)').first();
  await testRow.locator('.sb-more').click({ force: true });
  await page.waitForTimeout(400);
  out.features.rowMenu = await page.locator('.menu.row-menu .menu-row').allTextContents();
  out.features.rowMenuRect = await page.evaluate(() => {
    const r = document.querySelector('.menu.row-menu').getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), fits: r.top >= 0 && r.bottom <= window.innerHeight };
  });
  await page.screenshot({ path: shots + '/v4-desktop-rowmenu.png' });

  // exportar markdown (descarga real)
  try {
    const menuItem = page.locator('.menu.row-menu .menu-row', { hasText: 'Exportar como Markdown' }).first();
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }),
      menuItem.click(),
    ]);
    const file = await download.path();
    const body = readFileSync(file, 'utf8');
    out.features.exportMd = {
      filename: download.suggestedFilename(),
      bytes: body.length,
      hasClave: body.includes('CLAVE-CONTEXTO-4417'),
      hasTitle: body.includes('FEATURES-v4 check'),
    };
  } catch (e) {
    out.features.exportMd = { error: String(e).slice(0, 200) };
    out.features.exportClipboard = await page.evaluate(() => navigator.clipboard.readText().then((t) => t.slice(0, 120)).catch(() => null));
  }

  // exportar json (por portapapeles no; misma vía de descarga)
  try {
    await testRow.locator('.sb-more').click({ force: true });
    await page.waitForTimeout(300);
    const [dl2] = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }),
      page.locator('.menu.row-menu .menu-row', { hasText: 'Exportar como JSON' }).first().click(),
    ]);
    const txt = readFileSync(await dl2.path(), 'utf8');
    let parsed = null;
    try { parsed = JSON.parse(txt); } catch {}
    out.features.exportJson = { filename: dl2.suggestedFilename(), bytes: txt.length, jsonOk: !!parsed };
  } catch (e) { out.features.exportJson = { error: String(e).slice(0, 200) }; }

  // archivar
  await testRow.locator('.sb-more').click({ force: true });
  await page.waitForTimeout(300);
  await page.locator('.menu.row-menu .menu-row', { hasText: 'Archivar' }).first().click();
  await page.waitForTimeout(1800);
  out.features.afterArchive = await page.evaluate(() => ({
    activeRows: [...document.querySelectorAll('.sb-row:not([data-arch]) .sb-title')].map((e) => e.textContent).filter((t) => t.includes('FEATURES')),
    archRows: [...document.querySelectorAll('.sb-row[data-arch] .sb-title')].map((e) => e.textContent).filter((t) => t.includes('FEATURES')),
    toggleOpen: !!document.querySelector('.sb-arch-toggle.open'),
    toast: document.querySelector('.toast')?.textContent || null,
    currentTitle: document.querySelector('#chat-title').textContent,
  }));
  await page.screenshot({ path: shots + '/v4-desktop-archived.png' });

  // desarchivar
  const archRow = page.locator('.sb-row[data-arch]:has(.sb-title:has-text("FEATURES-v4 check"))').first();
  await archRow.locator('.sb-more').click({ force: true });
  await page.waitForTimeout(400);
  out.features.archMenuRect = await page.evaluate(() => {
    const r = document.querySelector('.menu.row-menu').getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), fits: r.top >= 0 && r.bottom <= window.innerHeight };
  });
  await page.locator('.menu.row-menu .menu-row', { hasText: 'Desarchivar' }).first().click();
  await page.waitForTimeout(1800);
  out.features.afterUnarchive = await page.evaluate(() => ({
    activeRows: [...document.querySelectorAll('.sb-row:not([data-arch]) .sb-title')].map((e) => e.textContent).filter((t) => t.includes('FEATURES')),
    archRows: [...document.querySelectorAll('.sb-row[data-arch] .sb-title')].map((e) => e.textContent).filter((t) => t.includes('FEATURES')),
  }));

  // ---------- 6. steering ----------
  await page.click('#btn-new');
  await page.waitForTimeout(1200);
  await page.fill('#input', 'Ejecutá exactamente este comando de shell y después respondé LISTO-1: ping -n 12 127.0.0.1');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.tool').length > 0, null, { timeout: 120000 }).catch(() => {});
  out.features.steerBusy = await page.evaluate(() => ({
    sendHidden: document.querySelector('#btn-send').hidden,
    stopVisible: !document.querySelector('#btn-stop').hidden,
    metaHint: document.querySelector('#meta-left').textContent,
    tools: document.querySelectorAll('.tool').length,
  }));
  await page.fill('#input', 'Además, cuando termines agregá la palabra STEER-OK en el final.');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  out.features.steerQueued = await page.evaluate(() => ({
    queuedBubbles: document.querySelectorAll('.msg-user.queued').length,
    note: document.querySelector('.msg-user .steer-note')?.textContent || null,
    inputCleared: document.querySelector('#input').value === '',
  }));
  await page.screenshot({ path: shots + '/v4-desktop-steer.png' });
  // esperar la confirmación de pickup (user_message_chunk con el mismo messageId)
  const delivered = await page
    .waitForFunction(() => (document.querySelector('.msg-user .steer-note')?.textContent || '').includes('recibida'), null, { timeout: 180000 })
    .then(() => true)
    .catch(() => false);
  out.features.steerDelivered = delivered;
  out.features.steerFinalNote = await page.evaluate(() => document.querySelector('.msg-user .steer-note')?.textContent || null);
  await idle(page);
  await page.waitForTimeout(1500);
  out.features.steerReply = await page.evaluate(() => ({
    bubbles: document.querySelectorAll('.msg-user').length,
    reply: [...document.querySelectorAll('.msg-a .content')].map((e) => e.textContent).join(' ').slice(-220),
    sysnotes: [...document.querySelectorAll('.sysnote')].map((e) => e.textContent),
  }));
  await page.screenshot({ path: shots + '/v4-desktop-steer-done.png' });
  // renombrar la sesión de steering para poder limpiarla
  try {
    const row2 = page.locator('.sb-row:has(.sb-item.active)').first();
    await row2.locator('.sb-rename').click({ force: true });
    await page.waitForTimeout(300);
    await page.fill('.sb-edit', 'FEATURES-v4 steer');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);
  } catch {}
  await ctx.close();

  // ---------- 7. phone 390: sidebar nueva + menú de fila ----------
  const pctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/159.0.0.0 Mobile Safari/537.36',
  });
  const p = await pctx.newPage();
  p.on('pageerror', (e) => out.errors.push('phone pageerror: ' + String(e.message).slice(0, 200)));
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 45000 });
  await p.waitForFunction(() => document.querySelectorAll('.sb-item').length > 0, null, { timeout: 20000 });
  await p.click('#btn-menu');
  await p.waitForTimeout(500);
  const archToggle = p.locator('.sb-arch-toggle').first();
  if (await archToggle.count()) { await archToggle.tap(); await p.waitForTimeout(600); }
  await p.screenshot({ path: shots + '/v4-phone-drawer.png' });
  await p.locator('.sb-more').first().click({ force: true });
  await p.waitForTimeout(600);
  out.features.phoneRowMenu = await p.evaluate(() => {
    const m = document.querySelector('.menu.row-menu');
    if (!m) return { open: false };
    const r = m.getBoundingClientRect();
    return { open: true, left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), fitsX: r.left >= 0 && r.right <= window.innerWidth, fitsY: r.top >= 0 && r.bottom <= window.innerHeight, rows: m.querySelectorAll('.menu-row').length };
  });
  await p.screenshot({ path: shots + '/v4-phone-rowmenu.png' });
  await p.tap('.sb-item:not(.arch)').catch(() => {});
  await p.waitForTimeout(6000);
  await p.tap('#input');
  await p.type('#input', '/');
  await p.waitForTimeout(1200);
  out.features.phoneSlash = await p.evaluate(() => {
    const box = document.querySelector('#slash-menu');
    const r = box.hidden ? null : box.getBoundingClientRect();
    return { visible: !box.hidden, items: box.querySelectorAll('.slash-item').length, top: r ? Math.round(r.top) : null, fits: r ? r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 : null };
  });
  await p.screenshot({ path: shots + '/v4-phone-slash.png' });
  await pctx.close();
} catch (e) {
  out.fatal = String(e && e.stack ? e.stack : e).slice(0, 900);
} finally {
  await browser.close();
}
console.log(JSON.stringify(out, null, 2));

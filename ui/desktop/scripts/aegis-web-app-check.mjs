// Verificación e2e v3 de goose-web: conexión, sesiones, envío+streaming,
// cambio de modelo (chip), tool card, permisos (approve), adjuntar imagen,
// borrar sesión, abrir sesión existente (replay), flujo móvil completo.
// Run: cd ui/desktop && node scripts/goose-web-app-check.mjs [url]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] || 'http://192.168.100.34:3788/';
const shots = 'C:/goose-web/tools/shots';
mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const out = { url, desktop: {}, phone: {}, errors: [] };
const idle = (page) =>
  page.waitForFunction(() => { const s = document.querySelector('#btn-send'); return s && !s.hidden; }, null, { timeout: 160000 }).catch(() => {});

try {
  // ---------------- desktop ----------------
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => out.errors.push('pageerror: ' + String(e.message).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') out.errors.push('console: ' + m.text().slice(0, 300)); });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 45000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelectorAll('.sb-item').length > 0, null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(600);
  out.desktop.conn = await page.textContent('#conn-text').catch(() => null);
  out.desktop.sessions = await page.locator('.sb-item').count();
  await page.screenshot({ path: shots + '/v3-desktop-boot.png' });

  // chat nuevo descartable
  await page.click('#btn-new');
  await page.waitForTimeout(1500);
  out.desktop.chips = await page.locator('.chip').count();

  // enviar mensaje real
  await page.fill('#input', 'Responde exactamente con: OK-WEB');
  await page.click('#btn-send');
  await page.waitForFunction(() => [...document.querySelectorAll('.msg-a .content')].some((e) => (e.textContent || '').includes('OK-WEB')), null, { timeout: 150000 }).catch(() => {});
  out.desktop.sentUserBubble = await page.locator('.msg-user').count();
  out.desktop.reply = ((await page.locator('.msg-a .content').last().textContent().catch(() => '')) || '').slice(0, 90);
  out.desktop.metaRight = await page.textContent('#meta-right').catch(() => null);
  await page.waitForTimeout(900);
  await page.screenshot({ path: shots + '/v3-desktop-chat.png' });

  // chip modelo
  try {
    const modelChip = page.locator('.chip[title="Model"]');
    if (await modelChip.count()) {
      out.desktop.chipTextBefore = ((await modelChip.textContent().catch(() => null)) || '').slice(0, 60);
      await modelChip.click();
      await page.waitForTimeout(500);
      out.desktop.menuHit = await page.evaluate(() => {
        const menu = document.querySelector('.menu:not([hidden])');
        if (!menu) return 'no-menu';
        const r = menu.getBoundingClientRect();
        const el = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + 20));
        return el && menu.contains(el) ? 'ok' : 'clipped:' + (el ? el.className || el.tagName : 'none');
      });
      await page.screenshot({ path: shots + '/v3-desktop-menu.png' });
      const rows = page.locator('.menu:not([hidden]) .menu-row');
      const nRows = await rows.count();
      out.desktop.menuRows = nRows;
      for (let i = 0; i < Math.min(nRows, 10); i++) {
        const cls = (await rows.nth(i).getAttribute('class')) || '';
        if (!cls.includes('sel')) { await rows.nth(i).click(); out.desktop.chipSwitched = true; break; }
      }
      await page.waitForTimeout(1800);
      out.desktop.chipTextAfter = ((await modelChip.textContent().catch(() => null)) || '').slice(0, 60);
      out.desktop.sysnotes = await page.locator('.sysnote').count();
    }
  } catch (e) { out.desktop.chipError = String(e).slice(0, 220); }

  // herramienta (modo auto): tarjeta
  await page.fill('#input', 'Ejecutá exactamente este comando de shell y después respondé LISTO: echo TOOL-TEST-OK');
  await page.click('#btn-send');
  await page.waitForFunction(() => document.querySelectorAll('.tool').length > 0, null, { timeout: 160000 }).catch(() => {});
  out.desktop.toolCards = await page.locator('.tool').count();
  out.desktop.toolText = ((await page.locator('.tool').first().textContent().catch(() => '')) || '').slice(0, 120);
  await idle(page);
  await page.screenshot({ path: shots + '/v3-desktop-tools.png' });

  // permisos: modo approve + comando -> tarjeta de permiso con botones
  try {
    const modeChip = page.locator('.chip[title="Mode"]');
    if (await modeChip.count()) {
      await modeChip.click();
      await page.waitForTimeout(500);
      const rows = page.locator('.menu:not([hidden]) .menu-row');
      const n = await rows.count();
      for (let i = 0; i < n; i++) {
        const txt = ((await rows.nth(i).textContent()) || '').trim();
        if (txt === 'approve') { await rows.nth(i).click(); break; }
      }
      await page.waitForTimeout(1500);
      out.desktop.modeSet = ((await modeChip.textContent().catch(() => '')) || '').trim();
    }
    await page.fill('#input', 'Ejecutá exactamente este comando de shell y después respondé LISTO: echo PERM-WEB');
    await page.click('#btn-send');
    await page.waitForFunction(() => document.querySelectorAll('.perm').length > 0, null, { timeout: 100000 }).catch(() => {});
    if ((await page.locator('.perm').count()) === 0) {
      // segundo intento: algunos turnos el modelo evita la herramienta
      await idle(page);
      await page.fill('#input', 'Es obligatorio: usá la herramienta de shell para ejecutar echo PERM-WEB ahora.');
      await page.click('#btn-send');
      await page.waitForFunction(() => document.querySelectorAll('.perm').length > 0, null, { timeout: 100000 }).catch(() => {});
    }
    out.desktop.permCards = await page.locator('.perm').count();
    await page.screenshot({ path: shots + '/v3-desktop-perm.png' });
    const once = page.getByRole('button', { name: 'Permitir una vez', exact: true });
    if (await once.count()) { await once.click(); out.desktop.permClicked = true; }
    else {
      const first = page.locator('.perm .pb').first();
      if (await first.count()) { await first.click(); out.desktop.permClicked = 'fallback'; }
    }
    await idle(page);
    out.desktop.permAnswered = await page.locator('.perm.answered').count();
  } catch (e) { out.desktop.permError = String(e).slice(0, 220); }

  // renombrar la sesión de prueba desde la UI
  try {
    const activeRow2 = page.locator('.sb-row:has(.sb-item.active)').first();
    await activeRow2.locator('.sb-rename').click({ force: true });
    await page.waitForTimeout(300);
    await page.fill('.sb-edit', 'Prueba web renombrada');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    out.desktop.renamedTitle = await page.textContent('#chat-title').catch(() => null);
    out.desktop.renamedInList = ((await page.locator('.sb-item.active .sb-title').textContent().catch(() => null)) || '').trim();
    await page.screenshot({ path: shots + '/v3-desktop-renamed.png' });
  } catch (e) { out.desktop.renameError = String(e).slice(0, 220); }

  // adjuntar imagen (file input) y mandarla
  try {
    await page.setInputFiles('#file-input', 'C:/goose-web/tools/test-red.png');
    await page.waitForTimeout(900);
    out.desktop.attThumbs = await page.locator('.att-thumb').count();
    await page.screenshot({ path: shots + '/v3-desktop-attach.png' });
    await page.fill('#input', '¿De qué color es esta imagen? Responde una sola palabra.');
    await page.click('#btn-send');
    await idle(page);
    out.desktop.imgUserBubbleImgs = await page.locator('.msg-user img').count();
    out.desktop.imgReply = ((await page.locator('.msg-a .content').last().textContent().catch(() => '')) || '').slice(0, 80);
    await page.screenshot({ path: shots + '/v3-desktop-image.png' });
  } catch (e) { out.desktop.imgError = String(e).slice(0, 220); }

  // borrar la sesión de prueba (fila activa) con confirmación inline
  try {
    const activeRow = page.locator('.sb-row:has(.sb-item.active)').first();
    await activeRow.locator('.sb-del').click({ force: true });
    await page.waitForTimeout(400);
    out.desktop.confirmShown = await page.locator('.sb-confirm').count();
    await activeRow.locator('.sb-confirm .ym').click();
    await page.waitForTimeout(1800);
    out.desktop.activeAfterDelete = await page.locator('.sb-item.active').count();
    out.desktop.welcomeAfterDelete = await page.locator('#welcome').isVisible().catch(() => false);
    out.desktop.sysnoteAfterDelete = await page.locator('.sysnote').allTextContents().catch(() => []);
  } catch (e) { out.desktop.delError = String(e).slice(0, 220); }

  // abrir una sesión existente (replay de historial)
  try {
    const items = page.locator('.sb-item');
    const n = await items.count();
    for (let i = 0; i < Math.min(n, 6); i++) {
      const el = items.nth(i);
      const cls = (await el.getAttribute('class')) || '';
      if (!cls.includes('active')) { await el.click(); out.desktop.openedSessionIndex = i; break; }
    }
    await page.waitForTimeout(7000);
    out.desktop.msgsAfterLoad = await page.locator('.msg-inner > *').count();
    out.desktop.titleAfterLoad = await page.textContent('#chat-title').catch(() => null);
    await page.screenshot({ path: shots + '/v3-desktop-loaded-session.png' });
  } catch (e) { out.desktop.openError = String(e).slice(0, 220); }
  await ctx.close();

  // ---------------- phone ----------------
  const pctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/159.0.0.0 Mobile Safari/537.36',
  });
  const p = await pctx.newPage();
  p.on('pageerror', (e) => out.errors.push('phone pageerror: ' + String(e.message).slice(0, 200)));
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 45000 }).catch(() => {});
  await p.waitForFunction(() => document.querySelectorAll('.sb-item').length > 0, null, { timeout: 20000 }).catch(() => {});
  out.phone.conn = await p.textContent('#conn-text').catch(() => null);
  out.phone.composerVisible = await p.locator('.composer').isVisible().catch(() => false);
  await p.screenshot({ path: shots + '/v3-phone-boot.png' });

  // drawer -> abrir la última sesión -> verificar render
  await p.click('#btn-menu');
  await p.waitForTimeout(400);
  out.phone.drawerOpen = await p.locator('#sidebar.open').isVisible().catch(() => false);
  out.phone.sessionsInDrawer = await p.locator('.sb-item').count();
  await p.screenshot({ path: shots + '/v3-phone-drawer.png' });
  await p.locator('.sb-item').first().click();
  await p.waitForTimeout(7000);
  out.phone.openedTitle = await p.textContent('#chat-title').catch(() => null);
  out.phone.msgsOnPhone = await p.locator('.msg-inner > *').count();
  out.phone.drawerClosedAfterOpen = !(await p.locator('#sidebar.open').isVisible().catch(() => false));
  await p.screenshot({ path: shots + '/v3-phone-session.png' });
  await pctx.close();
} catch (e) {
  out.fatal = String(e && e.stack ? e.stack : e).slice(0, 900);
} finally {
  await browser.close();
}
console.log(JSON.stringify(out, null, 2));

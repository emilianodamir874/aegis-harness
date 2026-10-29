import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
const app = join(import.meta.dirname, '..', 'dist-ts', 'app');
const b = await chromium.launch();
let checks = 0;
const ok = (v, s) => { if (!v) throw new Error(s); checks++; };
try {
  for (const [w, h, mobile] of [[384, 832, true], [1440, 900, false]]) {
    const page = await (await b.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2.8125 : 1 })).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/*', (r) => {
      const u = new URL(r.request().url());
      if (u.hostname !== 'actions.invalid') return r.abort();
      if (u.pathname === '/config.js') return r.fulfill({ contentType: 'application/javascript', body: "window.__AEGIS_APP__={acpUrl:'ws://actions.invalid/acp',cwd:'/mock',host:'mock'};" });
      if (u.pathname === '/client-log') return r.fulfill({ status: 204, body: '' });
      const f = join(app, u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
      if (!existsSync(f)) return r.fulfill({ status: 404, body: 'no' });
      return r.fulfill({ path: f });
    });
    await page.goto('http://actions.invalid/', { waitUntil: 'load' });
    await page.waitForFunction(() => !!globalThis.__aegisWeb?.testUi);
    await page.evaluate(() => { const a = globalThis.__aegisWeb; a.state.current = { id: 'actions', title: 'acciones', cwd: '/mock', configOptions: [] }; });
    await page.evaluate(() => {
      const a = globalThis.__aegisWeb;
      a.state.current = { id: 'actions', title: 'acciones', cwd: '/mock', configOptions: [] };
      document.querySelector('#welcome')?.remove();
      document.querySelector('#welcome')?.remove();
      a.testUi.addUser('prompt corto para editar', false, []);
      a.testUi.update({ sessionId: 'actions', update: { sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: 'respuesta final con contenido suficiente para que copiar y escuchar funcionen.' } } });
    });
    await page.waitForFunction(() => !!document.querySelector('.msg-a .act-btn'));
    await page.waitForTimeout(300);
    const counts = await page.evaluate(() => ({
      msgActs: document.querySelectorAll('.msg-acts, .msg-act').length,
      users: document.querySelectorAll('.msg-user .act-btn').length,
      agents: document.querySelectorAll('.msg-a .act-btn').length,
      rewinds: document.querySelectorAll('.msg-user .rewind-btn').length,
    }));
    ok(counts.msgActs === 0, `${w}: quedaron acciones duplicadas ${JSON.stringify(counts)}`);
    ok(counts.users === 1 && counts.agents === 1, `${w}: faltan disparadores ${JSON.stringify(counts)}`);
    ok(counts.rewinds === 0, `${w}: prompt local sin messageId no debe rebobinar`);
    await page.locator('.msg-user .act-btn').click();
    await page.locator('body > .acts-menu').waitFor();
    const labels = await page.locator('body > .acts-menu .act-t').allTextContents();
    ok(labels.includes('Copiar') && labels.includes('Editar'), `${w}: menú de usuario ${labels.join('|')}`);
    await page.keyboard.press('Escape');
    await page.locator('.msg-a .act-btn').click();
    await page.locator('body > .acts-menu').waitFor();
    const agentLabels = await page.locator('body > .acts-menu .act-t').allTextContents();
    ok(agentLabels.includes('Copiar'), `${w}: menú de agente ${agentLabels.join('|')}`);
    await page.keyboard.press('Escape');
    const largo = 'prompt largo '.repeat(100);
    await page.evaluate((texto) => globalThis.__aegisWeb.testUi.addUser(texto, false, []), largo);
    await page.waitForFunction(() => document.querySelectorAll('.msg-user .act-btn').length >= 2);
    await page.locator('.msg-user').last().locator('.act-btn').click();
    await page.locator('body > .acts-menu').waitFor();
    const largoLabels = await page.locator('body > .acts-menu .act-t').allTextContents();
    ok(largoLabels.includes('Ver todo'), `${w}: menú largo ${largoLabels.join('|')}`);
    await page.keyboard.press('Escape');
    const visible = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.msg-user')].at(-1);
      return el ? { hasClass: el.classList.contains('msg-largo'), height: el.getBoundingClientRect().height, scroll: el.scrollHeight } : null;
    });
    ok(!!visible?.hasClass && visible.height <= visible.scroll + 1, `${w}: plegado inválido ${JSON.stringify(visible)}`);
    ok(errors.length === 0, `${w}: errores ${errors.join('|')}`);
    console.log(`${w}x${h}: PASS acciones unificadas`);
    await page.context().close();
  }
} finally { await b.close(); }
console.log(`PASS actions-check (${checks} comprobaciones)`);

// Prueba aislada del bundle compilado: menú, teclado, medidas y scroll, sin ACP ni prompts reales.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
const root = join(process.cwd(), 'dist-ts', 'app');
const origin = 'http://density-fixture.invalid';
const out = 'C:/Users/Emiliano/backups/ui-ux-density-20261028';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const rows = [];
function check(name, ok, detail = '') { rows.push({ name, ok: !!ok, detail }); }
try {
  for (const width of [320, 390, 1024, 1440, 1920]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 500, hasTouch: width < 500, serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.route('**/*', route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === '/config.js') return route.fulfill({ contentType: 'application/javascript', body: `window.__AEGIS_APP__={acpUrl:'ws://density-fixture.invalid/acp',cwd:'/mock'};` });
      if (path === '/prices.json') return route.fulfill({ json: {} });
      if (path === '/pending.json') return route.fulfill({ json: { sessions: [] } });
      if (path === '/goals.json') return route.fulfill({ json: { goals: [] } });
      if (path === '/client-log') return route.fulfill({ status: 204, body: '' });
      const name = path === '/' ? 'index.html' : path.slice(1);
      const type = name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.js') ? 'application/javascript' : 'text/html';
      try { return route.fulfill({ contentType: type, body: readFileSync(join(root, name)) }); }
      catch { return route.fulfill({ status: 404, body: 'not found' }); }
    });
    await page.routeWebSocket('ws://density-fixture.invalid/acp', ws => {
      ws.onMessage(raw => {
        const msg = JSON.parse(String(raw));
        if (!msg.id) return;
        const value = msg.method === 'initialize' ? { protocolVersion: 1 } : msg.method === 'session/list' ? { sessions: [], nextCursor: null, _meta: { runningSessionIds: [] } } : msg.method === 'tools/list' ? { tools: [] } : { sources: [] };
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: value }));
      });
    });
    await page.goto(origin + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__aegisWeb?.view?.setDensity && !!window.__aegisWeb?.rpc?.ready);
    // Prueba de lectura en medio de una conversación larga; fixture puramente visual.
    await page.evaluate(() => {
      const log = document.querySelector('#messages');
      const inner = document.createElement('div'); inner.id = 'msg-inner'; inner.className = 'msg-inner';
      for (let i = 0; i < 80; i++) {
        const div = document.createElement('div'); div.className = i % 2 ? 'msg-a' : 'msg-user';
        div.textContent = 'Bloque de prueba número ' + i + '. Texto largo suficiente para cambiar líneas y alturas con cada medida de lectura. '.repeat(2);
        inner.append(div);
      }
      log.append(inner);
      log.scrollTop = log.scrollHeight / 2;
    });
    const button = page.locator('#btn-density');
    await button.click();
    const opened = await page.evaluate(() => {
      const menu = document.querySelector('#density-pop'), r = menu.getBoundingClientRect();
      const v = window.visualViewport;
      return { open: !menu.hidden, count: menu.querySelectorAll('[role="menuitemradio"]').length, expanded: document.querySelector('#btn-density').getAttribute('aria-expanded'), rect: [r.left, r.right, r.top, r.bottom], viewport: [(v?.offsetLeft ?? 0), (v?.offsetLeft ?? 0) + (v?.width ?? innerWidth), (v?.offsetTop ?? 0), (v?.offsetTop ?? 0) + (v?.height ?? innerHeight)] };
    });
    check(`${width}: opciones y límites`, opened.open && opened.count === 3 && opened.expanded === 'true' && opened.rect[0] >= opened.viewport[0] && opened.rect[1] <= opened.viewport[1] + 1 && opened.rect[2] >= opened.viewport[2] && opened.rect[3] <= opened.viewport[3] + 1, JSON.stringify(opened));
    await page.screenshot({ path: `${out}/density-menu-${width}.png` });
    await page.keyboard.press('End');
    check(`${width}: End enfoca Lectura`, await page.evaluate(() => document.activeElement?.getAttribute('data-density') === 'lectura'));
    await page.keyboard.press('Enter');
    const selected = await page.evaluate(() => ({ density: document.querySelector('#messages').dataset.density,
      checked: [...document.querySelectorAll('#density-pop [aria-checked="true"]')].map(e => e.dataset.density),
      stored: localStorage.getItem('aegis.density'), closed: document.querySelector('#density-pop').hidden,
      focused: document.activeElement?.id }));
    check(`${width}: aplica y conserva`, selected.density === 'lectura' && selected.checked.join() === 'lectura' && selected.stored === 'lectura' && selected.closed && selected.focused === 'btn-density', JSON.stringify(selected));
    const scroll = await page.evaluate(() => {
      const log = document.querySelector('#messages');
      const anchor = [...log.querySelectorAll('#msg-inner > .msg-user, #msg-inner > .msg-a')].find(el => el.getBoundingClientRect().bottom > log.getBoundingClientRect().top + 8);
      const before = anchor.getBoundingClientRect().top;
      window.__aegisWeb.view.setDensity('compacta');
      const after = anchor.getBoundingClientRect().top;
      return { jump: after - before, scrollTop: log.scrollTop, atBottom: log.scrollHeight - log.scrollTop - log.clientHeight < 60, measure: parseFloat(getComputedStyle(document.querySelector('#msg-inner')).maxWidth) };
    });
    check(`${width}: mantiene ancla visual`, Math.abs(scroll.jump) < 3 && scroll.scrollTop > 0 && !scroll.atBottom && (width < 500 || scroll.measure === 900), JSON.stringify(scroll));
    await button.click();
    await page.keyboard.press('Escape');
    check(`${width}: Escape restaura foco`, await page.evaluate(() => document.querySelector('#density-pop').hidden && document.activeElement?.id === 'btn-density'));
    check(`${width}: sin excepciones`, errors.length === 0, errors.join(' | '));
    await context.close();
  }
} finally { await browser.close(); }
for (const r of rows) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name} ${r.detail}`);
console.log(`${rows.filter(r => r.ok).length}/${rows.length} ${rows.every(r => r.ok) ? 'PASS' : 'FAIL'}`);
process.exitCode = rows.every(r => r.ok) ? 0 : 1;

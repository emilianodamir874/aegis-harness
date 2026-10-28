// Fixture visual sin tráfico a Node/ACP: todos los recursos y el WebSocket se interceptan.
// SPLIT_BASELINE=1 node tools/split-layout-check.mjs imprime medidas previas sin exigir geometría.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const root = join(import.meta.dirname, '..', 'dist-ts', 'app');
const origin = 'http://split-fixture.invalid';
const out = 'C:/Users/Emiliano/backups/ui-ux-split-20261028';
const baseline = process.env.SPLIT_BASELINE === '1';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const results = [];
try {
  for (const width of [390, 900, 901, 1024, 1280, 1360, 1361, 1440, 1920]) for (const density of ['comoda', 'compacta', 'lectura']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [];
    page.on('request', req => { if (new URL(req.url()).hostname !== 'split-fixture.invalid') errors.push('red externa: ' + req.url()); });
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.route('**/*', route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/config.js') return route.fulfill({ contentType: 'application/javascript', body: "window.__AEGIS_APP__={acpUrl:'ws://split-fixture.invalid/acp',cwd:'/mock'};" });
      if (path === '/client-log') return route.fulfill({ status: 204, body: '' });
      if (path.endsWith('.json')) return route.fulfill({ json: {} });
      const name = path === '/' ? 'index.html' : path.slice(1);
      try { return route.fulfill({ contentType: name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'application/javascript' : 'text/html', body: readFileSync(join(root, name)) }); }
      catch { return route.fulfill({ status: 404, body: 'not found' }); }
    });
    await page.routeWebSocket('ws://split-fixture.invalid/acp', ws => ws.onMessage(raw => {
      const msg = JSON.parse(String(raw));
      if (!msg.id) return;
      const result = msg.method === 'initialize' ? { protocolVersion: 1 }
        : msg.method === 'session/list' ? { sessions: [{ sessionId: 'first', title: 'Principal' }, { sessionId: 'second', title: 'Comparación' }], nextCursor: null, _meta: { runningSessionIds: [] } }
        : msg.method === '_aegis/unstable/session/export' ? { data: '# Comparación\n\nTexto de la segunda sesión.\n\n```ts\nconst hola = 1;\n```' }
        : msg.method === 'tools/list' ? { tools: [] } : { sources: [] };
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    }));
    await page.goto(origin + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__aegisSplit?.open && !!window.__aegisWeb?.rpc?.ready);
    await page.evaluate(density => {
      document.querySelector('#welcome')?.remove();
      const log = document.querySelector('#messages');
      log.dataset.density = density;
      const inner = document.createElement('div'); inner.id = 'msg-inner'; inner.className = 'msg-inner';
      for (let i = 0; i < 40; i++) {
        const div = document.createElement('div'); div.className = i % 2 ? 'msg-a' : 'msg-user';
        if (i % 2) div.innerHTML = '<div class="content"><p>Explicación larga de la respuesta con suficiente texto para ocupar varios renglones y comparar la medida del transcript.</p><div class="tbl-wrap"><table data-cols="3"><thead><tr><th>Caso</th><th>Estado</th><th>Detalle</th></tr></thead><tbody><tr><td>Prueba</td><td>Correcto</td><td>El contenido debe permanecer accesible por scroll interno</td></tr></tbody></table></div><div class="code-wrap"><pre><code>function compareSessionLayout() { return "0123456789".repeat(8); }</code></pre></div></div>';
        else div.textContent = 'Mensaje de prueba número ' + i + ' con texto largo de la sesión principal.';
        inner.append(div);
      }
      log.append(inner);
      log.scrollTop = log.scrollHeight / 2;
    }, density);
    await page.evaluate(() => window.__aegisSplit.open());
    await page.waitForSelector('.aegis-split .body p');
    const metric = await page.evaluate(() => {
      const r = s => { const x = document.querySelector(s)?.getBoundingClientRect(); return x && { left: +x.left.toFixed(1), right: +x.right.toFixed(1), top: +x.top.toFixed(1), bottom: +x.bottom.toFixed(1), width: +x.width.toFixed(1) }; };
      const panel = r('.aegis-split'), main = r('.main'), topbar = r('.topbar'), actions = r('.topbar-actions'), title = r('#btn-chat-info'), transcript = r('#msg-inner'), content = r('.msg-a .content'), composer = r('.composer'), table = r('.tbl-wrap'), code = r('.msg-a pre');
      const over = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left);
      return { width: innerWidth, panel, main, topbar, actions, title, transcript, content, composer, table, code, panelTopbarOverlap: +over(panel, topbar).toFixed(1), panelActionsOverlap: +over(panel, actions).toFixed(1), panelTranscriptOverlap: +over(panel, transcript).toFixed(1), tableScroll: document.querySelector('.tbl-wrap').scrollWidth > document.querySelector('.tbl-wrap').clientWidth, codeScroll: document.querySelector('.msg-a pre').scrollWidth > document.querySelector('.msg-a pre').clientWidth, docOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    if (density === 'comoda') await page.screenshot({ path: `${out}/split-${baseline ? 'before' : 'after'}-${width}.png` });
    const sideBySide = width >= 1361;
    const ok = errors.length === 0 && !metric.docOverflow && (baseline || (sideBySide
      ? metric.panelTopbarOverlap <= 1 && metric.panelTranscriptOverlap <= 1 && metric.panelActionsOverlap <= 1 && metric.transcript.width >= 380 && metric.composer.width >= 380 && metric.title.width >= 120 && metric.table.width <= metric.content.width + 1 && metric.code.width <= metric.content.width + 1
      : metric.panel.left <= 1 && metric.panel.right >= width - 1 && metric.panel.top <= 1));
    results.push({ width, density, ok, errors, metric });
    await page.evaluate(() => window.__aegisSplit.close());
    const closed = await page.evaluate(() => !document.querySelector('.aegis-split') && !document.documentElement.classList.contains('aegis-split-open') && !document.body.style.getPropertyValue('--aegis-split-pad') && Math.abs(document.querySelector('.main').getBoundingClientRect().right - innerWidth) < 1);
    if (!closed) results.push({ width, density, ok: false, errors: ['close no restaura layout'] });
    await context.close();
  }
} finally { await browser.close(); }
for (const row of results) console.log(JSON.stringify(row));
console.log(`${results.filter(r => r.ok).length}/${results.length} ${results.every(r => r.ok) ? 'PASS' : 'FAIL'}${baseline ? ' (diagnóstico anterior)' : ''}`);
process.exitCode = results.every(r => r.ok) ? 0 : 1;

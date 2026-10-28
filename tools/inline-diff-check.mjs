// Browser gate aislado de ACP/Node. Usa el bundle real compilado y updates en dos sesiones falsas.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const root = join(import.meta.dirname, '..', 'dist-ts', 'app');
const origin = 'http://inline-diff-fixture.invalid';
const out = 'C:/Users/Emiliano/backups/ui-inline-diff-20261028';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
let checked = 0;
try {
  for (const width of [390, 1440]) {
    const ctx = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('request', req => { if (new URL(req.url()).hostname !== 'inline-diff-fixture.invalid') errors.push('red externa: ' + req.url()); });
    await page.route('**/*', route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/config.js') return route.fulfill({ contentType: 'application/javascript', body: "window.__AEGIS_APP__={acpUrl:'ws://inline-diff-fixture.invalid/acp',cwd:'/mock',host:'mock'};" });
      if (path === '/client-log') return route.fulfill({ status: 204, body: '' });
      if (path.endsWith('.json')) return route.fulfill({ json: {} });
      try { const name = path === '/' ? 'index.html' : path.slice(1); return route.fulfill({ contentType: name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'application/javascript' : 'text/html', body: readFileSync(join(root, name)) }); }
      catch { return route.fulfill({ status: 404, body: 'not found' }); }
    });
    await page.routeWebSocket('ws://inline-diff-fixture.invalid/acp', ws => ws.onMessage(raw => {
      const msg = JSON.parse(String(raw));
      if (msg.id === undefined) return;
      const result = msg.method === 'initialize' ? { protocolVersion: 1 }
        : msg.method === 'session/list' ? { sessions: [], nextCursor: null, _meta: { runningSessionIds: [] } }
        : { sources: [] };
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    }));
    await page.goto(origin, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__aegisWeb?.rpc?.ready);
    const measure = await page.evaluate(() => {
      const app = window.__aegisWeb;
      app.state.current = { id: 'chat-one', title: 'Chat prueba', cwd: '/mock', configOptions: [] };
      document.querySelector('#welcome')?.remove();
      const id = 'tool-42';
      const update = event => app.testUi.update({ sessionId: 'chat-one', update: { sessionUpdate: 'tool_call_update', toolCallId: id, ...event } });
      update({ status: 'in_progress', title: 'Edición', rawInput: { path: 'src/code.ts', before: 'antes', after: 'después' }, _meta: { aegis: { toolCall: { toolName: 'developer__edit' } } } });
      update({ content: [{ type: 'diff', path: 'src/code.ts', oldText: 'const x = 1;\n', newText: 'const x = 2;\n' }] });
      update({ status: 'completed' });
      const card = app.state.tools.get(id), details = card.querySelector('.tool-diff');
      details.open = true;
      const code = details.querySelector('pre');
      const before = { label: details.querySelector('summary')?.innerText, removed: code.querySelector('.del')?.innerText, added: code.querySelector('.add')?.innerText,
        overlap: code.getBoundingClientRect().right - innerWidth, count: card.querySelectorAll('.tool-diff').length };
      update({ content: [{ type: 'diff', path: 'src/code.ts', oldText: 'const x = 1;\n', newText: 'const x = 2;\n' }] });
      app.testUi.update({ sessionId: 'another', update: { sessionUpdate: 'tool_call', toolCallId: id, content: [{ type: 'diff', path: 'intruso', newText: 'evil' }] } });
      return { ...before, afterCount: card.querySelectorAll('.tool-diff').length, intruder: card.textContent.includes('intruso') };
    });
    await page.screenshot({ path: `${out}/inline-${width}.png` });
    if (errors.length || measure.label?.replace(/\s+/g, '') !== 'src/code.ts+1−1' || measure.removed !== '-const x = 1;' || measure.added !== '+const x = 2;'
      || measure.overlap > 1 || measure.count !== 1 || measure.afterCount !== 1 || measure.intruder) throw Error(JSON.stringify({ width, measure, errors }));
    checked++;
    console.log(`${width}: inline ACP diff, expansion, dedupe, aislamiento, sin desborde PASS`);
    await ctx.close();
  }
} finally { await browser.close(); }
console.log(`${checked}/2 PASS`);

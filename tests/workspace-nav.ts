// Navegación de trabajo contra HTML/CSS y módulos compilados de dist-ts, sin web ni ACP reales.
// Desde web/: npx esbuild tests/workspace-nav.ts --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.cache/workspace-nav.mjs && node node_modules/.cache/workspace-nav.mjs
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type WebSocketRoute } from 'playwright';

const root = resolve(process.cwd(), 'dist-ts', 'app');
const host = 'workspace-nav.invalid';
const origin = `http://${host}`;
const modules = ['app.js', 'skills.js', 'memory.js', 'artifacts.js', 'workspace-nav.js', 'context-meter.js', 'session-mode.js', 'palette.js', 'onboarding.js', 'handoff.js', 'split-view.js', 'stats.js'];
const assets = new Map<string, { body: string; contentType: string }>();
for (const name of ['index.html', 'app.css', ...modules]) {
  assets.set('/' + name, { body: await readFile(resolve(root, name), 'utf8'), contentType: name.endsWith('.css') ? 'text/css' : name.endsWith('.html') ? 'text/html' : 'application/javascript' });
}
const fixtureFile = { name: 'fixture.txt', bytes: 13, mtime: '2026-01-01T00:00:00Z', ext: '.txt', url: '/dl/fixture.txt' };
const fail = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
const browser = await chromium.launch({ headless: true });
try {
  for (const { width, height } of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      const errors: string[] = [];
      const calls: string[] = [];
      page.on('pageerror', error => errors.push('pageerror: ' + error.message));
      page.on('console', msg => { if (msg.type() === 'error') errors.push('console: ' + msg.text()); });
      page.on('requestfailed', request => errors.push('requestfailed: ' + request.url()));
      await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.host !== host) { errors.push('red externa: ' + url.href); return route.abort(); }
        const path = url.pathname === '/' ? '/index.html' : url.pathname;
        calls.push(request.method() + ' ' + path);
        if (request.method() === 'GET' && path === '/config.js') return route.fulfill({ status: 200, contentType: 'application/javascript', body: `window.__AEGIS_APP__={acpUrl:'ws://${host}/acp',cwd:'/mock',host:'mock'};` });
        const asset = assets.get(path);
        if (request.method() === 'GET' && asset) return route.fulfill({ status: 200, ...asset });
        if (request.method() === 'GET' && path === '/outbox.json') return route.fulfill({ status: 200, json: url.searchParams.has('preview') ? { name: fixtureFile.name, ext: '.txt', text: 'fixture local' } : { dir: 'outbox fixture', items: [fixtureFile] } });
        if (request.method() === 'GET' && path === '/memory.json') return route.fulfill({ status: 200, json: { facts: [{ id: 'F-local', text: 'Solo fixture', status: 'confirmed', kind: 'fact' }] } });
        if (request.method() === 'GET' && ['/skills.json', '/stats.json', '/goals.json', '/search.json', '/ws/defaults', '/pending.json', '/prices.json'].includes(path)) return route.fulfill({ status: 200, json: path === '/skills.json' ? { skills: [] } : path === '/stats.json' ? { stats: {} } : path === '/search.json' ? { results: [] } : {} });
        if (request.method() === 'POST' && path === '/client-log') return route.fulfill({ status: 204, body: '' });
        errors.push('petición no simulada: ' + request.method() + ' ' + path);
        return route.fulfill({ status: 404, body: 'fixture: petición no simulada' });
      });
      await page.routeWebSocket(`ws://${host}/acp`, (ws: WebSocketRoute) => {
        ws.onMessage(raw => {
          const m = JSON.parse(String(raw));
          if (m.id === undefined) return;
          calls.push('ACP ' + m.method);
          const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
          switch (m.method) {
            case 'initialize': reply({ protocolVersion: 1 }); break;
            case 'session/list': reply({ sessions: [], nextCursor: null, _meta: { runningSessionIds: [] } }); break;
            case 'tools/list': reply({ tools: [] }); break;
            case '_aegis/unstable/sources/list': reply({ sources: [] }); break;
            default: errors.push('ACP inesperado: ' + m.method); ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'fixture: método prohibido' } }));
          }
        });
      });
      await page.goto(origin + '/', { waitUntil: 'load' });
      await page.waitForFunction(() => !!(window as any).__aegisMemory?.open && !!(window as any).__aegisArtifacts?.open && !!(window as any).__aegisWeb?.state);
      // El contenido local representa el transcript, no una respuesta ni una sesión inventada del ACP.
      await page.evaluate(() => {
        const log = document.getElementById('messages')!;
        const transcript = document.createElement('div');
        transcript.id = 'fixture-transcript';
        for (let i = 0; i < 65; i++) {
          const step = document.createElement('div');
          step.textContent = `Entrada local ${i}`;
          step.style.padding = '12px';
          transcript.append(step);
        }
        log.append(transcript);
        log.scrollTop = 0;
      });
      const mobile = width < 881;
      const openNav = async () => {
        if (mobile) {
          await page.locator('#btn-menu').click();
          await page.waitForFunction(() => document.getElementById('sidebar')!.classList.contains('open'));
          const g = await page.evaluate(() => {
            const sidebar = document.getElementById('sidebar')!;
            const r = sidebar.getBoundingClientRect();
            const v = window.visualViewport;
            return { top: r.top, bottom: r.bottom, width: r.width, vTop: v?.offsetTop ?? 0, vBottom: (v?.offsetTop ?? 0) + (v?.height ?? innerHeight), scrollWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth, listScroll: sidebar.querySelector('.sb-list')?.scrollHeight };
          });
          fail(Math.abs(g.top - g.vTop) <= 2 && Math.abs(g.bottom - g.vBottom) <= 2, `cajón no cubre viewport visual: ${JSON.stringify(g)}`);
          fail(g.width > 200 && g.width <= width && g.scrollWidth <= g.viewportWidth + 1, `desborde horizontal: ${JSON.stringify(g)}`);
          for (const id of ['btn-activity', 'btn-files', 'btn-memory']) fail(await page.locator('#' + id).isVisible(), `${id} no visible en cajón`);
        }
      };
      await openNav();
      await page.locator('#btn-files').click();
      await page.locator('.aegis-art[role="dialog"]').waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.querySelector('.aegis-art .item .name')?.textContent === 'fixture.txt');
      fail(calls.includes('GET /outbox.json'), 'Archivos no consultó el outbox del fixture');
      if (mobile) fail(!await page.locator('#sidebar').evaluate(el => el.classList.contains('open')), 'Archivos dejó el cajón abierto');
      await page.locator('.aegis-art header button:last-of-type').click();
      await openNav();
      await page.locator('#btn-memory').click();
      await page.locator('.aegis-mem[role="dialog"]').waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.querySelector('.aegis-mem')?.textContent?.includes('Solo fixture'));
      fail(calls.includes('GET /memory.json'), 'Memoria no consultó memoria del fixture');
      if (mobile) fail(!await page.locator('#sidebar').evaluate(el => el.classList.contains('open')), 'Memoria dejó el cajón abierto');
      await page.evaluate(() => (window as any).__aegisMemory.close());
      await openNav();
      await page.locator('#btn-activity').click();
      await page.waitForFunction(() => document.activeElement?.id === 'messages' && document.getElementById('messages')!.scrollTop > 0);
      fail(await page.locator('#fixture-transcript').count() === 1, 'Actividad modificó o sustituyó el transcript');
      fail(await page.locator('.aegis-art-backdrop:visible, .aegis-mem-backdrop:visible').count() === 0, 'Actividad abrió panel en lugar del transcript');
      if (mobile) fail(!await page.locator('#sidebar').evaluate(el => el.classList.contains('open')), 'Actividad dejó el cajón abierto');
      fail(!calls.some(call => /session\/(new|prompt|load)/.test(call)), `sesión o prompt inesperado: ${calls.join(', ')}`);
      fail(errors.length === 0, `${width}x${height}: ${errors.join(' | ')}`);
      console.log(`PASS workspace-nav ${width}x${height}: paneles reales, transcript, viewport, cero errores; fixture local`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }

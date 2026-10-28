// Navegación de trabajo contra HTML/CSS y módulos compilados de dist-ts, sin web ni ACP reales.
// Desde web/: npx esbuild tests/workspace-nav.ts --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.cache/workspace-nav.mjs && node node_modules/.cache/workspace-nav.mjs
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type WebSocketRoute } from 'playwright';

const root = resolve(process.cwd(), 'dist-ts', 'app');
const host = 'workspace-nav.invalid';
const origin = `http://${host}`;
const html = await readFile(resolve(root, 'index.html'), 'utf8');
const modules = [...html.matchAll(/<script\b[^>]*\bsrc=["']\.\/([^"']+\.js)["']/g)].map(m => m[1]).filter(name => name !== 'config.js');
const assets = new Map<string, { body: string; contentType: string }>();
for (const name of ['app.css', 'icon.svg', 'manifest.json', ...modules]) {
  assets.set('/' + name, { body: await readFile(resolve(root, name), 'utf8'), contentType: name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.json') ? 'application/json' : 'application/javascript' });
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
        if (request.method() === 'GET' && path === '/index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
        if (request.method() === 'GET' && path === '/config.js') return route.fulfill({ status: 200, contentType: 'application/javascript', body: `window.__AEGIS_APP__={acpUrl:'ws://${host}/acp',cwd:'/mock',host:'mock'};` });
        const asset = assets.get(path);
        if (request.method() === 'GET' && asset) return route.fulfill({ status: 200, ...asset });
        if (request.method() === 'GET' && path === '/outbox.json') return route.fulfill({ status: 200, json: url.searchParams.has('preview') ? { name: fixtureFile.name, ext: '.txt', text: 'fixture local' } : { dir: 'outbox fixture', items: [fixtureFile] } });
        if (request.method() === 'GET' && path === '/memory.json') return route.fulfill({ status: 200, json: { facts: [{ id: 'F-local', text: 'Solo fixture', status: 'confirmed', kind: 'fact' }] } });
        if (request.method() === 'GET' && path === '/pending.json') return route.fulfill({ status: 200, json: { sessions: [] } });
        if (request.method() === 'GET' && ['/skills.json', '/stats.json', '/goals.json', '/search.json', '/ws/defaults', '/prices.json'].includes(path)) return route.fulfill({ status: 200, json: path === '/skills.json' ? { skills: [] } : path === '/stats.json' ? { stats: {} } : path === '/search.json' ? { results: [] } : {} });
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
      await page.locator('.aegis-activity[role="dialog"]').waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.querySelector('.aegis-activity main')?.textContent?.includes('Ninguna confirmación sin respuesta registrada.'));
      fail(await page.locator('#fixture-transcript').count() === 1, 'Actividad modificó o sustituyó el transcript');
      fail(await page.locator('.aegis-art-backdrop:visible, .aegis-mem-backdrop:visible').count() === 0, 'Actividad abrió un panel no solicitado');
      if (mobile) fail(!await page.locator('#sidebar').evaluate(el => el.classList.contains('open')), 'Actividad dejó el cajón abierto');
      // El selector solo en móvil y debajo del compositor, con targets alcanzables.
      if (mobile) {
        await page.locator('.aegis-activity header button:last-of-type').click();
        await page.evaluate(() => { document.getElementById('messages')!.scrollTop = 180; });
        const layout = async () => page.evaluate(() => {
          const rect = (id: string) => document.getElementById(id)!.getBoundingClientRect();
          const bar = rect('workspace-switch'), composer = document.querySelector('.composer-wrap')!.getBoundingClientRect();
          const log = rect('messages'), viewport = window.visualViewport;
          return { top: bar.top, bottom: bar.bottom, composerBottom: composer.bottom, logBottom: log.bottom,
            viewportBottom: (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight),
            widths: ['view-chat', 'view-activity', 'view-files'].map(id => { const r = rect(id); return [r.width, r.height]; }),
            scroll: document.getElementById('messages')!.scrollTop,
          };
        });
        const initial = await layout();
        fail(initial.top >= initial.composerBottom - 1 && initial.logBottom <= initial.composerBottom + 1, `selector tapa compositor/transcript: ${JSON.stringify(initial)}`);
        fail(initial.widths.every(([w, h]) => w >= 44 && h >= 44), `targets pequeños: ${JSON.stringify(initial.widths)}`);
        fail(Math.abs(initial.bottom - initial.viewportBottom) <= 2, `selector no termina en viewport visual: ${JSON.stringify(initial)}`);
        await page.locator('#view-files').click();
        await page.locator('.aegis-art[role="dialog"]').waitFor({ state: 'visible' });
        await page.locator('#view-activity').click();
        await page.locator('.aegis-activity[role="dialog"]').waitFor({ state: 'visible' });
        fail(await page.locator('.aegis-art-backdrop:visible').count() === 0, 'Archivos no se cerró al alternar a Actividad');
        await page.locator('#view-chat').click();
        fail(await page.locator('.aegis-activity[role="dialog"]').count() === 0, 'Chat no cerró actividad');
        fail(await page.locator('#view-chat').getAttribute('aria-current') === 'page', 'Chat no figura seleccionado');
        await page.locator('#view-chat').focus();
        const focus = await page.locator('#view-chat').evaluate(el => ({ active: document.activeElement === el, rect: el.getBoundingClientRect().toJSON() }));
        fail(focus.active && focus.rect.top >= 0 && focus.rect.bottom <= height + 1, `foco no visible al volver a chat: ${JSON.stringify(focus)}`);
        fail(await page.locator('#fixture-transcript').count() === 1, 'Selector reemplazó transcript');
        const restored = await layout();
        fail(restored.scroll === initial.scroll, `se perdió scroll del chat: ${initial.scroll} -> ${restored.scroll}`);
        // Simular teclado con un visualViewport más bajo sin cambiar el layout viewport.
        await page.evaluate(() => {
          const fake = new EventTarget() as EventTarget & { height: number; offsetTop: number };
          fake.height = 510; fake.offsetTop = 0;
          Object.defineProperty(window, 'visualViewport', { configurable: true, value: fake });
          window.dispatchEvent(new Event('resize'));
        });
        const keyboard = await layout();
        fail(Math.abs(keyboard.bottom - 510) <= 2 && keyboard.top >= keyboard.composerBottom - 1, `selector/teclado no acotados: ${JSON.stringify(keyboard)}`);
        fail(keyboard.scroll === initial.scroll, 'teclado perdió scroll de transcript');
      } else {
        fail(!await page.locator('#workspace-switch').isVisible(), 'selector móvil visible en escritorio');
      }
      fail(!calls.some(call => /session\/(new|prompt|load)/.test(call)), `sesión o prompt inesperado: ${calls.join(', ')}`);
      fail(errors.length === 0, `${width}x${height}: ${errors.join(' | ')}`);
      console.log(`PASS workspace-nav ${width}x${height}: paneles reales, transcript, viewport, cero errores; fixture local`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }

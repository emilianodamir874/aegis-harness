// Postdeploy read-only gate. No credentials, prompts, fixtures or screenshots are created.
// Usage: node tools/verify-web-deploy.mjs [http://127.0.0.1:3788/]
// The on-disk bundle check is NOT proof of the JS already loaded into a Node process;
// the /changes.json anonymous-401 contract is an independent behavioral fingerprint.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const rows = [];
const gate = (name, ok, detail = '') => rows.push({ name, ok: !!ok, detail });
const errorKind = error => error?.name === 'TimeoutError' ? 'timeout' : 'request/parse failed';
let base;
try {
  base = new URL(process.argv[2] || 'http://127.0.0.1:3788/');
  if (process.argv.length > 3 || base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
    || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw Error('URL inválida');
} catch {
  console.error('Uso: node tools/verify-web-deploy.mjs [http://127.0.0.1:<puerto>/] (solo loopback, sin credenciales)');
  process.exit(2);
}
const url = path => new URL(path, base).href;
const timeout = 12000;
async function get(path, opts = {}) {
  // Fetch decodes Content-Encoding automatically; arrayBuffer() is the DECOMPRESSED body.
  const res = await fetch(url(path), { signal: AbortSignal.timeout(timeout), redirect: 'manual', cache: 'no-store', ...opts });
  return { res, bytes: Buffer.from(await res.arrayBuffer()) };
}
function psOwner(port = Number(base.port || 80), expectNode = true) {
  if (process.platform !== 'win32') return { ok: false, detail: 'identidad de puerto no implementada fuera de Windows' };
  // Only read the TCP owner and its executable/command; do not expose the command line (may contain secrets).
  const script = `$ErrorActionPreference='Stop'; $ids=@(Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -ExpandProperty OwningProcess -Unique); if($ids.Count -ne 1){throw 'ambiguous owner'}; $p=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $ids[0]); if(!$p){throw 'owner missing'}; [pscustomobject]@{pid=[int]$p.ProcessId; exe=[string]$p.ExecutablePath; cmd=[string]$p.CommandLine; started=[string]$p.CreationDate} | ConvertTo-Json -Compress`;
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 8192 });
  if (run.status !== 0 || run.error) return { ok: false, detail: 'no se pudo determinar dueño del puerto' };
  try {
    const p = JSON.parse(run.stdout.trim());
    const node = /^node(?:\.exe)?$/i.test(basename(p.exe || ''));
    // Match a script argument, not a substring of some unrelated filename.
    const scriptArg = /(?:^|\s)["']?(?:[^\s"']*[\\/])?server\.mjs(?:["']|\s|$)/i.test(p.cmd || '');
    const ok = (expectNode ? node && scriptArg : !node) && Number.isInteger(p.pid) && p.pid > 0;
    return { ok, detail: ok ? `PID ${p.pid} · ${expectNode ? 'node server.mjs' : 'backend'}` : 'dueño inesperado', pid: p.pid, started: p.started };
  } catch { return { ok: false, detail: 'respuesta de identidad inválida' }; }
}

try {
  const owner = psOwner();
  gate('dueño TCP', owner.ok, owner.detail);
  let bundleOK = false;
  try {
    const [published, built] = await Promise.all([readFile(join(root, 'server.mjs')), readFile(join(root, 'dist-ts/server.mjs'))]);
    bundleOK = sha(published) === sha(built);
    gate('bundle en disco', bundleOK, bundleOK ? `SHA256 ${sha(published).slice(0, 12)}… = dist-ts` : 'server.mjs difiere de dist-ts/server.mjs');
  } catch { gate('bundle en disco', false, 'falta server.mjs o dist-ts/server.mjs'); }
  let backendOwner;
  try {
    const { res, bytes } = await get('/healthz?backend=1');
    const health = JSON.parse(bytes.toString('utf8'));
    const ok = res.status === 200 && health?.ok === true && health?.processReady === true && health?.backendTcpReady === true;
    gate('readiness', ok, `HTTP ${res.status} · ok=${health?.ok === true} process=${health?.processReady === true} backend=${health?.backendTcpReady === true}`);
    const backendUrl = new URL(health.backend);
    if (backendUrl.hostname !== '127.0.0.1' || !Number(backendUrl.port)) throw Error('backend address invalid');
    backendOwner = { ...psOwner(Number(backendUrl.port), false), port: Number(backendUrl.port) };
    gate('dueño backend', backendOwner.ok, backendOwner.detail);
  } catch (e) { gate('readiness/identidad backend', false, errorKind(e)); }
  try {
    const { res } = await get('/changes.json'); // Anonymous; 401 before cwd validation is distinctive. No diff is retrieved.
    gate('contrato Node', res.status === 401 && /application\/json/i.test(res.headers.get('content-type') || ''),
      `GET /changes.json anónimo: HTTP ${res.status} (esperado 401 JSON)`);
  } catch (e) { gate('contrato Node', false, errorKind(e)); }

  let html = '';
  try {
    const { res, bytes } = await get('/', { headers: { 'Accept-Encoding': 'gzip' } });
    html = bytes.toString('utf8');
    gate('HTML gzip', res.status === 200 && /<html\b/i.test(html) && /<script\b/i.test(html)
      && /\bgzip\b/i.test(res.headers.get('content-encoding') || ''),
    `HTTP ${res.status} · gzip=${/\bgzip\b/i.test(res.headers.get('content-encoding') || '')} · decodificado=${bytes.length} B`);
  } catch (e) { gate('HTML gzip', false, errorKind(e)); }
  if (html) {
    const refs = [...html.matchAll(/<(script|link)\b[^>]*?\b(?:src|href)\s*=\s*(["'])(.*?)\2[^>]*>/gi)]
      .map(m => m[3]).filter(ref => /\.\b(?:js|css)(?:\?|$)/i.test(ref));
    const unique = [...new Set(refs)];
    gate('referencias HTML', unique.some(x => /^\.\/app\.js\?v=[a-f0-9]{64}$/.test(x))
      && unique.some(x => /^\.\/workspace-nav\.js\?v=[a-f0-9]{64}$/.test(x))
      && unique.some(x => /^\.\/activity\.js\?v=[a-f0-9]{64}$/.test(x))
      && unique.some(x => /^\.\/changes\.js\?v=[a-f0-9]{64}$/.test(x)),
    `${unique.length} JS/CSS · módulos críticos versionados`);
    let passed = 0;
    const bad = [];
    for (const ref of unique) {
      try {
        const target = new URL(ref, base);
        if (target.origin !== base.origin || !/^\/[a-z\d-]+\.(?:js|css)$/i.test(target.pathname)) {
          bad.push('referencia no local o no esperada'); continue;
        }
        const name = target.pathname.slice(1);
        if (name === 'config.js') { // Dynamic: do not even read its token-bearing response body.
          const response = await fetch(target.href, { signal: AbortSignal.timeout(timeout), redirect: 'manual', cache: 'no-store' });
          await response.body?.cancel();
          if (response.status !== 200) bad.push('config.js: HTTP no es 200');
          else passed++;
          continue;
        }
        const { res, bytes } = await get(target.pathname + target.search, { headers: { 'Accept-Encoding': 'gzip' } });
        if (res.status !== 200 || !/\bgzip\b/i.test(res.headers.get('content-encoding') || '')) {
          bad.push(`${name}: HTTP ${res.status} o sin gzip`); continue;
        }
        const disk = await readFile(join(root, 'app', name));
        const hash = sha(disk);
        if (sha(bytes) !== hash || target.searchParams.get('v') !== hash || [...target.searchParams].length !== 1) {
          bad.push(`${name}: SHA256 servido/disco/?v distinto`); continue;
        }
        passed++;
      } catch { bad.push('asset: no disponible o error de decodificación'); }
    }
    gate('assets gzip + SHA256', unique.length > 0 && bad.length === 0,
      `${passed}/${unique.length} verificados` + (bad.length ? ` · ${bad.slice(0, 4).join('; ')}` : ''));
  } else gate('assets gzip + SHA256', false, 'HTML no disponible');

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const [label, viewport] of [['escritorio', { width: 1440, height: 900 }], ['móvil', { width: 390, height: 844 }]]) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, serviceWorkers: 'block' });
      const page = await context.newPage();
      const errors = { console: 0, page: 0, http: 0, request: 0 };
      let wsSeen = false, wsConnected = false;
      page.on('console', m => { if (m.type() === 'error') errors.console++; });
      page.on('pageerror', () => errors.page++);
      page.on('response', r => { if (r.status() === 404 && new URL(r.url()).origin === base.origin) errors.http++; });
      page.on('requestfailed', r => { if (new URL(r.url()).origin === base.origin) errors.request++; });
      page.on('websocket', ws => { wsSeen = true; ws.on('framereceived', () => { wsConnected = true; }); });
      try {
        const main = await page.goto(base.href, { waitUntil: 'domcontentloaded', timeout });
        await page.waitForFunction(() => !!window.__aegisWeb?.state, null, { timeout });
        // Wait for an ACP reply, not just a socket in CONNECTING state.
        await page.waitForFunction(() => window.__aegisWeb?.rpc?.ready === true, null, { timeout: 10000 }).catch(() => {});
        const initial = await page.evaluate(() => ({ ready: window.__aegisWeb?.rpc?.ready === true,
          noSession: !window.__aegisWeb?.state?.current, controls: ['btn-activity', 'btn-changes', 'input'].every(id => !!document.getElementById(id)),
          visible: !!document.getElementById('welcome')?.getBoundingClientRect().width }));
        // A fresh browser context must not navigate/open a session or send any prompt.
        if (viewport.width < 500) await page.locator('#btn-menu').click();
        await page.locator('#btn-activity').click();
        await page.locator('.aegis-activity').waitFor({ timeout: 8000 });
        await page.waitForFunction(() => {
          const dialog = document.querySelector('.aegis-activity');
          return dialog && (/páginas agotadas|lista incompleta/.test(dialog.querySelector('.note')?.textContent || '')
            || /No se pudieron consultar sesiones/.test(dialog.querySelector('main')?.textContent || ''));
        }, null, { timeout: 12000 });
        const activity = await page.locator('.aegis-activity main').innerText();
        const activityNoFake = !/No se pudieron consultar sesiones/.test(activity)
          && !/No se pudo consultar \/pending\.json/.test(activity)
          && !/Formato de confirmaciones no disponible/.test(activity);
        await page.locator('.aegis-activity button').filter({ hasText: 'Cerrar' }).click();
        if (viewport.width < 500) await page.locator('#btn-menu').click();
        await page.locator('#btn-changes').click();
        await page.locator('.aegis-changes').waitFor({ timeout: 8000 });
        const changes = await page.locator('.aegis-changes').innerText();
        const changesOk = /Sin sesión activa · no se consultó Git/.test(changes) && /Abrí una conversación/.test(changes)
          && !/Git no informa cambios locales/.test(changes) && !/Panel no disponible/.test(changes);
        const ok = main?.status() === 200 && initial.controls && initial.visible && initial.noSession && initial.ready
          && wsSeen && wsConnected && activityNoFake && changesOk && Object.values(errors).every(n => n === 0);
        gate(`Chromium ${label}`, ok, `DOM=${initial.visible} sinSesión=${initial.noSession} ACP=${initial.ready && wsConnected ? 'conectado' : wsSeen ? 'socket sin respuesta' : 'sin socket'} actividad=${activityNoFake} cambios=${changesOk} errores=${JSON.stringify(errors)}`);
      } catch (e) { gate(`Chromium ${label}`, false, `${errorKind(e)} · ACP=${wsConnected ? 'conectado' : wsSeen ? 'socket sin respuesta' : 'sin socket'} · errores=${JSON.stringify(errors)}`); }
      finally { await context.close(); }
    }
  } catch { gate('Chromium', false, 'no se pudo iniciar Chromium/Playwright'); }
  finally { await browser?.close(); }
  const after = psOwner();
  gate('dueño TCP estable', owner.ok && after.ok && owner.pid === after.pid && owner.started === after.started,
    after.ok ? `PID ${after.pid} ${owner.pid === after.pid && owner.started === after.started ? 'estable' : 'cambió durante la verificación'}` : after.detail);
  if (backendOwner?.ok) {
    const backendAfter = psOwner(backendOwner.port, false);
    gate('backend estable', backendAfter.ok && backendOwner.pid === backendAfter.pid && backendOwner.started === backendAfter.started,
      backendAfter.ok ? `PID ${backendAfter.pid}` : backendAfter.detail);
  }
} catch { gate('verificador', false, 'fallo inesperado (sin imprimir datos de usuario)'); }
console.log('Gate                     Estado  Detalle');
for (const r of rows) console.log(`${r.name.padEnd(24)} ${r.ok ? 'OK   ' : 'FALLA'}   ${r.detail}`);
console.log('Identidad JS en memoria: no demostrable por hash desde HTTP; contrato /changes.json + dueño TCP son evidencia conductual, no prueba criptográfica.');
process.exitCode = rows.every(r => r.ok) ? 0 : 1;

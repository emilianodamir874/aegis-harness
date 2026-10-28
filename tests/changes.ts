/* Prueba aislada: Git se ejecuta solo en un repo temporal bajo os.tmpdir().
 * No consulta el repo ni el store de Aegis. No modifica scripts de runtime.
 * Correr: node --experimental-strip-types tests/changes.ts
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const temp = await mkdtemp(join(tmpdir(), 'aegis-changes-test-'));
const fixture = join(temp, 'repo');
const script = join(temp, 'changes-index.mjs');
function git(...args: string[]): void {
  execFileSync('git', ['-C', fixture, ...args], { timeout: 5000, stdio: 'pipe' });
}
async function run(cwd = fixture): Promise<any> {
  const stdout = execFileSync(process.execPath, [script, '--cwd', cwd], {
    encoding: 'utf8', timeout: 8000, maxBuffer: 256 * 1024,
  });
  return JSON.parse(stdout);
}
try {
  await mkdir(fixture);
  git('init', '-q');
  await writeFile(join(fixture, 'normal.txt'), 'primera\n');
  await writeFile(join(fixture, 'staged.txt'), 'original\n');
  await writeFile(join(fixture, 'private.txt'), 'seguro\n');
  await writeFile(join(fixture, '.env'), 'PASSWORD=valor-sensible\n');
  git('add', 'normal.txt', 'staged.txt', 'private.txt', '.env');
  git('-c', 'user.email=fixture@invalid.test', '-c', 'user.name=Fixture', 'commit', '-qm', 'fixture');
  await writeFile(join(fixture, 'normal.txt'), 'primera\nsegunda\n');
  await writeFile(join(fixture, 'staged.txt'), 'original\ncambio staged\n');
  git('add', 'staged.txt');
  await writeFile(join(fixture, 'private.txt'), 'seguro\npassword=valor-sensible\n');
  await writeFile(join(fixture, '.env'), 'PASSWORD=otro-secreto\n');
  await writeFile(join(fixture, 'espacio en nombre.txt'), 'sin contenido mostrado\n');
  await writeFile(join(fixture, 'extra.txt'), 'archivo sin trackear\n');
  await writeFile(join(fixture, 'staged.txt'), 'original\ncambio staged\ncambio local\n');
  await writeFile(join(fixture, 'bin.dat'), Buffer.from([0, 1, 2]));
  git('add', 'bin.dat');
  await mkdir(join(fixture, 'dir'));
  await writeFile(join(fixture, 'dir', 'inside.txt'), 'visible\n');
  git('add', 'dir/inside.txt');
  git('config', 'core.symlinks', 'true');
  try {
    await symlink(temp, join(fixture, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
  }
  const bundle = await build({ entryPoints: [resolve('src/tools/changes-index.ts')], bundle: true,
    write: false, platform: 'node', format: 'esm', packages: 'external', target: 'node22' });
  await writeFile(script, bundle.outputFiles[0].contents);
  const result = await run();
  assert.equal(result.kind, 'git');
  assert.equal(result.truncated, false);
  assert.equal(result.root, fixture.replaceAll('\\', '/'));
  const entries: any[] = result.entries;
  assert(entries.some(item => item.path === 'normal.txt' && item.worktree === 'M'
    && item.diff.includes('+segunda')));
  assert(entries.some(item => item.path === 'staged.txt' && item.staged === 'M'
    && item.diff.includes('+cambio staged') && item.diff.includes('+cambio local')
    && item.stagedAdded === 1 && item.stagedRemoved === 0
    && item.worktreeAdded === 1 && item.worktreeRemoved === 0));
  assert(entries.some(item => item.path === 'normal.txt' && item.worktreeAdded === 1 && item.worktreeRemoved === 0));
  assert(entries.some(item => item.path === 'dir/inside.txt' && item.stagedAdded === 1 && item.stagedRemoved === 0));
  assert(entries.some(item => item.path === 'bin.dat' && item.stagedAdded === null && item.stagedRemoved === null));
  assert(!entries.some(item => item.path === 'outside'), 'no seguir enlace exterior');
  assert(entries.some(item => item.path === 'espacio en nombre.txt' && item.worktree === '?'
    && item.diff === ''));
  assert(!entries.some(item => item.path === '.env'), 'ruta de credencial oculta');
  assert(entries.some(item => item.path === 'private.txt' && item.diff.includes('Diff oculto')));
  assert(!JSON.stringify(result).includes('valor-sensible'), 'sin filtrar secretos en salida');
  const notGit = await run(temp);
  assert.equal(notGit.kind, 'not-git');
  const missing = await run(join(temp, 'inexistente'));
  assert.equal(missing.kind, 'not-git');
  const client = await build({ entryPoints: [resolve('src/changes.ts')], bundle: true,
    write: false, platform: 'browser', format: 'esm', target: 'es2022' });
  const code = new TextDecoder().decode(client.outputFiles[0].contents);
  assert(code.includes('/changes.json?sessionId='), 'cliente necesita endpoint de sesión explícito');
  assert(code.includes('textContent'), 'panel construye texto sin HTML crudo');
  assert(!code.includes('innerHTML'), 'no inyectar diff como HTML');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const requests: string[] = [];
    let offline = false;
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      assert.equal(url.host, 'changes.invalid', 'sin conexiones al backend real');
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><script type="module" src="/changes.js"></script></body></html>' });
      if (url.pathname === '/changes.js') return route.fulfill({ contentType: 'text/javascript', body: code });
      if (url.pathname === '/changes.json') {
        assert.equal(route.request().method(), 'GET');
        requests.push(url.searchParams.get('sessionId') || '');
        if (offline) return route.fulfill({ status: 404, body: 'Sin endpoint' });
        return route.fulfill({ json: { kind: 'git', root: fixture, entries: [
          { path: '<img src=x onerror=alert(1)>', staged: 'M', worktree: ' ', diff: '+<script>alert(2)</script>', truncated: false },
        ], truncated: false } });
      }
      throw new Error('Ruta inesperada: ' + url.pathname);
    });
    await page.addInitScript((cwd: string) => { (window as any).__aegisWeb = { state: { current: { id: 'fixture-session', cwd } } }; }, fixture);
    await page.goto('http://changes.invalid/');
    await page.evaluate((cwd: string) => (window as any).__aegisChanges.open(cwd), fixture);
    assert.equal(await page.locator('.aegis-changes details').count(), 1);
    assert.equal(await page.locator('.aegis-changes img, .aegis-changes script').count(), 0, 'sin ejecución HTML de diff/ruta');
    assert((await page.locator('.aegis-changes').innerText()).includes('autor desconocido'));
    assert.deepEqual(requests, ['fixture-session']);
    offline = true;
    await page.locator('.aegis-changes header button').first().click();
    await page.waitForFunction(() => document.querySelector('.aegis-changes .note')?.textContent?.includes('Sin backend validado'));
    assert((await page.locator('.aegis-changes').innerText()).includes('Panel no disponible'));
    assert(!(await page.locator('.aegis-changes').innerText()).includes('Git no informa cambios'));
    await page.locator('.aegis-changes header button').last().click();
    assert.equal(await page.locator('.aegis-changes').count(), 0);
  } finally { await browser.close(); }
  console.log('PASS changes: fixture Git -z, staged, untracked, secretos, no Git y panel aislado (XSS/error)');
} finally {
  await rm(temp, { recursive: true, force: true });
}

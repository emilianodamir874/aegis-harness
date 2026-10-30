/* Gate del endpoint de cambios: Git se ejecuta solo en un repo temporal bajo os.tmpdir().
 * No consulta el repo ni el store de Aegis. No modifica scripts de runtime.
 * La vista vive ahora en la tarjeta de cada herramienta (tool-diff), no en un bloque aparte.
 * Correr: node dist-ts/tests/changes.mjs
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const temp = await mkdtemp(join(tmpdir(), 'aegis-changes-test-'));
const fixture = join(temp, 'repo');
const script = join(temp, 'changes-index.mjs');
function git(...args: string[]): void {
  execFileSync('git', ['-C', fixture, ...args], { timeout: 5000, stdio: 'pipe' });
}
async function run(cwd = fixture, extra: string[] = []): Promise<any> {
  const stdout = execFileSync(process.execPath, [script, '--cwd', cwd, ...extra], {
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
  assert(entries.some(item => item.path === 'dir/inside.txt' && item.stagedAdded === 1 && item.stagedRemoved === 0));
  assert(entries.some(item => item.path === 'bin.dat' && item.stagedAdded === null && item.stagedRemoved === null));
  assert(!entries.some(item => item.path === 'outside'), 'no seguir enlace exterior');
  assert(entries.some(item => item.path === 'espacio en nombre.txt' && item.worktree === '?'
    && item.diff === ''));
  assert(!entries.some(item => item.path === '.env'), 'ruta de credencial oculta');
  assert(entries.some(item => item.path === 'private.txt' && item.diff.includes('Diff oculto')));
  assert(!JSON.stringify(result).includes('valor-sensible'), 'sin filtrar secretos en salida');

  // Sin repo en el cwd: se listan los repos de adentro, con conteos y sin diffs.
  await mkdir(join(fixture, 'subrepo'));
  git('-C', join(fixture, 'subrepo'), 'init', '-q');
  await writeFile(join(fixture, 'subrepo', 'a.txt'), 'uno\n');
  const scan = await run(fixture, ['--scan']);
  assert.equal(scan.kind, 'repos', 'el escaneo explicito lista subproyectos dentro de un repo');
  assert(scan.repos.some((item: any) => item.rel === 'subrepo'));
  await mkdir(join(temp, 'suelto'));
  const padre = await run(join(temp, 'suelto'), ['--scan']);
  assert.equal(padre.kind, 'not-git', 'una carpeta sin repos adentro sigue siendo not-git');
  const afuera = await run(temp, ['--scan']);
  assert.equal(afuera.kind, 'repos', 'el padre de los dos repos se lista: ' + JSON.stringify(afuera.repos));
  assert(afuera.repos.every((r: any) => typeof r.rel === 'string' && typeof r.files === 'number' && !('diff' in r)),
    'el escaneo trae conteos, no diffs');
  assert.equal(afuera.entries.length, 0, 'el escaneo no trae entradas de archivos');
  assert(afuera.repos.every((r: any) => r.files === 0) || afuera.repos.some((r: any) => r.files > 0),
    'los conteos son numeros');

  const mono = join(temp, 'mono');
  await mkdir(join(mono, 'web'), { recursive: true });
  await mkdir(join(mono, 'src'), { recursive: true });
  execFileSync('git', ['-C', mono, 'init', '-q'], { stdio: 'pipe' });
  await writeFile(join(mono, 'web', 'client.txt'), 'original\n');
  await writeFile(join(mono, 'src', 'backend.txt'), 'original\n');
  execFileSync('git', ['-C', mono, 'add', 'web/client.txt', 'src/backend.txt'], { stdio: 'pipe' });
  execFileSync('git', ['-C', mono, '-c', 'user.email=fixture@invalid.test', '-c', 'user.name=Fixture', 'commit', '-qm', 'fixture'], { stdio: 'pipe' });
  await writeFile(join(mono, 'web', 'client.txt'), 'original\ncambio web\n');
  await writeFile(join(mono, 'src', 'backend.txt'), 'original\ncambio src\n');
  const monoScan = await run(mono, ['--scan']);
  assert.equal(monoScan.kind, 'repos', 'selector de proyectos dentro del monorepo');
  assert.equal(monoScan.repos.find((item: any) => item.rel === 'web')?.files, 1);
  assert.equal(monoScan.repos.find((item: any) => item.rel === 'src')?.files, 1);
  const monoWeb = await run(join(mono, 'web'));
  assert.equal(monoWeb.kind, 'git');
  assert.equal(resolve(monoWeb.root), resolve(mono));
  assert.deepEqual(monoWeb.entries.map((item: any) => item.path), ['client.txt']);
  assert(monoWeb.entries[0].diff.includes('+cambio web'));
  assert.equal(monoWeb.entries[0].worktreeAdded, 1);
  assert.equal(monoWeb.entries[0].worktreeRemoved, 0);

  // Raiz del workspace fuera del Git fisico: los alias son junctions a subproyectos.
  const alias = join(temp, 'alias');
  await mkdir(alias);
  await symlink(join(mono, 'web'), join(alias, 'web'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(join(mono, 'src'), join(alias, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
  const linked = await run(alias, ['--scan']);
  assert.equal(linked.kind, 'repos', 'selector sigue alias a subproyectos Git fisicos');
  assert.deepEqual(linked.repos.map((item: any) => item.rel).sort(), ['src', 'web']);
  assert.equal(linked.repos.find((item: any) => item.rel === 'web')?.files, 1);
  const legacy = join(temp, 'legacy');
  await mkdir(join(legacy, 'web'), { recursive: true });
  await mkdir(join(legacy, 'harness'));
  await symlink(mono, join(legacy, 'harness', 'src'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(join(mono, 'web'), join(legacy, 'harness', 'web'), process.platform === 'win32' ? 'junction' : 'dir');
  const legacyScan = await run(legacy, ['--scan']);
  assert.equal(legacyScan.kind, 'repos');
  assert(legacyScan.repos.some((item: any) => item.rel === 'web' && item.files === 1), 'shell web con logs abiertos resuelve proyecto fisico');

  const notGit = await run(temp);
  assert.equal(notGit.kind, 'not-git');
  const missing = await run(join(temp, 'inexistente'));
  assert.equal(missing.kind, 'not-git');
  console.log('PASS changes: fixture Git -z, staged, untracked, secretos, no Git y escaneo de repos anidados');
} finally {
  await rm(temp, { recursive: true, force: true });
}

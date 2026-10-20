import { build } from 'esbuild';
import { writeFile, mkdir, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const entries = [
  // bundle: la app tiene modulos propios en src/app/*.ts (esbuild los inlina en app.js)
  { entry: 'src/app.ts', output: 'app/app.js', options: { format: 'esm', platform: 'browser', bundle: true } },
  { entry: 'src/skills.ts', output: 'app/skills.js', options: { format: 'esm', platform: 'browser' } },
  { entry: 'src/stats.ts', output: 'app/stats.js', options: { format: 'esm', platform: 'browser' } },
  { entry: 'src/server.ts', output: 'server.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'src/piper-vivo.ts', output: 'piper-vivo.js', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'src/tools/goals-index.ts', output: 'tools/goals-index.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'src/tools/stats-index.ts', output: 'tools/stats-index.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'tests/lib.ts', output: 'tests/lib.js', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'tests/ui-mobile.ts', output: 'tests/ui-mobile.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'tests/gasto.ts', output: 'tests/gasto.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'tests/client-regressions.ts', output: 'tests/client-regressions.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'tests/server-regressions.ts', output: 'tests/server-regressions.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'tests/reload-smoke.ts', output: 'tests/reload-smoke.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'tests/rewind-regen.ts', output: 'tests/rewind-regen.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'tests/dedup-prompt.ts', output: 'tests/dedup-prompt.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'tests/run.ts', output: 'tests/run.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
];
for (const item of entries) {
  const result = await build({ entryPoints: [join(root, item.entry)], bundle: false, write: false, target: 'es2022', charset: 'utf8', logLevel: 'warning', ...item.options });
  if (result.outputFiles.length !== 1) throw new Error(`${item.entry}: cantidad inesperada de archivos`);
  const output = result.outputFiles[0].contents;
  const staged = join(root, 'dist-ts', item.output);
  await mkdir(resolve(staged, '..'), { recursive: true });
  await writeFile(staged, output);
  console.log(item.entry + ' -> ' + item.output + ' (' + output.length + ' bytes)');
}

for (const file of ['app/index.html', 'app/app.css', 'app/icon.svg', 'app/manifest.json']) {
  const dest = join(root, 'dist-ts', file);
  await mkdir(resolve(dest, '..'), { recursive: true });
  await copyFile(join(root, file), dest);
}

await writeFile(join(root, 'dist-ts', 'package.json'), JSON.stringify({ type: 'module' }) + '\n');

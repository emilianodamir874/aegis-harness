import { build } from 'esbuild';
import { writeFile, mkdir, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const entries = [
  // bundle: la app tiene modulos propios en src/app/*.ts (esbuild los inlina en app.js)
  { entry: 'src/app.ts', output: 'app/app.js', options: { format: 'esm', platform: 'browser', minify: process.env.AEGIS_BUILD_MINIFY !== '0', bundle: true } },
  // Se emite aparte para que las pruebas de navegador puedan importar el convertidor de audio real
  // (app.ts ya lo lleva inlineado en su bundle) y probar MediaRecorder -> WAV sin duplicar codigo.
  { entry: 'src/app/audio-wav.ts', output: 'app/audio-wav.js', options: { format: 'esm', platform: 'browser', minify: process.env.AEGIS_BUILD_MINIFY !== '0' } },
  { entry: 'src/skills.ts', output: 'app/skills.js', options: { format: 'esm', platform: 'browser', minify: process.env.AEGIS_BUILD_MINIFY !== '0' } },
  { entry: 'src/memory.ts', output: 'app/memory.js', options: { format: 'esm', platform: 'browser', minify: process.env.AEGIS_BUILD_MINIFY !== '0', bundle: true } },
  { entry: 'src/artifacts.ts', output: 'app/artifacts.js', options: { format: 'esm', platform: 'browser', minify: process.env.AEGIS_BUILD_MINIFY !== '0' } },
  { entry: 'src/workspace-nav.ts', output: 'app/workspace-nav.js', options: { format: 'esm', platform: 'browser', minify: process.env.AEGIS_BUILD_MINIFY !== '0' } },
  { entry: 'src/activity.ts', output: 'app/activity.js', options: { format: 'esm', platform: 'browser', minify: process.env.AEGIS_BUILD_MINIFY !== '0' } },
  { entry: 'src/changes.ts', output: 'app/changes.js', options: { format: 'esm', platform: 'browser', minify: process.env.AEGIS_BUILD_MINIFY !== '0' } },
  { entry: 'src/context-meter.ts', output: 'app/context-meter.js', options: { format: 'esm', platform: 'browser', minify: process.env.AEGIS_BUILD_MINIFY !== '0' } },
  { entry: 'src/session-mode.ts', output: 'app/session-mode.js', options: { format: 'esm', platform: 'browser', minify: process.env.AEGIS_BUILD_MINIFY !== '0' } },
  { entry: 'src/palette.ts', output: 'app/palette.js', options: { format: 'esm', platform: 'browser', minify: process.env.AEGIS_BUILD_MINIFY !== '0' } },
  { entry: 'src/onboarding.ts', output: 'app/onboarding.js', options: { format: 'esm', platform: 'browser', minify: process.env.AEGIS_BUILD_MINIFY !== '0' } },
  { entry: 'src/handoff.ts', output: 'app/handoff.js', options: { format: 'esm', platform: 'browser', minify: process.env.AEGIS_BUILD_MINIFY !== '0' } },
  { entry: 'src/split-view.ts', output: 'app/split-view.js', options: { format: 'esm', platform: 'browser', minify: process.env.AEGIS_BUILD_MINIFY !== '0' } },
  { entry: 'src/stats.ts', output: 'app/stats.js', options: { format: 'esm', platform: 'browser', minify: process.env.AEGIS_BUILD_MINIFY !== '0' } },
  { entry: 'src/server.ts', output: 'server.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'src/piper-vivo.ts', output: 'piper-vivo.js', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'src/tools/goals-index.ts', output: 'tools/goals-index.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'src/tools/stats-index.ts', output: 'tools/stats-index.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'src/tools/search-index.ts', output: 'tools/search-index.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'src/tools/changes-index.ts', output: 'tools/changes-index.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'tests/lib.ts', output: 'tests/lib.js', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'tests/ui-mobile.ts', output: 'tests/ui-mobile.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'tests/ui-shell.ts', output: 'tests/ui-shell.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },  { entry: 'tests/gasto.ts', output: 'tests/gasto.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'tests/stats-plan.ts', output: 'tests/stats-plan.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'tests/visibility.ts', output: 'tests/visibility.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'tests/search-fixture.ts', output: 'tests/search-fixture.js', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'tests/search-index.ts', output: 'tests/search-index.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'tests/search-e2e.ts', output: 'tests/search-e2e.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'tests/permission-e2e.ts', output: 'tests/permission-e2e.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'tests/media-e2e.ts', output: 'tests/media-e2e.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'tests/client-regressions.ts', output: 'tests/client-regressions.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'tests/server-regressions.ts', output: 'tests/server-regressions.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'tests/server-workspace-regressions.ts', output: 'tests/server-workspace-regressions.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'tests/workspace-nav.ts', output: 'tests/workspace-nav.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'tests/activity.ts', output: 'tests/activity.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'tests/changes.ts', output: 'tests/changes.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
  { entry: 'tests/changes-http.ts', output: 'tests/changes-http.mjs', options: { format: 'esm', platform: 'node', packages: 'external' } },
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

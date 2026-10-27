// Runner de las pruebas de aegis-web.
//
//   npm test                 -> regresiones aisladas + ui-mobile + gasto contra AEGIS_WEB_URL (default http://127.0.0.1:3788)
//   AEGIS_TEST_SMOKE=1 npm test  -> agrega reload-smoke, rewind-regen y dedup-prompt
//                                  (crean sesiones y gastan turnos reales)
//
// Cada prueba es un proceso aparte: si una cuelga el navegador, no arrastra a las demas.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const suites = ['client-regressions.mjs', 'server-regressions.mjs', 'server-workspace-regressions.mjs', 'workspace-nav.mjs', 'activity.mjs', 'changes.mjs', 'changes-http.mjs', 'search-index.mjs', 'search-e2e.mjs', 'permission-e2e.mjs', 'media-e2e.mjs', 'ui-mobile.mjs', 'ui-shell.mjs', 'gasto.mjs', 'stats-plan.mjs', 'visibility.mjs'];
if (process.env.AEGIS_TEST_SMOKE === '1') suites.push('reload-smoke.mjs', 'rewind-regen.mjs', 'dedup-prompt.mjs');

const results: Array<{ suite: string; code: number | null; ms: number }> = [];
for (const suite of suites) {
  const t0 = Date.now();
  console.log('\n=== ' + suite + ' ===');
  const r = spawnSync(process.execPath, [join(here, suite)], { stdio: 'inherit', env: process.env });
  results.push({ suite, code: r.status, ms: Date.now() - t0 });
}
const failed = results.filter((r) => r.code !== 0);
console.log('\n=== resumen ===');
for (const r of results) console.log((r.code === 0 ? 'OK   ' : 'FALLA') + '  ' + r.suite + '  ' + (r.ms / 1000).toFixed(1) + 's');
if (failed.length) {
  console.error('\n' + failed.length + ' suite(s) fallaron');
  process.exit(1);
}
console.log('\ntodo verde contra ' + (process.env.AEGIS_WEB_URL || 'http://127.0.0.1:3788'));

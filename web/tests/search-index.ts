// Pruebas del indice de busqueda (tools/search-index.mjs), ejecutado como lo llama el server:
// proceso aparte con --experimental-sqlite y AEGIS_SESSIONS_DB apuntando a una base temporal.
// Cubre: coincidencias en mensajes y titulos, acentos/Unicode, entradas malformadas, vacio,
// visibilidad (userVisible/sub_agent), topes y volumen grande.
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createSearchDb, createLargeDb } from './search-fixture.js';

const INDEX = resolve('dist-ts/tools/search-index.mjs');
const dir = await mkdtemp(join(tmpdir(), 'aegis-search-'));

type Result = {
  query: string;
  results: Array<{ sessionId: string; title: string; archived?: boolean; titleMatch?: boolean; matches: Array<{ role: string; snippet: string }> }>;
  totalSessions: number;
  totalMatches: number;
  truncated: boolean;
  _error?: string;
};

function run(dbFile: string, query: string, extra: string[] = []): Promise<Result> {
  return new Promise((ok, fail) => {
    execFile(
      process.execPath,
      ['--experimental-sqlite', INDEX, '--query', query, ...extra],
      { env: { ...process.env, AEGIS_SESSIONS_DB: dbFile }, timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return fail(new Error('el indice fallo: ' + err.message + ' ' + stderr.slice(0, 300)));
        try { ok(JSON.parse(stdout)); } catch (e) { fail(new Error('salida no es JSON: ' + stdout.slice(0, 200))); }
      },
    );
  });
}
const fail = (m: string): never => { console.error('FAIL ' + m); process.exit(1); };
const check = (c: unknown, m: string): void => { if (!c) fail(m); };
const MARK = '\u0001';

try {
  // ---------- base de contenido ----------
  const db = await createSearchDb(
    join(dir, 'contenido'),
    [
      { id: 's_acentos', name: 'Revisión de bots A52', updatedAt: '2026-10-20T22:06:00Z' },
      { id: 's_titulo', name: 'Presupuesto del taller', updatedAt: '2026-10-19T10:00:00Z' },
      { id: 's_oculto', name: 'Interna' },
      { id: 's_sub', name: 'Sub agente', type: 'sub_agent' },
      { id: 's_archivada', name: 'Vieja', archivedAt: '2026-10-01T00:00:00Z' },
    ],
    [
      { session: 's_acentos', text: 'Hicimos una revisión de estado del A52 con heimdall.' },
      { session: 's_acentos', text: 'El permiso de escritura quedó pedido.', role: 'assistant' },
      { session: 's_titulo', text: 'Nada relevante por acá.' },
      { session: 's_oculto', text: 'texto secreto que no se debe ver', visible: false },
      { session: 's_sub', text: 'texto de un sub agente que no se lista' },
      { session: 's_archivada', text: 'mencion de heimdall en una sesion archivada' },
    ],
  );

  // 1) coincidencia en el cuerpo, con marca en el snippet
  const r1 = await run(db, 'revision');
  check(r1.results.length === 1 && r1.results[0].sessionId === 's_acentos', 'cuerpo: encuentra la sesion correcta: ' + JSON.stringify(r1.results.map((x) => x.sessionId)));
  check(r1.results[0].matches[0].snippet.includes(MARK), 'cuerpo: el snippet trae la marca de coincidencia');
  check(/revisi[oó]n/i.test(r1.results[0].matches[0].snippet.replace(/\u0001|\u0002/g, '')), 'cuerpo: el snippet muestra el texto real');

  // 2) acentos y mayusculas en las dos direcciones
  for (const q of ['revisión', 'REVISIÓN', 'ReViSiOn']) {
    const r = await run(db, q);
    check(r.results.some((x) => x.sessionId === 's_acentos'), 'acentos/mayusculas: "' + q + '" encuentra la sesión');
  }

  // 3) prefijo
  const r3 = await run(db, 'permi');
  check(r3.results.some((x) => x.sessionId === 's_acentos'), 'prefijo: "permi" encuentra "permiso"');

  // 4) varias palabras: todas tienen que aparecer (predecible, sin inundar)
  const r4a = await run(db, 'heimdall a52');
  check(r4a.results.some((x) => x.sessionId === 's_acentos'), 'AND: dos palabras presentes encuentran la sesión');
  const r4b = await run(db, 'heimdall inexistentezzz');
  check(r4b.results.length === 0, 'AND: una palabra ausente descarta la sesión');

  // 5) solo titulo (sin coincidencia en mensajes)
  const r5 = await run(db, 'presupuesto');
  check(r5.results.length === 1 && r5.results[0].sessionId === 's_titulo' && r5.results[0].titleMatch === true, 'titulo: encuentra por nombre y lo marca: ' + JSON.stringify(r5.results));
  const r5b = await run(db, 'Revision de bots');
  check(r5b.results.some((x) => x.sessionId === 's_acentos' && x.titleMatch), 'titulo: el filtro de titulo tambien ignora acentos');

  // 6) visibilidad y tipos: ni mensajes internos ni sub_agent
  const r6 = await run(db, 'secreto');
  check(r6.results.length === 0, 'privacidad: userVisible=false no aparece');
  const r6b = await run(db, 'sub agente');
  check(!r6b.results.some((x) => x.sessionId === 's_sub'), 'privacidad: las sesiones sub_agent no se listan');
  const r6c = await run(db, 'heimdall');
  check(r6c.results.some((x) => x.sessionId === 's_archivada' && x.archived === true), 'archivadas: se encuentran y vienen marcadas');

  // 7) vacio y malformadas: sin excepciones, sin ruido
  for (const q of ['', '   ', '*', '"', 'a:b', 'NEAR(', '((((', '%%%', '<script>alert(1)</script>', 'x'.repeat(5000), '\t\n  ']) {
    const r = await run(db, q);
    check(!r._error, 'malformada "' + q.slice(0, 20) + '": sin _error (' + r._error + ')');
    check(Array.isArray(r.results), 'malformada "' + q.slice(0, 20) + '": results es array');
    if (q.trim().length < 2) check(r.results.length === 0, 'vacia "' + q + '": cero resultados');
  }

  // 8) topes: limite de sesiones y de coincidencias por sesion
  const db2 = await createSearchDb(
    join(dir, 'topes'),
    Array.from({ length: 30 }, (_, i) => ({ id: 't_' + i, name: 'Topes ' + i, updatedAt: new Date(1_760_000_000_000 + i * 1000).toISOString() })),
    Array.from({ length: 30 }, (_, i) => ({ session: 't_' + i, text: 'documento de topes numero ' + i })),
  );
  const r8 = await run(db2, 'topes', ['--limit', '5', '--per-session', '1']);
  check(r8.results.length === 5 && r8.truncated === true, 'topes: 5 sesiones y truncado=true');
  check(r8.results.every((x) => x.matches.length === 1), 'topes: una coincidencia por sesion');

  // 9) volumen: 20.000 mensajes; la aguja se encuentra y el tiempo se mantiene bajo
  const db3 = await createLargeDb(join(dir, 'grande'));
  const t0 = Date.now();
  const r9 = await run(db3, 'aguja escarlata');
  const ms = Date.now() - t0;
  check(r9.results.length === 1 && r9.results[0].sessionId === 'big_7', 'volumen: encuentra la aguja en 20k mensajes');
  check(ms < 3000, 'volumen: respondio en ' + ms + 'ms (limite 3000)');
  const r9b = await run(db3, 'relleno 199');
  check(r9b.results.length > 0, 'volumen: consulta comun devuelve resultados');

  console.log('PASS busqueda: contenido, titulos, acentos, malformadas, privacidad, topes y volumen (' + (await countMsgs(db3)) + ' mensajes, aguja en ' + ms + 'ms)');
} finally {
  await rm(dir, { recursive: true, force: true });
}

async function countMsgs(file: string): Promise<number> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  const n = (db.prepare('select count(*) n from messages').get() as { n: number }).n;
  db.close();
  return n;
}

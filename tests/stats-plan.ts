// Prueba de «vs plan» (tools/stats-index.mjs), ejecutada como la llama el server: proceso aparte
// con --experimental-sqlite, AEGIS_SESSIONS_DB apuntando a una base temporal y AEGIS_WEB_CONFIG a
// una config temporal. Cubre: dos proveedores (uno con plan declarado y otro sin), un plan
// declarado sin consumo, filas previas a la migracion v20 (provider null) y un periodo parcial
// (--days 7: el plan se prorratea por dia).
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const INDEX = resolve('dist-ts/tools/stats-index.mjs');
const dir = await mkdtemp(join(tmpdir(), 'aegis-stats-'));

type Fila = {
  provider: string;
  label: string;
  calls: number;
  tokens: number;
  estimatedUsd: number;
  costKnownCalls: number;
  planUsd: number | null;
  deltaUsd: number | null;
};
type Salida = {
  totales?: unknown;
  totals: { cost: number; calls: number };
  byProvider: Fila[];
  unknownProvider: { calls: number; estimatedUsd: number } | null;
  vsPlan: { providers: number; declared: number; estimatedUsd: number; planUsd: number; deltaUsd: number };
  planWindow: { periodDays: number; daysInMonth: number; factor: number; prorated: boolean };
  _error?: string;
};

const fail = (m: string): never => { console.error('FAIL ' + m); process.exit(1); };
const check = (c: unknown, m: string): void => { if (!c) fail(m); };
const near = (a: number, b: number, eps: number): boolean => Math.abs(a - b) <= eps;

/** usage_ledger tal como lo consulta el indice (columnas desde la migracion v20). */
async function crearDb(file: string): Promise<void> {
  const db = new DatabaseSync(file);
  db.exec(`
    create table sessions (id text primary key, name text, session_type text);
    create table usage_ledger (
      id integer primary key autoincrement,
      session_id text,
      created_timestamp integer,
      model text,
      input_tokens integer,
      output_tokens integer,
      total_tokens integer,
      cache_read_tokens integer,
      cache_write_tokens integer,
      cost real,
      cost_source text,
      is_compaction integer,
      provider text
    );
  `);
  db.prepare('insert into sessions (id, name, session_type) values (?, ?, ?)').run('s1', 'Fixture', 'user');
  const ins = db.prepare(
    `insert into usage_ledger (session_id, created_timestamp, model, input_tokens, output_tokens,
                               cache_read_tokens, cache_write_tokens, cost, cost_source, is_compaction, provider)
     values (?, ?, ?, ?, ?, 0, 0, ?, 'catalog', 0, ?)`,
  );
  const ahora = Math.floor(Date.now() / 1000);
  const hace = (dias: number): number => ahora - Math.round(dias * 86400);
  // chatgpt_codex: 2 llamadas, USD 8. opencode_go: 1 llamada, USD 4. Sin proveedor: 1, USD 2.
  ins.run('s1', hace(2), 'gpt-5.1', 1000, 200, 5.0, 'chatgpt_codex');
  ins.run('s1', hace(3), 'gpt-5.1', 600, 100, 3.0, 'chatgpt_codex');
  ins.run('s1', hace(1), 'deepseek-v4.1-flash', 4000, 800, 4.0, 'opencode_go');
  ins.run('s1', hace(4), 'modelo-viejo', 900, 100, 2.0, null);
  db.close();
}

function correr(dbFile: string, cfgFile: string, days: number): Promise<Salida> {
  return new Promise((ok, bad) => {
    execFile(
      process.execPath,
      ['--experimental-sqlite', INDEX, '--days', String(days)],
      {
        env: { ...process.env, AEGIS_SESSIONS_DB: dbFile, AEGIS_WEB_CONFIG: cfgFile },
        timeout: 30000,
        maxBuffer: 8 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) return bad(new Error('stats-index fallo: ' + err.message + ' ' + stderr.slice(0, 300)));
        try { ok(JSON.parse(stdout) as Salida); } catch (e) { bad(new Error('salida no es JSON: ' + stdout.slice(0, 200))); }
      },
    );
  });
}

try {
  const dbFile = join(dir, 'sessions.db');
  await crearDb(dbFile);

  // config con dos planes: chatgpt_codex con consumo y antigravity sin consumo.
  // opencode_go queda sin plan (monthly_usd 0) a proposito.
  const cfgFile = join(dir, 'config.json');
  await writeFile(
    cfgFile,
    JSON.stringify({
      secretKey: 'no-debe-salir-en-la-salida',
      plans: {
        chatgpt_codex: { monthly_usd: 20, label: 'ChatGPT', note: 'Plus' },
        antigravity: { monthly_usd: 10, label: 'Antigravity', note: '' },
        opencode_go: { monthly_usd: 0, label: 'OpenCode Go', note: '' },
      },
    }),
  );

  const d = await correr(dbFile, cfgFile, 7);
  check(!d._error, 'sin error: ' + d._error);
  check(near(d.totals.cost, 14, 1e-9), 'total estimado 14: ' + d.totals.cost);
  check(d.totals.calls === 4, '4 llamadas: ' + d.totals.calls);

  const porProv = new Map(d.byProvider.map((f) => [f.provider, f]));
  check(porProv.size === 3, 'tres proveedores en la tabla (dos con filas + uno declarado sin consumo): ' + [...porProv.keys()].join(','));

  const codex = porProv.get('chatgpt_codex')!;
  const f = d.planWindow.factor;
  check(near(codex.estimatedUsd, 8, 1e-9), 'chatgpt_codex consumo 8: ' + codex.estimatedUsd);
  check(codex.planUsd != null && near(codex.planUsd, 20 * f, 1e-9), 'chatgpt_codex plan prorrateado: ' + codex.planUsd);
  check(codex.deltaUsd != null && near(codex.deltaUsd, 8 - 20 * f, 1e-9), 'chatgpt_codex delta: ' + codex.deltaUsd);
  check(codex.label === 'ChatGPT', 'label del plan: ' + codex.label);

  const go = porProv.get('opencode_go')!;
  check(near(go.estimatedUsd, 4, 1e-9), 'opencode_go consumo 4: ' + go.estimatedUsd);
  check(go.planUsd === null && go.deltaUsd === null, 'opencode_go sin plan declarado: no calcula delta');

  const grav = porProv.get('antigravity')!;
  check(grav.calls === 0 && grav.estimatedUsd === 0, 'antigravity sin consumo aparece igual');
  check(grav.planUsd != null && near(grav.planUsd, 10 * f, 1e-9), 'antigravity plan prorrateado: ' + grav.planUsd);
  check(grav.deltaUsd != null && near(grav.deltaUsd, -10 * f, 1e-9), 'antigravity delta negativo: ' + grav.deltaUsd);

  check(d.unknownProvider != null && d.unknownProvider.calls === 1, 'una llamada sin proveedor');
  check(d.unknownProvider != null && near(d.unknownProvider.estimatedUsd, 2, 1e-9), 'consumo sin proveedor 2: ' + (d.unknownProvider && d.unknownProvider.estimatedUsd));

  check(d.vsPlan.declared === 2, 'dos planes declarados: ' + d.vsPlan.declared);
  check(d.vsPlan.providers === 2, 'dos planes comparables: ' + d.vsPlan.providers);
  check(near(d.vsPlan.estimatedUsd, 8, 1e-9), 'vs plan: consumo comparable 8: ' + d.vsPlan.estimatedUsd);
  check(near(d.vsPlan.planUsd, 30 * f, 1e-9), 'vs plan: plan 30 prorrateado: ' + d.vsPlan.planUsd);
  check(near(d.vsPlan.deltaUsd, 8 - 30 * f, 1e-9), 'vs plan: delta: ' + d.vsPlan.deltaUsd);

  check(d.planWindow.prorated === true, 'rango de 7 dias se marca prorrateado');
  check(Math.abs(d.planWindow.periodDays - 7) < 0.02, 'periodo de 7 dias: ' + d.planWindow.periodDays);

  const plano = JSON.stringify(d);
  check(!/no-debe-salir/.test(plano), 'la secretKey de config.json no aparece en la salida');

  // sin bloque plans: no se inventan precios, la tabla queda vacia de planes pero con consumo.
  const cfgVacia = join(dir, 'config-vacia.json');
  await writeFile(cfgVacia, JSON.stringify({ secretKey: 'x' }));
  const d2 = await correr(dbFile, cfgVacia, 7);
  check(d2.vsPlan.declared === 0, 'sin plans declarados: 0');
  check(d2.byProvider.length === 2, 'sin plans: solo los dos proveedores con filas: ' + d2.byProvider.length);
  check(d2.byProvider.every((f2) => f2.planUsd === null && f2.deltaUsd === null), 'sin plans: plan y delta nulos');
  check(near(d2.vsPlan.deltaUsd, 0, 1e-9), 'sin plans: delta 0');

  console.log('PASS stats-index vs plan (' + d.byProvider.length + ' proveedores, factor ' + f.toFixed(4) + ')');
} finally {
  await rm(dir, { recursive: true, force: true });
}

// Inventario observable del cliente vanilla: por módulo, qué RPC, qué endpoints HTTP, qué atajos y
// qué globals expone. Sirve para la tabla de paridad sin volcar código al contexto.
// Uso: node tools/vanilla-modules.mjs [dir]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] || 'src';
const files = readdirSync(dir).filter((name) => name.endsWith('.ts') && name !== 'server.ts');

const uniq = (list) => [...new Set(list)];

for (const file of files) {
  const text = readFileSync(join(dir, file), 'utf8');
  const lines = text.split('\n').length;
  const rpc = uniq([...text.matchAll(/request<[^>]*>\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]).concat([...text.matchAll(/request\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1])));
  const endpoints = uniq([...text.matchAll(/['"`](\/[a-z0-9-]+\.json[^'"`]*)['"`]/gi)].map((m) => m[1]));
  const fetches = uniq([...text.matchAll(/fetch\(\s*[`'"]([^`'"]+)/g)].map((m) => m[1]));
  const keys = uniq([...text.matchAll(/(?:event\.)?(?:ctrlKey|metaKey)[^\n]{0,80}key[^\n]{0,30}['"]([a-zA-Z])['"]/g)].map((m) => m[1].toLowerCase()));
  const globals = uniq([...text.matchAll(/window\.(__aegis[A-Za-z]+)/g)].map((m) => m[1]));
  const ids = uniq([...text.matchAll(/getElementById\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1])).slice(0, 6);
  console.log(
    [
      file.padEnd(20),
      String(lines).padStart(5),
      `rpc[${rpc.length}]: ${rpc.slice(0, 8).join(' ')}`,
      endpoints.length ? `http: ${endpoints.slice(0, 5).join(' ')}` : '',
      fetches.length ? `fetch: ${fetches.slice(0, 3).join(' ')}` : '',
      keys.length ? `teclas: ${keys.join('')}` : '',
      globals.length ? `globals: ${globals.join(' ')}` : '',
      ids.length ? `ids: ${ids.join(' ')}` : '',
    ]
      .filter(Boolean)
      .join(' | '),
  );
}

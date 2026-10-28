// Precomprime los assets del build del cliente React (.gz y .br al lado de cada archivo) para que el
// servidor los entregue tal cual. Mismo criterio que los assets del cliente viejo: comprimir una vez
// al construir, no en cada pedido.
// Uso: node scripts/precompress.mjs [dir]
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';

const dir = process.argv[2] || 'dist';
const ext = new Set(['.js', '.css', '.html', '.svg', '.json', '.map']);

const walk = (path) => {
  let files = [];
  for (const name of readdirSync(path)) {
    const full = join(path, name);
    const info = statSync(full);
    if (info.isDirectory()) files = files.concat(walk(full));
    else if (ext.has(extname(name)) && !name.endsWith('.gz') && !name.endsWith('.br')) files.push(full);
  }
  return files;
};

let total = 0;
let original = 0;
for (const file of walk(dir)) {
  const body = readFileSync(file);
  if (body.length < 1024) continue;
  const gz = gzipSync(body, { level: 9 });
  const br = brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
  writeFileSync(`${file}.gz`, gz);
  writeFileSync(`${file}.br`, br);
  total += Math.min(gz.length, br.length);
  original += body.length;
  console.log(`${relative(dir, file).padEnd(34)} ${(body.length / 1024).toFixed(1)} KB → br ${(br.length / 1024).toFixed(1)} KB / gz ${(gz.length / 1024).toFixed(1)} KB`);
}
console.log(`total: ${(original / 1024).toFixed(1)} KB → ${(total / 1024).toFixed(1)} KB comprimido`);

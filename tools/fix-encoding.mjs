// Repara archivos de texto con bytes Latin-1 sueltos dentro de un archivo mayormente UTF-8.
// El daño típico: PowerShell 5.1 escribió con Set-Content (ANSI) una línea y el resto siguió en
// UTF-8, así que el archivo mezcla las dos codificaciones y el decoder estricto falla.
// Uso: node tools/fix-encoding.mjs [--apply] <dir...>
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const roots = args.filter((arg) => arg !== '--apply');
const exts = new Set(['.ts', '.tsx', '.css', '.mjs', '.md', '.json', '.html']);

/** Decodifica UTF-8 estricto; en cada byte inválido interpreta Latin-1 y sigue. */
const repair = (bytes) => {
  let out = '';
  let index = 0;
  let fixed = 0;
  while (index < bytes.length) {
    const byte = bytes[index];
    if (byte < 0x80) {
      out += String.fromCharCode(byte);
      index += 1;
      continue;
    }
    let size = 0;
    if (byte >= 0xc2 && byte <= 0xdf) size = 2;
    else if (byte >= 0xe0 && byte <= 0xef) size = 3;
    else if (byte >= 0xf0 && byte <= 0xf4) size = 4;
    let valid = size > 0 && index + size <= bytes.length;
    if (valid) {
      for (let k = 1; k < size; k += 1) {
        const next = bytes[index + k];
        if (next < 0x80 || next > 0xbf) {
          valid = false;
          break;
        }
      }
    }
    if (valid) {
      out += Buffer.from(bytes.subarray(index, index + size)).toString('utf8');
      index += size;
      continue;
    }
    out += String.fromCharCode(byte);
    fixed += 1;
    index += 1;
  }
  return { out, fixed };
};

const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) {
      walk(full);
      continue;
    }
    if (!exts.has(extname(name))) continue;
    const bytes = readFileSync(full);
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      continue;
    } catch {
      const { out, fixed } = repair(bytes);
      console.log(`${apply ? 'REPARADO' : 'ROTO    '} ${full} bytesLatin1=${fixed}`);
      if (apply) writeFileSync(full, Buffer.from(out, 'utf8'));
    }
  }
};

for (const root of roots) walk(root);

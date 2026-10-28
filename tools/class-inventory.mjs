// Inventario de clases usadas por el cliente (app.ts + modulos) para auditar el CSS.
import fs from 'node:fs';
import path from 'node:path';

const root = 'C:/Aegis-Proyects/web';
const files = [];
for (const dir of ['src', 'app']) {
  for (const f of fs.readdirSync(path.join(root, dir))) {
    if (/\.(ts|js)$/.test(f)) files.push(path.join(root, dir, f));
  }
}

const classes = new Map();
const ids = new Map();
const add = (map, name, from) => {
  if (!name) return;
  if (!map.has(name)) map.set(name, new Set());
  map.get(name).add(from);
};

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const base = path.basename(f);
  const push = (raw) => {
    for (const c of raw.split(/\s+/)) if (/^[a-zA-Z][\w-]*$/.test(c)) add(classes, c, base);
  };
  for (const m of src.matchAll(/class="([^"$`]*)"/g)) push(m[1]);
  for (const m of src.matchAll(/className\s*=\s*'([^'$`]*)'/g)) push(m[1]);
  for (const m of src.matchAll(/classList\.(?:add|toggle|remove)\(\s*'([\w-]+)'/g)) add(classes, m[1], base);
  for (const m of src.matchAll(/classList\.add\(\s*'([\w-]+)'/g)) add(classes, m[1], base);
  for (const m of src.matchAll(/id="([a-zA-Z][\w-]*)"/g)) add(ids, m[1], base);
  for (const m of src.matchAll(/getElementById\('([\w-]+)'\)/g)) add(ids, m[1], base);
  for (const m of src.matchAll(/\$\('#([\w-]+)'\)/g)) add(ids, m[1], base);
}

const css = fs.readFileSync(path.join(root, 'app/app.css'), 'utf8');
const styled = new Set();
for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) styled.add(m[1]);

const sorted = [...classes.keys()].sort();
const unstyled = sorted.filter((c) => !styled.has(c));
const unstyledByFile = {};
for (const c of unstyled) {
  for (const f of classes.get(c)) {
    (unstyledByFile[f] ||= []).push(c);
  }
}

console.log('== clases usadas:', sorted.length, '| con regla en app.css:', sorted.length - unstyled.length);
console.log('\n== SIN ESTILO (por archivo) ==');
for (const [f, list] of Object.entries(unstyledByFile).sort()) {
  console.log(`\n-- ${f} (${list.length}): ${list.sort().join(' ')}`);
}
console.log('\n== TODAS ==');
console.log(sorted.join(' '));
fs.writeFileSync(path.join(root, 'tools/_class-inventory.json'), JSON.stringify({ classes: sorted, ids: [...ids.keys()].sort() }, null, 1));

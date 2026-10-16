import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
const p = 'C:/Users/Emiliano/.agents/AGENTS.md';
copyFileSync(p, p + '.bak-skills-path-20261016');
let s = readFileSync(p, 'utf8');
const antes = s.length;
const pares = [
  ['Las skills son archivos: `~/.agents/skills/<nombre>/SKILL.md` (global) o `<proyecto>/.agents/skills/`.',
   'Las skills son archivos: `<config>/skills/<nombre>/SKILL.md`, o sea hoy `C:/Aegis-Proyects/state/config/skills/<nombre>/SKILL.md` (raiz GLOBAL: la leen todas las sesiones, desde cualquier carpeta; depende de `AEGIS_PATH_ROOT`, que es variable de usuario). Se mudaron ahi el 2026-10-16 (antes `~/.agents/skills`). Tambien se leen `<proyecto>/.agents/skills/` y `~/.agents/skills` si existieran, pero el lugar canonico es el primero. Para verificar: `aegis skills list` tiene que dar 38 lineas desde CUALQUIER carpeta.'],
  ['En .agents/skills/ el .bak al lado del SKILL.md esta bien.',
   'En <config>/skills/ (hoy C:/Aegis-Proyects/state/config/skills, antes .agents/skills) el .bak al lado del SKILL.md esta bien.'],
];
for (const [a, b] of pares) {
  const n = s.split(a).length - 1;
  if (n !== 1) throw new Error('esperaba 1 aparicion y hay ' + n + ': ' + a.slice(0, 60));
  s = s.replace(a, b);
  console.log('  reemplazo ok (' + n + ')');
}
writeFileSync(p, s);
console.log('  bytes: ' + antes + ' -> ' + s.length);
console.log('  queda mencion a ~/.agents/skills: ' + (s.split('~/.agents/skills').length - 1));

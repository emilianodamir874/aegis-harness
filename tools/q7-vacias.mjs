import fs from 'node:fs';
const dir = 'C:/Aegis-Proyects/state/state/logs';
const ini = Date.UTC(2026, 9, 16, 12, 0, 0) / 1000, fin = Date.UTC(2026, 9, 16, 12, 40, 0) / 1000;
let n = 0, vacias = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.startsWith('llm_request'))) {
  for (const l of fs.readFileSync(dir + '/' + f, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    const m = /"created":(\d{10})/.exec(l);
    const t = m ? Number(m[1]) : 0;
    if (t && (t < ini || t > fin)) continue;
    if (t) n++;
    if (/"content":\[\]/.test(l)) { vacias++; if (vacias <= 6) console.log('  VACIA ' + f + ' t=' + (t ? new Date(t * 1000).toISOString().slice(11, 19) : '?') + ' bytes=' + l.length); }
  }
}
console.log('  entradas con hora en 12:00-12:40: ' + n + ' | con content vacio: ' + vacias);

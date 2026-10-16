import fs from 'node:fs';
const ini = Date.UTC(2026, 9, 16, 12, 17, 50) / 1000;
const fin = Date.UTC(2026, 9, 16, 12, 18, 40) / 1000;
const dir = 'C:/Aegis-Proyects/state/state/logs';
let n = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.startsWith('llm_request'))) {
  const txt = fs.readFileSync(dir + '/' + f, 'utf8');
  for (const l of txt.split('\n')) {
    const m = /"created":(\d{10})/.exec(l);
    if (!m) continue;
    const t = Number(m[1]);
    if (t < ini || t > fin) continue;
    const role = (/"(role|type)":"([a-z]+)"/.exec(l) || [])[2] || '?';
    const tipo = (/\{"type":"([A-Za-z]+)"/.exec(l) || [])[1] || '?';
    const stop = (/stopReason"?\s*:\s*"?([a-z_]+)/.exec(l) || [])[1] || '';
    const largo = l.length;
    console.log('  ' + f + ' t=' + new Date(t * 1000).toISOString().slice(11, 19) + ' role=' + role + ' tipo=' + tipo + ' stop=' + stop + ' bytes=' + largo);
    if (n++ > 12) break;
  }
}
console.log('  total coincidencias: ' + n);

// Verifica si el bloque "Para escuchar" de mis respuestas entra en el contexto que recibe el modelo.
import fs from 'node:fs';
import path from 'node:path';
const dirs = ['C:/Aegis-Proyects/state/data/logs', 'C:/Aegis-Proyects/state/state/logs'];
let files = [];
for (const d of dirs) {
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d)) if (f.startsWith('llm_request') && f.endsWith('.jsonl')) {
    const p = path.join(d, f);
    files.push({ p, m: fs.statSync(p).mtimeMs, s: fs.statSync(p).size });
  }
}
files.sort((a, b) => b.m - a.m);
console.log('logs de request: ' + files.length);
let assistantBlocks = 0, userMentions = 0, analizados = 0, ejemplo = null;
for (const f of files.slice(0, 3)) {
  const lineas = fs.readFileSync(f.p, 'utf8').split('\n').filter(Boolean);
  console.log('  ' + path.basename(f.p) + ' (' + (f.s / 1024).toFixed(0) + ' KB, ' + lineas.length + ' requests, ' + new Date(f.m).toISOString() + ')');
  for (const l of lineas) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    const msgs = (j && j.input && j.input.messages) || (j && j.messages) || [];
    if (!Array.isArray(msgs)) continue;
    analizados++;
    for (const m of msgs) {
      const txt = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
      if (!txt.includes('Para escuchar')) continue;
      if (m.role === 'assistant') { assistantBlocks++; if (!ejemplo) { const i = txt.indexOf('Para escuchar'); ejemplo = txt.slice(Math.max(0, i - 120), i + 200); } }
      else userMentions++;
    }
  }
}
console.log('requests analizados: ' + analizados);
console.log('mensajes de ASSISTANT (mis respuestas) con el bloque: ' + assistantBlocks);
console.log('mensajes de USER que lo mencionan (prompts/instrucciones): ' + userMentions);
if (ejemplo) console.log('ejemplo dentro de un mensaje mio: ...' + ejemplo.replace(/\s+/g, ' ') + '...');

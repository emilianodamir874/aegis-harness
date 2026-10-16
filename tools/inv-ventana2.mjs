import fs from 'node:fs';
import path from 'node:path';
const base = 'C:/Aegis-Proyects/state/state/logs';
function walk(d, acc = []) { if (!fs.existsSync(d)) return acc; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, acc); else acc.push(p); } return acc; }
const desde = Date.parse('2026-10-16T00:40:00Z');
const hallados = [];
for (const f of walk(base)) {
  let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
  for (const l of txt.split('\n')) {
    const m = l.match(/"timestamp":"([^"]+)"/);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (Number.isNaN(t) || t < desde) continue;
    if (!/upstream_stream_interrupted|Connection reset without closing|host remoto|database is locked|LLM provider error|WebSocket error|compaction/i.test(l)) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    hallados.push({ t, nivel: j.level, msg: String((j.fields && (j.fields.message || j.fields.error)) || ''), span: j.span || {}, f: path.basename(f) });
  }
}
hallados.sort((a, b) => a.t - b.t);
console.log('eventos relevantes: ' + hallados.length);
for (const h of hallados.slice(-22)) {
  const prov = h.span['gen_ai.provider.name'] || '';
  const mod = h.span['gen_ai.request.model'] || '';
  const sid = h.span['session.id'] || h.span['gen_ai.conversation.id'] || '';
  console.log(new Date(h.t).toISOString().slice(11, 19) + ' ' + (h.nivel || '?') + ' [' + prov + '/' + mod + ' sesion ' + sid + '] ' + h.msg.replace(/\s+/g, ' ').slice(0, 300));
}
const porProv = {};
for (const h of hallados) { const k = (h.span['gen_ai.provider.name'] || '?') + ' / ' + (h.span['gen_ai.request.model'] || '?'); porProv[k] = (porProv[k] || 0) + 1; }
console.log('agrupado: ' + JSON.stringify(porProv));

// Reenvía "Vamos con todo!!" a _36 (quedó persistido sin run que lo levante).
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
const SID = '20261012_36';
const TEXT = '[Reenvío del asistente: el "Vamos con todo!!" de Emiliano (18:08) quedó escrito en el chat pero ningún run lo levantó — se perdió al vuelo. El asistente lo reenvía: Emiliano dio luz verde a los DOS pendientes: (1) MOBI/AZW3 real — conseguí uno real (Z-Library) y probá el parser en serio; (2) flasheá la imagen de las 13:26 en la tablet para que un reinicio limpio deje el lector v3 + estos arreglos instalados de fábrica. Contá el plan en una línea y andá con todo.]';

let id = 0; const pend = new Map();
const ws = new WebSocket(url);
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && m.method === undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'session/request_permission') {
    const opt = (m.params.options || []).find((o) => o.optionId === 'allow_once') || m.params.options[0];
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: opt.optionId } } }));
  }
});
await new Promise((r) => ws.addEventListener('open', r));
const req = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(Object.assign(new Error(m.error.message || 'rpc'), { raw: m.error })) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'resume-36b', version: '1' } });
const t0 = Date.now();
try {
  const r = await req('session/prompt', { sessionId: SID, prompt: [{ type: 'text', text: TEXT }] });
  console.log(`OK — turno en _36 termino tras ${Math.round((Date.now() - t0) / 1000)}s:`, JSON.stringify(r).slice(0, 200));
} catch (e) {
  console.log('ERROR:', JSON.stringify(e.raw || e.message).slice(0, 250));
}
ws.close(); process.exit(0);

// Reenvía a _36 el mensaje que quedó sin respuesta ("vos podes sacar screenshots").
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
const SID = '20261012_36';
const TEXT = '[Reenvío del asistente: tu mensaje de las 17:27 quedó sin respuesta (el turno anterior terminó sin levantarlo — el server descarta indicaciones en cola al cerrar un run). El mensaje de Emiliano que quedó sin contestar fue:] vos podes sacar screenshots. [Pedido: respondelo y hacé lo que pide — el round de captura documentado para que vea las pantallas del lector en la tablet.]';

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
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'resume-36', version: '1' } });
try {
  const r = await req('session/prompt', { sessionId: SID, prompt: [{ type: 'text', text: TEXT }] });
  console.log('OK — turno en _36 completo:', r && r.stopReason);
  console.log('(el cliente lo verá al reabrir/refrescar la sesión)');
} catch (e) {
  console.log('ERROR:', JSON.stringify(e.raw || e.message).slice(0, 250));
}
ws.close(); process.exit(0);

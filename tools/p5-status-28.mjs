// Avisa a la sesión _28 (aegis): el Punto 5 ya está implementado; detalles + pedido.
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/goose-web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
const SID = '20261012_28';
const TEXT = '[Estado del Punto 5: YA IMPLEMENTADO por el asistente en el cliente — NO lo re-implementes; rebasá tus ediciones de `app.js` sobre la versión actual (toqué el archivo hoy ~17:07; backups `app.js.bak-pre-detach` y `.bak-pre-btnnew`). Qué quedó hecho: `detachRunView()` (libera la vista sin ceremonias; el run sigue en el server y `checkAdoptedRun()` lo re-adopta al volver); `openSession` y `newSession` lo llaman; el handler de `#btn-new` ya no bloquea (tenía su propia guarda "Esperá a que termine" — era el faltante que reportó Emiliano); `sendText` captura la sesión del turno y no toca la UI si la resolución llega con la vista en otro chat; `onUpdate` ya filtraba por `sessionId` (v6.2). Verificado con 3 checks nuevos en `ui/desktop/scripts/`: `goose-web-switch-check.mjs`, `-newchat-check.mjs`, `-owner-switch-check.mjs` (los 3 verdes; el owner con run verificado VIVO desde afuera al cambiar). Detalle aparte para revisar en tu ronda: vi un tool card marcado "· interrumpido (sin resultado)" con el run TODAVÍA VIVO (tu build del serve v3 quedó así en una vista recargada) — el sweep de interrumpidos parece correr antes de adoptar el run; que un card pendiente con run activo no quede como interrumpido (o que se auto-corrija al completarse).]';

let id = 0; const pend = new Map();
const ws = new WebSocket(url);
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id !== undefined && m.method === undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
const req = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(Object.assign(new Error(m.error.message || 'rpc'), { raw: m.error })) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'p5-status', version: '1' } });
let runId = null;
try {
  await req('_aegis/unstable/session/steer', { sessionId: SID, prompt: [{ type: 'text', text: '.' }], expectedRunId: 'probe' + Math.random().toString(36).slice(2) });
} catch (e) {
  const d = e.raw && e.raw.data;
  if (d && typeof d === 'object' && d.actualRunId) runId = d.actualRunId;
}
try {
  if (runId) {
    const r = await req('_aegis/unstable/session/steer', { sessionId: SID, prompt: [{ type: 'text', text: TEXT }], expectedRunId: runId });
    console.log('STEER enviado ✓', JSON.stringify(r).slice(0, 160));
  } else {
    const r = await req('session/prompt', { sessionId: SID, prompt: [{ type: 'text', text: TEXT }] });
    console.log('PROMPT enviado ✓');
  }
} catch (e) {
  console.log('FALLÓ:', JSON.stringify(e.raw || e.message).slice(0, 200));
}
ws.close(); process.exit(0);

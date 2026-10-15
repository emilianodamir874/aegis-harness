// Aviso a _28: watchdog huérfano implementado + hallazgo del steer descartado en el cierre.
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/goose-web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
const SID = '20261012_28';
const TEXT = '[Notas del asistente (cliente, app.js): 1) Watchdog de turno HUÉRFANO implementado (no dupliques; rebasá app.js sobre el estado actual, backups .bak-pre-detach/.bak-pre-btnnew/.bak-pre-watchdog): si estamos busy como dueños y el server ya no tiene run activo (doble sonda, gracia 4 s, tick 15 s), el cliente libera la consola, reenvía la cola y settleSteers — mata el caso "después de mandar un mensaje no puedo enviar más" (prompt sin respuesta por run muerto en silencio). Test: ui/desktop/scripts/goose-web-watchdog-sanity.mjs. 2) Hallazgo para tu punto 1/5: un steer ACEPTADO y persistido que el turno cierra sin consumir (clear_active_run → discard_pending_steers) queda como mensaje sin respuesta; finishSettle lo marca "recibida" por estar en el historial (persistido ≠ consumido) — revisar esa lógica. Caso vivo: sesión 20261012_36, "vos podes sacar screenshots" (17:27:57) — lo reenvié a mano. 3) DATO DEL CASO: TU run murió en silencio a las 17:18:50 en medio del análisis de deadrun-live (mismo bug de la clase punto 1; sin mensaje final, sin run activo). Retomá desde ahí: ¿cómo venía el serve v3 (¿se construyó?) y el resto de la ronda?]';

let id = 0; const pend = new Map();
const ws = new WebSocket(url);
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id !== undefined && m.method === undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
const req = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(Object.assign(new Error(m.error.message || 'rpc'), { raw: m.error })) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'wd-note', version: '1' } });
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
    console.log('STEER enviado ✓', JSON.stringify(r).slice(0, 140));
  } else {
    const r = await req('session/prompt', { sessionId: SID, prompt: [{ type: 'text', text: TEXT }] });
    console.log('PROMPT enviado ✓ (no había run activo)');
  }
} catch (e) {
  console.log('FALLÓ:', JSON.stringify(e.raw || e.message).slice(0, 180));
}
ws.close(); process.exit(0);

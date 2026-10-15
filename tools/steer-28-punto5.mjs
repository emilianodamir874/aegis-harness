// Manda el Punto 5 (cambiar de chat con turno en curso) a la sesión _28.
// Si hay run activo → steer con el runId real; si no → prompt normal.
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
const SID = '20261012_28';
const TEXT = '[Punto 5 (pedido directo de Emiliano, prioridad ALTA en esta ronda): "no me gusta que no me deje cambiar de chat si está en streaming el que estoy". Hoy `openSession` bloquea el cambio con el aviso "Esperá a que termine la respuesta actual." cuando state.busy. Comportamiento pedido: poder cambiar de chat aunque haya un turno en curso (propio o adoptado): (a) el run sigue en el server, no se cancela; (b) los `session/update` de una sesión que NO es la visible NO se renderizan (filtrar por `params.sessionId` en el handler de updates y en `noteRunActivity` — hoy van al view actual); (c) la barra/Detener aplican solo a la sesión visible; al VOLVER a la sesión con el run, `checkAdoptedRun()` ya re-adopta (barra + refresco periódico — esto ya funciona); (d) la resolución del `session/prompt` propio no debe tocar la UI si mientras tanto cambiaste de sesión (guard: sesión de la respuesta ≠ state.current ⇒ no tocar setBusy/runBar/finishStream); (e) mismo cuidado para "+ Nuevo chat" y para renombrar/borrar durante un run. Test: cambiar de sesión en medio de un run con chunks llegando; sin contaminación cruzada; al volver: barra + Detener + refresco OK; el run termina sano.]';

let id = 0; const pend = new Map();
const ws = new WebSocket(url);
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id !== undefined && m.method === undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
const req = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(Object.assign(new Error(m.error.message || 'rpc'), { raw: m.error })) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'steer-28', version: '1' } });

// 1) ¿run activo?
let runId = null;
try {
  await req('_aegis/unstable/session/steer', { sessionId: SID, prompt: [{ type: 'text', text: '.' }], expectedRunId: 'probe' + Math.random().toString(36).slice(2) });
} catch (e) {
  const d = e.raw && e.raw.data;
  if (d && typeof d === 'object' && d.actualRunId) runId = d.actualRunId;
}
console.log('run activo en _28:', runId);
try {
  if (runId) {
    const r = await req('_aegis/unstable/session/steer', { sessionId: SID, prompt: [{ type: 'text', text: TEXT }], expectedRunId: runId });
    console.log('STEER enviado ✓', JSON.stringify(r).slice(0, 200));
  } else {
    const r = await req('session/prompt', { sessionId: SID, prompt: [{ type: 'text', text: TEXT }] });
    console.log('PROMPT enviado ✓ (no había run; startReason:', r && r.stopReason, ')');
  }
} catch (e) {
  console.log('FALLÓ:', JSON.stringify(e.raw || e.message).slice(0, 300));
}
ws.close(); process.exit(0);

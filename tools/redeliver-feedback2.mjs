// Redelivery #2: feedback de Emiliano sobre recarga/streaming + evidencia de
// prueba en vivo sobre v5. Sesión nueva, corre desprendido.
import { readFile } from 'node:fs/promises';

const cfg = JSON.parse(await readFile('C:/aegis-web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;

const PREFACE =
  '[Reenvío del asistente de Emiliano. Contexto: venís de la sesión "Feedback UI móvil (3 puntos)" donde desplegaste la v5. ' +
  'Emiliano la usó y escribió el siguiente mensaje a las 13:43, PERO quedó sin respuesta: entró como steer/indicación al turno ' +
  'en curso y el turno terminó sin consumirlo (ni tu respuesta final lo menciona). Además el asistente reprodujo el escenario en vivo ' +
  'sobre la v5 y encontró huecos que confirman su reporte: (a) turno largo en curso → recargar la página → durante ~75s de una ' +
  'herramienta silenciosa NO aparece la barra "Aegis está trabajando…" ni Detener, y no llegan actualizaciones (parece muerto y hay ' +
  'que recargar a mano, exactamente lo que él describe); (b) en esa ventana, enviar un mensaje NO se encola ni steer-ea (la UI cree ' +
  'que no hay run) y no da feedback claro; (c) un steer que el turno no consume queda persistido sin respuesta para siempre; ' +
  '(d) Detener sí funciona (75 ms) cuando la barra está visible ✓. El mensaje de Emiliano:]';

const HIS =
  'por las dudas aviso, cuando yo recargaba la pagina ya perdia el streaming, no podia pausarlo ni continuaba. Requiero de recargar activamente lla pagina para ver las actualizaciones del chat.';

const TEXT = PREFACE + '\n\n---\n' + HIS + '\n---\n\nPedidos concretos: 1) al recargar en medio de un turno, adoptar el run de inmediato (aunque la herramienta esté en silencio): la barra de trabajo y Detener deberían aparecer solas y el cliente debería resincronizarse (session/info o equivalente) sin necesidad de recargar a mano para ver avances. 2) Un steer que el turno termina sin consumir: decidir y resolver — p.ej. reencolarlo como prompt normal al terminar y avisar en la UI. 3) Verificar con tu phone-audit el caso "recarga durante tool silencioso".';

let id = 0;
const pend = new Map();
let tools = 0;
let textBuf = '';
const ws = new WebSocket(url);
const t0 = Date.now();
const log = (...a) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && m.method === undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'session/request_permission') {
    const opt = (m.params.options || []).find((o) => o.optionId === 'allow_once') || m.params.options[0];
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: opt.optionId } } }));
    return;
  }
  if (m.method === 'session/update' && m.params && m.params.update) {
    const u = m.params.update;
    if (u.sessionUpdate === 'tool_call' && u.status !== 'in_progress') { tools += 1; log('tool:', (u.title || u.kind || '?').slice(0, 95)); }
    if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.type === 'text') { textBuf += u.content.text; if (textBuf.length % 1200 < 60) log('streaming…', textBuf.slice(-120).replace(/\n/g, ' ')); }
  }
});
await new Promise((res) => ws.addEventListener('open', res));
const req = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error).slice(0, 200))) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });

await req('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { aegis: { customNotifications: true } } }, clientInfo: { name: 'redeliver2', version: '1' }, _meta: { 'aegis/useLoginShellPath': true } });
const s = await req('session/new', { cwd: cfg.cwd, mcpServers: [] });
log('sesión nueva:', s.sessionId);
try { await req('_aegis/unstable/session/rename', { sessionId: s.sessionId, title: 'Feedback recarga y streaming (2)' }); log('renombrada'); } catch (e) { log('rename falló:', String(e).slice(0, 120)); }

log('enviando prompt…');
try {
  const res = await req('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: TEXT }] });
  log('PROMPT COMPLETO — stopReason:', res && res.stopReason, '| tools:', tools);
  console.log('--- final ---');
  console.log(textBuf.slice(-400));
} catch (e) {
  log('PROMPT FALLÓ:', String(e).slice(0, 300));
}
ws.close();
process.exit(0);

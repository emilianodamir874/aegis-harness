// Reanuda la sesión _23 tras la muerte silenciosa del run (14:53:50).
// Le da a goose: el estado (run muerto, shell completado pero resultado perdido),
// los artefactos listos, el mensaje pendiente que se perdió, y su propio plan.
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/goose-web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
const SID = '20261012_23';

const TEXT = '[Reanudación del asistente de Emiliano. Tu run anterior murió en silencio a las 14:53:50, justo después del thinking en el que planificabas: S = stream-typing, A = adopted con ventanas A/B. El shell del stream-typing SÍ se ejecutó (su salida quedó escrita en tools/stream-typing.json a las 14:55) pero el resultado nunca te llegó y el run desapareció sin persistir nada — si podés, anotalo como bug de runtime del serve (herramienta completada, resultado perdido).\n\n' +
'Artefactos listos en C:/goose-web/tools/:\n' +
'- info-probe.json: el poll dispara — messageCount 1→2→4→5→6→7→8 en 30 s; steer devuelve el runId real; cierre end_turn. ✓\n' +
'- stream-typing.json (S, CPU 4x): reposo p50 3.2 ms; streaming1 p50 8.9 / p95 17.9 / longTasks 0; streaming2 (200 teclas) p50 18.9 / p95 19.4; trasTerminar p50 2.8. ✓\n' +
'- typing-check.json: adopción 469 ms con barra+aviso; secciones A/B (poll on/off) y D (Detener 1317 ms → cancelled). ✓\n' +
'Mensaje que quedó sin respuesta (se perdió al morir el run): "El primer resultado tiene un sesgo de tiempo: el poll sí dispara (aquí messageCount cambió 6 veces en 30 s). Mi ventana de 8 s no lo alcanzó. Ahora mido bien los dos escenarios."\n\n' +
'Retomá tu plan desde donde quedó: (1) leé tools/stream-typing.json y cerrá S (¿el lag de tecleo está en streaming?); (2) reescribí typing-adopt-check como planeaste (PASOS=20, SEGS=3, ventana A watch ON vs B watch OFF de 25 s cada una, con measure devolviendo samples; después C steer y D detener) y corrélo para cerrar A con datos de resyncs reales; (3) si falta algo, medilo; después resumen corto: qué encontraste, si hace falta tocar el cliente, y próximos pasos. (4) opcional menor: el tool card del shell que quedó colgado del run muerto se ve girando para siempre en el replay — decidí si vale pintarlo como "interrumpido" en una v6.2.]';

let id = 0; const pend = new Map(); let tools = 0; let textBuf = '';
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
    if (u.sessionUpdate === 'tool_call' && u.status !== 'in_progress') { tools += 1; log('tool:', (u.title || u.kind || '?').slice(0, 90)); }
    if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.type === 'text') { textBuf += u.content.text; if (textBuf.length % 1500 < 80) log('streaming…', textBuf.slice(-100).replace(/\n/g, ' ')); }
    if (u.sessionUpdate === 'tool_call_update' && u.status) { if (u.status !== 'in_progress') log('tool_update:', u.status, ((u.title || '')).slice(0, 70)); }
  }
});
await new Promise((r) => ws.addEventListener('open', r));
const req = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error).slice(0, 200))) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });

await req('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { goose: { customNotifications: true } } }, clientInfo: { name: 'resume23', version: '1' }, _meta: { 'goose/useLoginShellPath': true } });
log('reanudando sesión', SID);
try {
  const res = await req('session/prompt', { sessionId: SID, prompt: [{ type: 'text', text: TEXT }] });
  log('PROMPT COMPLETO — stopReason:', res && res.stopReason, '| tools:', tools);
  console.log('--- final ---');
  console.log(textBuf.slice(-500));
} catch (e) {
  log('PROMPT FALLÓ:', String(e).slice(0, 300));
}
ws.close();
process.exit(0);

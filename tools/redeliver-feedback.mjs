// Reenvía a aegis (sesión nueva) el feedback de Emiliano que quedó sin
// respuesta en "aegis-web UI perfection" (el turno murió por auto-compactación).
// Incluye la foto original adjunta. Corre desprendido; escribe progreso.
import { readFile } from 'node:fs/promises';

const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
const b64 = (await readFile('C:/Aegis-Proyects/web/tools/user-photo.jpg')).toString('base64');

const PREFACE =
  '[Feedback de Emiliano sobre la UI de aegis-web, reenviado por su asistente a una sesión nueva: ' +
  'el turno anterior (sesión "aegis-web UI perfection") quedó sin respuesta porque esa sesión estaba al ' +
  'límite de contexto y la auto-compactación se lo comió. La foto adjunta es una captura del celular (~390px).]';
const HIS =
  'Te paso una foto de como se ve. Arriba izquierda no veo todos los desplegables. Además escribir en la barra por celular se nota lento. Si lo hago muy rápido se pierden caracteres. Además no puedo notar cuando termina el streaming de la respuesta o detenerlo.';
const TEXT = PREFACE + '\n\n' + HIS;

let id = 0;
const pend = new Map();
let msgs = 0;
let tools = 0;
let textBuf = '';
let permSeen = false;
const ws = new WebSocket(url);
const t0 = Date.now();
const log = (...a) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && m.method === undefined && pend.has(m.id)) {
    pend.get(m.id)(m);
    pend.delete(m.id);
    return;
  }
  if (m.method === 'session/request_permission') {
    permSeen = true;
    const opt = (m.params.options || []).find((o) => o.optionId === 'allow_once') || m.params.options[0];
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: opt.optionId } } }));
    log('permiso respondido (allow_once)');
    return;
  }
  if (m.method === 'session/update' && m.params && m.params.update) {
    const u = m.params.update;
    if (u.sessionUpdate === 'tool_call' && u.status !== 'in_progress') {
      tools += 1;
      log('tool:', (u.title || u.kind || '?').slice(0, 90));
    }
    if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.type === 'text') {
      textBuf += u.content.text;
      msgs += 1;
      if (msgs % 40 === 0) log('streaming…', textBuf.slice(-140).replace(/\n/g, ' '));
    }
  }
});
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', () => rej(new Error('ws error')));
});
const req = (method, params) =>
  new Promise((res, rej) => {
    const mid = ++id;
    pend.set(mid, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error).slice(0, 200))) : res(m.result)));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }));
  });

await req('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { aegis: { customNotifications: true } } }, clientInfo: { name: 'redeliver', version: '1' }, _meta: { 'aegis/useLoginShellPath': true } });
const s = await req('session/new', { cwd: cfg.cwd, mcpServers: [] });
log('sesión nueva:', s.sessionId);
try {
  await req('_aegis/unstable/session/rename', { sessionId: s.sessionId, title: 'Feedback UI móvil (3 puntos)' });
  log('renombrada -> "Feedback UI móvil (3 puntos)"');
} catch (e) {
  log('rename falló:', String(e).slice(0, 140));
}

log('enviando prompt con foto (' + Math.round(b64.length / 1024) + ' KB b64)…');
try {
  const res = await req('session/prompt', {
    sessionId: s.sessionId,
    prompt: [
      { type: 'text', text: TEXT },
      { type: 'image', mimeType: 'image/jpeg', data: b64 },
    ],
  });
  log('PROMPT COMPLETO — stopReason:', res && res.stopReason, '| tools:', tools, '| permitido:', permSeen);
  log('últimos 200 chars de la respuesta:');
  console.log(textBuf.slice(-200));
} catch (e) {
  log('PROMPT FALLÓ:', String(e).slice(0, 300));
}
ws.close();
process.exit(0);

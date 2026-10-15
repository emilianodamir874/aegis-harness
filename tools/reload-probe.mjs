// Probe: ¿una conexión NUEVA (pestaña recargada) recibe el streaming de un run
// que arrancó OTRA conexión? ¿Y qué devuelve un steer con expectedRunId falso?
//  - wsA arranca un turno largo con una herramienta silenciosa (~35 s).
//  - a los 5 s, wsB se conecta, hace session/load y registra TODO lo que recibe.
//  - wsB sondea el run activo con un steer de expectedRunId inválido.
//  - al final borra la sesión de prueba.
import { readFile } from 'node:fs/promises';

const cfg = JSON.parse(await readFile('C:/goose-web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;

function client(name) {
  let id = 0;
  const pend = new Map();
  const notes = [];
  const ws = new WebSocket(url);
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id !== undefined && m.method === undefined) {
      const p = pend.get(m.id);
      if (p) { pend.delete(m.id); p(m); }
      return;
    }
    if (m.method === 'session/request_permission') {
      const opt = m.params?.options?.[0]?.optionId ?? 'allow';
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: opt } } }));
      notes.push({ t: Date.now(), kind: 'permission-auto-answered' });
      return;
    }
    if (m.method) notes.push({ t: Date.now(), method: m.method, update: m.params?.update?.sessionUpdate, meta: m.params?.update?._meta, text: m.params?.update?.content?.text });
  });
  const req = (method, params) =>
    new Promise((res, rej) => {
      const mid = ++id;
      pend.set(mid, (m) => (m.error ? rej(Object.assign(new Error(method), { err: m.error })) : res(m.result)));
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }));
    });
  const open = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('ws error ' + name)));
  });
  const init = () => req('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { aegis: { customNotifications: true } } }, clientInfo: { name, version: '1' }, _meta: { 'aegis/useLoginShellPath': true } });
  return { name, ws, req, open, init, notes };
}

const out = {};
const A = client('probe-A');
await A.open;
await A.init();
const ns = await A.req('session/new', { cwd: cfg.cwd, mcpServers: [] });
const sid = ns.sessionId;
out.sessionId = sid;
A.notes.length = 0;

// turno largo: herramienta silenciosa de ~35 s
const promptP = A.req('session/prompt', {
  sessionId: sid,
  prompt: [{ type: 'text', text: 'Ejecutá exactamente este comando con la herramienta de shell y esperá a que termine: powershell -NoProfile -Command "Start-Sleep -Seconds 35; Write-Output FIN-PROBE". Después respondé exactamente: LISTO-PROBE' }],
}).then((r) => (out.promptA = { stopReason: r?.stopReason }), (e) => (out.promptAErr = String(e?.err || e).slice(0, 300)));

await new Promise((r) => setTimeout(r, 5000));
out.A_al_5s = A.notes.map((n) => n.update || n.kind || n.method).slice(-6);

// ---- conexión nueva, como una pestaña recargada ----
const B = client('probe-B');
await B.open;
await B.init();
const tLoad = Date.now();
const loaded = await B.req('session/load', { sessionId: sid, cwd: cfg.cwd, mcpServers: [] });
out.loadB = { ms: Date.now() - tLoad, configOptions: (loaded?.configOptions || []).length, meta: loaded?._meta || null };
out.B_tras_load = B.notes.map((n) => n.update || n.method);
B.notes.length = 0;

// sondeo del run activo (expectedRunId inválido)
try {
  const r = await B.req('_aegis/unstable/session/steer', {
    sessionId: sid,
    prompt: [{ type: 'text', text: '(sondeo de run activo)' }],
    expectedRunId: 'run_sondeo-invalido',
  });
  out.sondeo = { ok: true, result: r };
} catch (e) {
  out.sondeo = { ok: false, error: e.err || String(e) };
}

// esperar lo que queda del turno (+ margen)
await new Promise((r) => setTimeout(r, 40000));
out.B_durante_el_resto = B.notes.map((n) => ({ u: n.update || n.method, meta: n.meta ?? undefined, text: n.text != null ? String(n.text).slice(0, 40) : undefined }));
await promptP;
out.B_al_final = B.notes.slice(-8).map((n) => ({ u: n.update || n.method, meta: n.meta ?? undefined, text: n.text != null ? String(n.text).slice(0, 60) : undefined }));
out.A_total_notas = A.notes.length;

// ¿session/info trae algo sobre el run?
try {
  out.info = await B.req('_aegis/unstable/session/info', { sessionId: sid });
} catch (e) {
  out.infoErr = String(e?.err || e).slice(0, 200);
}
await A.req('session/delete', { sessionId: sid }).catch(() => {});
A.ws.close(); B.ws.close();
console.log(JSON.stringify(out, null, 1));
process.exit(0);

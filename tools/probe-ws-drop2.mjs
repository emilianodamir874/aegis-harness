// EXPERIMENTO (v2, a prueba de balas): ¿un corte de la WS dueña mata el run?
// c1 crea sesión de prueba y lanza un prompt con tool lenta (~40s).
// c2 (otra conexión, queda abierta) sondea el run ANTES y DESPUÉS de cerrar c1.
// Al final imprime el sid para verificar en la DB si se persistió la respuesta.
import { readFile } from 'node:fs/promises';

const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const at = () => '+' + ((Date.now() - t0) / 1000).toFixed(1) + 's';

function connect(name) {
  const ws = new WebSocket(url);
  let id = 0;
  const pend = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id !== undefined && m.method === undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws error'))); });
  const req = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    pend.set(mid, (m) => (m.error ? rej(Object.assign(new Error(name + ':' + method), { raw: m.error })) : res(m.result)));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }));
  });
  const init = async () => { await ready; await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name, version: '1' } }); };
  return { ws, req, init };
}
const probe = async (c, sid) => {
  try { await c.req('_aegis/unstable/session/steer', { sessionId: sid, prompt: [{ type: 'text', text: '.' }], expectedRunId: 'probe' + Math.random().toString(36).slice(2) }); return 'ok(no error)'; }
  catch (e) {
    const d = e.raw && e.raw.data;
    if (typeof d === 'string') return d;
    if (d && d.actualRunId) return 'RUN=' + d.actualRunId;
    if (d && d.message) return 'RUN=' + (String(d.message).match(/run_[0-9a-f-]+/) || ['?'])[0];
    return JSON.stringify(d).slice(0, 120);
  }
};

const out = { log: [] };
const c1 = connect('exp-c1');
await c1.init();
const s1 = await c1.req('session/new', { cwd: cfg.cwd, mcpServers: [] });
const sid = s1.sessionId;
out.sid = sid;
c1.ws.addEventListener('close', () => out.log.push([at(), 'c1 WS CLOSED']));
c1.req('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'Corré shell: powershell -NoProfile -Command "Start-Sleep -Seconds 40". Cuando termine, respondé exactamente ZZ-DROP-DONE.' }] })
  .then((r) => out.log.push([at(), 'c1 prompt resolved stopReason=' + (r && r.stopReason)]))
  .catch((e) => out.log.push([at(), 'c1 prompt error: ' + String((e.raw && e.raw.data) || e.message).slice(0, 120)]));

await sleep(1000);
const c2 = connect('exp-c2');
await c2.init();
out.log.push([at(), 'c2 probe (c1 abierta): ' + (await probe(c2, sid))]);
await sleep(5000);
out.log.push([at(), 'c2 probe (c1 abierta): ' + (await probe(c2, sid))]);

out.log.push([at(), 'CLOSING c1 NOW']);
c1.ws.close();
for (const w of [3000, 7000, 15000, 20000, 25000, 30000]) {
  await sleep(w);
  out.log.push([at(), 'c2 probe: ' + (await probe(c2, sid))]);
}
try {
  const l = await c2.req('session/list', { meta: { aegis: { includeLastMessageSnippet: true } } });
  const s = (l.sessions || []).find((x) => x.sessionId === sid);
  out.snippet = s && s._meta && s._meta.lastMessageSnippet;
} catch (e) { out.snippetErr = String(e.message); }
await c2.req('session/delete', { sessionId: sid }).catch(() => {});
c2.ws.close();
console.log(JSON.stringify(out, null, 1));
process.exit(0);

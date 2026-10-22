// ¿Qué modelos del proveedor activo NO razonan? Crea una sesión por modelo, manda un prompt
// trivial en modo chat y mira si la respuesta trae bloque "thinking" en la DB. Archiva todo.
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
const wsUrl = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
const cwd = cfg.cwd || 'C:/Aegis-Proyects';
const modelos = (process.env.MODELOS || 'glm-5.3-flash,minimax-m3.1-flash-free,longcat-2.0,mimo-v2.6-flash').split(',');

let id = 0;
const pend = new Map();
const ws = new WebSocket(wsUrl);
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && m.method === undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
await new Promise((res) => ws.addEventListener('open', res));
const req = (method, params) => new Promise((res, rej) => {
  const mid = ++id;
  pend.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }));
});
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'no-thinking', version: '1' } });

const db = new DatabaseSync('C:/Aegis-Proyects/state/data/sessions/sessions.db', { readOnly: true });

for (const modelo of modelos) {
  let sid = '';
  const t0 = Date.now();
  try {
    const nuevo = await req('session/new', { cwd, mcpServers: [] });
    sid = nuevo.sessionId;
    await req('session/set_config_option', { sessionId: sid, configId: 'model', value: modelo });
    await req('session/set_mode', { sessionId: sid, modeId: 'chat' });
    await req('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'Respondé solo con la palabra ok.' }] });
    const row = db.prepare("select content_json from messages where session_id = ? and role = 'assistant' order by rowid desc limit 1").get(sid);
    let kinds = [];
    if (row) {
      try { kinds = JSON.parse(row.content_json).map((b) => b.type); } catch (e) { kinds = ['?']; }
    }
    const razona = kinds.includes('thinking');
    console.log((razona ? 'RAZONA ' : 'LIMPIO ') + modelo.padEnd(26) + ' ' + JSON.stringify(kinds) + '  (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)');
  } catch (e) {
    console.log('ERROR  ' + modelo.padEnd(26) + ' ' + String(e.message).slice(0, 140));
  } finally {
    if (sid) { try { await req('_aegis/unstable/session/archive', { sessionId: sid }); } catch (e) {} }
  }
}
ws.close();
process.exit(0);

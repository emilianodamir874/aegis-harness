// Para open_design y opencode_go: qué valores de thinking_effort ofrece el harness y qué hace
// el API con cada uno (error / razona / latencia). Crea una sesión por proveedor y la archiva.
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
const wsUrl = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
const cwd = cfg.cwd || 'C:/Aegis-Proyects';
const MODELO = 'deepseek-v4.1-flash';
const PROVEEDORES = ['opencode_go', 'open_design'];

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
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'effort-probe', version: '1' } });
const db = new DatabaseSync('C:/Aegis-Proyects/state/data/sessions/sessions.db', { readOnly: true });

const ultimaRespuesta = (sid) => {
  const row = db.prepare("select content_json from messages where session_id = ? and role = 'assistant' order by rowid desc limit 1").get(sid);
  if (!row) return { kinds: [], texto: '' };
  let blocks = [];
  try { blocks = JSON.parse(row.content_json); } catch (e) { return { kinds: [], texto: '' }; }
  const kinds = blocks.map((b) => b.type);
  const texto = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
  return { kinds, texto };
};

for (const prov of PROVEEDORES) {
  let sid = '';
  try {
    const nuevo = await req('session/new', { cwd, mcpServers: [] });
    sid = nuevo.sessionId;
    const r = await req('session/set_config_option', { sessionId: sid, configId: 'provider', value: prov });
    const opts = (r && r.configOptions) || [];
    const effort = opts.find((o) => o && o.id === 'thinking_effort');
    const valores = effort ? (effort.options || []).map((o) => o.value) : [];
    console.log('\n=== ' + prov + ' | modelo ' + MODELO + ' ===');
    console.log('efforts que ofrece el harness: ' + JSON.stringify(valores));
    try { await req('session/set_config_option', { sessionId: sid, configId: 'model', value: MODELO }); }
    catch (e) { console.log('aviso: no pude fijar el modelo: ' + e.message); }
    await req('session/set_mode', { sessionId: sid, modeId: 'chat' });

    for (const valor of valores) {
      const t0 = Date.now();
      let setErr = '';
      try { await req('session/set_config_option', { sessionId: sid, configId: 'thinking_effort', value: valor }); }
      catch (e) { setErr = 'set rechazado'; }
      let promptErr = '';
      if (!setErr) {
        try {
          await req('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'Decí solo: ok' }] });
        } catch (e) { promptErr = String(e.message).slice(0, 90); }
      }
      const ms = Date.now() - t0;
      const { kinds, texto } = promptErr ? { kinds: [], texto: '' } : ultimaRespuesta(sid);
      const razona = kinds.includes('thinking');
      const estado = setErr ? 'SET-RECHAZADO' : promptErr ? 'ERROR: ' + promptErr : razona ? 'RAZONA' : 'LIMPIO';
      console.log('  ' + valor.padEnd(7) + ' ' + estado.padEnd(28) + ' ' + ms + ' ms  ' + JSON.stringify(texto.slice(0, 40)));
    }
  } catch (e) {
    console.log('\n=== ' + prov + ': ERROR ' + e.message);
  } finally {
    if (sid) { try { await req('_aegis/unstable/session/archive', { sessionId: sid }); } catch (e) {} }
  }
}
ws.close();
process.exit(0);

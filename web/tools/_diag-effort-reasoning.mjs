// Con un prompt que SI obliga a razonar, mide cuánto piensa cada effort en cada proveedor.
// Sirve para saber cuál es el effort más bajo que realmente apaga el razonamiento.
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
const wsUrl = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
const cwd = cfg.cwd || 'C:/Aegis-Proyects';
const MODELO = 'deepseek-v4.1-flash';
const PROMPT = 'Un tren sale a las 14:05 y tarda 2 h 37 min. ¿A qué hora llega? Respondé solo la hora.';
const PROVEEDORES = (process.env.PROVS || 'opencode_go,open_design').split(',');
const EFFORTS = (process.env.EFFORTS || 'off,low,medium,high,max').split(',');

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
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'effort-reasoning', version: '1' } });
const db = new DatabaseSync('C:/Aegis-Proyects/state/data/sessions/sessions.db', { readOnly: true });

const ultima = (sid) => {
  const row = db.prepare("select content_json from messages where session_id = ? and role = 'assistant' order by rowid desc limit 1").get(sid);
  if (!row) return { think: 0, texto: '' };
  let blocks = [];
  try { blocks = JSON.parse(row.content_json); } catch (e) { return { think: 0, texto: '' }; }
  const think = blocks.filter((b) => b.type === 'thinking').reduce((n, b) => n + String(b.thinking || '').length, 0);
  const texto = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
  const ultimaThink = blocks.filter((b) => b.type === 'thinking').map((b) => String(b.thinking || '')).join(' ').trim();
  return { think, texto, ultimaThink };
};

for (const prov of PROVEEDORES) {
  let sid = '';
  console.log('\n=== ' + prov + ' | ' + MODELO + ' ===');
  try {
    const nuevo = await req('session/new', { cwd, mcpServers: [] });
    sid = nuevo.sessionId;
    await req('session/set_config_option', { sessionId: sid, configId: 'provider', value: prov });
    try { await req('session/set_config_option', { sessionId: sid, configId: 'model', value: MODELO }); } catch (e) {}
    await req('session/set_mode', { sessionId: sid, modeId: 'chat' });
    // Calentamiento: el primer turno de la sesion puede emitir un bloque thinking minimo
    // que no tiene que ver con el effort (artefacto medido).
    try { await req('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'Decí solo: ok' }] }); } catch (e) {}
    for (const valor of EFFORTS) {
      let setErr = '';
      try { await req('session/set_config_option', { sessionId: sid, configId: 'thinking_effort', value: valor }); }
      catch (e) { setErr = 'set rechazado'; }
      if (setErr) { console.log('  ' + valor.padEnd(7) + ' SET-RECHAZADO'); continue; }
      let err = '';
      const pensares = [];
      let ms = 0;
      let texto = '';
      let ultimaThink = '';
      for (let r = 0; r < 2; r++) {
        const t0 = Date.now();
        try { await req('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: PROMPT }] }); }
        catch (e) { err = String(e.message).slice(0, 80); break; }
        ms += Date.now() - t0;
        const u = ultima(sid);
        pensares.push(u.think);
        texto = u.texto;
        ultimaThink = u.ultimaThink || '';
      }
      if (err) { console.log('  ' + valor.padEnd(7) + ' ERROR ' + err); continue; }
      console.log('  ' + valor.padEnd(7) + ' pensar=' + JSON.stringify(pensares) + '  ' + Math.round(ms / 2) + ' ms/turno  respuesta=' + JSON.stringify(texto.slice(0, 20)) + (pensares.some((n) => n > 0) ? '  [think: ' + JSON.stringify(ultimaThink.slice(0, 70)) + ']' : ''));
    }
  } catch (e) {
    console.log('  ERROR ' + e.message);
  } finally {
    if (sid) { try { await req('_aegis/unstable/session/archive', { sessionId: sid }); } catch (e) {} }
  }
}
ws.close();
process.exit(0);

// Despierta la ronda v6.3 en _28 (run muerto en silencio 17:45; Emiliano pregunto "Y?"/"y?" y quedo colgado).
// Se lanza DESPUES del swap a v3. Fire-and-forget: manda el prompt, espera 20 s de eventos y sale.
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/goose-web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;
const SID = '20261012_28';
const TEXT = '[Relevo del asistente: 1) Tu run de las 17:45 murio en silencio en medio de la verificacion (el mismo bug del punto 1; ya esta su fix en v3). Emiliano te mando "Y?" (18:35) y "y?" (18:35:39) que quedaron sin respuesta POR ESE bug: contestalas y retoma ahi. 2) El asistente acaba de hacer el swap: el serve corriendo es goose-serve-v3.exe con TUS parches (stall watchdog GOOSE_RUN_STALL_TIMEOUT_SECS=900, aviso "se interrumpio de forma inesperada", client_cancelled, touch_progress) — verificalo contra el serve real. 3) El cliente (app.js) ya tiene ademas: detach con turno en curso, watchdog de turno huerfano (+wd) y settle con steerAnsweredInHistory (+sc; README secciones nuevas). 4) Cerra la ronda v6.3: resumen de lo verificado, lo que quedo pendiente y el estado del swap.]';

let id = 0; const pend = new Map(); let eventos = 0;
const ws = new WebSocket(url);
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && m.method === undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'session/request_permission') {
    const opt = (m.params.options || []).find((o) => o.optionId === 'allow_once') || m.params.options[0];
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: opt.optionId } } }));
    return;
  }
  if (m.method === 'session/update') eventos += 1;
});
await new Promise((r) => ws.addEventListener('open', r));
const req = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(Object.assign(new Error(m.error.message || 'rpc'), { raw: m.error })) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'wake-28', version: '1' } });
try {
  deck: {
    // fire-and-forget: no esperamos la respuesta del prompt (llega al fin del turno)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'session/prompt', params: { sessionId: SID, prompt: [{ type: 'text', text: TEXT }] } }));
  }
  await new Promise((r) => setTimeout(r, 20000));
  console.log(`PROMPT enviado a _28. Eventos recibidos en 20s: ${eventos} ${eventos > 0 ? '(el turno arranco ✓)' : '(sin eventos aun — puede estar pensando)'}`);
} catch (e) {
  console.log('ERROR:', JSON.stringify(e.raw || e.message).slice(0, 250));
}
ws.close(); process.exit(0);

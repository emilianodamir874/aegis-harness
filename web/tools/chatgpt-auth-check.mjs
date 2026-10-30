// Prueba de punta a punta del proveedor ChatGPT/Codex contra el serve vivo, sin tocar ninguna
// conversacion existente: crea una sesion nueva, elige el proveedor, manda "ok" y la borra.
// Uso: node tools/chatgpt-auth-check.mjs [url] [proveedor]
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://127.0.0.1:3788/';
const provider = process.argv[3] || 'chatgpt_codex';
const preferModel = process.argv[4] || 'gpt-6.1-sol';

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1200, height: 800 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
await p.goto(url, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.rpc && window.__aegisWeb.rpc.ready === true, null, { timeout: 30000 });
await p.evaluate((m) => { window.__preferModel = m; }, preferModel);

const res = await p.evaluate(async (provider) => {
  const A = window.__aegisWeb;
  const rpc = A.rpc;
  const cwd = (A.state.current && A.state.current.cwd) || A.cfg?.cwd || 'C:/Aegis-Proyects';
  const out = { cwd, provider };
  let sid = null;
  try {
    const n = await rpc.request('session/new', { cwd, mcpServers: [] });
    sid = n.sessionId || (n._meta && n._meta.sessionId);
    out.sid = String(sid).slice(0, 14);
    const opts = n.configOptions || [];
    const prov = opts.find((o) => o.id === 'provider' || o.id === 'model_provider');
    out.proveedores = prov ? (prov.options || []).map((o) => o.value) : null;
    if (prov && (prov.options || []).some((o) => o.value === provider)) {
      await rpc.request('session/set_config_option', { sessionId: sid, configId: prov.id, value: provider });
      out.proveedorElegido = provider;
    } else {
      out.proveedorElegido = 'no disponible: ' + (prov ? (prov.options || []).map((o) => o.value).join(',') : 'sin opcion provider');
    }
    const modelo = opts.find((o) => o.id === 'model');
    out.modeloInicial = modelo ? modelo.currentValue || modelo.value : null;

    // tras cambiar de proveedor el server pone su modelo por defecto (gpt-5.5 para chatgpt_codex,
    // que esta cuenta NO acepta): se mira la lista real y se elige uno valido.
    const opts2 = (await rpc.request('session/load', { sessionId: sid, cwd, mcpServers: [] })).configOptions || [];
    const modelo2 = opts2.find((o) => o.id === 'model');
    if (modelo2) {
      out.modelosDelProveedor = (modelo2.options || []).map((o) => o.value);
      out.modeloActivo = modelo2.currentValue || null;
      const preferido = (typeof window !== 'undefined' && window.__preferModel) || 'gpt-6.1-sol';
      const elegido = (modelo2.options || []).map((o) => o.value).find((v) => v === preferido) || (modelo2.options || [])[0]?.value;
      if (elegido && elegido !== out.modeloActivo) {
        await rpc.request('session/set_config_option', { sessionId: sid, configId: 'model', value: elegido });
        out.modeloElegido = elegido;
      }
    }

    const t0 = performance.now();
    let texto = '';
    let error = null;
    const onMsg = (m) => {
      if (m.method === 'session/update' && m.params && m.params.update) {
        const u = m.params.update;
        if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.type === 'text') texto += u.content.text;
      }
    };
    const previo = rpc.ws.onmessage;
    rpc.ws.onmessage = (ev) => { try { onMsg(JSON.parse(ev.data)); } catch (e) {} if (previo) previo(ev); };
    try {
      await rpc.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'Respondé solamente: ok' }] });
      out.prompt = 'ok';
    } catch (e) {
      error = (e && e.message) || String(e);
      out.prompt = 'error';
      out.error = error;
    }
    rpc.ws.onmessage = previo;
    await new Promise((r) => setTimeout(r, 1500));
    out.ms = Math.round(performance.now() - t0);
    out.respuesta = texto.slice(0, 200);
  } catch (e) {
    out.fallo = (e && e.message) || String(e);
  }
  if (sid) { try { await rpc.request('session/delete', { sessionId: sid }); out.borrada = true; } catch (e) { out.borrada = 'error: ' + ((e && e.message) || e); } }
  return out;
}, provider);

console.log(JSON.stringify({ ...res, erroresPagina: errs }, null, 1));
const ok = res.prompt === 'ok' && res.respuesta;
console.log(ok ? 'OK: el proveedor respondio' : 'FALLA: ' + (res.error || res.fallo || 'sin respuesta'));
await b.close();
process.exit(0);

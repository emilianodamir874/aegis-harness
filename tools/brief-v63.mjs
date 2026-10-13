// Brief v6.3 para goose: mejoras de tokens/velocidad/robustez aprobadas por Emiliano.
// Sesión nueva en el serve v2 (code-mode) — NO reiniciar el serve desde adentro.
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/goose-web/config.json', 'utf8'));
const url = `ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`;

const TEXT = '[Brief del asistente de Emiliano — nueva ronda de mejoras (v6.3). Emiliano aprobó trabajar sobre los 4 puntos del análisis de hoy (tokens / velocidad / robustez). Evidencia y estado abajo; todo es verificable leyendo archivos y la DB.]\n\n' +
'ESTADO ACTUAL (12/10, noche):\n' +
'- Web: serve v2 CON code-mode (`goose-serve-v2.exe`) corriendo en 3284; script `C:/goose-web/scripts/start-goose-web.ps1` (backup `.bak-pre-v2`). CLI: `goose.cmd` → `goose-codemode-v2.exe`. Sesiones NUEVAS corren Code Mode (`execute_typescript`/`list_functions`); las VIEJAS retomadas no lo heredan. OJO: tu propia sesión corre EN este serve — si reconstruís el serve, NO lo reinicies vos (te matarías el turno): construí a nombre nuevo (v3), probá en puerto alterno con `C:/goose-web/tools/smoke-serve-v2.mjs <puerto>`, y dejá el swap final documentado (repunte del script + reinicio cuando no haya runs).\n' +
'- Cliente: v6.2 en producción (soft refresh 39ms, cartas interrumpidas, steer reencolado, sondeo v6.1). README: secciones v6/v6.1/v6.2 + pitfalls.\n' +
'- Análisis de hoy: scripts `C:/goose-web/tools/analyze-sessions.py`, `analyze-speed.py`, `analyze-extra.py` y `session-analysis.json` (datos reales de la DB: 110 sesiones, 4216 llamadas; hoy 672 llamadas / 67,9M tok / 96,4% caché / $0,65).\n\n' +
'LOS 4 PUNTOS:\n' +
'1) ROBUSTEZ — runs que mueren en silencio (el más serio). Evidencia: sesión `20261012_23`, 14:53:50: el run murió a mitad de un thinking; el shell del test SÍ completó (escribió `tools/stream-typing.json` a las 14:55) pero el resultado nunca volvió y el run desapareció sin persistir nada; quedaron 2 tool cards colgadas (lo documentaste como fixture en el README v6.2). Impacto: 39 min muertos y UI muda hasta recargar. Pedido: investigar el ciclo de vida del run en el serve (entrega de resultados de herramientas, timeouts de provider/stream, cancelación) e implementar mitigación backend — watchdog de progreso (N minutos sin avance ⇒ cerrar el run con error VISIBLE) y/o entrega garantizada del resultado. Si es profundo, dejá diagnóstico + plan + mitigación parcial segura.\n' +
'2) CONTEXTO/TOKENS. Evidencia (hoy): contexto pico 194.960 (límite de compactación 200k configurado); compactó 1 vez y volvió a 165k en ~30 llamadas; thinking = 86% del output (_23: 457KB vs 74KB de texto); blobs: 7× `read_image` = 2,7MB base64 en historial, shell hasta 185KB; los resúmenes de pares tool (67 hoy) no cubren imágenes. Pedidos: (a) esfuerzo de razonamiento configurable/expuesto (open_design tiene alias -none/-low/-high/-max; el chip hoy está oculto por tener 1 opción); (b) extender poda/resumen de contexto a imágenes y salidas grandes; (c) evaluar compactar antes (~85%) o podar tool outputs viejos. Números exactos en `session-analysis.json`.\n' +
'3) VELOCIDAD — replay inicial de sesiones enormes (cliente). Evidencia: sesión 1167 mensajes ⇒ bloqueos 200–323ms en la carga inicial (el refresh suave ya está v6.2). Pedido: virtualizar/paginar el render del replay (o diferido), con medición antes/después (`goose-web-phone-audit.mjs` / perf).\n' +
'4) HERRAMIENTAS — cap de salidas. Evidencia: salida máx hoy 185KB shell / 708KB imagen; quedan en el historial para siempre. Verificar el efecto real de `GOOSE_MAX_TOOL_RESPONSE_SIZE: 60000` (config del usuario) y agregar spill automático a archivo con puntero ("salida completa en <path>") para dumps.\n\n' +
'REGLAS: no tocar sesiones vivas; binarios nuevos con nombre nuevo (nunca pisar uno en uso); scripts de verificación Playwright en `ui/desktop/scripts/`; sin commits; README/skills actualizados con lo que cierres; cada cambio con evidencia medida (antes/después), nada de claims sin número. Orden sugerido: 1 → 4 → 3 → 2. Al final: resumen por punto con evidencia. Si algo del punto 1 requiere rebuild del serve, dejalo listo (v3 + prueba en puerto alt) y documentá el swap — lo aplicamos desde afuera cuando termines.]';

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
    if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.type === 'text') { textBuf += u.content.text; if (textBuf.length % 1800 < 90) log('streaming…', textBuf.slice(-110).replace(/\n/g, ' ')); }
  }
});
await new Promise((r) => ws.addEventListener('open', r));
const req = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error).slice(0, 200))) : res(m.result))); ws.send(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })); });

await req('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { goose: { customNotifications: true } } }, clientInfo: { name: 'brief-v63', version: '1' }, _meta: { 'goose/useLoginShellPath': true } });
const s = await req('session/new', { cwd: cfg.cwd, mcpServers: [] });
log('sesión nueva:', s.sessionId);
try { await req('_goose/unstable/session/rename', { sessionId: s.sessionId, title: 'Mejoras v6.3 (tokens/velocidad/robustez)' }); log('renombrada'); } catch (e) { log('rename falló:', String(e).slice(0, 120)); }
log('enviando brief…');
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

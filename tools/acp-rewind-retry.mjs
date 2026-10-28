// Verifica rewind y retry CONTRA EL MOTOR REAL, en una sesiÃ³n desechable que se borra al final.
// Gasta un turno mÃ­nimo: prompt de una palabra y cancel a los 6 s si sigue generando.
// Uso: node tools/acp-rewind-retry.mjs
import { WebSocket } from 'ws';

const config = await (await fetch('http://127.0.0.1:3788/config.js')).text();
const search = new URL(/"acpUrl"\s*:\s*"([^"]+)"/.exec(config)[1]).search;
const socket = new WebSocket(`ws://127.0.0.1:3788/acp${search}`);

let id = 0;
const pending = new Map();
socket.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.method === 'session/update' && msg.params?.update?.sessionUpdate === 'agent_message_chunk') {
    const texto = msg.params.update.content?.text ?? msg.params.update.text ?? '';
    if (texto) respuesta += texto;
  }
  const slot = msg.id !== undefined ? pending.get(msg.id) : undefined;
  if (!slot) return;
  pending.delete(msg.id);
  if (msg.error) slot.reject(new Error(`${msg.error.code}: ${msg.error.message} ${msg.error.data ? JSON.stringify(msg.error.data) : ''}`));
  else slot.resolve(msg.result);
});
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const rid = ++id;
    pending.set(rid, { resolve, reject });
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }));
  });

let respuesta = '';
await new Promise((resolve, reject) => {
  socket.once('open', resolve);
  socket.once('error', reject);
});
await send('initialize', {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: 'aegis-web-react-rewind-probe', version: '0.1.0' },
});

const { sessionId } = await send('session/new', { cwd: 'C:\\Aegis-Proyects', mcpServers: [] });
console.log(`sesion desechable ${sessionId}`);

// El turno termina cuando `watch` deja de informar activeRunId; messageCount solo no alcanza
// (el mensaje del usuario ya cuenta antes de que el agente conteste).
const turnoTerminado = async (etiqueta, maxMs) => {
  const t0 = Date.now();
  let ultimo = null;
  while (Date.now() - t0 < maxMs) {
    const w = await send('_aegis/unstable/session/watch', { sessionId });
    const info = await send('_aegis/unstable/session/info', { sessionId });
    ultimo = { run: w?.activeRunId ?? null, count: info?.session?._meta?.messageCount ?? 0 };
    if (!ultimo.run && ultimo.count >= 2) return { etiqueta, ...ultimo, ms: Date.now() - t0 };
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  return { etiqueta, ...(ultimo ?? { run: null, count: 0 }), ms: Date.now() - t0, timeout: true };
};

try {
  // 1. Un turno mÃ­nimo.
  respuesta = '';
  void send('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'ok' }],
    _meta: { promptId: `probe-${Date.now()}` },
  }).catch((error) => console.log(`prompt: ${error.message}`));
  const primerTurno = await turnoTerminado('primer turno', 120000);
  console.log(`primer turno: mensajes=${primerTurno.count} run=${primerTurno.run} en ${primerTurno.ms} ms${primerTurno.timeout ? ' (timeout)' : ''}, respuesta=${JSON.stringify(respuesta.slice(0, 60))}`);
  await send('session/cancel', { sessionId }).catch(() => {});

  // 2. Retry primero (sin rewind): rewind oculta el turno del usuario y despues no hay nada que repetir.
  try {
    const retryPrimero = await send('_aegis/unstable/session/retry', { sessionId });
    console.log(`retry sin rewind: keys={${Object.keys(retryPrimero ?? {}).join(',')}}`);
    const trasRetryPrimero = await turnoTerminado('tras retry', 120000);
    console.log(`tras retry: mensajes=${trasRetryPrimero.count} en ${trasRetryPrimero.ms} ms${trasRetryPrimero.timeout ? ' (timeout)' : ''}`);
  } catch (error) {
    console.log(`retry sin rewind: error ${error.message}`);
  }

  // 3. Rewind de un paso (despues del retry, con turno visible).
  let rewind = null;
  try {
    rewind = await send('_aegis/unstable/session/rewind', { sessionId, back: 1 });
    console.log(`rewind: keys={${Object.keys(rewind ?? {}).join(',')}} messageId=${rewind?.messageId ?? '?'}`);
  } catch (error) {
    console.log(`rewind: error ${error.message}`);
  }

  // 3. Retry.
  try {
    const retry = await send('_aegis/unstable/session/retry', { sessionId });
    console.log(`retry: keys={${Object.keys(retry ?? {}).join(',')}}`);
  } catch (error) {
    console.log(`retry: error ${error.message}`);
  }
  const trasRetry = await turnoTerminado('tras retry', 120000);
  console.log(`tras retry: mensajes=${trasRetry.count} run=${trasRetry.run} en ${trasRetry.ms} ms${trasRetry.timeout ? ' (timeout)' : ''}`);

  // 4. El export dice cÃ³mo quedÃ³ el historial.
  const dump = await send('_aegis/unstable/session/export', { sessionId, format: 'markdown' });
  const texto = String(dump?.data ?? '');
  console.log(`export: ${texto.length} chars, encabezado=${JSON.stringify(texto.split('\n').slice(0, 3).join(' | ').slice(0, 120))}`);
} finally {
  await send('session/cancel', { sessionId }).catch(() => {});
  try {
    await send('session/delete', { sessionId });
    console.log('sesion desechable borrada');
  } catch (error) {
    console.log(`limpieza: ${error.message}`);
  }
  socket.close();
  process.exit(0);
}

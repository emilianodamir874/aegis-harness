// Prueba el ciclo de vida de una sesión DESECHABLE contra el motor real, usando el mismo cliente y
// store del frontend React (no el cliente vanilla). Crea la sesión, la renombra, la archiva,
// la desarchiva y la borra. Nunca toca sesiones existentes.
// Uso: node tools/acp-lifecycle.mjs ws://127.0.0.1:3284/acp?token=...   (o /acp local sin token)
import { WebSocket } from 'ws';

const resolveUrl = async () => {
  if (process.argv[2]) return process.argv[2];
  const config = await (await fetch('http://127.0.0.1:3788/config.js')).text();
  const match = /"acpUrl"\s*:\s*"([^"]+)"/.exec(config);
  if (!match) throw new Error('no pude leer acpUrl de /config.js');
  const original = new URL(match[1]);
  // Mismo camino que el navegador: el proxy del servidor web, no el puerto del motor directo.
  return `ws://127.0.0.1:3788/acp${original.search}`;
};

const url = await resolveUrl();
const log = (step, detail) => console.log(`${step.padEnd(22)} ${detail}`);

let id = 0;
const pending = new Map();
const notifications = [];
const socket = new WebSocket(url, { headers: { Origin: 'http://127.0.0.1:3788' } });

const send = (method, params) =>
  new Promise((resolve, reject) => {
    const rid = ++id;
    pending.set(rid, { resolve, reject });
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }));
    setTimeout(() => {
      if (pending.delete(rid)) reject(new Error(`${method}: timeout 90 s`));
    }, 90000);
  });

socket.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.method) {
    const detalle = msg.params && msg.params.update ? JSON.stringify(msg.params.update).slice(0, 120) : '';
    notifications.push(msg.method + (detalle ? ' ' + detalle : ''));
    if (msg.id !== undefined && msg.method === 'session/request_permission') {
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'cancelled' } } }));
    }
    return;
  }
  const slot = pending.get(msg.id);
  if (!slot) return;
  pending.delete(msg.id);
  if (msg.error) slot.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
  else slot.resolve(msg.result);
});

const main = async () => {
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const init = await send('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'aegis-web-react-lifecycle', version: '0.1.0' },
    _meta: { 'aegis/useLoginShellPath': true },
  });
  log('initialize', `protocol=${init.protocolVersion ?? '?'} authMethods=${(init.authMethods ?? []).length}`);

  const listAll = async () => {
    const rows = [];
    let cursor = null;
    for (let page = 0; page < 20; page += 1) {
      const response = await send('session/list', {
        ...(cursor ? { cursor } : {}),
        meta: { aegis: { includeLastMessageSnippet: false } },
      });
      rows.push(...(response.sessions ?? []));
      cursor = response.nextCursor ?? null;
      if (!cursor) break;
    }
    return rows;
  };

  const created = await send('session/new', { cwd: 'C:\\Aegis-Proyects', mcpServers: [] });
  const sid = created.sessionId;
  if (!sid) throw new Error('session/new sin sessionId');
  log('session/new', sid);

  const marker = `prueba-react-${Date.now()}`;
  await send('_aegis/unstable/session/watch', { sessionId: sid, since: 0, epoch: null });
  await send('_aegis/unstable/session/rename', { sessionId: sid, title: marker });
  let listed = await listAll();
  const row = listed.find((s) => s.sessionId === sid);
  const renamed = Boolean(row) && row.title === marker;
  log('rename', `title="${marker}" visible=${renamed} userSetName=${row?._meta?.userSetName}`);

  await send('_aegis/unstable/session/archive', { sessionId: sid });
  listed = await listAll();
  const afterArchive = listed.find((s) => s.sessionId === sid);
  log('archive', `sigue en la lista=${Boolean(afterArchive)} archivadaLocalmente=no (marca del cliente)`);

  await send('_aegis/unstable/session/unarchive', { sessionId: sid });
  listed = await listAll();
  const afterUnarchive = listed.find((s) => s.sessionId === sid);
  log('unarchive', `sigue en la lista=${Boolean(afterUnarchive)}`);

  const watched = await send('_aegis/unstable/session/watch', { sessionId: sid, since: 0, epoch: null });
  log('watch', `cursor=${watched.cursor} epoch=${watched.epoch} replay=${(watched.replay ?? []).length} activeRun=${watched.activeRunId ?? 'null'}`);
  await send('_aegis/unstable/session/unwatch', { sessionId: sid });

  let exportState = 'no ofrecido';
  try {
    const exported = await send('_aegis/unstable/session/export', { sessionId: sid, format: 'markdown' });
    exportState = `ok keys=${Object.keys(exported).join(',')} bytes=${String(exported.content ?? exported.markdown ?? '').length}`;
  } catch (error) {
    exportState = `error ${error.message}`;
  }
  log('export', exportState);

  const unwatched = await send('_aegis/unstable/session/unwatch', { sessionId: sid }).then(() => 'ok', (error) => `error ${error.message}`);
  log('unwatch', unwatched);

  await send('session/delete', { sessionId: sid });
  listed = await listAll();
  const gone = !listed.some((s) => s.sessionId === sid);
  log('delete', `borrada=${gone}`);

  const methods = [...new Set(notifications)].join(',') || '(ninguna)';
  log('notificaciones', methods);
  socket.close();
};

main().then(
  () => process.exit(0),
  (error) => {
    console.error('FALLO', error.message);
    process.exit(1);
  },
);

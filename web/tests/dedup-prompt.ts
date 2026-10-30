// Idempotencia de session/prompt por _meta.promptId.
//
// Un cliente que reintenta un mensaje (corte de red) manda el mismo promptId: el server
// tiene que devolver la corrida ya hecha en vez de ejecutar el turno otra vez. Y si el
// mismo id llega con contenido distinto, tiene que rechazarlo.
//
// Cuesta un turno real (el primero); el segundo se sirve de cache. Corre con
// AEGIS_TEST_SMOKE=1.
import { readFile } from 'node:fs/promises';
import { acpEndpoint, check, pass } from './lib.js';

const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
const ws = new WebSocket(acpEndpoint() + '?token=' + cfg.secretKey);
const pending = new Map<number, (m: any) => void>();
let id = 0;
let sid = '';

const request = (method: string, params: unknown): Promise<any> =>
  new Promise((resolve, reject) => {
    const rid = ++id;
    pending.set(rid, (m: any) => (m.error ? reject(Error(method + ': ' + JSON.stringify(m.error))) : resolve(m.result)));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }));
  });

ws.onmessage = ({ data }: MessageEvent) => {
  const m = JSON.parse(String(data));
  if (m.method === 'session/request_permission') {
    const o = m.params?.options?.find((x: any) => x.optionId === 'allow_once') ?? m.params?.options?.[0];
    if (o) ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: o.optionId } } }));
  } else if (m.id !== undefined && !m.method) {
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  }
};

try {
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(Error('no pude abrir el WS ACP en ' + acpEndpoint()));
  });
  await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { _meta: { aegis: { customNotifications: true } } },
    clientInfo: { name: 'aegis-web-tests', version: '1' },
  });

  const session = await request('session/new', { cwd: 'C:/Aegis-Proyects', mcpServers: [] });
  sid = session.sessionId;
  console.log('sesion ' + sid);

  const promptId = 'dedup-' + Date.now();
  const prompt = { sessionId: sid, prompt: [{ type: 'text', text: 'Responde solamente la palabra: OK' }], _meta: { promptId } };

  const t0 = Date.now();
  const first = await request('session/prompt', prompt);
  const firstMs = Date.now() - t0;

  const t1 = Date.now();
  const second = await request('session/prompt', prompt);
  const secondMs = Date.now() - t1;

  check(JSON.stringify(first) === JSON.stringify(second), 'el reintento devuelve el mismo resultado: ' + JSON.stringify(second).slice(0, 120));
  check(secondMs < 1500, 'el reintento no vuelve a llamar al modelo (' + secondMs + ' ms vs ' + firstMs + ' ms del primero)');

  let rejected = false;
  try {
    await request('session/prompt', {
      sessionId: sid,
      prompt: [{ type: 'text', text: 'contenido distinto con el mismo id' }],
      _meta: { promptId },
    });
  } catch (e) {
    rejected = /different content/.test(String((e as Error).message));
  }
  check(rejected, 'el mismo promptId con otro contenido se rechaza');

  pass('idempotencia de prompts (primero ' + firstMs + ' ms, reintento ' + secondMs + ' ms)');
} catch (e) {
  console.error('FAIL ' + (e as Error).message);
  process.exitCode = 1;
} finally {
  if (sid) await request('session/delete', { sessionId: sid }).catch(() => {});
  ws.close();
}

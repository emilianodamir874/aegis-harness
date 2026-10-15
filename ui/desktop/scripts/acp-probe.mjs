// ACP probe: minimal headless client for aegis serve (diagnostics for goose-web).
// Creates a session, sends a prompt, streams session/update notifications.
// Run:  cd ui/desktop && node scripts/acp-probe.mjs ["prompt text"]
import { readFileSync } from 'node:fs';
import { client, methods } from '@agentclientprotocol/sdk';
import { createWebSocketStream } from '@agentclientprotocol/sdk/experimental/ws-client';

const cfg = JSON.parse(readFileSync('C:/goose-web/config.json', 'utf8'));
const url = `ws://127.0.0.1:${cfg.servePort}/acp?token=${cfg.secretKey}`;
const promptText = process.argv[2] || 'Respondé exactamente: PONG. Nada más.';
const cwd = process.env.PROBE_CWD || 'C:\\Users\\Emiliano';

const updates = [];
const app = client({ name: 'acp-probe' }).onNotification(
  methods.client.session.update,
  (ctx) => {
    const u = ctx.params;
    updates.push(u);
    const kind = u?.update?.sessionUpdate || u?.sessionUpdate || '?';
    const text =
      u?.update?.content?.text ?? u?.content?.text ?? u?.update?.agentMessageChunk?.content?.text ?? '';
    console.log(`[update:${kind}]`, String(text).slice(0, 200).replace(/\n/g, ' '));
  }
);

const stream = createWebSocketStream(url, { protocols: [] });
const connection = app.connect(stream);

const hardStop = setTimeout(() => {
  console.log('PROBE TIMEOUT (240s). updates so far:', updates.length);
  process.exit(2);
}, 240000);

try {
  console.log('initialize...');
  const init = await connection.agent.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'acp-probe', version: '0.1.0' },
  });
  console.log('INIT OK:', JSON.stringify(init).slice(0, 400));

  console.log('session/new...');
  const sess = await connection.agent.request('session/new', { cwd, mcpServers: [] });
  console.log('SESSION OK:', JSON.stringify(sess).slice(0, 400));
  const sessionId = sess.sessionId || sess.session_id;

  console.log('session/prompt:', JSON.stringify(promptText));
  const t0 = Date.now();
  const res = await connection.agent.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: promptText }],
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`PROMPT DONE in ${secs}s`);
  console.log('RESULT:', JSON.stringify(res).slice(0, 1200));
  console.log('UPDATES:', updates.length);
} catch (err) {
  console.log('PROBE ERROR:', err && err.message ? err.message : String(err));
  console.log('UPDATES so far:', updates.length);
  process.exitCode = 3;
} finally {
  clearTimeout(hardStop);
  try {
    connection.close();
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(process.exitCode || 0), 500);
}

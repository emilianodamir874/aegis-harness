// Smoke del estado vacío: pulsa "Nuevo chat", verifica la tarjeta de onboarding con datos reales y
// borra la sesión que creó (messageCount 0, creada después de arrancar el script). No manda prompts.
// Uso: node tools/react-onboard-smoke.mjs "http://127.0.0.1:3790/app-react/?acp=proxy"
import { chromium } from 'playwright';
import { WebSocket } from 'ws';

const url = process.argv[2] || 'http://127.0.0.1:3790/app-react/?acp=proxy';
const started = new Date().toISOString();

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});

let rows = [];
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sidebar', { timeout: 20000 });
  const nuevo = page.getByRole('button', { name: /nuevo chat/i }).first();
  await nuevo.click();
  await page.waitForSelector('.onboard', { timeout: 20000 });
  await page.waitForFunction(
    () => (document.querySelector('.onboard dl')?.childElementCount ?? 0) > 0 || document.querySelector('.onboard p') !== null,
    { timeout: 30000 },
  );
  rows = await page.$$eval('.onboard .onboard-row', (nodes) =>
    nodes.map((node) => `${node.querySelector('dt')?.textContent ?? ''}: ${node.querySelector('dd')?.textContent ?? ''}`),
  );
  const vacio = await page.locator('.onboard p').count();
  console.log(JSON.stringify({ filas: rows, avisoVacio: vacio > 0, errores: errors }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ fallo: String(error && error.message), errores: errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}

// Limpieza: borra la sesión vacía que el smoke creó.
const config = await (await fetch('http://127.0.0.1:3788/config.js')).text();
const search = new URL(/"acpUrl"\s*:\s*"([^"]+)"/.exec(config)[1]).search;
const socket = new WebSocket(`ws://127.0.0.1:3788/acp${search}`);
let id = 0;
const pending = new Map();
socket.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  const slot = msg.id !== undefined ? pending.get(msg.id) : undefined;
  if (!slot) return;
  pending.delete(msg.id);
  msg.error ? slot.reject(new Error(msg.error.message)) : slot.resolve(msg.result);
});
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const rid = ++id;
    pending.set(rid, { resolve, reject });
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }));
  });
await new Promise((resolve, reject) => {
  socket.once('open', resolve);
  socket.once('error', reject);
});
await send('initialize', {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: 'aegis-web-react-onboard-smoke', version: '0.1.0' },
});
const list = await send('session/list', { meta: { aegis: { includeLastMessageSnippet: false } } });
const candidata = (list.sessions ?? []).find(
  (row) => row._meta?.messageCount === 0 && String(row._meta?.createdAt ?? '') >= started,
);
if (candidata) {
  await send('session/delete', { sessionId: candidata.sessionId });
  console.log(`limpieza: borrada la sesión vacía ${candidata.sessionId}`);
} else {
  console.log('limpieza: no encontré la sesión vacía del smoke (revisar a mano)');
}
socket.close();

// Prueba DIRIGIDA del guard de streamAppend: inyecta por el WebSocket la MISMA notificacion dos
// veces (y una version acumulada) y verifica que el texto NO se duplique dentro del globo.
// Uso: node tools/dup-chunk-check.mjs [url]
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://127.0.0.1:3788/';
const T1 = 'ZZQQZZQQZZQQZZQQZZQQ';
const T2 = T1 + 'EXTRA-EXTRA';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

await p.goto(url, { waitUntil: 'load' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 20000 });
await p.evaluate(() => { try { window.__aegisWeb.refreshSessions(); } catch (e) {} });
await p.waitForSelector('.sb-item', { timeout: 15000 });
const items = await p.$$('.sb-item');
await items[items.length - 1].click();
await p.waitForTimeout(5000);

const res = await p.evaluate(async ({ T1, T2 }) => {
  const A = window.__aegisWeb;
  const sid = A.state.current && A.state.current.id;
  const send = (text) => A.rpc.ws.onmessage({ data: JSON.stringify({
    jsonrpc: '2.0', method: 'session/update',
    params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', messageId: 'probe-dup-1', content: { type: 'text', text } } },
  }) });
  const read = () => [...document.querySelectorAll('#msg-inner .msg-a .content')]
    .map((e) => e.textContent).filter((t) => t.includes('ZZQQ'));
  const out = { sid: String(sid).slice(0, 12) };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  send(T1); await wait(400); out.afterFirst = read();
  send(T1); await wait(400); out.afterMismaOtraVez = read();
  send(T2); await wait(600); out.afterAcumulada = read();
  out.globos = [...document.querySelectorAll('#msg-inner .msg-a .content')].filter((e) => e.textContent.includes('ZZQQ')).length;
  return out;
}, { T1, T2 });

const ok1 = res.afterFirst.length === 1 && res.afterFirst[0].trim() === T1;
const ok2 = res.afterMismaOtraVez.length === 1 && res.afterMismaOtraVez[0].trim() === T1;
const ok3 = res.afterAcumulada.length === 1 && res.afterAcumulada[0].trim() === T2;
const ok4 = res.globos === 1;
console.log(JSON.stringify({ ...res, globosCompartidos: res.globos }, null, 1));
console.log('1) primera inyeccion pinta una vez      : ' + (ok1 ? 'OK' : 'FALLA'));
console.log('2) la MISMA notificacion no duplica     : ' + (ok2 ? 'OK' : 'FALLA'));
console.log('3) la version acumulada aplica el delta : ' + (ok3 ? 'OK' : 'FALLA'));
console.log('4) un solo globo (no una caja nueva)    : ' + (ok4 ? 'OK' : 'FALLA'));
console.log('errores de pagina: ' + errs.length + (errs.length ? ' :: ' + errs.slice(0, 2).join(' | ') : ''));
console.log(ok1 && ok2 && ok3 && ok4 ? 'RESULTADO: OK' : 'RESULTADO: HAY FALLAS');
await b.close();

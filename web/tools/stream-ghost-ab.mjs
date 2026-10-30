// A/B del "fantasma" de pintado con GPU real (Chrome con ventana, no headless).
// Fase A: se fuerza el modo viejo por CSS (content-visibility: auto en toda la cola + blur de
//         entrada). Fase B: el modo nuevo (los arreglos del 2026-10-17). Mismo turno inyectado,
//         mismas mediciones: captura vs la misma escena repintada sin cambiar layout.
// Uso: node tools/stream-ghost-ab.mjs [url]
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const url = process.argv[2] || 'http://127.0.0.1:3788/';
const OUT = 'C:/Aegis-Proyects/web/tools/shots';
const PARA = 'The script found 3,200 buy NEW and 3,195 cancelled, all with data — but /tmp/canc.tsv was not created. Why? Because the file write used "/tmp/canc.tsv" and the open(...) call should have created it, unless the write failed silently in the sandbox. El archivo no se creó (probablemente /tmp no es escribible por el usuario aegis). Lo mando al home. ';
const THOUGHT = 'The script found 3,200 buy NEW, 3,195 cancelled, all with data — but /tmp/canc.tsv was not created. Why? Because the file write used "/tmp/canc.tsv" — and the script open(...) should have created it... unless the write failed silently? If the sandbox blocks writes outside the session root, every intermediate file will fail the same way. ';
const LONG_OUT = Array.from({ length: 16 }, (_, i) => `linea ${i + 1}: ordenes buy NEW 3200 | canceladas 3195 | rango 1792200410551 1792217142765`).join('\n');

const b = await chromium.launch({ headless: false, channel: 'chrome' });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const dp = await ctx.newPage();
await dp.setContent('<div></div>');
const diff = async (b1, b2) => {
  const d1 = 'data:image/png;base64,' + b1.toString('base64');
  const d2 = 'data:image/png;base64,' + b2.toString('base64');
  return await dp.evaluate(async ([s1, s2]) => {
    const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    const [i1, i2] = await Promise.all([load(s1), load(s2)]);
    if (i1.width !== i2.width || i1.height !== i2.height) return { pixeles: 0, distinto: true };
    const mk = (img) => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(0, 0, img.width, img.height).data; };
    const A = mk(i1), B = mk(i2);
    let n = 0, max = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    const W = i1.width;
    for (let i = 0; i < A.length; i += 4) {
      const d = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]));
      if (d > 40) { n++; if (d > max) max = d; const px = (i / 4) % W, py = Math.floor(i / 4 / W); if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; }
    }
    return { pixeles: n, maxDelta: max, bbox: n ? [x0, y0, x1 - x0, y1 - y0] : null, distinto: n > 400 };
  }, [d1, d2]);
};

await p.goto(url, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.rpc && window.__aegisWeb.rpc.ready === true, null, { timeout: 30000 });
await p.waitForSelector('.sb-item', { timeout: 30000 });
const big = await p.evaluate(() => {
  const s = window.__aegisWeb.state.sessions.slice().sort((a, b) => (b._meta?.messageCount || 0) - (a._meta?.messageCount || 0))[0];
  document.querySelector(`.sb-row[data-id="${s.sessionId}"] .sb-item`)?.click();
  return { id: s.sessionId, n: s._meta?.messageCount || 0 };
});
await p.waitForFunction(() => !document.querySelector('#status-pill'), null, { timeout: 180000 }).catch(() => {});
await p.waitForTimeout(2500);
const sid = await p.evaluate(() => window.__aegisWeb.state.current && window.__aegisWeb.state.current.id);
// el cursor de streaming pulsa (animation) y cambia pixeles entre las dos capturas: se congela
await p.addStyleTag({ content: '*, *::after, *::before { animation-play-state: paused !important; }' });

const fases = {
  viejo: `.msg-a, .msg-user, .tool { content-visibility: auto !important; }
          .msg-a.in { animation-name: msgIn !important; }`,
  nuevo: `.msg-a, .msg-user, .tool { content-visibility: visible !important; }
          .msg-a.in { animation-name: msgInSinBlur !important; }`,
};

const send = (u) => p.evaluate(([sid, u]) => {
  window.__aegisWeb.rpc.ws.onmessage({ data: JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: u } }) });
}, [sid, u]);
const wait = (ms) => p.waitForTimeout(ms);
const atBottom = () => p.evaluate(async () => {
  const m = document.querySelector('#messages');
  m.scrollTop = m.scrollHeight;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
});
const box = await p.evaluate(() => { const r = document.querySelector('#messages').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; });
const repaint = () => p.evaluate(async () => {
  const m = document.querySelector('#messages');
  m.style.transform = 'translateZ(0)';
  void m.offsetHeight;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  m.style.transform = '';
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
});

const corrientes = [];
const probar = async (label) => {
  await atBottom();
  // sin esto las dos capturas caen en medio de un chunk y la diferencia es el texto nuevo,
  // no un fantasma: se mide solo con el stream quieto (el render se estabiliza a los 90 ms)
  await wait(450);
  const s1 = await p.screenshot({ clip: box });
  await repaint();
  await wait(60);
  const s2 = await p.screenshot({ clip: box });
  const d = await diff(s1, s2);
  if (d.distinto) { writeFileSync(`${OUT}/ab-${label}-pantalla.png`, s1); writeFileSync(`${OUT}/ab-${label}-repintado.png`, s2); }
  return { label, ...d };
};

for (const [fase, css] of Object.entries(fases)) {
  const h = await p.addStyleTag({ content: css });
  const marca = `${fase}-${Date.now().toString(36)}`;
  const res = [];
  for (let r = 0; r < 3; r++) {
    const gid = `${marca}-g${r}`, tid = `${marca}-t${r}`, tcid = `${marca}-c${r}`;
    for (let i = 0; i < PARA.length; i += 46) { await send({ sessionUpdate: 'agent_message_chunk', messageId: gid, content: { type: 'text', text: PARA.slice(i, i + 46) } }); await wait(45); }
    res.push(await probar(`${marca}-txt${r}`));
    if (r === 1) {
      await send({ sessionUpdate: 'tool_call', toolCallId: tcid, title: 'extracting order cancellations from ledger', kind: 'shell', status: 'in_progress', rawInput: { command: 'python recorte.py > /tmp/canc.tsv' } });
      await wait(200);
      await send({ sessionUpdate: 'tool_call_update', toolCallId: tcid, title: 'extracting order cancellations from ledger', kind: 'shell', status: 'completed', rawInput: { command: 'python recorte.py > /tmp/canc.tsv' }, content: [{ type: 'content', content: { type: 'text', text: LONG_OUT } }] });
      res.push(await probar(`${marca}-tool`));
    }
    for (let i = 0; i < THOUGHT.length; i += 40) { await send({ sessionUpdate: 'agent_thought_chunk', messageId: tid, content: { type: 'text', text: THOUGHT.slice(i, i + 40) } }); await wait(40); }
    res.push(await probar(`${marca}-think${r}`));
  }
  corrientes.push({ fase, comprobaciones: res.length, conFantasma: res.filter((x) => x.distinto).length, peor: res.reduce((a, x) => (x.pixeles > (a.pixeles || 0) ? x : a), {}) });
  await p.evaluate((el) => el.remove(), h);
}

console.log(JSON.stringify({ sesion: big, sid: String(sid).slice(0, 12), corrientes }, null, 1));
await b.close();
process.exit(0);

// v3: el escenario real del duenio -> sesion LARGA (miles de mensajes arriba) + un turno que
// llega en streaming desde otra conexion. Compara la captura contra la MISMA escena repintada
// SIN cambiar layout (promocion de capa), asi una diferencia = pintado obsoleto de verdad.
// Uso: node tools/stream-ghost-check3.mjs [url] [sufijo]
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const url = process.argv[2] || 'http://127.0.0.1:3788/';
const tag = process.argv[3] || 'run';
const OUT = 'C:/Aegis-Proyects/web/tools/shots';

const PARA = [
  'The script found 3,200 buy NEW and 3,195 cancelled, all with data — but /tmp/canc.tsv was not created. ',
  'Why? Because the file write used "/tmp/canc.tsv" and the open(...) call should have created it, unless the write failed silently in the sandbox. ',
  'El archivo no se creó (probablemente /tmp no es escribible por el usuario aegis). Lo mando al home y vuelvo a correr el recorte con el mismo rango. ',
  'las hubiera tocado si seguían vivas? Hay que revisar el ledger de ordenes y comparar con el snapshot de las 11:40. ',
].join('');
const THOUGHT = [
  'The script found 3,200 buy NEW, 3,195 cancelled, all with data — but /tmp/canc.tsv was not created. ',
  'Why? Because the file write used "/tmp/canc.tsv" — and the script open(...) should have created it... unless the write failed silently? ',
  'If the sandbox blocks writes outside the session root, every intermediate file will fail the same way. ',
].join('');
const LONG_OUT = [
  'ordenes buy NEW: 3200 | canceladas: 3195 | con datos: 3195',
  'rango: 1792200410551 1792217142765',
  "head: cannot open '/tmp/canc.tsv' for reading: No such file or directory",
  'En linea: 2 Caracter: 1',
  'Traceback (most recent call last): File "recorte.py", line 41, in <module> PermissionError: [Errno 13] Permission denied',
].join('\n');

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

const dp = await ctx.newPage();
await dp.setContent('<div></div>');
const diff = async (b1, b2) => {
  const d1 = 'data:image/png;base64,' + b1.toString('base64');
  const d2 = 'data:image/png;base64,' + b2.toString('base64');
  return await dp.evaluate(async ([s1, s2]) => {
    const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    const [i1, i2] = await Promise.all([load(s1), load(s2)]);
    if (i1.width !== i2.width || i1.height !== i2.height) return { distinto: true, motivo: 'tamaño', pixeles: 0 };
    const mk = (img) => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(0, 0, img.width, img.height).data; };
    const A = mk(i1), B = mk(i2);
    let n = 0, max = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    const W = i1.width;
    for (let i = 0; i < A.length; i += 4) {
      const d = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]));
      if (d > 40) {
        n++; if (d > max) max = d;
        const px = (i / 4) % W, py = Math.floor(i / 4 / W);
        if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
      }
    }
    return { distinto: n > 400, pixeles: n, maxDelta: max, bbox: n ? [x0, y0, x1 - x0, y1 - y0] : null, total: W * i1.height };
  }, [d1, d2]);
};

await p.goto(url, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.rpc && window.__aegisWeb.rpc.ready === true, null, { timeout: 30000 });
await p.waitForSelector('.sb-item', { timeout: 30000 });

const big = await p.evaluate(() => {
  const s = window.__aegisWeb.state.sessions.slice().sort((x, y) => (y._meta?.messageCount || 0) - (x._meta?.messageCount || 0))[0];
  return s ? { id: s.sessionId, n: s._meta?.messageCount || 0 } : null;
});
await p.evaluate((id) => document.querySelector(`.sb-row[data-id="${id}"] .sb-item`)?.click(), big.id);
await p.waitForFunction(() => !document.querySelector('#status-pill'), null, { timeout: 180000 }).catch(() => {});
await p.waitForTimeout(3000);
const sid = await p.evaluate(() => window.__aegisWeb.state.current && window.__aegisWeb.state.current.id);
await p.addStyleTag({ content: '*, *::after, *::before { animation: none !important; transition: none !important; }' });

const send = (u) => p.evaluate(([sid, u]) => {
  window.__aegisWeb.rpc.ws.onmessage({ data: JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: u } }) });
}, [sid, u]);
const txt = (id, t) => send({ sessionUpdate: 'agent_message_chunk', messageId: id, content: { type: 'text', text: t } });
const think = (id, t) => send({ sessionUpdate: 'agent_thought_chunk', messageId: id, content: { type: 'text', text: t } });
const tool = (id, status, extra) => send({ sessionUpdate: status === 'in_progress' ? 'tool_call' : 'tool_call_update', toolCallId: id, ...extra });
const wait = (ms) => p.waitForTimeout(ms);
const atBottom = () => p.evaluate(async () => {
  const m = document.querySelector('#messages');
  m.scrollTop = m.scrollHeight;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
});

await atBottom();
const box = await p.evaluate(() => { const r = document.querySelector('#messages').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; });

// repintado SIN cambiar layout: promociona a capa propia (no toca tamaños)
const repaint = async () => {
  await p.evaluate(async () => {
    const m = document.querySelector('#messages');
    m.style.transform = 'translateZ(0)';
    m.style.opacity = '0.999';
    void m.offsetHeight;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    m.style.opacity = '';
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    m.style.transform = '';
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
};
const probe = async (label, save) => {
  await atBottom();
  await wait(80);
  const s1 = await p.screenshot({ clip: box });
  await repaint();
  await wait(80);
  const s2 = await p.screenshot({ clip: box });
  const d = await diff(s1, s2);
  if (save) {
    writeFileSync(`${OUT}/ghost3-${tag}-${label}-pantalla.png`, s1);
    writeFileSync(`${OUT}/ghost3-${tag}-${label}-repintado.png`, s2);
  }
  return d;
};

const medidas = [];
const chunkN = (s, n) => { const out = []; for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n)); return out; };

for (let r = 0; r < 6; r++) {
  const gid = 'g' + r, tid = 'th' + r, tcid = 'tc' + r;
  const ch = chunkN(PARA, 46);
  for (let i = 0; i < ch.length; i++) {
    await txt(gid, ch[i]);
    await wait(45);
    if (i === 4) medidas.push({ punto: `${gid}-texto`, ...(await probe(`${gid}-texto`, false)) });
  }
  if (r % 2 === 0) {
    await tool(tcid, 'in_progress', { title: 'extracting order cancellations from ledger', kind: 'shell', status: 'in_progress', rawInput: { command: 'python recorte.py > /tmp/canc.tsv' } });
    await wait(200);
    await tool(tcid, 'completed', { title: 'extracting order cancellations from ledger', kind: 'shell', status: 'completed', rawInput: { command: 'python recorte.py > /tmp/canc.tsv' }, content: [{ type: 'content', content: { type: 'text', text: LONG_OUT } }] });
    medidas.push({ punto: `${tcid}-tool`, ...(await probe(`${tcid}-tool`, false)) });
  }
  for (const c of chunkN(THOUGHT, 40)) { await think(tid, c); await wait(40); }
  medidas.push({ punto: `${tid}-think`, ...(await probe(`${tid}-think`, false)) });
}

const final = await probe('final', true);
const dom = await p.evaluate(() => {
  const kids = [...document.querySelector('#msg-inner').children];
  const rect = (e) => { const r = e.getBoundingClientRect(); return { t: +r.top.toFixed(1), b: +r.bottom.toFixed(1) }; };
  const solapes = [];
  for (let i = 0; i < kids.length - 1; i++) {
    const a = rect(kids[i]), c = rect(kids[i + 1]);
    if (a.b - c.t > 2) solapes.push({ i, a: String(kids[i].className).slice(0, 28), b: String(kids[i + 1].className).slice(0, 28), px: +(a.b - c.t).toFixed(1) });
  }
  const tail = kids.slice(-12).map((e) => {
    const r = e.getBoundingClientRect();
    return { clase: String(e.className).slice(0, 30), h: +r.height.toFixed(1), scrollH: e.scrollHeight, cv: getComputedStyle(e).contentVisibility };
  });
  return { nHijos: kids.length, solapes, tail, alFinal: (() => { const m = document.querySelector('#messages'); return m.scrollHeight - m.scrollTop - m.clientHeight < 4; })() };
});

console.log(JSON.stringify({ sesion: big, sid: String(sid).slice(0, 12), medidas, final, dom, erroresPagina: errs }, null, 1));
console.log(`comprobaciones: ${medidas.length}, con pintado obsoleto: ${medidas.filter((m) => m.distinto).length}`);
console.log(final.distinto ? 'AL FINAL: pintado obsoleto presente' : 'AL FINAL: sin pintado obsoleto');
console.log(dom.solapes.length ? `LAYOUT: ${dom.solapes.length} solapamientos` : 'LAYOUT: sin solapamientos');
await b.close();
process.exit(0);

import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 900, height: 800 } })).newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 120)));
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 25000 });
await p.waitForTimeout(2000);
const res = await p.evaluate(() => {
  // se asegura de usar EL MISMO contenedor que usa la funcion (#msg-inner)
  const caja = document.getElementById('messages');
  let inner = document.getElementById('msg-inner');
  if (!inner) { inner = document.createElement('div'); inner.id = 'msg-inner'; inner.className = 'msg-inner'; caja.appendChild(inner); }
  inner.textContent = '';
  const chat = (cls, txt) => { const d = document.createElement('div'); d.className = 'msg-user ' + cls; d.textContent = txt; inner.appendChild(d); return d; };
  chat('', 'mensaje vivo 1');
  chat('hidden-from-agent', 'rebobinado (no lo ve el modelo)');
  chat('hidden-from-agent', 'respuesta vieja de la IA');
  chat('', 'mensaje nuevo despues del rebobinado');
  const antes = inner.children.length;
  window.__aegisWeb.markHiddenTail();
  const quedan = [...inner.children].map((k) => k.className.replace('msg-user ', '') + ' | ' + (k.textContent || '').slice(0, 40));
  const marca = inner.querySelector('.rw-marker');
  return {
    antes, despues: inner.children.length, quedan,
    marca: marca ? marca.textContent : null,
    vivosSiguen: !!(inner.textContent.includes('mensaje vivo 1') && inner.textContent.includes('mensaje nuevo despues')),
    ocultosSeFueron: !inner.textContent.includes('respuesta vieja de la IA') && !inner.textContent.includes('rebobinado (no lo ve'),
  };
});
await p.screenshot({ path: 'C:/Users/Emiliano/tmp/inv/rebobinar2.png' });
console.log(JSON.stringify({ res, errs }, null, 1));
await b.close();

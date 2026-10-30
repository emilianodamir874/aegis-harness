import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 25000 });
await p.waitForTimeout(2500);
await p.click('#btn-menu').catch(() => {});
await p.waitForTimeout(700);
await p.click('[data-id="20261016_9"]');
await p.waitForTimeout(12000);
const info = await p.evaluate(() => {
  const todos = [...document.querySelectorAll('#messages *')];
  const con = todos.filter((e) => /omitidos del replay/.test(e.textContent || ''));
  const hoja = con.length ? con[con.length - 1] : null;
  const cadena = (el) => { const c = []; let a = el; while (a && c.length < 8) { c.push(a.tagName.toLowerCase() + (a.id ? '#' + a.id : '') + (a.className ? '.' + String(a.className).split(' ').slice(0, 2).join('.') : '')); a = a.parentElement; } return c; };
  const nodosTexto = [];
  if (hoja) { const w = document.createTreeWalker(hoja, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const t = n.nodeValue || ''; if (/recortado/.test(t)) nodosTexto.push({ padre: n.parentNode.tagName.toLowerCase() + '.' + String(n.parentNode.className || '').slice(0, 30), texto: t.slice(0, 120), regexMia: /…?\s*\[recortado: \d+ bytes omitidos del replay\]/.test(t), codigos: [...t.slice(0, 40)].map((c) => c.charCodeAt(0)).slice(0, 14) }); } }
  return { cuantos: con.length, etiquetaMasInterna: hoja ? hoja.tagName.toLowerCase() + '.' + String(hoja.className) : null, cadena: hoja ? cadena(hoja) : null, html: hoja ? hoja.outerHTML.slice(0, 300) : null, nodosTexto, marcas: document.querySelectorAll('.replay-cut').length };
});
console.log(JSON.stringify(info, null, 1));
await b.close();

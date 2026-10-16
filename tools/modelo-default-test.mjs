import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 860 } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 110)));
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 20000 });
await p.waitForTimeout(4000);
const bienvenida = await p.evaluate(() => {
  const el = document.getElementById('default-model-chip');
  const r = el ? el.getBoundingClientRect() : null;
  return { visible: !!(el && !el.hidden && r && r.width > 0), texto: el ? el.textContent : '', titulo: el ? el.title.slice(0, 60) : '', hayChat: !!(window.__aegisWeb.state.current && window.__aegisWeb.state.current.id), cfgs: { modelo: window.__AEGIS_APP__.defaultModel, prov: window.__AEGIS_APP__.defaultProvider } };
});
const fila = await p.$('[data-id]');
if (fila) { await fila.click({ timeout: 8000 }).catch(() => {}); await p.waitForTimeout(4500); }
const conChat = await p.evaluate(() => ({ chipOculto: document.getElementById('default-model-chip').hidden, hayChat: !!(window.__aegisWeb.state.current && window.__aegisWeb.state.current.id), chipsDelChat: document.querySelectorAll('#chips .chip').length }));
console.log(JSON.stringify({ bienvenida, conChat, errs }, null, 1));
await b.close();

import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 20000 });
await p.waitForTimeout(2000);
const diag = await p.evaluate(() => {
  const ids = [...document.querySelectorAll('[data-id]')].slice(0, 6).map((n) => n.getAttribute('data-id'));
  const ses = (window.__aegisWeb.state.sessions || []).slice(0, 6).map((s) => s.id || s.sessionId);
  return { filasDataId: ids, sesionesLista: ses, totalSesiones: (window.__aegisWeb.state.sessions || []).length, current: window.__aegisWeb.state.current && window.__aegisWeb.state.current.id, title: document.getElementById('chat-title').textContent };
});
// intento 1: clic en la fila
let trasClic = null;
if (diag.filasDataId.length) {
  await p.click('[data-id="' + diag.filasDataId[0] + '"]');
  await p.waitForTimeout(4500);
  trasClic = await p.evaluate(() => ({ current: window.__aegisWeb.state.current && window.__aegisWeb.state.current.id, title: document.getElementById('chat-title').textContent, url: location.hash }));
}
// abrir el popover y ver que dice
await p.click('#btn-goals');
await p.waitForTimeout(3000);
const pop = await p.evaluate(async () => {
  const st = window.__aegisWeb.state;
  let api = null;
  try { const r = await fetch('/goals.json?sid=' + encodeURIComponent(st.current ? st.current.id : '')); api = (await r.json()).items.length; } catch (e) { api = 'err ' + e.message; }
  return { current: st.current && st.current.id, goals: (st.goals || []).length, goalsSid: st.goalsSid, err: st.goalsErr, api, cuerpo: document.getElementById('gp-body').textContent.slice(0, 120), items: document.querySelectorAll('#goals .gp-item').length };
});
console.log(JSON.stringify({ diag, trasClic, pop }, null, 1));
await b.close();

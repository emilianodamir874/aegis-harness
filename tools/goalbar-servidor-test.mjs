import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 120)));
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.state, null, { timeout: 20000 });
await p.waitForTimeout(1500);
// abrir nuestra sesion (tiene 2 /goal en el historial, ninguno activo en el servidor)
await p.click('[data-id="20261015_21"]');
await p.waitForFunction(() => window.__aegisWeb.state.current && window.__aegisWeb.state.current.id === '20261015_21', null, { timeout: 20000 });
await p.waitForTimeout(4000);
const trasAbrir = await p.evaluate(() => ({
  chipVisible: !document.getElementById('goalbar').hidden,
  chipTexto: (document.getElementById('goalbar').querySelector('.goalbar-text') || {}).textContent || '',
  goalEnEstado: window.__aegisWeb.state.goal,
  activoServidor: (window.__aegisWeb.state.goals || []).length,
  hayOcultos: (JSON.parse(localStorage.getItem('aegis.goalsOcultos') || '[]')).length,
}));
// optimista: al "escribir" un /goal aparece, y el refresco contra el servidor lo corrige
const optimista = await p.evaluate(async () => {
  const w = window.__aegisWeb;
  w.noteGoalFrom('/goal prueba de chip optimista');
  const instantaneo = !document.getElementById('goalbar').hidden;
  await w.fetchGoals(true);
  return { instantaneo, despuesDelRefresco: !document.getElementById('goalbar').hidden, goalFinal: w.state.goal };
});
// borrado del panel: si el objetivo vigente estuviera oculto, no se muestra
const oculto = await p.evaluate(() => {
  const w = window.__aegisWeb;
  const sid = w.state.current.id;
  localStorage.setItem('aegis.goalsOcultos', JSON.stringify([sid + '|2026-10-16 00:00:00|objetivo de prueba']));
  const r = { detecta: w.gpOcultoPorTexto('objetivo de prueba'), noDetectaOtro: w.gpOcultoPorTexto('otra cosa') };
  localStorage.removeItem('aegis.goalsOcultos');
  return r;
});
console.log(JSON.stringify({ trasAbrir, optimista, oculto, errs }, null, 1));
await b.close();

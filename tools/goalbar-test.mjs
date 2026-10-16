import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 110)));
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.renderGoalBar, null, { timeout: 20000 });
const r = await p.evaluate(() => {
  const w = window.__aegisWeb;
  w.state.goal = 'continua hasta terminar todo el trabajo pendiente y documentalo';
  w.state.grind = null;
  w.renderGoalBar();
  const bar = document.getElementById('goalbar');
  const comp = document.querySelector('.composer');
  const bb = bar.getBoundingClientRect();
  const cb = comp.getBoundingClientRect();
  return {
    visible: !bar.hidden,
    anchoBarra: Math.round(bb.width), anchoCompositor: Math.round(cb.width),
    masAngostaQueElCompositor: bb.width <= cb.width + 1,
    centrada: Math.abs((bb.left + bb.width / 2) - (cb.left + cb.width / 2)) < 3,
    radio: getComputedStyle(bar).borderRadius,
    boton: !!document.getElementById('goalbar-x'),
    alto: Math.round(bb.height),
  };
});
console.log(JSON.stringify({ ...r, errs }, null, 1));
await b.close();

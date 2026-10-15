// Sanity del watchdog: turno normal largo desde la UI -> no debe liberar ni molestar.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));

const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await (await b.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
await p.goto('http://192.168.100.34:3788/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelector('#conn-text')?.textContent === 'Conectado', null, { timeout: 30000 }).catch(() => {});
await p.waitForTimeout(2500);
await p.click('#btn-new');
await p.waitForTimeout(1500);
const sid = await p.evaluate(() => localStorage.getItem('gweb.last'));

await p.fill('#input', 'Ejecutá shell: powershell -NoProfile -Command "Start-Sleep -Seconds 18". Después respondé FIN-WD.');
await p.click('#btn-send');
const marcas = [];
for (let i = 0; i < 30; i++) {
  await p.waitForTimeout(2000);
  const st = await p.evaluate(() => {
    const G = window.__aegisWeb || {}; const s = G.state || {};
    return {
      busy: !!s.busy,
      notas: [...document.querySelectorAll('.sysnote')].map((e) => e.innerText).filter((x) => /sin cerrar|liber/i.test(x)),
      fin: /FIN-WD/.test((document.querySelector('#messages') || { innerText: '' }).innerText || ''),
    };
  });
  marcas.push(`${i * 2}s busy=${st.busy ? 1 : 0}${st.notas.length ? ' LIBERO!' : ''}`);
  if (st.notas.length) break;
  if (!st.busy && i > 3) break;
}
const fin = await p.evaluate(() => {
  const G = window.__aegisWeb || {}; const s = G.state || {};
  return { busy: !!s.busy, notasMalas: [...document.querySelectorAll('.sysnote')].map((e) => e.innerText).filter((x) => /sin cerrar|liber/i.test(x)).length, tieneFin: /FIN-WD/.test(document.querySelector('#messages').innerText) };
});
console.log(JSON.stringify({ sid, marcas, fin }, null, 1));
await b.close();
process.exit(0);

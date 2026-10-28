// Gate visual de la primera pasada: targets táctiles, bienvenida y movimiento reducido.
// No crea sesiones ni manda prompts.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const base = (process.argv[2] || 'http://127.0.0.1:3788').replace(/\/+$/, '');
const pw = JSON.parse(readFileSync('C:/Aegis-Proyects/web/auth.json', 'utf8')).password;
const browser = await chromium.launch({ headless: true });
let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${detail}`);
  if (!ok) failures++;
}
try {
  for (const width of [320, 390]) {
    const ctx = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    const login = await ctx.request.post(base + '/login', { form: { password: pw }, maxRedirects: 0 });
    check(`${width}: login`, [200, 302].includes(login.status()));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__aegisWeb?.rpc?.ready, null, { timeout: 20000 });
    await page.waitForSelector('#aegis-onboard', { timeout: 15000 });
    const initial = await page.evaluate(() => {
      const b = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { width: r.width, height: r.height, x: r.x, right: r.right }; };
      return { suggestions: [...document.querySelectorAll('.wsug .sug')].map((el) => el.textContent), duplicates: document.querySelectorAll('#aegis-onboard .sug').length,
        topbar: b('.topbar'), title: b('#btn-chat-info'), chip: b('#chips .chip'), doctor: b('#btn-doctor'),
        docParent: document.querySelector('#btn-doctor')?.parentElement?.className,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        animation: getComputedStyle(document.querySelector('.welcome')).animationDuration };
    });
    check(`${width}: sin scroll horizontal`, !initial.overflow);
    check(`${width}: sugerencias únicas del proyecto`, initial.suggestions.length === 3 && initial.suggestions[0].includes('proyecto') && initial.duplicates === 0);
    check(`${width}: cabecera legible`, initial.title?.width >= 80 && initial.doctor?.right <= width && initial.docParent === 'topbar-actions', JSON.stringify({ title: initial.title?.width, doctor: initial.doctor?.right }));
    check(`${width}: chip táctil`, initial.chip?.height >= 44, String(initial.chip?.height));
    check(`${width}: movimiento reducido`, parseFloat(initial.animation) <= 0.001, initial.animation);
    await page.locator('#btn-doctor').click();
    await page.waitForSelector('.aegis-doctor td', { timeout: 12000 });
    const modal = await page.evaluate(() => {
      const card = document.querySelector('.aegis-doctor').getBoundingClientRect();
      const buttons = [...document.querySelectorAll('.aegis-doctor header button')].map((el) => el.getBoundingClientRect().height);
      return { left: card.left, right: card.right, top: card.top, bottom: card.bottom, focus: document.activeElement?.textContent?.trim(), buttons };
    });
    check(`${width}: Doctor dentro del viewport`, modal.left >= 0 && modal.right <= width + 1 && modal.top >= 0 && modal.bottom <= 845 && modal.buttons.every((h) => h >= 44), JSON.stringify(modal));
    await page.keyboard.press('Escape');
    check(`${width}: Doctor devuelve foco`, await page.evaluate(() => document.activeElement?.id === 'btn-doctor'));
    // Fixture efímero que mide el hitbox real sin alterar una sesión persistida.
    const targets = await page.evaluate(() => {
      const host = document.createElement('div');
      host.className = 'msg-a';
      host.style.cssText = 'position:relative;width:100px;height:80px';
      host.innerHTML = '<button class="act-btn" aria-label="Acciones">⋯</button>';
      const band = document.createElement('div');
      band.className = 'rw-band';
      band.innerHTML = '<button class="rw-band-head">Historial oculto al modelo</button>';
      document.body.append(host, band);
      const a = host.querySelector('button').getBoundingClientRect();
      const r = band.querySelector('button').getBoundingClientRect();
      host.remove(); band.remove();
      return { action: [a.width, a.height], band: [r.width, r.height] };
    });
    check(`${width}: acción y banda táctiles`, targets.action.every((n) => n >= 44) && targets.band[1] >= 44, JSON.stringify(targets));
    check(`${width}: sin excepciones`, errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
  await ctx.request.post(base + '/login', { form: { password: pw }, maxRedirects: 0 });
  const page = await ctx.newPage();
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  const animation = await page.evaluate(() => {
    const host = document.createElement('div');
    host.className = 'msg-inner';
    host.innerHTML = '<div class="msg-a"><div class="thought">Histórico</div></div><div class="tool" data-state="err">Histórica</div><div class="msg-user">Histórico</div><div class="msg-a in">En vivo</div><div class="tool in" data-state="run">En vivo</div>';
    document.body.append(host);
    const name = (sel) => getComputedStyle(host.querySelector(sel)).animationName;
    const result = { historicalTool: name('.tool:not(.in)'), historicalMessage: name('.msg-user'),
      historicalThought: name('.thought'), liveTool: name('.tool.in'), liveMessage: name('.msg-a.in') };
    host.remove();
    return result;
  });
  check('replay estático, turno vivo animado', animation.historicalTool === 'none' && animation.historicalMessage === 'none'
    && animation.historicalThought === 'none' && animation.liveTool.includes('toolIn') && animation.liveMessage.includes('msgIn'), JSON.stringify(animation));
  await ctx.close();
} finally {
  await browser.close();
}
console.log(`${failures ? 'FAIL' : 'PASS'}: ${failures} fallas`);
process.exitCode = failures ? 1 : 0;

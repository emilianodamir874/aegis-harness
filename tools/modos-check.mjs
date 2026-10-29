// Gate de los tres modos de sesión: cada uno con su textura, su cinta y sus reglas de stream.
// Uso: node tools/modos-check.mjs [url]
// Read-only: abre la web viva, inyecta un turno de muestra y mide estilos computados.
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:3788/';
const res = [];
const check = (n, ok, d = '') => res.push({ n, ok: !!ok, d });
const errores = [];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errores.push(String(e).slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|403/.test(m.text())) errores.push(m.text().slice(0, 160)); });

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__aegisWeb?.chips?.setModo, null, { timeout: 20000 });

/** Un turno de muestra con las mismas clases que produce el render real. */
async function sembrarTurno(modo) {
  await page.evaluate((m) => {
    const w = window.__aegisWeb;
    w.chips.setModo(m);
    let inner = document.getElementById('msg-inner');
    if (!inner) {
      inner = document.createElement('div');
      inner.id = 'msg-inner';
      inner.className = 'msg-inner';
      document.getElementById('messages').appendChild(inner);
    }
    inner.innerHTML = '';
    const user = document.createElement('div');
    user.className = 'msg-user in';
    user.dataset.modo = m;
    user.innerHTML = '<p>revisá el parser de batches</p>';
    inner.appendChild(user);

    const tool = document.createElement('div');
    tool.className = 'tool in ok';
    tool.dataset.modo = m;
    tool.innerHTML = '<span class="tool-ic"></span><div class="tool-body"><div class="tool-title">read_file <span class="tname">read</span></div></div>';
    if (m === 'plan') {
      tool.classList.add('cita');
      const cita = document.createElement('div');
      cita.className = 'tool-cita';
      cita.textContent = 'leyó src/chunked.rs';
      tool.querySelector('.tool-body').appendChild(cita);
    }
    if (m === 'revisar') tool.classList.add('espera');
    inner.appendChild(tool);

    const bot = document.createElement('div');
    bot.className = 'msg-a in';
    bot.dataset.modo = m;
    bot.innerHTML = '<div class="content"><p>Primer párrafo cerrado.</p><p class="pluma">y esto se está escribiendo</p></div>';
    inner.appendChild(bot);
    w.chips.render();
  }, modo);
  // La hoja de estilos es un request aparte: medir antes de que aplique hacia fallar el gate por
  // carrera y no por el diseno. Se espera la regla del modo recien sembrado.
  await page.waitForFunction((m) => {
    const el = document.querySelector('.msg-a[data-modo="' + m + '"]');
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (m === 'plan') return cs.borderLeftStyle === 'dotted';
    if (m === 'revisar') return /217, 164, 91/.test(cs.borderTopColor);
    return /143, 192, 164/.test(cs.borderLeftColor);
  }, modo, { timeout: 8000 });  await page.waitForTimeout(120);
}

const estilo = (sel, props) => page.evaluate(([s, p]) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const out = {};
  for (const k of p) out[k] = cs.getPropertyValue(k);
  return out;
}, [sel, props]);

const pseudo = (sel, which, prop) => page.evaluate(([s, w, p]) => {
  const el = document.querySelector(s);
  if (!el) return '';
  return getComputedStyle(el, w).getPropertyValue(p);
}, [sel, which, prop]);

// ---------- plan · cuaderno ----------
await sembrarTurno('plan');
const cajaPlan = await page.evaluate(() => document.getElementById('messages').dataset.modo);
check('el contenedor se marca con el modo', cajaPlan === 'plan', String(cajaPlan));
const cintaPlan = await page.evaluate(() => document.querySelector('.modo-cinta')?.textContent || '');
check('la cinta dice que plan no escribe', /plan · no escribe/.test(cintaPlan), cintaPlan);
const botPlan = await estilo('.msg-a[data-modo="plan"]', ['border-left-style', 'background-color', 'box-shadow', 'font-family']);
check('en plan la respuesta es hoja: filete punteado y sin caja', botPlan && botPlan['border-left-style'] === 'dotted' && /rgba\(0, 0, 0, 0\)|transparent/.test(botPlan['background-color']), JSON.stringify(botPlan));
check('en plan la respuesta va en serif', /serif|Palatino|Georgia/i.test((botPlan || {})['font-family'] || ''), String((botPlan || {})['font-family']).slice(0, 60));
const marcaUsuario = await pseudo('.msg-user[data-modo="plan"]', '::before', 'content');
check('tu mensaje es nota al margen con ›', marcaUsuario.includes('›'), marcaUsuario);
const cita = await estilo('.tool.cita .tool-cita', ['text-decoration-style', 'font-family']);
check('la lectura es cita subrayada, no card', cita && /dotted/.test(cita['text-decoration-style'] || ''), JSON.stringify(cita));
const iconoOculto = await estilo('.tool.cita .tool-ic', ['display']);
check('la cita no muestra icono de herramienta', iconoOculto && iconoOculto.display === 'none', JSON.stringify(iconoOculto));
const pluma = await pseudo('.msg-a[data-modo="plan"] .pluma', '::after', 'animation-name');
check('el párrafo abierto lleva pluma animada', pluma === 'pluma', pluma);
await page.screenshot({ path: 'tools/shots/modo-plan.png' });

// ---------- revisar · borrador marcado ----------
await sembrarTurno('revisar');
const cintaRev = await page.evaluate(() => document.querySelector('.modo-cinta')?.textContent || '');
check('la cinta de revisar pide el sí', /revisar · cada escritura espera tu sí/.test(cintaRev), cintaRev);
const botRev = await estilo('.msg-a[data-modo="revisar"]', ['border-top-color', 'background-color']);
check('en revisar el folio tiene borde ámbar y fondo de papel', botRev && /217, 164, 91/.test(botRev['border-top-color'] || ''), JSON.stringify(botRev));
const doblez = await pseudo('.msg-a[data-modo="revisar"]', '::after', 'background-image');
check('el folio muestra la esquina doblada', /gradient/.test(doblez || ''), String(doblez).slice(0, 60));
const espera = await pseudo('.tool.espera .tool-title', '::after', 'content');
check('la escritura pendiente avisa que espera', /esperando tu s/.test(espera || ''), espera);
const pulso = await estilo('.tool.espera', ['animation-name']);
check('la escritura pendiente pulsa', pulso && pulso['animation-name'] === 'espera', JSON.stringify(pulso));
await page.screenshot({ path: 'tools/shots/modo-revisar.png' });

// ---------- ejecutar · consola ----------
await sembrarTurno('ejecutar');
const cintaEj = await page.evaluate(() => document.querySelector('.modo-cinta')?.textContent || '');
check('la cinta de ejecutar nombra permission.yaml', /ejecutar · permission\.yaml manda/.test(cintaEj), cintaEj);
const toolEj = await estilo('.tool[data-modo="ejecutar"]', ['font-family', 'border-left-width']);
check('en ejecutar la tool es recibo monoespaciado', /mono|Consolas|Cascadia/i.test((toolEj || {})['font-family'] || ''), String((toolEj || {})['font-family']).slice(0, 60));
const botEj = await estilo('.msg-a[data-modo="ejecutar"]', ['border-left-color']);
check('en ejecutar la respuesta lleva filete verde', botEj && /143, 192, 164/.test(botEj['border-left-color'] || ''), JSON.stringify(botEj));
const sinCita = await page.evaluate(() => !!document.querySelector('.tool.cita'));
check('en ejecutar no hay citas: las lecturas vuelven a ser cards', !sinCita);
await page.screenshot({ path: 'tools/shots/modo-ejecutar.png' });

// ---------- el sello no se re-pinta al cambiar de modo ----------
await page.evaluate(() => window.__aegisWeb.chips.setModo('plan'));
await page.waitForTimeout(80);
const sellos = await page.evaluate(() => ({
  contenedor: document.getElementById('messages').dataset.modo,
  mensaje: document.querySelector('.msg-a')?.dataset.modo || '',
}));
check('cambiar de modo no re-pinta el historial ya escrito', sellos.contenedor === 'plan' && sellos.mensaje === 'ejecutar', JSON.stringify(sellos));

await ctx.close();
await browser.close();

const ok = res.filter((r) => r.ok).length;
for (const r of res) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.n}${r.d ? '  [' + r.d + ']' : ''}`);
if (errores.length) console.log('\nerrores de consola:\n' + errores.join('\n'));
console.log(`\n${ok}/${res.length} PASS`);
process.exit(ok === res.length && !errores.length ? 0 : 1);

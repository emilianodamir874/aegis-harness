// Gate del mapeo de esfuerzos: compara lo que la UI ofrece para cada modelo con lo que el motor
// acepta de verdad (session/set_config_option model + session/load), modelo por modelo.
// Uso: node tools/efforts-map-check.mjs [url] [--todos]
//   --todos   recorre TODOS los modelos de los proveedores aplicables (294 de experiential incluidos)
// Crea una sesion de descarte y la borra al final.
//
// Dos grupos:
//   aplicables  antigravity / chatgpt_codex / experiential -> la UI aplica el modelo y se compara
//               contra lo que el motor recalcula para ESE modelo.
//   fijos       open_design / opencode_go (FIXED_MODELS) -> el motor fuerza deepseek-v4.1-flash:
//               pedir otro modelo no debe cambiar el activo ni inventar niveles.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const BASE = process.argv[2] || 'http://192.168.100.34:3788/';
const TODOS = process.argv.includes('--todos');
const cfg = JSON.parse(await readFile('C:/Aegis-Proyects/web/config.json', 'utf8'));
const APLICABLES = ['antigravity', 'chatgpt_codex', 'experiential'];
const FIJOS = ['open_design', 'opencode_go'];
const PROVS = [...APLICABLES, ...FIJOS];

const ws = new WebSocket(`ws://${cfg.publicHost}:${cfg.servePort}/acp?token=${cfg.secretKey}`);
let id = 0;
const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && !m.method && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
await new Promise((r) => ws.addEventListener('open', r));
const req = (m, p) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ jsonrpc: '2.0', id: i, method: m, params: p || {} })); });
await req('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'efforts-map', version: '1' } });
const sid = (await req('session/new', { cwd: cfg.cwd, mcpServers: [] })).result.sessionId;

const motor = async () => {
  const r = await req('session/load', { sessionId: sid, cwd: cfg.cwd, mcpServers: [] });
  const co = r.result.configOptions || [];
  const ef = co.find((o) => o && o.id === 'thinking_effort');
  const md = co.find((o) => o && o.id === 'model');
  return {
    niveles: ef && Array.isArray(ef.options) ? ef.options.map((o) => String(o.value)) : [],
    modelo: md ? String(md.currentValue) : '',
    esfuerzo: ef ? String(ef.currentValue) : '',
  };
};

const res = [];
const check = (n, ok, d = '') => res.push({ n, ok: !!ok, d });
const filas = [];
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errores = [];
page.on('pageerror', (e) => errores.push(String(e).slice(0, 160)));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__aegisWeb?.chips?.efforts, null, { timeout: 15000 });
await page.evaluate((e) => window.__aegisWeb.chips.abrirSesion(e), { sessionId: sid, title: 'gate efforts', cwd: cfg.cwd });
await page.waitForSelector('#chips .chip-model', { timeout: 15000 });
await page.waitForTimeout(1200);

const universo = await page.evaluate((provs) => {
  const cat = window.__aegisWeb.chips.catalogo() || [];
  const out = {};
  for (const p of provs) {
    const e = cat.find((x) => x && x.providerId === p);
    out[p] = e && Array.isArray(e.models) ? e.models.map((m) => String(m.id)) : [];
  }
  return out;
}, PROVS);
check('el catalogo trae los cinco proveedores visibles', PROVS.every((p) => (universo[p] || []).length > 0), PROVS.map((p) => p + ':' + (universo[p] || []).length).join(' '));

// Muestra por proveedor.
const muestra = (provs) => {
  const out = [];
  for (const p of provs) {
    const lista = universo[p] || [];
    let paso;
    if (TODOS) paso = lista;                     // exhaustivo: todos los modelos aplicables
    else if (lista.length <= 6) paso = lista;
    else paso = [lista[0], lista[Math.floor(lista.length / 2)], lista[lista.length - 1]];
    for (const m of paso) out.push({ prov: p, model: m });
  }
  return out;
};

// ---------- grupo A: modelos aplicables ----------
for (const caso of muestra(APLICABLES)) {
  await page.evaluate(({ p, m }) => window.__aegisWeb.chips.efforts.aplicar(p, m), { p: caso.prov, m: caso.model });
  await page.waitForTimeout(320);
  const real = await motor();
  const activo = await page.evaluate(() => window.__aegisWeb.chips.modeloActivo());
  if (activo !== caso.model) {
    // El motor parte el sufijo de esfuerzo que algunos ids traen embebido (o3-mini-high ->
    // o3-mini + effort high). No es un fallo: es una normalizacion, y se verifica como tal.
    const m = /^(.*)-(off|low|medium|high|max)$/.exec(caso.model);
    const normalizado = !!m && real.modelo === m[1] && real.esfuerzo === m[2];
    filas.push({ ...caso, motor: real.niveles.join(','), ui: normalizado ? 'normalizado' : '(no aplico)', veredicto: normalizado ? 'ok' : 'NO APLICA' });
    if (!normalizado) continue;
    const uiNorm = await page.evaluate(({ p, mi }) => window.__aegisWeb.chips.efforts.de(p, mi), { p: caso.prov, mi: m[1] });
    const okNorm = real.niveles.length === uiNorm.length && real.niveles.every((v) => uiNorm.includes(v));
    if (!okNorm) filas[filas.length - 1].veredicto = 'DIFIERE';
    continue;
  }
  const ui = await page.evaluate(({ p, m }) => ({
    de: window.__aegisWeb.chips.efforts.de(p, m),
    niveles: window.__aegisWeb.chips.efforts.niveles(p, m),
    chip: window.__aegisWeb.chips.efforts.chip(p, m),
  }), { p: caso.prov, m: caso.model });
  const igual = (a, b) => a.length === b.length && a.every((v) => b.includes(v));
  const okLista = igual(real.niveles, ui.de);
  const okPanel = igual(real.niveles, ui.niveles);
  const unNivel = real.niveles.length === 1;
  const okChip = unNivel ? ui.chip === '' : real.niveles.includes(ui.chip);
  filas.push({
    ...caso, motor: real.niveles.join(','), ui: ui.de.join(','),
    veredicto: okLista && okPanel && okChip ? 'ok' : 'DIFIERE',
  });
}

const difieren = filas.filter((f) => f.veredicto === 'DIFIERE');
check('la UI ofrece exactamente lo que el motor acepta para cada modelo', difieren.length === 0,
  difieren.length ? difieren.map((f) => `${f.prov}/${f.model}: motor=${f.motor} ui=${f.ui}`).join(' | ') : `${filas.length} modelos`);

// ---------- grupo B: proveedores con modelo fijo ----------
for (const p of FIJOS) {
  const otro = (universo[p] || []).find((m) => m !== 'deepseek-v4.1-flash') || '';
  if (!otro) { check(`${p}: el catalogo tiene un solo modelo`, true, 'nada que forzar'); continue; }
  await page.evaluate(({ prov, m }) => window.__aegisWeb.chips.efforts.aplicar(prov, m), { prov: p, m: otro });
  await page.waitForTimeout(500);
  const real = await motor();
  const activo = await page.evaluate(() => window.__aegisWeb.chips.modeloActivo());
  const ui = await page.evaluate(({ prov, m }) => window.__aegisWeb.chips.efforts.de(prov, m), { prov: p, m: otro });
  check(`${p}: pedir ${otro} no cambia el modelo fijo ni inventa niveles`,
    activo === 'deepseek-v4.1-flash' && real.modelo === 'deepseek-v4.1-flash'
      && real.niveles.length === ui.length && real.niveles.every((v) => ui.includes(v)),
    `activo=${activo} motor=${real.modelo} niveles motor=[${real.niveles.join(',')}] ui=[${ui.join(',')}]`);
}

// ---------- caso dirigido: nivel inexistente -> el motor lo normaliza ----------
const sinMedium = filas.find((f) => f.veredicto === 'ok' && !f.motor.split(',').includes('medium') && f.motor.includes('high'));
if (sinMedium) {
  await page.evaluate(({ p, m }) => window.__aegisWeb.chips.efforts.aplicar(p, m, 'medium'), { p: sinMedium.prov, m: sinMedium.model });
  await page.waitForTimeout(600);
  const real = await motor();
  const chip = await page.evaluate(({ p, m }) => window.__aegisWeb.chips.efforts.chip(p, m), { p: sinMedium.prov, m: sinMedium.model });
  check('pedir un nivel que el modelo no tiene cae al mas cercano real',
    !real.niveles.includes('medium') && real.esfuerzo !== 'medium' && real.esfuerzo === chip,
    `${sinMedium.prov}/${sinMedium.model} pidio medium -> motor=${real.esfuerzo} chip=${chip} (opciones: ${real.niveles.join(',')})`);
} else {
  check('pedir un nivel que el modelo no tiene cae al mas cercano real', true, 'ningun modelo de la muestra sin medium');
}

// ---------- caso dirigido: modelo de un solo nivel ----------
const unNivel = filas.find((f) => f.veredicto === 'ok' && f.motor === 'off');
if (unNivel) {
  const ui = await page.evaluate(({ p, m }) => ({
    chip: window.__aegisWeb.chips.efforts.chip(p, m),
    niveles: window.__aegisWeb.chips.efforts.niveles(p, m),
  }), { p: unNivel.prov, m: unNivel.model });
  check('un modelo sin niveles no pinta esfuerzo en el chip', ui.chip === '' && ui.niveles.length === 1 && ui.niveles[0] === 'off',
    `${unNivel.prov}/${unNivel.model}: chip="${ui.chip}" niveles=[${ui.niveles.join(',')}]`);
} else {
  check('un modelo sin niveles no pinta esfuerzo en el chip', true, 'la muestra no incluyo ninguno');
}

await browser.close();
await req('session/delete', { sessionId: sid });
ws.close();

// Agregado: cuantas listas distintas tiene cada proveedor entre los modelos medidos.
const porProv = {};
for (const f of filas) {
  if (f.veredicto === 'NO APLICA' || !f.motor) continue;
  porProv[f.prov] = porProv[f.prov] || new Set();
  porProv[f.prov].add(f.motor);
}
console.log('\nlistas de esfuerzo distintas por proveedor (entre los modelos medidos):');
for (const [p, set] of Object.entries(porProv)) console.log(`  ${p}: ${set.size} -> ${[...set].map((l) => '[' + l + ']').join(' ')}`);

console.log('\n--- tabla ---');
for (const f of filas) console.log(`${f.veredicto.padEnd(9)} ${f.prov.padEnd(14)} ${String(f.model).padEnd(32)} motor=[${f.motor}] ui=[${f.ui}]`);
const ok = res.filter((r) => r.ok).length;
for (const r of res) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.n}${r.d ? '  [' + r.d + ']' : ''}`);
if (errores.length) console.log('\nerrores de consola:\n' + errores.join('\n'));
console.log(`\n${ok}/${res.length} PASS`);
process.exit(ok === res.length && !errores.length ? 0 : 1);

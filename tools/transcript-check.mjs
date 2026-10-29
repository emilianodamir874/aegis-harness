// Gate del transcript: como se concatena lo que llega del motor.
//
// El bug que lo origino: un chunk que NO era continuacion exacta de lo pintado se appendeaba a
// ciegas, y el razonamiento quedaba partido a mitad de frase o duplicado. Aca se alimentan los
// cuatro modos que puede mandar el motor (delta puro, acumulado, reemision, fragmento huerfano) y
// se verifica que el texto pintado sea exactamente lo que la app deberia mostrar.
//
// Uso: node tools/transcript-check.mjs [url]
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://192.168.100.34:3788/';
const res = [];
const check = (n, ok, d = '') => res.push({ n, ok: !!ok, d });

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errores = [];
page.on('pageerror', (e) => errores.push(String(e).slice(0, 160)));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__aegisWeb?.feed, null, { timeout: 20000 });
await page.waitForTimeout(400);

// Limpia el transcript y alimenta una secuencia; devuelve el texto pintado del rec de ese key.
const correr = (key, chunks, thought = true) => page.evaluate(({ key, chunks, thought }) => {
  const W = window.__aegisWeb;
  const inner = document.querySelector('#msg-inner');
  if (inner) inner.innerHTML = '';
  W.state.msgs.clear();
  for (const c of chunks) W.feed(key, c, thought);
  const rec = W.state.msgs.get(key);
  return rec ? { texto: rec.text, html: rec.body.innerHTML.length } : null;
}, { key, chunks, thought });

// ---------- 1. delta puro ----------
const delta = await correr('t1', ['Mirando ', 'el archivo ', 'y el último commit.']);
check('delta puro: se concatena tal cual',
  delta && delta.texto === 'Mirando el archivo y el último commit.',
  delta && JSON.stringify(delta.texto));

// ---------- 2. acumulado (el provider reemite todo) ----------
const acum = await correr('t2', ['Mirando el archivo.', 'Mirando el archivo. y el commit.', 'Mirando el archivo. y el commit. Y la rama.']);
check('acumulado: no duplica, queda el texto completo',
  acum && acum.texto === 'Mirando el archivo. y el commit. Y la rama.',
  acum && JSON.stringify(acum.texto));

// ---------- 3. reemision completa distinta ----------
// El provider reemite el acumulado de otro tramo: mismo arranque, mas largo. Antes se sumaba y el
// razonamiento aparecia dos veces.
const reem = await correr('t3', [
  'Reviso el archivo y veo que el panel de letra todavia tiene el control nativo.',
  'Reviso el archivo y veo que el panel de letra todavia tiene el control nativo. Lo cambio por un riel propio con dos A en los extremos, y despues mido.',
]);
check('reemision del acumulado: reemplaza en vez de sumar',
  reem && reem.texto.startsWith('Reviso el archivo') && reem.texto.split('Reviso el archivo').length === 2 && reem.texto.length > 120,
  reem && JSON.stringify(reem.texto.length));

// ---------- 4. fragmento huerfano con solape ----------
const solape = await correr('t4', [
  'antes de seguir con el repaso de los paneles y el chasis comun de la interfaz',
  'comun de la interfaz: hay que revisar el borde del panel.',
]);
check('solape: recorta lo repetido y no parte la frase',
  solape && solape.texto === 'antes de seguir con el repaso de los paneles y el chasis comun de la interfaz: hay que revisar el borde del panel.',
  solape && JSON.stringify(solape.texto.slice(-70)));

// ---------- 5. identificadores partidos a mitad de palabra ----------
// El motor corta donde quiere: "overflow" + "-y: auto" o "--" + "vars". Antes se metia un \n\n
// delante de cualquier chunk que arrancara con guion y el markdown lo leia como vineta: el
// razonamiento se veia partido EN VIVO y bien al recargar.
const partido = await correr('t5', [
  'El panel tiene overflow',
  '-y: auto + backdrop',
  '-filter: blur(2px); y adentro',
  '-- sin tocar el resto.',
]);
check('identificadores partidos: se pegan sin separadores ni vinetas',
  partido && partido.texto === 'El panel tiene overflow-y: auto + backdrop-filter: blur(2px); y adentro-- sin tocar el resto.'
  && !/\n/.test(partido.texto),
  partido && JSON.stringify(partido.texto));

// ---------- 6. retroceso (llega menos texto que lo ya pintado) ----------
const retro = await correr('t6', ['Texto completo del razonamiento que ya estaba pintado en pantalla.', 'Texto completo']);
check('retroceso: ignora el chunk corto y conserva lo pintado',
  retro && retro.texto === 'Texto completo del razonamiento que ya estaba pintado en pantalla.',
  retro && JSON.stringify(retro.texto.slice(0, 40)));

// ---------- 7. razonamiento y respuesta no se mezclan ----------
const mezcla = await page.evaluate(() => {
  const W = window.__aegisWeb;
  const inner = document.querySelector('#msg-inner');
  if (inner) inner.innerHTML = '';
  W.state.msgs.clear();
  W.feed('r1', 'Pienso el plan y lo anoto.', true);
  W.feed('a1', 'Y esta es la respuesta final.', false);
  return {
    razon: W.state.msgs.get('r1')?.text,
    resp: W.state.msgs.get('a1')?.text,
    cajas: document.querySelectorAll('#msg-inner .msg-a').length,
  };
});
check('razonamiento y respuesta viven en cajas separadas',
  mezcla.razon === 'Pienso el plan y lo anoto.' && mezcla.resp === 'Y esta es la respuesta final.' && mezcla.cajas === 2,
  JSON.stringify(mezcla));

// ---------- 8. la tarjeta de herramienta avisa cuando el comando se corta ----------
const tool = await page.evaluate(() => {
  const W = window.__aegisWeb;
  const inner = document.querySelector('#msg-inner');
  if (inner) inner.innerHTML = '';
  W.toolFeed({ toolCallId: 'x1', kind: 'shell', status: 'in_progress', rawInput: { command: 'cd C:\\Aegis-Proyects\\web; python tools\\_cc1.py; Remove-Item tools\\_cc1.py; node --check app\\bundle.js' } });
  const el = W.state.tools.get('x1');
  const tt = el?.querySelector('.tool-title'); return { titulo: (tt?.firstChild?.textContent || '').trim(), completo: tt?.textContent?.trim() || '', estado: el?.dataset.state || '' };
});
check('comando largo: se recorta con puntos suspensivos, no en seco',
  /…$/.test(tool.titulo) && tool.titulo.length <= 91 && tool.estado === 'run',
  JSON.stringify(tool));

// ---------- 9. un update no repite el boton "Ver todo" ----------
const botones = await page.evaluate(async () => {
  const W = window.__aegisWeb;
  const largo = Array.from({ length: 200 }, (_, i) => 'linea ' + i).join('\n');
  const u = { toolCallId: 'x2', kind: 'shell', status: 'in_progress', rawInput: { command: 'ls' }, content: [{ type: 'content', content: { type: 'text', text: largo } }] };
  W.toolFeed(u);
  await new Promise((r) => setTimeout(r, 260));
  W.toolFeed({ ...u, status: 'completed' });
  await new Promise((r) => setTimeout(r, 260));
  const el = W.state.tools.get('x2');
  return { botones: el ? el.querySelectorAll('.tool-more').length : -1, estado: el?.dataset.state };
});
check('la tarjeta no acumula botones "Ver todo" al actualizarse', botones.botones === 1 && botones.estado === 'ok', JSON.stringify(botones));

// ---------- 10. refresco suave: el camino del turno en vivo ----------
// Este era el agujero: durante el turno el texto se acumula en SOFT.text, no en rec.text, asi que
// la reconciliacion del pintado directo no se aplicaba y el razonamiento salia partido.
const suave = await page.evaluate(() => {
  const W = window.__aegisWeb;
  const inner = document.querySelector('#msg-inner');
  if (inner) inner.innerHTML = '';
  W.setSoft(true);
  try {
    W.feed('s1', 'Reviso el archivo del panel y veo que el control todavia', true);
    W.feed('s1', ' es el nativo del navegador, con dos numeros sueltos.', true);
    W.feed('s1', 'Reviso el archivo del panel y veo que el control todavia es el nativo del navegador, con dos numeros sueltos. Lo cambio.', true);
    return { texto: W.softText('s1') };
  } finally { W.setSoft(false); }
});
check('refresco suave: aplica la misma reconciliacion (no duplica ni parte)',
  suave.texto === 'Reviso el archivo del panel y veo que el control todavia es el nativo del navegador, con dos numeros sueltos. Lo cambio.',
  suave.texto.slice(0, 90));

// ---------- 11. hub replay: lo que llega al reconectar ----------
const hub = await page.evaluate(() => {
  const W = window.__aegisWeb;
  W.setHub(true);
  try {
    W.feed('h1', 'El plan era arreglar el transcript y despues', true);
    W.feed('h1', ' los paneles, con sus pruebas.', true);
    W.feed('h1', 'El plan era arreglar el transcript y despues los paneles, con sus pruebas. Y despues medir.', true);
    return { texto: W.hubText('h1') };
  } finally { W.setHub(false); }
});
check('hub replay: aplica la misma reconciliacion',
  hub.texto === 'El plan era arreglar el transcript y despues los paneles, con sus pruebas. Y despues medir.',
  hub.texto.slice(0, 90));

// ---------- 12. una sola caja de razonamiento aunque se intercale cromo ----------
// thoughtKeyFor exigia "ultimo hijo del wrap": cualquier nodo de cromo entre chunks abria caja
// nueva y un razonamiento se veia como seis bloques. Ahora solo corta si hay otra caja de mensaje.
const unaCaja = await page.evaluate(async () => {
  const W = window.__aegisWeb;
  const inner = document.querySelector('#msg-inner');
  if (inner) inner.innerHTML = '';
  W.state.msgs.clear();
  W.state.thoughtRec = null;
  const wrap = document.querySelector('#msg-inner') || inner;
  // Se usa el MISMO camino que el motor: thoughtKeyFor() decide la clave en cada chunk.
  const k1 = W.thinkKey({ messageId: 'm1' });
  W.feed(k1, 'Primer tramo del razonamiento.', true);
  // cromo entre medio: un nodo suelto que no es caja de mensaje
  const ruido = document.createElement('div');
  ruido.className = 'runbar';
  if (wrap) wrap.appendChild(ruido);
  const k2 = W.thinkKey({ messageId: 'm1' });
  W.feed(k2, ' Segundo tramo, misma caja.', true);
  const cajas = document.querySelectorAll('#msg-inner .msg-a').length;
  const rec = W.state.msgs.get(k1);
  return { cajas, mismaClave: k1 === k2, texto: rec ? rec.text : '', claves: [...W.state.msgs.keys()] };
});
check('un solo razonamiento = una sola caja, aunque se intercale cromo',
  unaCaja.cajas === 1 && unaCaja.mismaClave && /Segundo tramo/.test(unaCaja.texto || ''),
  JSON.stringify(unaCaja));

await browser.close();
const ok = res.filter((r) => r.ok).length;
for (const r of res) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.n}${r.d ? '  [' + r.d + ']' : ''}`);
if (errores.length) console.log('\nerrores de consola:\n' + errores.join('\n'));
console.log(`\n${ok}/${res.length} PASS`);
process.exit(ok === res.length && !errores.length ? 0 : 1);

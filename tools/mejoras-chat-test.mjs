import { chromium } from 'playwright';
const br = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const p = await (await br.newContext({ viewport: { width: 430, height: 900 } })).newPage();
const errs = [], tts = [];
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
p.on('request', (r) => { if (r.url().includes('/tts?')) tts.push(decodeURIComponent(new URL(r.url()).searchParams.get('text') || '')); });
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'load' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.read && window.__aegisWeb.read.live, null, { timeout: 20000 });
const W = () => p.evaluate(() => window.__aegisWeb);

console.log('== 1) BORRADOR POR CHAT ==');
const r1 = await p.evaluate(async () => {
  const aw = window.__aegisWeb;
  aw.state.current = { id: 'chatA', title: 'A' };
  const inp = document.getElementById('input');
  inp.value = 'borrador de A sin enviar';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 700));
  const guardadoA = localStorage.getItem('aegis.draft.chatA');
  // me voy a otro chat: carga el borrador de B (vacio)
  aw.state.current = { id: 'chatB', title: 'B' };
  inp.value = ''; aw.read.draft.load();
  const enB = inp.value;
  inp.value = 'borrador de B'; inp.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 700));
  const guardadoB = localStorage.getItem('aegis.draft.chatB');
  // vuelvo a A: tiene que reaparecer lo de A
  aw.state.current = { id: 'chatA', title: 'A' };
  inp.value = ''; aw.read.draft.load();
  const alVolverA = inp.value;
  // envio: el borrador de A se limpia
  inp.value = ''; aw.read.draft.save();
  const trasEnviar = localStorage.getItem('aegis.draft.chatA');
  return { guardadoA, enB, guardadoB, alVolverA, trasEnviar };
});
console.log('  guardado en A: ' + JSON.stringify(r1.guardadoA));
console.log('  al cambiar a B ve: ' + JSON.stringify(r1.enB) + ' | B guardo: ' + JSON.stringify(r1.guardadoB));
console.log('  al volver a A ve: ' + JSON.stringify(r1.alVolverA) + ' | tras enviar (debe ser null): ' + JSON.stringify(r1.trasEnviar));

console.log('== 2) ESTADO EN VIVO DE LOS TURNOS (desde cualquier chat) ==');
const r2 = await p.evaluate(async () => {
  const aw = window.__aegisWeb;
  aw.state.current = { id: 'yo-estoy-en-otro', title: 'otro' };
  aw.read.live.mark('sess-trabajando', true);
  const corriendo = { running: aw.read.live.running('sess-trabajando'), any: aw.read.live.any(), done: aw.read.live.done('sess-trabajando') };
  const notasAntes = document.querySelectorAll('.sysnote').length;
  aw.read.live.mark('sess-trabajando', false);
  const despues = { running: aw.read.live.running('sess-trabajando'), any: aw.read.live.any(), done: aw.read.live.done('sess-trabajando') };
  await new Promise((r) => setTimeout(r, 300));
  const notas = [...document.querySelectorAll('.sysnote')].map((e) => e.textContent).slice(-1);
  const titulo = document.title;
  return { corriendo, despues, notasNuevas: document.querySelectorAll('.sysnote').length - notasAntes, ultimaNota: notas, titulo };
});
console.log('  mientras corre: ' + JSON.stringify(r2.corriendo));
console.log('  al terminar:    ' + JSON.stringify(r2.despues));
console.log('  avisa en otro chat: notas nuevas=' + r2.notasNuevas + ' | ' + JSON.stringify(r2.ultimaNota));
console.log('  titulo de la pestana: ' + JSON.stringify(r2.titulo));

console.log('== 3) VOLVER A ESCUCHAR (boton en el mensaje) ==');
await p.evaluate(() => {
  const aw = window.__aegisWeb;
  aw.state.current = { id: 'chatA', title: 'A' };
  aw.read.engine('piper');
  aw.read.toggle(true);
  aw.read.append('## 🔊 Para escuchar\nMensaje viejo con bloque. Se puede volver a escuchar.\n\n## Detalle\nEsto no se lee.');
});
await p.waitForTimeout(1500);
const info = await p.evaluate(() => {
  const b = document.querySelector('.msg-read');
  return { hayBoton: !!b, visible: b ? !b.hidden : false, texto: b ? b.textContent : null, conBlq: document.querySelectorAll('.msg-read:not([hidden])').length };
});
console.log('  boton: ' + JSON.stringify(info));
const ttsAntes = tts.length;
await p.evaluate(() => document.querySelector('.msg-read').click());
await p.waitForTimeout(4000);
console.log('  pedidos /tts al hacer clic: ' + JSON.stringify(tts.slice(ttsAntes)));
await p.evaluate(() => window.__aegisWeb.read.append('Mensaje sin bloque para nada.'));
await p.waitForTimeout(800);
const sinBloque = await p.evaluate(() => { const bs = [...document.querySelectorAll('.msg-read')]; return { botones: bs.length, visibles: bs.filter((b) => !b.hidden).length }; });
console.log('  mensaje sin bloque -> boton oculto? ' + JSON.stringify(sinBloque));
console.log('errores: ' + JSON.stringify(errs));
await br.close();

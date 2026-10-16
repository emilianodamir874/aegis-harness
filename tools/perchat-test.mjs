import { chromium } from 'playwright';
const br = await chromium.launch();
const p = await (await br.newContext({ viewport: { width: 430, height: 900 } })).newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 140)));
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'load' });
await p.waitForFunction(() => window.__aegisWeb && window.__aegisWeb.read && window.__aegisWeb.read.perChat, null, { timeout: 20000 });
console.log('== modo lectura POR CHAT ==');
const r = await p.evaluate(async () => {
  const aw = window.__aegisWeb;
  localStorage.clear();
  // chat A: lo prendo
  aw.state.current = { id: 'chatA' };
  aw.read.toggle(true);
  const A_clave = localStorage.getItem('aegis.readOn.chatA');
  // me voy al chat B: tiene que estar apagado
  aw.state.current = { id: 'chatB' };
  const B_estado = aw.read.perChat.load();
  aw.state.current = { id: 'chatA' };
  const A_estado = aw.read.perChat.load();
  // lo apago en A, vuelvo a B y sigo apagado; vuelvo a A y sigue apagado
  aw.read.toggle(false);
  const A_apagado = aw.read.perChat.load();
  const B_sigue = (aw.state.current = { id: 'chatB' }, aw.read.perChat.load());
  // migracion del interruptor global viejo
  localStorage.clear();
  localStorage.setItem('aegis.readOn', '1');
  aw.state.current = { id: 'chatC' };
  const migrado = aw.read.perChat.load();
  const claveNueva = localStorage.getItem('aegis.readOn.chatC');
  const globalBorrado = localStorage.getItem('aegis.readOn');
  // el boton refleja el estado
  const boton = document.getElementById('btn-read').className;
  return { A_clave, B_estado, A_estado, A_apagado, B_sigue, migrado, claveNueva, globalBorrado, boton };
});
console.log(JSON.stringify(r, null, 1));
console.log('errores: ' + JSON.stringify(errs));
await br.close();

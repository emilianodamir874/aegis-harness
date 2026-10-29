// Gate de lectura del transcript: historial de prompts, variantes, buscar (Ctrl+F), ir al final y
// acciones por mensaje. Sin backend: sirve el bundle compilado y un ACP de mentira.
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const app = join(import.meta.dirname, '..', 'dist-ts', 'app');
const origin = 'http://lectura-fixture.invalid';
const browser = await chromium.launch();
let checks = 0;
const eq = (a, b, que) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(que + ': ' + JSON.stringify(a) + ' != ' + JSON.stringify(b)); checks++; };
const ok = (v, que) => { if (!v) throw new Error(que); checks++; };

try {
  for (const [ancho, alto, movil] of [[384, 832, true], [1440, 900, false]]) {
    const ctx = await browser.newContext({ viewport: { width: ancho, height: alto }, isMobile: movil, hasTouch: movil, deviceScaleFactor: movil ? 2.625 : 1 });
    const page = await ctx.newPage();
    const errores = [];
    page.on('pageerror', (e) => errores.push(String(e.message).slice(0, 160)));
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'lectura-fixture.invalid') return route.abort();
      if (url.pathname === '/config.js') return route.fulfill({ contentType: 'application/javascript', body: "window.__AEGIS_APP__={acpUrl:'ws://lectura-fixture.invalid/acp',cwd:'/mock',host:'mock'};" });
      if (url.pathname === '/client-log') return route.fulfill({ status: 204, body: '' });
      if (url.pathname.startsWith('/changes.json')) return route.fulfill({ json: { kind: 'not-git', entries: [], truncated: false } });
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = join(app, rel);
      if (!existsSync(file)) return route.fulfill({ status: 404, body: 'no' });
      return route.fulfill({ path: file });
    });
    await page.goto(origin + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => !!globalThis.__aegisLectura, null, { timeout: 20000 });

    // 1) Historial de prompts, con persistencia entre recargas.
    const hist = await page.evaluate(() => {
      const h = globalThis.__aegisLectura.historial;
      h.cambiarSesion('s1');
      h.guardar('s1', 'primer prompt');
      h.guardar('s1', 'segundo prompt');
      h.guardar('s1', 'segundo prompt'); // duplicado consecutivo: no se apila
      const a = h.atras('borrador en curso');
      const b = h.atras('borrador en curso');
      const c = h.atras('borrador en curso');
      const d = h.adelante();
      const e = h.adelante();
      return { a, b, c, d, e, total: h.total() };
    });
    eq(hist.a, 'segundo prompt', 'la primera flecha trae el ultimo prompt');
    eq(hist.b, 'primer prompt', 'la segunda trae el anterior');
    eq(hist.c, null, 'en el tope no inventa nada');
    eq(hist.d, 'segundo prompt', 'bajar vuelve al siguiente');
    eq(hist.e, 'borrador en curso', 'al final devuelve lo que estabas escribiendo');
    eq(hist.total, 2, 'el prompt repetido no se duplica');
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => !!globalThis.__aegisLectura, null, { timeout: 20000 });
    const persistido = await page.evaluate(() => {
      const h = globalThis.__aegisLectura.historial;
      h.cambiarSesion('s1');
      return h.atras('');
    });
    eq(persistido, 'segundo prompt', 'el historial sobrevive a la recarga');

    // 2) Variantes de respuesta.
    const vars = await page.evaluate(() => {
      const v = globalThis.__aegisLectura.variantes;
      v.cambiarSesion('s1');
      const turno = v.archivar('<p>primera</p>');
      v.agregar('<p>segunda</p>', turno);
      const pos1 = v.posicion();
      const atras = v.mover(-1);
      const pos2 = v.posicion();
      const tope = v.mover(-1);
      const adelante = v.mover(1);
      return { pos1, atras: atras && atras.html, pos2, tope, adelante: adelante && adelante.html };
    });
    eq(vars.pos1, { idx: 1, total: 2 }, 'dos variantes, parado en la ultima');
    eq(vars.atras, '<p>primera</p>', 'volver trae la respuesta anterior');
    eq(vars.pos2, { idx: 0, total: 2 }, 'la posicion se mueve');
    eq(vars.tope, null, 'no se pasa del principio');
    eq(vars.adelante, '<p>segunda</p>', 'se puede volver a la ultima');

    // 3) Buscar en la conversacion (Ctrl+F) sobre un transcript real.
    await page.evaluate(() => {
      const app = globalThis.__aegisWeb;
      app.state.current = { id: 's1', title: 'prueba', cwd: '/mock', configOptions: [] };
      document.querySelector('#welcome')?.remove();
      const texto = 'El teclado del telefono achica la pantalla y el composer queda arriba. '.repeat(6);
      app.testUi.update({ sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: texto + ' TECLADO otra vez teclado.' } } });
    });
    await page.waitForSelector('.msg-a', { timeout: 5000 });
    // El texto del stream entra en el siguiente frame: esperar que este volcado antes de buscar.
    await page.waitForFunction(() => (document.querySelector('.msg-a')?.textContent || '').includes('teclado'), null, { timeout: 5000 });
    await page.keyboard.press('Control+f');
    await page.waitForSelector('.buscar-barra:not([hidden])', { timeout: 3000 });
    await page.evaluate(() => globalThis.__aegisLectura.buscarTexto('teclado'));
    await page.waitForTimeout(250);
    const busca = await page.evaluate(() => ({
      hits: document.querySelectorAll('[data-buscar]').length,
      cuenta: document.querySelector('.buscar-cuenta')?.textContent,
      activo: document.querySelectorAll('[data-buscar].buscar-actual').length,
    }));
    ok(busca.hits >= 1, 'marca los mensajes con coincidencias: ' + JSON.stringify(busca) + ' diag=' + JSON.stringify(await page.evaluate(() => ({ ...globalThis.__aegisLectura.estadoBusqueda(), txt: (document.querySelector('.msg-a')?.textContent || '').slice(0, 60), valor: document.querySelector('.buscar-input')?.value }))));
    ok(/\d+\/\d+/.test(busca.cuenta || ''), 'la cuenta se muestra: ' + busca.cuenta);
    eq(busca.activo, 1, 'una sola coincidencia marcada como actual');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);
    const cerrado = await page.evaluate(() => ({
      marcas: document.querySelectorAll('[data-buscar]').length,
      barraOculta: document.querySelector('.buscar-barra')?.hidden,
      textoIntacto: (document.querySelector('.msg-a')?.textContent || '').includes('El teclado del telefono'),
    }));
    eq(cerrado.marcas, 0, 'al cerrar no queda ningun mensaje marcado');
    eq(cerrado.barraOculta, true, 'la barra se oculta');
    ok(cerrado.textoIntacto, 'el texto del mensaje queda intacto');

    // 4) Acciones por mensaje: existen, copian sin romper y "editar" llena el composer.
    const actos = await page.evaluate(() => {
      const el = document.querySelector('.msg-a');
      const fila = el?.querySelector(':scope > .msg-acts');
      return { fila: !!fila, botones: [...(fila?.querySelectorAll('.msg-act') || [])].map((b) => b.dataset.act), altura: fila ? Math.round(fila.querySelector('.msg-act').getBoundingClientRect().height) : 0 };
    });
    ok(actos.fila, 'cada mensaje del agente tiene su fila de acciones');
    eq(actos.botones, ['copiar'], 'el mensaje del agente ofrece copiar');
    if (movil) ok(actos.altura >= 30, 'en el telefono el boton es tocable: ' + actos.altura + 'px');
    await page.evaluate(() => {
      const app = globalThis.__aegisWeb;
      app.testUi.addUser('un prompt de usuario que se puede editar', false, []);
    });
    await page.waitForTimeout(120);
    const editar = await page.evaluate(() => {
      const usuarios = [...document.querySelectorAll('.msg-user')];
      const el = usuarios[usuarios.length - 1];
      const boton = el.querySelector('.msg-act[data-act="editar"]');
      boton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return { boton: !!boton, valor: document.querySelector('#input')?.value };
    });
    ok(editar.boton, 'el mensaje del usuario ofrece editar');
    ok((editar.valor || '').includes('se puede editar'), 'editar carga el texto en el composer: ' + editar.valor);

    ok(await page.locator('.ir-final').count() === 1, 'existe la pildora de ir al final');
    eq(errores.length, 0, 'sin errores de pagina: ' + errores.join(' | '));
    await ctx.close();
    console.log(ancho + 'x' + alto + ': historial, variantes, buscar, acciones e ir-al-final PASS');
  }
} finally {
  await browser.close();
}
console.log('PASS lectura del transcript (' + checks + ' comprobaciones)');

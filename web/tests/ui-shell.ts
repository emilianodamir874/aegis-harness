// Shell de la UI: jerarquia, acciones por fila, menus con teclado, panel de Skills
// y desborde horizontal en tres anchos. Read-only: no crea sesiones ni turnos.
import { chromium } from 'playwright';
import { baseUrl, check, pass, openPage } from './lib.js';

const url = baseUrl();
const browser = await chromium.launch({ headless: true });

// ¿El proxy vivo ya sirve /search.json? Hasta que se reinicie responde 404 y la UI oculta la
// seccion (comportamiento cubierto en search-e2e). Cuando exista, este test exige resultados
// reales en vez de tolerar el 404.
let liveSearch: { ok: boolean; sessions: number } = { ok: false, sessions: 0 };
try {
  const r = await fetch(url + '/search.json?q=aegis&limit=5');
  if (r.ok) {
    const j: any = await r.json();
    liveSearch = { ok: true, sessions: Array.isArray(j.results) ? j.results.length : 0 };
  }
} catch {}

// Contraste WCAG de un texto contra un fondo opaco (ambos rgb/rgba ya compuestos).
function ratio(a: number[], b: number[]): number {
  const lum = (c: number[]) => {
    const f = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
const parse = (css: string): number[] => (css.match(/[\d.]+/g) || []).slice(0, 3).map(Number);

try {
  const page = await openPage(browser, { viewport: { width: 1440, height: 900 } });
  const errs: string[] = [];
  const bad: string[] = [];
  page.on('pageerror', (e: Error) => errs.push(e.message));
  page.on('response', (r: any) => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url()); });

  await page.goto(url + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('#session-list .sb-row', { timeout: 20000 });
  await page.waitForTimeout(1200);

  // --- jerarquia y estructura
  const shell = await page.evaluate(() => {
    const h1 = document.querySelectorAll('h1');
    const rows = document.querySelectorAll('.sb-row').length;
    return {
      h1: h1.length === 1 && h1[0].id === 'chat-title' && h1[0].tagName === 'H1',
      rows,
      more: document.querySelectorAll('.sb-more').length,
      legacyDel: document.querySelectorAll('.sb-del').length,
      legacyRename: document.querySelectorAll('.sb-rename').length,
      listRole: document.getElementById('session-list')?.getAttribute('role'),
      logRole: document.getElementById('messages')?.getAttribute('role'),
      skills: !!document.getElementById('btn-skills'),
    };
  });
  check(shell.h1, 'un solo h1 y es el titulo del chat');
  check(shell.rows > 0 && shell.more === shell.rows, 'una accion por fila: ' + JSON.stringify(shell));
  check(shell.legacyDel === 0 && shell.legacyRename === 0, 'sin iconos de borrar/renombrar por fila');
  check(shell.listRole === 'list' && shell.logRole === 'log', 'roles de lista y log');
  check(shell.skills, 'entrada a Skills presente');

  // --- contraste de la metadata de sesion (11px)
  const contrast = await page.evaluate(() => {
    const el = document.querySelector('.sb-sub') as HTMLElement;
    const bg = document.querySelector('.sidebar') as HTMLElement;
    return { color: getComputedStyle(el).color, bg: getComputedStyle(bg).backgroundColor, size: getComputedStyle(el).fontSize };
  });
  const r = ratio(parse(contrast.color), parse(contrast.bg));
  check(r >= 4.5, 'contraste de .sb-sub ' + r.toFixed(2) + ':1 (' + JSON.stringify(contrast) + ')');

  // --- la lista se recorre con flechas (300+ sesiones: tabular no escala)
  await page.locator('#session-list .sb-item').first().focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const nav = await page.evaluate(() => {
    const items = [...document.querySelectorAll('#session-list .sb-item')];
    return items.indexOf(document.activeElement as HTMLElement);
  });
  check(nav === 2, 'ArrowDown avanza por la lista (indice ' + nav + ')');
  await page.keyboard.press('End');
  const last = await page.evaluate(() => {
    const items = [...document.querySelectorAll('#session-list .sb-item')];
    return items.indexOf(document.activeElement as HTMLElement) === items.length - 1;
  });
  check(last, 'End va a la ultima sesion');
  await page.keyboard.press('Home');
  check(await page.evaluate(() => document.activeElement === document.querySelector('#session-list .sb-item')), 'Home vuelve a la primera');
  // Token aleatorio por corrida: el buscador tambien indexa lo que el agente escribe, asi que
  // una cadena fija ("zzzz-no-existe") puede existir en el store y el test dejaria de probar
  // el caso vacio.
  const sinResultados = 'zq' + Math.random().toString(36).slice(2, 10);
  await page.fill('#search', sinResultados);
  await page.waitForTimeout(150);
  // La busqueda en el contenido es asincrona: el estado vacio aparece cuando la consulta
  // se asienta (no mientras esta buscando). Se espera en vez de asumir que es inmediato.
  await page.waitForSelector('#session-list > .sb-empty', { timeout: 5000 }).catch(() => {});
  const filtroVacio = await page.evaluate(() => ({
    empty: !!document.querySelector('#session-list > .sb-empty'),
    buscando: !!document.querySelector('.sb-remote-loading'),
    head: !!document.querySelector('.sb-remote-head'),
  }));
  check(filtroVacio.empty && !filtroVacio.buscando, 'el filtro sin resultados muestra estado vacio (' + JSON.stringify(filtroVacio) + ')');
  await page.locator('#search').press('Escape');
  await page.waitForTimeout(200);
  const cleared = await page.evaluate(() => ({ q: (document.getElementById('search') as HTMLInputElement).value, rows: document.querySelectorAll('#session-list .sb-row').length }));
  check(cleared.q === '' && cleared.rows > 0, 'Esc limpia el filtro y vuelve la lista (' + JSON.stringify(cleared) + ')');

  // --- menu de fila: abre con teclado, incluye borrar, Esc devuelve el foco
  const id = await page.evaluate(() => document.querySelector('.sb-row')!.getAttribute('data-id'));
  await page.locator(`.sb-row[data-id="${id}"] .sb-more`).focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('body > .menu.row-menu', { state: 'visible' });
  const menu = await page.evaluate(() => {
    const m = document.querySelector('body > .menu.row-menu') as HTMLElement;
    return {
      role: m.getAttribute('role'),
      labels: [...m.querySelectorAll('.menu-row')].map((b) => (b.textContent || '').trim()),
      danger: !!m.querySelector('.menu-row.danger'),
      focusInside: m.contains(document.activeElement),
    };
  });
  check(menu.role === 'menu', 'menu con role=menu');
  check(menu.danger && menu.labels.some((l) => /Borrar/.test(l)), 'accion destructiva dentro del menu: ' + JSON.stringify(menu.labels));
  check(menu.focusInside, 'el foco entra al menu abierto con teclado');
  await page.keyboard.press('ArrowDown');
  const moved = await page.evaluate(() => (document.activeElement as HTMLElement)?.className);
  check(/menu-row/.test(moved || ''), 'ArrowDown mueve el foco entre opciones');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const afterEsc = await page.evaluate(() => ({
    visible: !!document.querySelector('body > .menu.row-menu'),
    focused: (document.activeElement as HTMLElement)?.className || '',
  }));
  check(!afterEsc.visible, 'Esc cierra el menu de fila');
  check(/sb-more/.test(afterEsc.focused), 'Esc devuelve el foco al boton de acciones (' + afterEsc.focused + ')');

  // --- menu de chips: aria y teclado
  // Los chips de proveedor/modelo existen cuando hay una sesion abierta (o cache):
  // se abre la sesion mas liviana de la lista para no arrastrar un replay enorme.
  const light = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.sb-row')];
    const parsed = rows.map((r) => {
      const sub = r.querySelector('.sb-sub')?.textContent || '';
      const n = Number((sub.match(/^(\d+)/) || [0, '999999'])[1]);
      return { id: r.getAttribute('data-id'), n };
    }).sort((a, b) => a.n - b.n);
    return parsed[0] ? parsed[0].id : null;
  });
  if (light) {
    await page.locator(`.sb-row[data-id="${light}"] .sb-item`).click();
    await page.waitForSelector('#chips .chip[aria-haspopup="menu"]', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(400);
  }
  // El chip de modelo/proveedor abre un combo (role=dialog), no el menu de fila: anuncia QUÉ abre
  // con aria-haspopup=dialog y si está abierto con aria-expanded.
  const chipInfo = await page.evaluate(() => {
    const b = document.querySelector('#chips .chip') as HTMLElement | null;
    return b ? { haspopup: b.getAttribute('aria-haspopup'), expanded: b.getAttribute('aria-expanded'), text: b.textContent, cls: b.className } : null;
  });
  check(!!chipInfo, 'hay un chip de modelo/proveedor con sesión abierta: ' + JSON.stringify(chipInfo));
  check(chipInfo!.haspopup === 'dialog' && chipInfo!.expanded === 'false', 'chip anuncia el diálogo y su estado: ' + JSON.stringify(chipInfo));
  await page.locator('#chips .chip').first().click();
  await page.waitForTimeout(250);
  const chipOpen = await page.evaluate(() => {
    const b = document.querySelector('#chips .chip') as HTMLElement;
    return {
      expanded: b.getAttribute('aria-expanded'),
      dialog: !!document.querySelector('.combo-panel[role="dialog"]'),
      opciones: document.querySelectorAll('.combo-panel [role="option"]').length,
    };
  });
  check(chipOpen.expanded === 'true' && chipOpen.dialog && chipOpen.opciones > 0, 'chip abierto anuncia expanded y trae el combo con opciones: ' + JSON.stringify(chipOpen));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const chipClosed = await page.evaluate(() => ({
    expanded: (document.querySelector('#chips .chip') as HTMLElement).getAttribute('aria-expanded'),
    dialog: !!document.querySelector('.combo-panel[role="dialog"]'),
  }));
  check(chipClosed.expanded === 'false' && !chipClosed.dialog, 'Esc cierra el combo y baja expanded: ' + JSON.stringify(chipClosed));

  // --- panel de Skills: abre, busca, cierra y devuelve el foco
  await page.click('#btn-skills');
  await page.waitForSelector('#sk-overlay[data-open="1"]', { timeout: 10000 });
  await page.waitForSelector('#sk-list .sk-row', { timeout: 15000 });
  const skills = await page.evaluate(() => {
    const box = document.getElementById('sk-box') as HTMLElement;
    return {
      rows: document.querySelectorAll('#sk-list .sk-row').length,
      dialog: box.getAttribute('role') + '/' + box.getAttribute('aria-modal'),
      focusInSearch: document.activeElement === document.getElementById('sk-q'),
      overflowX: box.scrollWidth - box.clientWidth,
      clipped: [...document.querySelectorAll('.sk-desc')].filter((d) => (d as HTMLElement).scrollWidth > (d as HTMLElement).clientWidth + 2).length,
    };
  });
  check(skills.rows > 0, 'las skills se listan');
  check(skills.dialog === 'dialog/true', 'panel con semantica de dialogo modal');
  check(skills.focusInSearch, 'el foco arranca en el buscador');
  check(skills.overflowX <= 1, 'panel sin desborde horizontal (' + skills.overflowX + 'px)');
  check(skills.clipped === 0, 'descripciones envueltas, sin texto cortado (' + skills.clipped + ')');

  const total = skills.rows;
  await page.fill('#sk-q', 'zzzz-no-existe');
  await page.waitForTimeout(250);
  const filtered = await page.evaluate(() => ({
    rows: document.querySelectorAll('#sk-list .sk-row').length,
    empty: !!document.querySelector('#sk-list .sk-empty'),
    count: (document.getElementById('sk-count') as HTMLElement).textContent,
  }));
  check(filtered.rows === 0 && filtered.empty, 'la busqueda filtra y muestra estado vacio');
  await page.fill('#sk-q', '');
  await page.waitForTimeout(200);
  check(await page.evaluate(() => document.querySelectorAll('#sk-list .sk-row').length) === total, 'borrar la busqueda restaura la lista');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const closed = await page.evaluate(() => ({
    open: (document.getElementById('sk-overlay') as HTMLElement).dataset.open,
    focused: (document.activeElement as HTMLElement)?.id,
  }));
  check(closed.open === '0', 'Esc cierra el panel');
  check(closed.focused === 'btn-skills', 'el foco vuelve a la entrada de Skills (' + closed.focused + ')');
  check(errs.length === 0, 'sin errores de pagina: ' + JSON.stringify(errs.slice(0, 3)));
  // /search.json es una mejora opcional: si el proxy vivo todavia no se reinicio con el
  // endpoint, el cliente recibe 404 y oculta la seccion (comportamiento verificado aparte en
  // search-e2e). Cualquier otro 4xx/5xx sigue siendo un fallo.
  const pendiente = bad.filter((b) => /^404 .*\/search\.json/.test(b));
  const otros = bad.filter((b) => !/^404 .*\/search\.json/.test(b));
  if (pendiente.length && !liveSearch.ok) console.log('aviso: /search.json 404 (endpoint pendiente de reinicio del proxy)');
  if (pendiente.length && liveSearch.ok) check(false, 'el endpoint existe pero una request dio 404: ' + JSON.stringify(pendiente));
  check(otros.length === 0, 'sin HTTP >= 400: ' + JSON.stringify(otros.slice(0, 3)));

  // Búsqueda en vivo (solo si el endpoint ya está desplegado): la sección tiene que traer
  // fragmentos resaltados de verdad.
  if (liveSearch.ok && liveSearch.sessions > 0) {
    await page.fill('#search', 'aegis');
    await page.waitForSelector('.sb-hit', { timeout: 10000 });
    const vivo = await page.evaluate(() => ({
      hits: document.querySelectorAll('.sb-hit').length,
      marks: document.querySelectorAll('.sb-hit mark').length,
      roles: document.querySelectorAll('.sb-snip-role').length,
    }));
    check(vivo.hits > 0 && vivo.marks > 0, 'búsqueda en vivo con fragmentos: ' + JSON.stringify(vivo));
    check(vivo.roles > 0, 'los fragmentos dicen quién lo dijo');
    await page.fill('#search', '');
    await page.waitForTimeout(400);
    console.log('búsqueda en vivo verificada: ' + vivo.hits + ' sesiones, ' + vivo.marks + ' marcas');
  } else {
    console.log('aviso: búsqueda en vivo no verificada (endpoint ausente o sin resultados)');
  }
  // (la pagina principal se cierra despues del panel de informacion, mas abajo)

  // --- desborde y solapamiento del header en tres anchos
  for (const [w, h] of [[1440, 900], [768, 900], [390, 844]]) {
    const p = await openPage(browser, { viewport: { width: w, height: h }, hasTouch: w < 800, isMobile: w < 800 });
    await p.goto(url + '/', { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#session-list .sb-row', { timeout: 20000 }).catch(() => {});
    await p.waitForTimeout(1200);
    const m = await p.evaluate(() => {
      const tb = document.querySelector('.topbar')!.getBoundingClientRect();
      const ms = document.getElementById('messages')!.getBoundingClientRect();
      const co = document.querySelector('.composer')!.getBoundingClientRect();
      return {
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
        overlap: tb.bottom - ms.top,
        composerW: Math.round(co.width),
        inputFont: parseFloat(getComputedStyle(document.getElementById('input')!).fontSize),
      };
    });
    check(m.scrollW <= m.clientW + 1, w + 'px sin scroll horizontal (' + m.scrollW + '/' + m.clientW + ')');
    check(m.overlap <= 1, w + 'px: el header no se monta sobre los mensajes (' + m.overlap + 'px)');
    check(m.composerW > 200, w + 'px: composer usable (' + m.composerW + ')');
    if (w === 390) check(m.inputFont >= 16, 'input a 16px en movil (sin zoom iOS): ' + m.inputFont);
    await p.close();
  }

  // --- panel de informacion de la conversacion (header)
  // Se espera a que la sesion termine de cargar: openSession/updateTitle cierran el panel
  // (cambiar de conversacion descarta la info de la anterior).
  await page.click('#session-list .sb-item');
  await page.waitForFunction(() => (window as any).__aegisWeb?.state?.current?.id, null, { timeout: 8000 });
  await page.waitForTimeout(1200);
  await page.locator('#btn-chat-info').focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('#btn-chat-info[aria-expanded="true"]', { timeout: 5000 });
  const info = await page.evaluate(() => {
    const p = document.getElementById('chat-info') as HTMLElement;
    return {
      expanded: document.getElementById('btn-chat-info')?.getAttribute('aria-expanded'),
      role: p.getAttribute('role'),
      labelled: p.getAttribute('aria-labelledby'),
      rows: [...p.querySelectorAll('.ci-k')].map((k) => (k.textContent || '').toLowerCase()),
      actions: [...p.querySelectorAll('.ci-actions button')].map((b) => (b.textContent || '').trim()),
      destructive: !!p.querySelector('[data-ci="delete"]'),
      insideViewport: p.getBoundingClientRect().right <= window.innerWidth - 4 && p.getBoundingClientRect().left >= 4,
      focus: document.activeElement?.id,
    };
  });
  check(info.expanded === 'true', 'el titulo anuncia el panel abierto');
  check(info.role === 'dialog' && info.labelled === 'ci-title', 'panel con rol de dialogo etiquetado');
  check(info.rows.includes('id') && info.rows.includes('carpeta') && !info.rows.includes('mensajes'), 'no duplica el contador de mensajes del sidebar (' + info.rows.join(',') + ')');
  check(info.actions.includes('Copiar ID') && info.actions.includes('Exportar Markdown'), 'acciones de lectura presentes');
  check(!info.destructive, 'sin borrar en el header (vive en la fila, con confirmación)');
  check(info.insideViewport, 'el panel queda dentro del viewport');
  check(info.focus === 'ci-close', 'el foco entra al panel');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const infoCerrado = await page.evaluate(() => ({
    open: !(document.getElementById('chat-info') as HTMLElement).hidden,
    expanded: document.getElementById('btn-chat-info')?.getAttribute('aria-expanded'),
    focus: document.activeElement?.id,
  }));
  check(!infoCerrado.open && infoCerrado.expanded === 'false', 'Esc cierra el panel y el estado');
  check(infoCerrado.focus === 'btn-chat-info', 'Esc devuelve el foco al titulo');
  // click afuera
  await page.click('#btn-chat-info');
  await page.waitForTimeout(200);
  await page.click('#messages', { position: { x: 40, y: 40 } });
  await page.waitForTimeout(250);
  check(await page.evaluate(() => (document.getElementById('chat-info') as HTMLElement).hidden), 'click afuera cierra el panel');
  await page.close();

  pass('shell: jerarquia, filas, menus con teclado, skills y responsive contra ' + url);
} finally {
  await browser.close();
}

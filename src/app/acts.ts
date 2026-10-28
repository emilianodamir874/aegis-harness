// Menú de acciones de fila: un disparador (⋯) por elemento, con submenús al costado.
//
// El patrón es el mismo que el chip de modelo: cuando una fila acumula dos o más acciones,
// no se dibujan dos botones al lado — se dibuja uno y las acciones viven adentro, agrupadas
// por tema en un submenú lateral. Ahorra lugar y deja un solo lugar donde buscar.
//
// Reglas que ya cobraron bugs en este archivo:
// - el menú va al <body> (portal) y se posiciona en coordenadas fijas: inmune a overflow y
//   a contextos de apilado;
// - el submenú se coloca a la derecha; si no entra, a la izquierda; si tampoco (teléfono),
//   debajo de su fila, siempre con clamp contra los cuatro bordes del viewport;
// - Escape y ArrowLeft vuelven al menú padre, y el foco vuelve al disparador al cerrar;
// - cerrar se hace con click afuera, Escape, scroll y resize.

export type ActItem = {
  label: string;
  icon?: string;
  run?: () => void;
  danger?: boolean;
  sub?: ActItem[];
  hint?: string;
};

let abierto: HTMLElement | null = null;
let disparador: HTMLElement | null = null;

const MARGEN = 8;

function cerca(sel: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(sel);
}

export function cerrarAcciones() {
  document.querySelectorAll<HTMLElement>('body > .acts-menu').forEach((m) => m.remove());
  if (disparador && disparador.isConnected) disparador.setAttribute('aria-expanded', 'false');
  abierto = null;
  disparador = null;
}

function medir(menu: HTMLElement, r: DOMRect, lateral: boolean, fila?: DOMRect) {
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  let left: number;
  let top: number;
  if (lateral && fila) {
    left = fila.right + 6;
    if (left + w > window.innerWidth - MARGEN) left = fila.left - w - 6;
    top = fila.top;
    if (left < MARGEN) { left = Math.min(Math.max(MARGEN, fila.left), Math.max(MARGEN, window.innerWidth - MARGEN - w)); top = fila.bottom + 6; }
  } else {
    left = r.right - w;
    if (left < MARGEN) left = MARGEN;
    top = r.bottom + 7;
    if (top + h > window.innerHeight - MARGEN) top = Math.max(MARGEN, r.top - h - 7);
    else if (r.bottom + 7 + h > window.innerHeight - MARGEN) top = Math.max(MARGEN, r.top - h - 7);
  }
  if (top + h > window.innerHeight - MARGEN) top = Math.max(MARGEN, window.innerHeight - MARGEN - h);
  if (top < MARGEN) top = MARGEN;
  if (left + w > window.innerWidth - MARGEN) left = Math.max(MARGEN, window.innerWidth - MARGEN - w);
  menu.style.left = Math.round(left) + 'px';
  menu.style.top = Math.round(top) + 'px';
  menu.style.maxHeight = Math.max(120, window.innerHeight - 2 * MARGEN) + 'px';
}

function filas(menu: HTMLElement): HTMLElement[] {
  return [...menu.querySelectorAll<HTMLElement>(':scope > .menu-row:not([disabled])')];
}

function pintar(items: ActItem[], nivel: 'menu' | 'sub'): HTMLElement {
  const menu = document.createElement('div');
  menu.className = 'menu acts-menu' + (nivel === 'sub' ? ' acts-sub' : '');
  menu.setAttribute('role', 'menu');
  for (const it of items) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'menu-row' + (it.danger ? ' danger' : '');
    row.setAttribute('role', 'menuitem');
    row.innerHTML =
      '<span class="act-main">' +
      (it.icon ? '<span class="act-ico">' + it.icon + '</span>' : '') +
      '<span class="act-t">' + it.label + '</span>' +
      (it.hint ? '<span class="act-hint">' + it.hint + '</span>' : '') +
      '</span>' +
      (it.sub ? '<span class="act-chev" aria-hidden="true"><svg viewBox="0 0 12 12" width="11" height="11" fill="none"><path d="M4.5 2.8 7.7 6l-3.2 3.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>' : '');
    if (it.sub) {
      row.setAttribute('aria-haspopup', 'menu');
      row.setAttribute('aria-expanded', 'false');
      const abrirSub = () => {
        if (row.classList.contains('act-open')) return;
        cerrarSub(menu);
        const sub = pintar(it.sub!, 'sub');
        sub.dataset.parent = '1';
        document.body.appendChild(sub);
        menu.dataset.sub = '1';
        row.classList.add('act-open');
        row.setAttribute('aria-expanded', 'true');
        medir(sub, row.getBoundingClientRect(), true, row.getBoundingClientRect());
        abierto = sub;
        const first = filas(sub)[0];
        if (first && menu.dataset.kbd === '1') first.focus({ preventScroll: true });
      };
      const cerrarEste = () => {
        cerrarSub(menu);
        row.classList.remove('act-open');
        row.setAttribute('aria-expanded', 'false');
      };
      row.addEventListener('pointerenter', abrirSub);
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        if (row.classList.contains('act-open')) { cerrarEste(); return; }
        abrirSub();
      });
      row.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); abrirSub(); const f = filas(menu.dataset.sub === '1' ? (abierto || menu) : menu)[0]; f?.focus(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cerrarEste(); }
      });
    } else {
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        const fn = it.run;
        cerrarAcciones();
        fn?.();
      });
    }
    menu.appendChild(row);
  }
  if (nivel === 'menu') {
    menu.addEventListener('keydown', (e) => {
      const items = filas(menu);
      const i = items.indexOf(document.activeElement as HTMLElement);
      const ir = (n: number) => { e.preventDefault(); items[(i + n + items.length) % items.length].focus(); };
      if (e.key === 'ArrowDown') ir(1);
      else if (e.key === 'ArrowUp') ir(-1);
      else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); }
      else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus(); }
      else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        const back = disparador;
        cerrarAcciones();
        if (back && back.isConnected) back.focus();
      }
    });
  } else {
    menu.addEventListener('keydown', (e) => {
      const items = filas(menu);
      const i = items.indexOf(document.activeElement as HTMLElement);
      const ir = (n: number) => { e.preventDefault(); items[(i + n + items.length) % items.length].focus(); };
      if (e.key === 'ArrowDown') ir(1);
      else if (e.key === 'ArrowUp') ir(-1);
      else if (e.key === 'Escape' || e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        const padre = cerca('body > .acts-menu:not(.acts-sub)');
        cerrarSub();
        const fila = padre?.querySelector<HTMLElement>('.menu-row.act-open');
        fila?.classList.remove('act-open');
        fila?.setAttribute('aria-expanded', 'false');
        (fila || disparador)?.focus();
      }
    });
  }
  return menu;
}

function cerrarSub(scope?: HTMLElement) {
  document.querySelectorAll<HTMLElement>('body > .acts-sub').forEach((m) => m.remove());
  (scope || document).querySelectorAll<HTMLElement>('.menu-row.act-open').forEach((r) => {
    r.classList.remove('act-open');
    r.setAttribute('aria-expanded', 'false');
  });
}

// Abre el menú de acciones de un elemento. `trigger` es el botón ⋯ de la fila.
export function abrirAcciones(trigger: HTMLElement, items: ActItem[]) {
  cerrarAcciones();
  if (!items.length) return;
  disparador = trigger;
  trigger.setAttribute('aria-expanded', 'true');
  const menu = pintar(items, 'menu');
  document.body.appendChild(menu);
  abierto = menu;
  medir(menu, trigger.getBoundingClientRect(), false);
  const porTeclado = document.documentElement.dataset.kbd === '1' || !!trigger.dataset.kbd;
  if (porTeclado) filas(menu)[0]?.focus({ preventScroll: true });
}

// Crea el disparador ⋯ de una fila. No dibuja nada más: el menú se arma al abrir.
export function botonAcciones(etiqueta: string, items: () => ActItem[], extraClass = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'act-btn' + (extraClass ? ' ' + extraClass : '');
  b.setAttribute('aria-label', 'Acciones: ' + etiqueta);
  b.setAttribute('aria-haspopup', 'menu');
  b.setAttribute('aria-expanded', 'false');
  b.title = 'Acciones';
  b.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="3.4" cy="8" r="1.35" fill="currentColor"/><circle cx="8" cy="8" r="1.35" fill="currentColor"/><circle cx="12.6" cy="8" r="1.35" fill="currentColor"/></svg>';
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const ya = abierto && disparador === b;
    if (ya) { cerrarAcciones(); return; }
    abrirAcciones(b, items());
  });
  // Abrir con el teclado deja el foco dentro del menú (como cualquier menú del sistema).
  b.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault();
      b.dataset.kbd = '1';
      abrirAcciones(b, items());
      delete b.dataset.kbd;
    }
  });
  return b;
}

let globalesListas = false;
export function wireAccionesGlobales() {
  if (globalesListas) return;
  globalesListas = true;
  document.addEventListener('click', (e) => {
    const t = e.target as Element | null;
    if (t && t.closest && t.closest('.acts-menu, .act-btn')) return;
    cerrarAcciones();
  });
  window.addEventListener('resize', cerrarAcciones);
  window.addEventListener('scroll', (e) => {
    const t = e.target as Element | null;
    if (t && t.closest && t.closest('.acts-menu')) return;
    cerrarAcciones();
  }, true);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && abierto) { e.stopPropagation(); cerrarAcciones(); }
  }, true);
}

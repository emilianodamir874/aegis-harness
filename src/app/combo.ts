// Combobox propio del cromo (proveedor, modo, modelo).
//
// Por que existe: los selectores eran un <button> + un .menu con filas. Con dos modelos alcanzaba;
// con el catalogo real (294 modelos en Experiential Labs, 18 en OpenCode Go, 40 en OpenAI) no hay
// como encontrar nada sin buscar, la segunda linea util (contexto, tarifa, si razona) no cabia, y
// en el telefono el menu de 250 px se abria pegado al borde.
//
// El componente no sabe nada del motor: recibe secciones ya armadas y devuelve el `value` elegido.
// Quien lo usa decide que hacer (session/set_config_option, session/set_mode, proveedor + modelo).
//
// Desktop: popover anclado al chip, 380 px, se da vuelta si abajo no entra.
// Movil (<= 640 px): hoja inferior con fondo atenuado, filas de 48 px y el input sin autofoco (el
// teclado se levanta recien cuando se toca el buscador, no al abrir).
//
// Teclado (patron combobox: el foco se queda en el input, la fila activa va por aria-activedescendant):
//   ↑ ↓ / Home / End / PageUp PageDown  mover
//   Enter                                elegir
//   →                                    accion secundaria de la fila (esfuerzo del modelo)
//   Esc / Tab                            cerrar

import { esc } from './format';
import { uiIcon } from './icons';

export type ComboItem = {
  value: string;
  label: string;
  meta?: string;
  tag?: string;
  keywords?: string;
  title?: string;
  current?: boolean;
  disabled?: boolean;
  /** Accion secundaria de la fila: boton a la derecha (el esfuerzo de un modelo). */
  aux?: { label: string; bars?: number; title?: string };
};

export type ComboSection = { label: string; hint?: string; items: ComboItem[] };

export type ComboOptions = {
  anchor: HTMLElement;
  title: string;
  placeholder?: string;
  sections: ComboSection[];
  empty?: string;
  footer?: string;
  autofocus?: boolean;
  onPick: (value: string, item: ComboItem) => void;
  onAux?: (value: string, item: ComboItem) => void;
  onClose?: (motivo: 'pick' | 'aux' | 'cancel') => void;
};

export type ComboHandle = {
  setSections: (sections: ComboSection[]) => void;
  close: () => void;
};

type Vivo = {
  root: HTMLElement;
  panel: HTMLElement;
  input: HTMLInputElement;
  list: HTMLElement;
  count: HTMLElement;
  anchor: HTMLElement;
  opts: ComboOptions;
  items: ComboItem[];
  filas: HTMLElement[];
  activo: number;
  instance: number;
  hoja: boolean;
  onDoc: (e: Event) => void;
  onScroll: (e: Event) => void;
  onResize: () => void;
  onViewport?: () => void;
};

let vivo: Vivo | null = null;
let seq = 0;

/** Minusculas y sin acentos: "Diseno" y "diseno" tienen que caer en el mismo resultado. */
const norm = (s: unknown): string =>
  String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/**
 * Puntaje de una fila contra la busqueda. 0 = no entra.
 *   3 el nombre empieza con la consulta    2 el nombre la contiene
 *   1 la contiene el id, la familia o una etiqueta
 *
 * Solo substring, a proposito: la subsecuencia ("d...e...e...p" en cualquier orden) metia
 * "Claude Opus 4.6" y "Daybreak Red" al buscar "deep", y con la descripcion adentro metia
 * medio catalogo. Buscar es substring; lo que no esta en el nombre, el id o la familia no
 * aparece, y lo que aparece se explica solo leyendo la fila.
 */
function puntaje(q: string, it: ComboItem): number {
  if (!q) return 1;
  const nombre = norm(it.label);
  if (nombre.startsWith(q)) return 3;
  if (nombre.includes(q)) return 2;
  const otros = [it.value, it.keywords, it.tag].filter(Boolean).map(norm);
  if (otros.some((c) => c.includes(q))) return 1;
  return 0;
}

function barsHtml(n: number): string {
  const lvl = Math.max(1, Math.min(5, n || 1));
  let out = '<span class="co-bars" aria-hidden="true">';
  for (let i = 1; i <= 5; i++) out += '<i' + (i <= lvl ? ' class="on"' : '') + '></i>';
  return out + '</span>';
}

function hintHtml(conAux: boolean): string {
  return '<kbd>↑</kbd><kbd>↓</kbd><span>moverse</span><kbd>Enter</kbd><span>elegir</span>'
    + (conAux ? '<kbd>→</kbd><span>esfuerzo</span>' : '')
    + '<kbd>Esc</kbd><span>cerrar</span>';
}

function filaHtml(v: Vivo, i: number, it: ComboItem): string {
  const cls = 'combo-opt' + (it.current ? ' sel' : '') + (it.disabled ? ' is-off' : '');
  const aux = it.aux
    ? '<button type="button" class="co-aux" tabindex="-1" data-i="' + i + '"'
      + ' title="' + esc(it.aux.title || 'Esfuerzo de razonamiento') + '"'
      + ' aria-label="' + esc(it.aux.title || 'Esfuerzo de razonamiento') + '">'
      + barsHtml(it.aux.bars || 1) + '<span>' + esc(it.aux.label) + '</span></button>'
    : '';
  return '<div class="' + cls + '" role="option" id="co-' + v.instance + '-' + i + '" data-i="' + i + '"'
    + ' aria-selected="' + (it.current ? 'true' : 'false') + '"'
    + (it.disabled ? ' aria-disabled="true"' : '')
    + (it.title ? ' title="' + esc(it.title) + '"' : '') + '>'
    + '<span class="co-body">'
    + '<span class="co-l1"><span class="co-name">' + esc(it.label) + '</span>'
    + (it.tag ? '<span class="co-tag">' + esc(it.tag) + '</span>' : '') + '</span>'
    + (it.meta ? '<span class="co-l2">' + esc(it.meta) + '</span>' : '')
    + '</span>' + aux
    + '<span class="co-check" aria-hidden="true">' + uiIcon('check', { size: 13 }) + '</span>'
    + '</div>';
}

/** Repinta la lista con el filtro actual. Es lo unico que cambia al tipear. */
function pintar(v: Vivo): void {
  const q = norm(v.input.value).trim();
  const partes: string[] = [];
  const items: ComboItem[] = [];
  let total = 0;
  let mejor = -1;
  let mejorPuntaje = 0;
  for (const sec of v.opts.sections) {
    // Con consulta, cada grupo se ordena por calidad de coincidencia: primero el que empieza
    // con lo tipeado, despues el que lo contiene, y al final el que lo tiene desparramado.
    const conPuntaje = sec.items.map((it) => ({ it, s: puntaje(q, it) })).filter((x) => x.s > 0);
    if (!conPuntaje.length) continue;
    if (q) conPuntaje.sort((a, b) => b.s - a.s);
    total += sec.items.length;
    partes.push('<div class="combo-sec" role="presentation"><span>' + esc(sec.label) + '</span>'
      + (sec.hint ? '<em>' + esc(sec.hint) + '</em>' : '') + '</div>');
    for (const { it, s } of conPuntaje) {
      if (s > mejorPuntaje) { mejorPuntaje = s; mejor = items.length; }
      partes.push(filaHtml(v, items.length, it));
      items.push(it);
    }
  }
  v.items = items;
  v.list.innerHTML = partes.length
    ? partes.join('')
    : '<div class="combo-empty">' + esc(v.opts.empty || 'Sin resultados para «' + v.input.value + '».') + '</div>';
  v.filas = [...v.list.querySelectorAll<HTMLElement>('.combo-opt')];
  v.count.textContent = q ? items.length + ' de ' + total : String(items.length);
  for (const fila of v.filas) {
    fila.addEventListener('pointerenter', () => marcar(v, Number(fila.dataset.i), false));
    fila.addEventListener('click', (e) => {
      const it = v.items[Number(fila.dataset.i)];
      if (!it || it.disabled) return;
      e.stopPropagation();
      if ((e.target as HTMLElement).closest('.co-aux') && v.opts.onAux) {
        cerrar('aux');
        v.opts.onAux(it.value, it);
        return;
      }
      cerrar('pick');
      v.opts.onPick(it.value, it);
    });
  }
  // Fila activa: lo tipeado manda (el mejor puntaje de todos los grupos, para que un "codex"
  // encontrado en otro proveedor sea lo primero que se elija con Enter); sin consulta, el actual.
  const marcada = items.findIndex((it) => it.current && !it.disabled);
  const primera = items.findIndex((it) => !it.disabled);
  v.activo = q && mejor >= 0 ? mejor : (marcada >= 0 ? marcada : (primera >= 0 ? primera : -1));
  if (v.activo >= 0) marcar(v, v.activo, !!q || v.activo > 12);
  else v.input.removeAttribute('aria-activedescendant');
  ubicar(v);
}

function marcar(v: Vivo, i: number, scroll: boolean): void {
  if (i < 0 || i >= v.items.length) return;
  v.activo = i;
  for (const fila of v.filas) fila.classList.toggle('act', Number(fila.dataset.i) === i);
  const fila = v.filas.find((f) => Number(f.dataset.i) === i);
  if (fila) {
    v.input.setAttribute('aria-activedescendant', fila.id);
    if (scroll) fila.scrollIntoView({ block: 'nearest' });
  }
}

function ubicar(v: Vivo): void {
  if (v.hoja) return;
  const m = 10;
  const ancho = Math.min(380, window.innerWidth - 2 * m);
  v.panel.style.width = ancho + 'px';
  v.panel.style.maxHeight = Math.max(200, Math.min(460, window.innerHeight - 2 * m)) + 'px';
  const alto = v.panel.offsetHeight;
  const r = v.anchor.isConnected ? v.anchor.getBoundingClientRect() : null;
  const ref = r || ({ left: m, right: m, top: 0, bottom: 0, width: 0, height: 0 } as DOMRect);
  let top = ref.bottom + 7;
  if (top + alto > window.innerHeight - m) {
    const arriba = ref.top - 7 - alto;
    top = arriba >= m ? arriba : Math.max(m, window.innerHeight - m - alto);
  }
  let left = ref.left;
  if (left + ancho > window.innerWidth - m) left = window.innerWidth - m - ancho;
  if (left < m) left = m;
  v.panel.style.left = Math.round(left) + 'px';
  v.panel.style.top = Math.round(top) + 'px';
}

function cerrar(motivo: 'pick' | 'aux' | 'cancel'): void {
  const v = vivo;
  if (!v) return;
  vivo = null;
  document.removeEventListener('pointerdown', v.onDoc, true);
  window.removeEventListener('scroll', v.onScroll, true);
  window.removeEventListener('resize', v.onResize);
  if (v.onViewport) {
    window.visualViewport?.removeEventListener('resize', v.onViewport);
    window.visualViewport?.removeEventListener('scroll', v.onViewport);
  }
  v.root.remove();
  document.documentElement.classList.remove('combo-open');
  if (v.anchor.isConnected) {
    v.anchor.setAttribute('aria-expanded', 'false');
    if (motivo === 'cancel') v.anchor.focus({ preventScroll: true });
  }
  if (v.opts.onClose) v.opts.onClose(motivo);
}

/** Cierra el combobox abierto, si hay uno (lo usa quien va a reconstruir los chips). */
export function cerrarCombo(): void {
  if (vivo) cerrar('cancel');
}

export function comboAbierto(): boolean {
  return !!vivo;
}

export function abrirCombo(opts: ComboOptions): ComboHandle {
  cerrarCombo();
  const instance = ++seq;
  const hoja = window.matchMedia('(max-width: 640px)').matches;
  const root = document.createElement('div');
  root.className = 'combo-root ' + (hoja ? 'is-sheet' : 'is-pop');
  root.innerHTML =
    '<div class="combo-back"></div>'
    + '<div class="combo-panel" role="dialog" aria-modal="' + (hoja ? 'true' : 'false') + '"'
    + ' aria-label="' + esc(opts.title) + '">'
    + (hoja ? '<div class="combo-grab" aria-hidden="true"></div>' : '')
    + '<div class="combo-head"><span class="combo-title">' + esc(opts.title) + '</span>'
    + '<button type="button" class="combo-close" aria-label="Cerrar">' + uiIcon('cross', { size: 13 }) + '</button></div>'
    + '<div class="combo-search"><span class="combo-search-ic" aria-hidden="true">' + uiIcon('search', { size: 13 }) + '</span>'
    + '<input class="combo-input" type="text" role="combobox" aria-expanded="true" aria-autocomplete="list"'
    + ' aria-controls="combo-list-' + instance + '" placeholder="' + esc(opts.placeholder || 'Buscar…') + '"'
    + ' autocomplete="off" autocapitalize="off" spellcheck="false">'
    + '<span class="combo-count" aria-hidden="true"></span></div>'
    + '<div class="combo-list" id="combo-list-' + instance + '" role="listbox" aria-label="' + esc(opts.title) + '"></div>'
    + '<div class="combo-foot">' + (opts.footer || hintHtml(!!opts.onAux)) + '</div>'
    + '</div>';
  document.body.appendChild(root);
  document.documentElement.classList.add('combo-open');
  // La hoja se ancla al viewport VISUAL: con el teclado abierto, 100dvh puede quedar mas alto
  // que el area visible y la barra de busqueda terminaria debajo del teclado.
  let ajustarHoja: (() => void) | null = null;
  if (hoja) {
    ajustarHoja = () => {
      const vv = window.visualViewport;
      const alto = vv ? vv.height : window.innerHeight;
      const arriba = vv ? vv.offsetTop : 0;
      root.style.top = Math.round(arriba) + 'px';
      root.style.height = Math.round(alto) + 'px';
    };
    ajustarHoja();
    window.visualViewport?.addEventListener('resize', ajustarHoja);
    window.visualViewport?.addEventListener('scroll', ajustarHoja);
  }

  const v: Vivo = {
    root,
    panel: root.querySelector('.combo-panel') as HTMLElement,
    input: root.querySelector('.combo-input') as HTMLInputElement,
    list: root.querySelector('.combo-list') as HTMLElement,
    count: root.querySelector('.combo-count') as HTMLElement,
    anchor: opts.anchor,
    opts,
    items: [],
    filas: [],
    activo: -1,
    instance,
    hoja,
    onDoc: () => {},
    onScroll: () => {},
    onResize: () => {},
    onViewport: ajustarHoja || undefined,
  };
  vivo = v;

  v.onDoc = (e: Event) => {
    if (!v.root.contains(e.target as Node)) cerrar('cancel');
  };
  // En movil la hoja queda clavada: el scroll de atras no la mueve. En desktop el popover
  // viaja con el chip, asi que si la pagina se mueve se cierra (mismo criterio que los menus).
  v.onScroll = (e: Event) => {
    if (hoja) return;
    const t = e.target;
    if (t instanceof Element && t.closest('.combo-panel')) return;
    cerrar('cancel');
  };
  v.onResize = () => cerrar('cancel');

  document.addEventListener('pointerdown', v.onDoc, true);
  window.addEventListener('scroll', v.onScroll, true);
  window.addEventListener('resize', v.onResize);

  (root.querySelector('.combo-close') as HTMLElement).addEventListener('click', (e) => {
    e.stopPropagation();
    cerrar('cancel');
  });
  v.input.addEventListener('input', () => pintar(v));
  v.input.addEventListener('keydown', (e: KeyboardEvent) => {
    const max = v.items.length;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cerrar('cancel'); return; }
    if (e.key === 'Tab') { cerrar('cancel'); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!max) return;
      const paso = e.key === 'ArrowDown' ? 1 : -1;
      let i = v.activo;
      for (let k = 0; k < max; k++) {
        i = (i + paso + max) % max;
        if (!v.items[i].disabled) break;
      }
      marcar(v, i, true);
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      if (!max) return;
      const desde = e.key === 'Home' ? -1 : 0;
      const paso = e.key === 'Home' ? 1 : -1;
      let i = desde < 0 ? -1 : max;
      for (let k = 0; k < max; k++) {
        i = (i + paso + max) % max;
        if (!v.items[i].disabled) break;
      }
      marcar(v, i, true);
      return;
    }
    if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      if (!max) return;
      const destino = Math.max(0, Math.min(max - 1, v.activo + (e.key === 'PageDown' ? 8 : -8)));
      marcar(v, destino, true);
      return;
    }
    if (e.key === 'ArrowRight' && v.opts.onAux) {
      const it = v.items[v.activo];
      if (!it || it.disabled) return;
      e.preventDefault();
      e.stopPropagation();
      cerrar('aux');
      v.opts.onAux(it.value, it);
      return;
    }
    if (e.key === 'Enter') {
      const it = v.items[v.activo];
      e.preventDefault();
      if (!it || it.disabled) return;
      cerrar('pick');
      v.opts.onPick(it.value, it);
    }
  });

  pintar(v);
  const autofocus = opts.autofocus === undefined ? !hoja : !!opts.autofocus;
  if (autofocus) v.input.focus({ preventScroll: true });
  if (v.anchor.isConnected) v.anchor.setAttribute('aria-expanded', 'true');

  return {
    setSections(sections: ComboSection[]) {
      if (vivo !== v) return;
      v.opts.sections = sections;
      pintar(v);
    },
    close() {
      if (vivo === v) cerrar('cancel');
    },
  };
}

// Chasis de los paneles del cromo (letra, uso y gasto, objetivos, estado del chat).
//
// Por que existe: cada panel resolvia su posicion, su cierre y su foco por su cuenta, y el
// resultado se veia distinto en cada uno. El combobox (combo.ts) ya tenia resuelto lo dificil:
// popover anclado al disparador con clamp al viewport, hoja inferior en el telefono con telon y
// grab handle, cierre por Esc / click afuera / scroll, foco devuelto al disparador. Esto es el
// mismo chasis, sin lista: cabecera con titulo y cruz, cuerpo libre y un pie de acciones.
//
// Desktop: tarjeta de 340 px anclada debajo del disparador, se da vuelta si abajo no entra.
// Movil (<= 640 px): hoja inferior con telon, cuerpo con scroll propio y pie fijo visible.

import { esc } from './format';
import { uiIcon } from './icons';

export type PanelOpts = {
  id?: string;
  anchor: HTMLElement;
  /** Selector del disparador, para reencontrarlo si el cromo se reconstruye con el panel abierto. */
  anchorSel?: string;
  title: string;
  sub?: string;
  body: string;
  footer?: string;
  /** Se llama despues de montar: aca van los listeners del contenido. */
  onMount?: (api: PanelApi) => void;
  onClose?: () => void;
};

export type PanelApi = {
  root: HTMLElement;
  body: HTMLElement;
  foot: HTMLElement;
  setBody: (html: string) => void;
  setTitle: (title: string, sub?: string) => void;
  /** Recalcula la posicion. Necesario cuando el contenido crece DESPUES de abrir (una carga
   *  asincrona): ubicar() mide el alto al abrir y el panel se salia de la pantalla. */
  reubicar: () => void;
  close: () => void;
};

type Vivo = {
  root: HTMLElement;
  panel: HTMLElement;
  anchor: HTMLElement;
  opts: PanelOpts;
  onDoc: (e: Event) => void;
  onScroll: (e: Event) => void;
  onResize: () => void;
  onViewport?: () => void;
  ajustar: (() => void) | null;
};

let vivo: Vivo | null = null;
let seq = 0;

function ubicar(v: Vivo): void {
  if (v.ajustar) { v.ajustar(); return; }
  const m = 10;
  const ancho = Math.min(340, window.innerWidth - 2 * m);
  v.panel.style.width = ancho + 'px';
  // Techo generoso: el panel de gasto tiene ocho secciones y con 560 px quedaba casi todo detras
  // de un scroll. En escritorio entra completo; en el telefono lo limita el propio viewport.
  v.panel.style.maxHeight = Math.max(220, Math.min(720, window.innerHeight - 2 * m)) + 'px';
  const alto = v.panel.offsetHeight;
  // El disparador puede haber sido reemplazado por un repintado del cromo.
  const ancla = v.anchor.isConnected ? v.anchor
    : (v.opts.anchorSel ? document.querySelector<HTMLElement>(v.opts.anchorSel) : null);
  if (ancla) v.anchor = ancla;
  const r = ancla ? ancla.getBoundingClientRect() : null;
  const ref = r || ({ left: m, right: m, top: 0, bottom: 0, width: 0, height: 0 } as DOMRect);
  let top = ref.bottom + 7;
  if (top + alto > window.innerHeight - m) {
    const arriba = ref.top - 7 - alto;
    top = arriba >= m ? arriba : Math.max(m, window.innerHeight - m - alto);
  }
  let left = ref.right - ancho;
  if (left + ancho > window.innerWidth - m) left = window.innerWidth - m - ancho;
  if (left < m) left = m;
  v.panel.style.left = Math.round(left) + 'px';
  v.panel.style.top = Math.round(top) + 'px';
}

function cerrar(): void {
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
  document.documentElement.classList.remove('panel-open');
  const ancla = v.anchor.isConnected ? v.anchor
    : (v.opts.anchorSel ? document.querySelector<HTMLElement>(v.opts.anchorSel) : null);
  if (ancla) {
    ancla.setAttribute('aria-expanded', 'false');
    ancla.focus({ preventScroll: true });
  }
  if (v.opts.onClose) v.opts.onClose();
}

export function panelAbierto(): boolean {
  return !!vivo;
}

export function cerrarPanel(): void {
  if (vivo) cerrar();
}

export function abrirPanel(opts: PanelOpts): PanelApi {
  cerrarPanel();
  const instance = ++seq;
  const hoja = window.matchMedia('(max-width: 640px)').matches;
  const root = document.createElement('div');
  root.className = 'panel-root ' + (hoja ? 'is-sheet' : 'is-pop');
  if (opts.id) root.id = opts.id;
  root.innerHTML =
    '<div class="panel-back"></div>'
    + '<div class="panel" role="dialog" aria-modal="' + (hoja ? 'true' : 'false') + '"'
    + ' aria-labelledby="panel-t-' + instance + '">'
    + (hoja ? '<div class="panel-grab" aria-hidden="true"></div>' : '')
    + '<div class="panel-head">'
    +   '<span class="panel-title" id="panel-t-' + instance + '">' + esc(opts.title) + '</span>'
    +   '<span class="panel-sub">' + esc(opts.sub || '') + '</span>'
    +   '<button type="button" class="panel-x" aria-label="Cerrar">' + uiIcon('cross', { size: 13 }) + '</button>'
    + '</div>'
    + '<div class="panel-body">' + opts.body + '</div>'
    + (opts.footer ? '<div class="panel-foot">' + opts.footer + '</div>' : '')
    + '</div>';
  document.body.appendChild(root);
  document.documentElement.classList.add('panel-open');

  let ajustar: (() => void) | null = null;
  if (hoja) {
    ajustar = () => {
      const vv = window.visualViewport;
      root.style.top = Math.round(vv ? vv.offsetTop : 0) + 'px';
      root.style.height = Math.round(vv ? vv.height : window.innerHeight) + 'px';
    };
    ajustar();
    window.visualViewport?.addEventListener('resize', ajustar);
    window.visualViewport?.addEventListener('scroll', ajustar);
  }

  const v: Vivo = {
    root,
    panel: root.querySelector('.panel') as HTMLElement,
    anchor: opts.anchor,
    opts,
    onDoc: () => {},
    onScroll: () => {},
    onResize: () => {},
    onViewport: ajustar || undefined,
    ajustar,
  };
  vivo = v;

  v.onDoc = (e: Event) => {
    const t = e.target as Node;
    if (v.root.contains(t)) return;
    // El disparador no cierra el panel: lo togglea su propio handler y el orden se pisa.
    const a = v.anchor.isConnected ? v.anchor : null;
    const sel = v.opts.anchorSel ? document.querySelector(v.opts.anchorSel) : null;
    if ((a && a.contains(t)) || (sel && sel.contains(t))) return;
    cerrar();
  };
  // Cerrar por scroll SOLO si se movio el contenedor que hospeda al disparador.
  // Antes se cerraba con cualquier scroll de la pagina: arrastrar el panel (que tiene scroll
  // propio) o mover el sidebar lo cerraba a mitad de lectura, y se sentia como que el panel se
  // cae solo. Tampoco se lee window.scrollY en cada evento: es layout sincronico.
  const host = v.anchor.parentElement;
  const enPanel = (t: EventTarget | null) => t instanceof Element && !!t.closest('.panel-root');
  v.onScroll = (e: Event) => {
    if (hoja) return;
    const t = e.target;
    if (enPanel(t)) return;                       // scroll interno del panel: nunca cierra
    if (t instanceof Element && t !== document.documentElement && t !== document.body) return;
    cerrar();                                     // se movio la pagina de fondo
  };
  v.onResize = () => cerrar();

  // El popover se ancla al disparador por coordenadas: si la pagina scrollea, se va con ella.
  // Con el host capturado se puede seguir; si no se puede, se cierra (que era el comportamiento
  // sano) pero solo por scroll REAL de la pagina, no por un reflow.
  void host;
  document.addEventListener('pointerdown', v.onDoc, true);
  window.addEventListener('scroll', v.onScroll, true);
  window.addEventListener('resize', v.onResize);

  (root.querySelector('.panel-x') as HTMLElement).addEventListener('click', (e) => {
    e.stopPropagation();
    cerrar();
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cerrar(); }
  });

  const api: PanelApi = {
    root,
    body: root.querySelector('.panel-body') as HTMLElement,
    foot: (root.querySelector('.panel-foot') as HTMLElement) || document.createElement('div'),
    setBody(html: string) {
      const b = root.querySelector('.panel-body') as HTMLElement;
      if (b) b.innerHTML = html;
      if (vivo === v) ubicar(v);
    },
    setTitle(title: string, sub?: string) {
      const t = root.querySelector('.panel-title');
      const s = root.querySelector('.panel-sub');
      if (t) t.textContent = title;
      if (s) s.textContent = sub || '';
    },
    reubicar: () => { if (vivo === v) ubicar(v); },
    close: () => { if (vivo === v) cerrar(); },
  };

  if (v.anchor.isConnected) v.anchor.setAttribute('aria-expanded', 'true');
  ubicar(v);
  if (opts.onMount) opts.onMount(api);
  if (!hoja) {
    // Sólo el primer control de entrada: enfocar un botón le deja el aro de foco encendido y el
    // panel abre con un borde naranja que no significa nada.
    const foco = root.querySelector<HTMLElement>('.panel-body input, .panel-body [role="combobox"], .panel-body textarea');
    if (foco) foco.focus({ preventScroll: true });
  }
  return api;
}

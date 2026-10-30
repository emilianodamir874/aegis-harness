/* Piezas de lectura del transcript: buscar dentro de la conversación (Ctrl+F), botón para volver al
 * final y acciones por mensaje (copiar / editar / plegar prompts largos). Se enganchan por delegación
 * y observación del DOM para no seguir engordando app.ts (7 400 líneas).
 *
 * Buscar trabaja por MENSAJE, no por fragmento de texto: recorre los nodos del transcript, cuenta en
 * cuáles aparece la aguja y salta de uno a otro. El resaltado por palabra requería reescribir nodos de
 * texto y era frágil con el markdown ya sanitizado; marcar el mensaje entero es correcto siempre,
 * dice cuántas coincidencias hay y lleva a ellas, que es para lo que se usa Ctrl+F.
 */
import * as variantes from './variantes';

// Los mensajes se buscan en todo el documento: segun la fase del render viven en #msg-inner o en
// #messages, y atarse a un contenedor dejaba el buscador mudo.
const SELECTOR_MENSAJES = '.msg-a:not(.hidden-from-agent), .msg-user:not(.hidden-from-agent)';
let coincidencias: HTMLElement[] = [];
let actual = -1;
let barra: HTMLElement | null = null;
let aguja = '';

function copiar(texto: string): Promise<void> {
  const seguro = () => {
    const area = document.createElement('textarea');
    area.value = texto; area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.append(area); area.select();
    try { document.execCommand('copy'); } finally { area.remove(); }
  };
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(texto).catch(seguro);
  seguro();
  return Promise.resolve();
}

// ---------- buscar dentro de la conversación ----------
function contenedor(): HTMLElement | null {
  return document.querySelector<HTMLElement>('#msg-inner') || document.querySelector<HTMLElement>('#messages');
}

function pintarCuenta(): void {
  if (!barra) return;
  const cuenta = barra.querySelector('.buscar-cuenta');
  if (cuenta) cuenta.textContent = coincidencias.length ? `${actual + 1}/${coincidencias.length}` : '0/0';
  const campo = barra.querySelector('.buscar-input') as HTMLInputElement | null;
  if (campo) campo.setAttribute('aria-invalid', String(!!campo.value.trim() && !coincidencias.length));
}

function limpiar(): void {
  for (const el of coincidencias) {
    el.removeAttribute('data-buscar');
    el.classList.remove('buscar-actual');
  }
  coincidencias = [];
  actual = -1;
}

function irA(i: number): void {
  if (!coincidencias.length) { pintarCuenta(); return; }
  actual = ((i % coincidencias.length) + coincidencias.length) % coincidencias.length;
  coincidencias.forEach((el, k) => el.classList.toggle('buscar-actual', k === actual));
  coincidencias[actual].scrollIntoView({ block: 'center', behavior: 'smooth' });
  pintarCuenta();
}

function marcar(consulta: string): void {
  limpiar();
  aguja = consulta.trim().toLowerCase();
  if (!aguja) { pintarCuenta(); return; }
  for (const el of document.querySelectorAll<HTMLElement>(SELECTOR_MENSAJES)) {
    if ((el.textContent || '').toLowerCase().includes(aguja)) {
      el.dataset.buscar = String(coincidencias.length + 1);
      coincidencias.push(el);
    }
  }
  actual = coincidencias.length ? 0 : -1;
  if (coincidencias.length) irA(0); else pintarCuenta();
}

export function abrirBuscar(): void {
  const cont = document.querySelector('#messages');
  if (!cont) return;
  if (!barra) {
    barra = document.createElement('div');
    barra.className = 'buscar-barra';
    barra.innerHTML = '<input class="buscar-input" type="search" placeholder="Buscar en la conversación" aria-label="Buscar en la conversación" />'
      + '<span class="buscar-cuenta" aria-live="polite">0/0</span>'
      + '<button type="button" class="buscar-nav" data-dir="-1" aria-label="Coincidencia anterior">↑</button>'
      + '<button type="button" class="buscar-nav" data-dir="1" aria-label="Coincidencia siguiente">↓</button>'
      + '<button type="button" class="buscar-cerrar" aria-label="Cerrar búsqueda">×</button>';
    cont.prepend(barra); // arriba del transcript: sticky, no tapa el ultimo mensaje
    const campo = barra.querySelector('.buscar-input') as HTMLInputElement;
    campo.addEventListener('input', () => marcar(campo.value));
    campo.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); irA(actual + (e.shiftKey ? -1 : 1)); }
      if (e.key === 'Escape') { e.preventDefault(); cerrarBuscar(); }
      e.stopPropagation();
    });
    barra.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const nav = t.closest('.buscar-nav') as HTMLElement | null;
      if (nav) { irA(actual + Number(nav.dataset.dir || 1)); return; }
      if (t.closest('.buscar-cerrar')) cerrarBuscar();
    });
  }
  barra.hidden = false;
  const campo = barra.querySelector('.buscar-input') as HTMLInputElement;
  campo.focus();
  campo.select();
  if (campo.value) marcar(campo.value);
}

export function cerrarBuscar(): void {
  limpiar();
  aguja = '';
  if (barra) barra.hidden = true;
}

export function buscarAbierto(): boolean { return !!barra && !barra.hidden; }

/** Busca un texto en el transcript abierto (lo usa el gate y sirve desde la consola). */
export function buscarTexto(consulta: string): void {
  abrirBuscar();
  const campo = barra?.querySelector<HTMLInputElement>('.buscar-input');
  if (campo) campo.value = consulta;
  marcar(consulta);
}

/** Estado del buscador, para diagnóstico. */
export function estadoBusqueda(): { coincidencias: number; actual: number; raiz: string | null; aguja: string } {
  const raiz = document.querySelector('#msg-inner') ? '#msg-inner' : (document.querySelector('#messages') ? '#messages' : null);
  return { coincidencias: coincidencias.length, actual, raiz, aguja };
}

// ---------- volver al final ----------
let pildora: HTMLButtonElement | null = null;

// El scroll no vive siempre en el mismo nodo: en escritorio scrollea #messages y en el teléfono
// puede scrollear #msg-inner o el propio .app. Se busca el que realmente tiene contenido de más.
// Quien scrollea cambia con el layout: en el telefono es #messages, en escritorio puede ser
// #msg-inner o .app. Se elige el candidato con mas contenido desbordado, no el primero que exista.
function scroller(): HTMLElement | null {
  let mejor: HTMLElement | null = null;
  let desborde = 0;
  for (const sel of ['#messages', '#msg-inner', '.app']) {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) continue;
    const d = el.scrollHeight - el.clientHeight;
    if (d > desborde) { desborde = d; mejor = el; }
  }
  return mejor || document.querySelector<HTMLElement>('#messages');
}

function medirPegado(): void {
  if (!pildora) return;
  const cont = scroller();
  if (!cont) return;
  const distancia = cont.scrollHeight - cont.scrollTop - cont.clientHeight;
  // Solo aparece si hay algo que scrollear Y no estas al final.
  pildora.hidden = distancia < 80;
}

export function irAlFinal(suave = true): void {
  const cont = scroller();
  if (!cont) return;
  cont.scrollTo({ top: cont.scrollHeight, behavior: suave ? 'smooth' : 'auto' });
  if (pildora) pildora.hidden = true;
}

function instalarPildora(): void {
  const cont = document.querySelector<HTMLElement>('#messages');
  if (!cont || pildora) return;
  pildora = document.createElement('button');
  pildora.type = 'button';
  pildora.className = 'ir-final';
  pildora.hidden = true;
  pildora.innerHTML = '<span aria-hidden="true">↓</span><span class="ir-final-txt">al final</span>';
  pildora.setAttribute('aria-label', 'Ir al final de la conversación');
  pildora.addEventListener('click', () => irAlFinal());
  (cont.parentElement || document.body).append(pildora);
  cont.addEventListener('scroll', medirPegado, { passive: true });
  new ResizeObserver(medirPegado).observe(cont);
  new MutationObserver(medirPegado).observe(cont, { childList: true });
}

// ---------- conmutador de variantes ----------
// Solo aparece si regeneraste: ‹ 1/2 › sobre el ultimo mensaje del agente. Es una vista local
// (las variantes viejas quedaron fuera del contexto por el rewind y siguen en la sesion).
function pintarVariantes(): void {
  const pos = variantes.posicion();
  const mensajes = [...document.querySelectorAll<HTMLElement>('.msg-a')];
  const ultimo = mensajes[mensajes.length - 1];
  let chipEl = document.querySelector<HTMLElement>('.variantes-chip');
  if (!pos || !ultimo) { chipEl?.remove(); return; }
  if (!chipEl) {
    chipEl = document.createElement('div');
    chipEl.className = 'variantes-chip';
    chipEl.innerHTML = '<button type="button" class="var-nav" data-dir="-1" aria-label="Respuesta anterior">‹</button>'
      + '<span class="var-pos" aria-live="polite"></span>'
      + '<button type="button" class="var-nav" data-dir="1" aria-label="Respuesta siguiente">›</button>'
      + '<span class="var-nota" title="Las variantes anteriores quedaron fuera del contexto del modelo; siguen guardadas en la sesion.">local</span>';
    chipEl.addEventListener('click', (e) => {
      const boton = (e.target as HTMLElement).closest?.('.var-nav') as HTMLElement | null;
      if (!boton) return;
      const movido = variantes.mover(Number(boton.dataset.dir) === -1 ? -1 : 1);
      const destino = [...document.querySelectorAll<HTMLElement>('.msg-a')].pop();
      if (movido && destino) { destino.innerHTML = movido.html; }
      pintarVariantes();
    });
  }
  const acciones = ultimo.querySelector<HTMLElement>(':scope > .act-btn');
  if (acciones?.parentElement) acciones.parentElement.append(chipEl);
  else ultimo.append(chipEl);
  const posEl = chipEl.querySelector('.var-pos');
  if (posEl) posEl.textContent = (pos.idx + 1) + '/' + pos.total;
}

export function refrescarVariantes(): void { pintarVariantes(); }

export function instalar(): void {
  instalarPildora();
  new MutationObserver(() => pintarVariantes()).observe(document.querySelector('#messages') || document.body, { childList: true, subtree: false });
  pintarVariantes();
  document.addEventListener('keydown', (e) => {
    const meta = e.ctrlKey || e.metaKey;
    if (meta && (e.key === 'f' || e.key === 'F')) {
      // En un SPA de un solo panel, Ctrl+F tiene que buscar acá y no en el HTML crudo.
      e.preventDefault();
      abrirBuscar();
    } else if (e.key === 'Escape' && buscarAbierto()) {
      e.preventDefault();
      cerrarBuscar();
    }
  }, true);
}

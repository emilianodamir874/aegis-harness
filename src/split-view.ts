/* Split view de dos sesiones (M9, la mitad que faltaba).
 *
 * Por que existe: comparar dos sesiones obliga a saltar entre ellas y perder el hilo. Este panel
 * abre una segunda sesion al costado, en modo lectura, para tener las dos a la vista.
 *
 * Alcance declarado: es una foto, no un espejo en vivo. Se alimenta de
 * `_aegis/unstable/session/export` (el mismo RPC del boton de exportar) y se refresca cuando lo
 * pedis. Un segundo stream en vivo necesita una conexion ACP propia y queda fuera de esto a
 * proposito: prefiero una foto honesta, con su boton de refrescar, antes que un panel que se
 * desincroniza sin avisar.
 */

interface SplitRpc {
  request<T = void>(method: string, params: Record<string, unknown>): Promise<T>;
}

interface SessionRow {
  sessionId?: string;
  id?: string;
  title?: string;
  name?: string;
  updatedAt?: string;
}

declare global {
  interface Window {
    __aegisSplit?: { open: () => Promise<void>; close: () => void; toggle: () => Promise<void> };
  }
}

const CSS = `
.aegis-split{position:fixed;top:0;right:0;bottom:0;width:min(46vw,620px);z-index:9050;display:flex;flex-direction:column;background:var(--bg-sidebar,#191817);border-left:1px solid rgba(255,255,255,.1);box-shadow:-18px 0 50px rgba(0,0,0,.4);font:14px/1.5 system-ui,Segoe UI,sans-serif;color:var(--fg,#e7edf5)}
@media (max-width:900px){.aegis-split{width:100vw}}
.aegis-split header{display:flex;gap:8px;align-items:center;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08)}
.aegis-split header select{flex:1;min-width:0;font:inherit;color:inherit;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:6px 8px}
.aegis-split button{cursor:pointer;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:5px 10px;color:inherit;font:inherit}
.aegis-split button:hover{background:rgba(255,255,255,.13)}
.aegis-split .body{flex:1;overflow:auto;padding:12px 14px}
.aegis-split .body h1,.aegis-split .body h2,.aegis-split .body h3{margin:14px 0 6px;font-size:15px}
.aegis-split .body pre{background:rgba(0,0,0,.3);border-radius:8px;padding:8px;overflow:auto;font:12px/1.45 ui-monospace,Consolas,monospace}
.aegis-split .body code{font:12px ui-monospace,Consolas,monospace}
.aegis-split .body p{margin:6px 0}
.aegis-split .body blockquote{margin:8px 0;padding-left:10px;border-left:2px solid rgba(255,255,255,.18);color:#c8d3e2}
.aegis-split .status{padding:6px 12px;border-top:1px solid rgba(255,255,255,.08);color:#93a2b8;font-size:11.5px}
`;

let panel: HTMLDivElement | null = null;
let bodyEl: HTMLDivElement | null = null;
let statusEl: HTMLDivElement | null = null;
let selectEl: HTMLSelectElement | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function rpc(): SplitRpc | undefined {
  return (window.__aegisWeb as unknown as { rpc?: SplitRpc })?.rpc;
}

function currentSessionId(): string {
  const state = window.__aegisWeb as unknown as { state?: { current?: { id?: string } } } | undefined;
  return String(state?.current?.id || '');
}

function say(text: string): void {
  if (statusEl) statusEl.textContent = text;
}

/// Markdown a HTML por el renderer de la app cuando existe; si no, texto plano en un <pre>.
function render(text: string): HTMLElement {
  const container = el('div');
  const md = (window.__aegisWeb as unknown as { md?: (t: string) => string })?.md;
  if (typeof md === 'function') {
    try {
      container.innerHTML = md(text);
      return container;
    } catch {
      /* cae a texto plano */
    }
  }
  const pre = el('pre');
  pre.textContent = text;
  container.appendChild(pre);
  return container;
}

async function loadSessions(): Promise<SessionRow[]> {
  const client = rpc();
  if (!client) return [];
  try {
    const res = await client.request<{ sessions?: SessionRow[] }>('session/list', {});
    return res?.sessions || [];
  } catch {
    return [];
  }
}

async function refresh(): Promise<void> {
  const client = rpc();
  const id = selectEl?.value || '';
  if (!client || !id || !bodyEl) return;
  say('leyendo…');
  try {
    const res = await client.request<{ data?: string }>('_aegis/unstable/session/export', {
      sessionId: id,
      format: 'markdown',
    });
    const text = String(res?.data || '');
    bodyEl.textContent = '';
    if (!text) {
      bodyEl.appendChild(el('p', undefined, 'El export vino vacío.'));
      say('sin contenido');
      return;
    }
    bodyEl.appendChild(render(text));
    say(`${text.length} chars · foto del ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    say(`no pude leer: ${String((error as Error).message || error)}`);
  }
}

async function open(): Promise<void> {
  if (panel) {
    void refresh();
    return;
  }
  if (!document.getElementById('aegis-split-style')) {
    const style = el('style');
    style.id = 'aegis-split-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  panel = el('div', 'aegis-split');
  panel.setAttribute('role', 'complementary');
  panel.setAttribute('aria-label', 'Segunda sesión (solo lectura)');

  const header = el('header');
  selectEl = el('select');
  selectEl.appendChild(el('option', undefined, 'Cargando…'));
  const reload = el('button', undefined, 'Refrescar');
  const closeBtn = el('button', undefined, 'Cerrar');
  header.append(selectEl, reload, closeBtn);
  panel.appendChild(header);

  bodyEl = el('div', 'body');
  panel.appendChild(bodyEl);
  statusEl = el('div', 'status', 'foto en solo lectura · Ctrl+Alt+2 para cerrar');
  panel.appendChild(statusEl);
  document.body.appendChild(panel);

  // Deja lugar al transcript principal para que no quede tapado.
  document.body.style.setProperty('--aegis-split-pad', 'min(46vw, 620px)');
  document.documentElement.classList.add('aegis-split-open');

  closeBtn.addEventListener('click', close);
  reload.addEventListener('click', () => void refresh());
  selectEl.addEventListener('change', () => void refresh());

  const sessions = await loadSessions();
  const activa = currentSessionId();
  const otras = sessions.filter((row) => String(row.sessionId || row.id) !== activa);
  selectEl.textContent = '';
  if (!otras.length) {
    selectEl.appendChild(el('option', undefined, 'no hay otras sesiones'));
    say('sin sesiones para comparar');
    return;
  }
  for (const row of otras.slice(0, 80)) {
    const id = String(row.sessionId || row.id || '');
    const option = el('option', undefined, `${row.title || row.name || id.slice(0, 8)} · ${String(row.updatedAt || '').slice(0, 10)}`);
    option.value = id;
    selectEl.appendChild(option);
  }
  // Por defecto, la mas reciente que no sea la activa.
  if (otras.length) selectEl.value = String(otras[0].sessionId || otras[0].id || '');
  void refresh();
}

function close(): void {
  if (!panel) return;
  panel.remove();
  panel = null;
  bodyEl = null;
  statusEl = null;
  selectEl = null;
  document.body.style.removeProperty('--aegis-split-pad');
  document.documentElement.classList.remove('aegis-split-open');
}

async function toggle(): Promise<void> {
  if (panel) close();
  else await open();
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && panel && document.activeElement && panel.contains(document.activeElement)) close();
  if (event.altKey && event.ctrlKey && event.key === '2') {
    event.preventDefault();
    void toggle();
  }
});

window.__aegisSplit = { open, close, toggle };

/* Palette de comandos (Ctrl+K / Cmd+K) — M10.
 *
 * Por que existe: Ctrl+K abre la busqueda de sesiones y ahi termina. Esta palette pone en una sola
 * lista los comandos que hoy viven en menus, paneles y atajos: abrir memoria, artefactos, skills,
 * gasto, cambiar el modo de sesion, compactar, exportar, nueva sesion y buscar.
 *
 * Corre en captura y corta la propagacion: cuando la palette abre, Ctrl+K deja de ser la busqueda de
 * sesiones. La busqueda sigue estando, como primer resultado cuando hay texto.
 *
 * No toca `src/app.ts`: usa lo que app y mis modulos ya exponen en `window`.
 */

declare global {
  interface Window {
    __aegisPalette?: { open: () => void; close: () => void; toggle: () => void };
  }
}

interface PaletteCommand {
  id: string;
  title: string;
  hint?: string;
  keys?: string;
  run: () => void | Promise<void>;
}

const CSS = `
.aegis-pal-backdrop{position:fixed;inset:0;background:rgba(6,8,12,.55);backdrop-filter:blur(2px);z-index:9300;display:flex;align-items:flex-start;justify-content:center;padding:14vh 16px 16px}
.aegis-pal{width:min(640px,100%);background:var(--panel,#14181f);color:var(--fg,#e7edf5);border:1px solid rgba(255,255,255,.1);border-radius:12px;box-shadow:0 24px 70px rgba(0,0,0,.55);overflow:hidden;font:14px/1.45 system-ui,Segoe UI,sans-serif}
.aegis-pal input{width:100%;box-sizing:border-box;padding:13px 16px;border:0;border-bottom:1px solid rgba(255,255,255,.08);background:transparent;color:inherit;font:15px/1.4 inherit;outline:none}
.aegis-pal ul{list-style:none;margin:0;padding:6px;max-height:min(50vh,420px);overflow:auto}
.aegis-pal li{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;cursor:pointer}
.aegis-pal li[aria-selected=true]{background:rgba(47,109,246,.18)}
.aegis-pal li .t{flex:1}
.aegis-pal li .h{color:#93a2b8;font-size:12px}
.aegis-pal li kbd{font:11px/1 ui-monospace,Consolas,monospace;color:#93a2b8;border:1px solid rgba(255,255,255,.14);border-radius:5px;padding:2px 5px}
.aegis-pal .empty{padding:20px;text-align:center;color:#93a2b8}
.aegis-pal footer{padding:7px 14px;border-top:1px solid rgba(255,255,255,.08);color:#93a2b8;font-size:11.5px}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function composerInput(): HTMLTextAreaElement | HTMLInputElement | null {
  return document.querySelector<HTMLTextAreaElement>('.composer textarea') ||
    document.querySelector<HTMLInputElement>('.composer input[type=text]');
}

function sendToComposer(text: string, submit = false): void {
  const input = composerInput();
  if (!input) return;
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
  if (submit) {
    const form = input.closest('form');
    if (form) form.requestSubmit();
    else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
}

function clickIfPresent(selector: string): boolean {
  const node = document.querySelector<HTMLElement>(selector);
  if (!node) return false;
  node.click();
  return true;
}

function commands(): PaletteCommand[] {
  const list: PaletteCommand[] = [
    {
      id: 'compact',
      title: 'Compactar el contexto ahora',
      hint: 'pone /compact en el composer',
      run: () => sendToComposer('/compact', true),
    },
    {
      id: 'memory',
      title: 'Abrir memoria del operador',
      hint: 'confirmar, rechazar, fijar hechos',
      keys: 'Ctrl+Alt+M',
      run: () => window.__aegisMemory?.open(),
    },
    {
      id: 'artifacts',
      title: 'Abrir artefactos del outbox',
      hint: 'previsualizar y descargar',
      keys: 'Ctrl+Alt+O',
      run: () => window.__aegisArtifacts?.open(),
    },
    {
      id: 'skills',
      title: 'Abrir skills',
      keys: 'Ctrl+Alt+S',
      run: () => window.__aegisSkills?.open(),
    },
    {
      id: 'mode-plan',
      title: 'Modo plan',
      hint: 'no puede escribir: las tools no se le mandan',
      run: () => window.__aegisSessionMode?.set('plan'),
    },
    {
      id: 'mode-revisar',
      title: 'Modo revisar',
      hint: 'cada escritura pide permiso y muestra el diff',
      run: () => window.__aegisSessionMode?.set('revisar'),
    },
    {
      id: 'mode-ejecutar',
      title: 'Modo ejecutar',
      hint: 'permission.yaml manda',
      run: () => window.__aegisSessionMode?.set('ejecutar'),
    },
    {
      id: 'contextmap',
      title: 'Que ocupa el contexto',
      hint: 'abre el mapa del medidor',
      run: () => {
        const meter = document.querySelector<HTMLElement>('.ctx-meter');
        if (meter) meter.click();
      },
    },
    {
      id: 'new-session',
      title: 'Nueva sesion',
      run: () => {
        const byId = document.getElementById('new-session') || document.querySelector<HTMLElement>('[data-action="new-session"]');
        if (byId) byId.click();
        else if (!clickIfPresent('.new-chat') && !clickIfPresent('button[title*="ueva"]')) {
          sendToComposer('/new', true);
        }
      },
    },
    {
      id: 'search-sessions',
      title: 'Buscar en sesiones',
      hint: 'la busqueda de siempre',
      keys: 'Ctrl+K',
      run: () => {
        const search = document.querySelector<HTMLInputElement>('.sidebar input[type=search], .sidebar input[type=text], #search');
        if (search) search.focus();
      },
    },
    {
      id: 'search-messages',
      title: 'Buscar en mensajes de esta sesion',
      hint: 'pone /search y espera el texto',
      run: () => sendToComposer('/search '),
    },
    {
      id: 'export',
      title: 'Exportar la conversacion',
      hint: 'markdown, via el menu del titulo',
      run: () => {
        const title = document.querySelector<HTMLElement>('#title, .title');
        if (title) title.click();
      },
    },
    {
      id: 'spend',
      title: 'Ver gasto y uso',
      run: () => {
        if (!clickIfPresent('[data-panel="gasto"]') && !clickIfPresent('button[title*="asto"]')) {
          sendToComposer('/stats', true);
        }
      },
    },
    {
      id: 'help',
      title: 'Ayuda de atajos',
      hint: 'Ctrl+K palette · Ctrl+Alt+M memoria · Ctrl+Alt+O artefactos · Esc cierra',
      run: () => sendToComposer('¿Qué atajos tiene esta interfaz? Resumí en una lista corta.'),
    },
  ];
  return list;
}

let backdrop: HTMLDivElement | null = null;
let items: PaletteCommand[] = [];
let filtered: PaletteCommand[] = [];
let cursor = 0;
let input: HTMLInputElement | null = null;
let listEl: HTMLUListElement | null = null;

function render(): void {
  if (!listEl) return;
  listEl.textContent = '';
  if (!filtered.length) {
    const empty = el('div', 'empty', 'Sin coincidencias.');
    listEl.appendChild(empty as unknown as HTMLLIElement);
    return;
  }
  filtered.forEach((cmd, index) => {
    const li = el('li');
    li.setAttribute('aria-selected', String(index === cursor));
    li.appendChild(el('span', 't', cmd.title));
    if (cmd.hint) li.appendChild(el('span', 'h', cmd.hint));
    if (cmd.keys) li.appendChild(el('kbd', undefined, cmd.keys));
    li.addEventListener('click', () => void runCommand(cmd));
    li.addEventListener('mousemove', () => {
      if (cursor !== index) {
        cursor = index;
        render();
      }
    });
    listEl!.appendChild(li);
  });
}

function refilter(): void {
  const needle = (input?.value || '').trim().toLowerCase();
  filtered = needle
    ? items.filter((cmd) => `${cmd.title} ${cmd.hint || ''} ${cmd.id}`.toLowerCase().includes(needle))
    : items.slice();
  cursor = 0;
  render();
}

async function runCommand(cmd: PaletteCommand): Promise<void> {
  close();
  try {
    await cmd.run();
  } catch {
    /* un comando que falla no deja la palette abierta */
  }
}

function onKey(event: KeyboardEvent): void {
  if (!backdrop) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
    return;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    cursor = Math.min(cursor + 1, filtered.length - 1);
    render();
    return;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    cursor = Math.max(cursor - 1, 0);
    render();
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    const cmd = filtered[cursor];
    if (cmd) void runCommand(cmd);
  }
}

function open(): void {
  if (backdrop) return;
  if (!document.getElementById('aegis-pal-style')) {
    const style = el('style');
    style.id = 'aegis-pal-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  items = commands();
  filtered = items.slice();
  cursor = 0;

  backdrop = el('div', 'aegis-pal-backdrop');
  const box = el('div', 'aegis-pal');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', 'Paleta de comandos');

  input = el('input');
  input.type = 'text';
  input.placeholder = 'Comando, o texto para buscar…';
  input.setAttribute('aria-label', 'Buscar comando');
  input.addEventListener('input', refilter);
  input.addEventListener('keydown', onKey);

  listEl = el('ul');
  listEl.setAttribute('role', 'listbox');

  const foot = el('footer', undefined, 'Enter ejecuta · ↑↓ mueve · Esc cierra');
  box.append(input, listEl, foot);
  backdrop.appendChild(box);
  document.body.appendChild(backdrop);
  render();
  input.focus();

  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close();
  });
}

function close(): void {
  if (!backdrop) return;
  backdrop.remove();
  backdrop = null;
  input = null;
  listEl = null;
}

function toggle(): void {
  if (backdrop) close();
  else open();
}

document.addEventListener(
  'keydown',
  (event) => {
    const isK = event.key === 'k' || event.key === 'K';
    if (!isK) return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    const target = event.target as HTMLElement | null;
    const typing = target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable);
    // Con el foco en el composer, Ctrl+K sigue siendo del navegador (no rompe escribir).
    if (typing && !backdrop) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    toggle();
  },
  true,
);

window.__aegisPalette = { open, close, toggle };

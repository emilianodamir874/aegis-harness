/* Galeria de artefactos (aegis-web).
 *
 * Por que existe: el agente deja archivos en `web/outbox` y el link `/dl/<nombre>` funciona, pero no
 * habia forma de ver que hay, cuanto pesa ni como se ve sin abrir la carpeta a mano. Esta galeria
 * lista el outbox por fecha, previsualiza markdown, imagenes y codigo, y deja copiar el link.
 *
 * La API es `/outbox.json` (lista) y `/outbox.json?name=X&preview=1` (contenido acotado a 2 MB).
 */

interface OutboxItem {
  name: string;
  bytes: number;
  mtime: string;
  ext: string;
  url: string;
}

interface PreviewPayload {
  name?: string;
  bytes?: number;
  ext?: string;
  binary?: boolean;
  tooLarge?: boolean;
  text?: string;
  dataUrl?: string;
  error?: string;
}

declare global {
  interface Window {
    __aegisArtifacts?: { open: () => void; close: () => void; load: () => void };
  }
}

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
const MD_EXT = ['.md', '.markdown'];

const CSS = `
.aegis-art-backdrop{position:fixed;inset:0;background:rgba(6,8,12,.62);backdrop-filter:blur(2px);z-index:9100;display:flex;align-items:center;justify-content:center;padding:24px}
.aegis-art{width:min(1080px,100%);max-height:min(88vh,940px);display:grid;grid-template-columns:340px 1fr;background:var(--panel,#14181f);color:var(--fg,#e7edf5);border:1px solid rgba(255,255,255,.08);border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.55);font:14px/1.45 system-ui,Segoe UI,sans-serif;overflow:hidden}
@media (max-width:760px){.aegis-art{grid-template-columns:1fr}}
.aegis-art header{grid-column:1/-1;display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,.07)}
.aegis-art header h2{margin:0;font-size:16px;font-weight:650}
.aegis-art header .grow{flex:1}
.aegis-art button{cursor:pointer;background:rgba(255,255,255,.06);color:inherit;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:5px 10px;font:inherit}
.aegis-art button:hover{background:rgba(255,255,255,.12)}
.aegis-art .list{overflow:auto;border-right:1px solid rgba(255,255,255,.07);padding:6px}
.aegis-art .item{display:block;width:100%;text-align:left;background:transparent;border:1px solid transparent;border-radius:8px;padding:8px 10px;margin:2px 0}
.aegis-art .item:hover{background:rgba(255,255,255,.06)}
.aegis-art .item[aria-selected=true]{background:rgba(47,109,246,.16);border-color:rgba(47,109,246,.5)}
.aegis-art .item .name{font-weight:600;word-break:break-all}
.aegis-art .item .meta{color:#93a2b8;font-size:12px;margin-top:2px}
.aegis-art .view{display:flex;flex-direction:column;overflow:hidden}
.aegis-art .view .bar{display:flex;gap:8px;align-items:center;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.07);color:#93a2b8;font-size:12px}
.aegis-art .view .body{overflow:auto;padding:14px;flex:1}
.aegis-art pre{margin:0;white-space:pre-wrap;word-break:break-word;font:12.5px/1.5 ui-monospace,Consolas,monospace}
.aegis-art img{max-width:100%;border-radius:8px}
.aegis-art .empty{padding:28px;text-align:center;color:#93a2b8}
.aegis-art .status{grid-column:1/-1;padding:8px 18px;color:#93a2b8;font-size:12px;border-top:1px solid rgba(255,255,255,.07);min-height:16px}
`;

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

interface Panel {
  backdrop: HTMLDivElement;
  list: HTMLDivElement;
  body: HTMLDivElement;
  bar: HTMLDivElement;
  status: HTMLDivElement;
}

let panel: Panel | null = null;
let items: OutboxItem[] = [];
let selected = '';

function buildPanel(): Panel {
  if (!document.getElementById('aegis-art-style')) {
    const style = el('style');
    style.id = 'aegis-art-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const backdrop = el('div', 'aegis-art-backdrop');
  const dialog = el('div', 'aegis-art');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Artefactos');

  const header = el('header');
  header.appendChild(el('h2', '', 'Artefactos'));
  header.appendChild(el('span', 'grow'));
  const reloadButton = el('button', '', 'Recargar');
  const closeButton = el('button', '', 'Cerrar');
  header.append(reloadButton, closeButton);
  dialog.appendChild(header);

  const list = el('div', 'list');
  const view = el('div', 'view');
  const bar = el('div', 'bar');
  const body = el('div', 'body');
  view.append(bar, body);
  dialog.append(list, view);

  const status = el('div', 'status');
  dialog.appendChild(status);
  backdrop.appendChild(dialog);

  closeButton.addEventListener('click', close);
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
  reloadButton.addEventListener('click', () => void load());

  return { backdrop, list, body, bar, status };
}

async function preview(name: string): Promise<void> {
  if (!panel) return;
  selected = name;
  renderList();
  panel.bar.textContent = name;
  panel.body.textContent = '';
  try {
    const response = await fetch(`/outbox.json?name=${encodeURIComponent(name)}&preview=1`, { cache: 'no-store' });
    const data = (await response.json()) as PreviewPayload;
    if (data.error) {
      panel.body.appendChild(el('div', 'empty', data.error));
      return;
    }
    if (data.tooLarge) {
      panel.body.appendChild(el('div', 'empty', `Demasiado grande para previsualizar (${fmtBytes(data.bytes || 0)}).`));
      const link = el('a', '', 'Descargar');
      link.href = `/dl/${encodeURIComponent(name)}`;
      panel.body.appendChild(link);
      return;
    }
    const ext = (data.ext || '').toLowerCase();
    if (IMAGE_EXT.includes(ext) && data.dataUrl) {
      const img = el('img');
      img.src = data.dataUrl;
      img.alt = name;
      panel.body.appendChild(img);
      return;
    }
    const pre = el('pre');
    pre.textContent = data.text || '';
    panel.body.appendChild(pre);
    if (MD_EXT.includes(ext)) panel.status.textContent = 'markdown crudo (sin render) para copiar tal cual';
  } catch (error) {
    panel.body.appendChild(el('div', 'empty', String((error as Error).message || error)));
  }
}

function renderList(): void {
  if (!panel) return;
  panel.list.textContent = '';
  if (!items.length) {
    panel.list.appendChild(el('div', 'empty', 'El outbox esta vacio.'));
    return;
  }
  for (const item of items) {
    const button = el('button', 'item');
    button.setAttribute('aria-selected', String(item.name === selected));
    button.appendChild(el('div', 'name', item.name));
    const when = new Date(item.mtime).toLocaleString();
    button.appendChild(el('div', 'meta', `${fmtBytes(item.bytes)} \u00b7 ${when}`));
    button.addEventListener('click', () => void preview(item.name));
    panel.list.appendChild(button);
  }
}

async function load(): Promise<void> {
  if (!panel) return;
  try {
    const response = await fetch('/outbox.json', { cache: 'no-store' });
    const data = (await response.json()) as { items?: OutboxItem[]; dir?: string };
    items = data.items || [];
    renderList();
    panel.status.textContent = `${items.length} archivos en ${data.dir || 'outbox'}`;
    if (!selected && items.length) void preview(items[0].name);
  } catch (error) {
    panel.status.textContent = `no pude listar el outbox: ${String((error as Error).message || error)}`;
  }
}

function open(): void {
  if (!panel) panel = buildPanel();
  panel.backdrop.style.display = 'flex';
  document.body.appendChild(panel.backdrop);
  void load();
}

function close(): void {
  if (panel) panel.backdrop.style.display = 'none';
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') close();
  if (event.altKey && event.ctrlKey && (event.key === 'o' || event.key === 'O')) {
    event.preventDefault();
    open();
  }
});

window.__aegisArtifacts = { open, close, load: () => void load() };

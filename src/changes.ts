/* Estado Git actual en solo lectura. /changes.json valida el cwd permitido antes de consultar Git. */
interface ChangeEntry {
  path: string; staged: string; worktree: string; diff: string; truncated?: boolean;
  stagedAdded?: number | null; stagedRemoved?: number | null;
  worktreeAdded?: number | null; worktreeRemoved?: number | null;
}
interface ChangeResponse {
  kind: 'git' | 'not-git' | 'error';
  cwd?: string; root?: string; entries: ChangeEntry[]; truncated: boolean; error?: string;
}
declare global {
  interface Window {
    __aegisChanges?: { open: (cwd: string) => Promise<void>; close: () => void; refresh: () => Promise<void> };
  }
}
const STYLE = `
.aegis-changes-shade{position:fixed;inset:0;z-index:9200;background:rgba(0,0,0,.7);display:grid;place-items:center;padding:16px}
.aegis-changes{background:var(--panel,#14181f);color:var(--fg,#eef);border:1px solid #627080;border-radius:10px;width:min(850px,100%);max-height:90dvh;display:flex;flex-direction:column;font:14px/1.5 system-ui,Segoe UI,sans-serif}
.aegis-changes header{display:flex;gap:8px;align-items:center;padding:12px;border-bottom:1px solid #627080}
.aegis-changes h2{font-size:17px;margin:0;flex:1}
.aegis-changes button{font:inherit;background:#283341;color:inherit;border:1px solid #627080;border-radius:6px;padding:4px 10px;cursor:pointer}
.aegis-changes main{overflow:auto;padding:12px;overflow-wrap:anywhere}
.aegis-changes details{border-bottom:1px solid #627080;padding:8px 0}
.aegis-changes summary{cursor:pointer}
.aegis-changes pre{overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 ui-monospace,Consolas,monospace}
.aegis-changes .note{padding:8px 12px;border-top:1px solid #627080;color:#b2c5d9}
`;
let shade: HTMLDivElement | null = null;
let main: HTMLElement | null = null;
let note: HTMLElement | null = null;
let selectedCwd = '';
let serial = 0;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}
function counts(added: unknown, removed: unknown): string {
  const n = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const a = n(added), r = n(removed);
  return a === null || r === null ? '+? / −? (no disponible)' : `+${a} / −${r}`;
}
function testStatus(): string {
  // Git status/diff cannot establish whether tests were run. A test-status source
  // would need separate, verifiable evidence; no such source is in this API.
  return 'Pruebas: estado desconocido; Git no registra su ejecución';
}
function valid(value: unknown): value is ChangeResponse {
  return !!value && typeof value === 'object' && ['git', 'not-git', 'error'].includes((value as ChangeResponse).kind)
    && Array.isArray((value as ChangeResponse).entries) && typeof (value as ChangeResponse).truncated === 'boolean';
}
async function refresh(): Promise<void> {
  if (!main || !note) return;
  const version = ++serial, view = main, footer = note;
  view.replaceChildren(el('p', 'Consultando Git…'));
  footer.textContent = 'Estado actual de Git; autor desconocido. ' + testStatus();
  try {
    const current = (window as Window & { __aegisWeb?: { state?: { current?: { id?: string; cwd?: string } } } }).__aegisWeb?.state?.current;
    if (!selectedCwd || !current?.id || current.cwd !== selectedCwd) {
      view.replaceChildren(el('p', 'Abrí una conversación para consultar los cambios de su directorio.'));
      footer.textContent = 'Sin sesión activa · no se consultó Git.';
      return;
    }
    const response = await fetch('/changes.json?sessionId=' + encodeURIComponent(current.id), { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const payload: unknown = await response.json();
    if (!valid(payload)) throw new Error('Respuesta inválida');
    if (serial !== version || main !== view) return;
    view.replaceChildren();
    if (payload.kind === 'error') throw new Error(payload.error || 'Consulta no disponible');
    if (payload.kind === 'not-git') {
      view.append(el('p', 'El directorio no es un repositorio Git.'));
      return;
    }
    view.append(el('p', 'Estado actual de Git: ' + (payload.root || selectedCwd)));
    view.append(el('p', testStatus()));
    if (!payload.entries.length) view.append(el('p', 'Git no informa cambios locales.'));
    for (const item of payload.entries.slice(0, 60)) {
      if (!item || typeof item.path !== 'string' || typeof item.diff !== 'string'
        || typeof item.staged !== 'string' || typeof item.worktree !== 'string') continue;
      const row = el('details');
      row.append(el('summary', `${item.staged}${item.worktree} · ${item.path}`));
      if (item.worktree === '?') row.append(el('p', 'Sin seguimiento · +? / −? (no se lee el contenido).'));
      else {
        if (item.staged !== ' ') row.append(el('p', 'Staged: ' + counts(item.stagedAdded, item.stagedRemoved)));
        if (item.worktree !== ' ') row.append(el('p', 'Sin stage: ' + counts(item.worktreeAdded, item.worktreeRemoved)));
      }
      row.append(el('pre', item.diff || (item.worktree === '?' ? 'Archivo no rastreado; no se muestra contenido.' : 'Diff no disponible o sin contenido textual.')));
      if (item.truncated) row.append(el('p', 'Diff recortado.'));
      view.append(row);
    }
    footer.textContent = `${payload.entries.length} entradas${payload.truncated ? ' · resultado recortado' : ''} · cambios locales, autor desconocido`;
  } catch (error) {
    if (serial !== version || main !== view) return;
    view.replaceChildren(el('p', 'Panel no disponible: ' + (error instanceof Error ? error.message : String(error))));
    footer.textContent = 'Sin backend validado no hay datos de Git. Nunca inferir ausencia de cambios.';
  }
}
function close(): void {
  serial++;
  shade?.remove(); shade = null; main = null; note = null;
}
async function open(cwd: string): Promise<void> {
  selectedCwd = typeof cwd === 'string' ? cwd.trim() : '';
  if (!shade) {
    if (!document.getElementById('aegis-changes-style')) {
      const style = el('style', STYLE); style.id = 'aegis-changes-style'; document.head.append(style);
    }
    shade = el('div'); shade.className = 'aegis-changes-shade';
    const dialog = el('div'); dialog.className = 'aegis-changes';
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Cambios Git en solo lectura');
    const header = el('header'); header.append(el('h2', 'Cambios Git'));
    const reload = el('button', 'Recargar'); reload.type = 'button'; reload.addEventListener('click', () => void refresh());
    const dismiss = el('button', 'Cerrar'); dismiss.type = 'button'; dismiss.addEventListener('click', close);
    header.append(reload, dismiss);
    main = el('main'); note = el('div'); note.className = 'note';
    dialog.append(header, main, note); shade.append(dialog); document.body.append(shade);
    shade.addEventListener('click', event => { if (event.target === shade) close(); });
    dismiss.focus();
  }
  await refresh();
}
document.addEventListener('keydown', event => { if (event.key === 'Escape' && shade) close(); });
window.__aegisChanges = { open, close, refresh };
export {};

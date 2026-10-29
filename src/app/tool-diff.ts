// Diff por archivo DENTRO de la tarjeta de la herramienta (estilo Codex/Claude): una fila por
// archivo, abierta por defecto si es corta, y actualizada en vivo mientras la herramienta corre.
// Los bloques ACP `diff` pertenecen al toolCallId; no se infiere autoría del estado de Git.
type DiffBlock = { type?: string; path?: unknown; oldText?: unknown; newText?: unknown };
type ToolEvent = { content?: DiffBlock[]; rawInput?: Record<string, unknown>; _meta?: { aegis?: { toolCall?: { toolName?: string } } } };
type ToolCard = HTMLElement & { __toolInput?: Record<string, unknown>; __diffKeys?: Set<string> };
type Detalle = HTMLElement & { open?: boolean };

const MAX_BYTES = 200_000;
const MAX_CORE = 360;
const MAX_VISIBLE = 240;
// Abierto solo si entra cómodo en pantalla: en el teléfono un diff de 200 líneas abierto esconde
// el resto del turno. Lo grande queda plegado y el usuario decide.
const MAX_ABIERTO = 24;
const splitLines = (text: string): string[] => text === '' ? [] : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
type Change = { kind: '+' | '-' | ' '; text: string };
export type DiffView = { lines: Change[]; added: number | null; removed: number | null; clipped: boolean };

export function formatToolDiff(oldText: string | undefined, newText: string): DiffView {
  if ((oldText?.length || 0) + newText.length > MAX_BYTES) return { lines: [], added: null, removed: null, clipped: true };
  const before = oldText === undefined ? [] : splitLines(oldText);
  const after = splitLines(newText);
  if (oldText === undefined) {
    const clipped = after.length > MAX_VISIBLE;
    return { lines: after.slice(0, MAX_VISIBLE).map(text => ({ kind: ' ', text })), added: null, removed: null, clipped };
  }
  let start = 0;
  while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++;
  let tail = 0;
  while (tail < before.length - start && tail < after.length - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const a = before.slice(start, before.length - tail), b = after.slice(start, after.length - tail);
  if (a.length + b.length > MAX_CORE) return { lines: [], added: null, removed: null, clipped: true };
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const changes: Change[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) changes.push({ kind: ' ', text: a[i++] }), j++;
    else if (i < a.length && (j === b.length || dp[i + 1][j] >= dp[i][j + 1])) changes.push({ kind: '-', text: a[i++] });
    else changes.push({ kind: '+', text: b[j++] });
  }
  const added = changes.filter(c => c.kind === '+').length, removed = changes.filter(c => c.kind === '-').length;
  if (!added && !removed) return { lines: [], added: 0, removed: 0, clipped: false };
  const visible: Change[] = [];
  if (start) visible.push({ kind: ' ', text: before[start - 1] });
  for (let k = 0; k < changes.length; k++) {
    if (changes[k].kind !== ' ' || changes.slice(Math.max(0, k - 2), k + 3).some(c => c.kind !== ' ')) visible.push(changes[k]);
    else if (visible.at(-1)?.text !== '…') visible.push({ kind: ' ', text: '…' });
  }
  if (tail) visible.push({ kind: ' ', text: before[before.length - tail] });
  return { lines: visible.slice(0, MAX_VISIBLE), added, removed, clipped: visible.length > MAX_VISIBLE };
}

const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const pathLabel = (value: unknown): string => typeof value === 'string' && value.trim() ? value.trim() : 'Archivo sin ruta';

// El estado (en curso / listo) es independiente de quien describió el diff: se marca aparte para que
// el chip desaparezca al completar aunque la fila la haya pintado el bloque ACP.
function marcarEstado(row: Detalle, vivo: boolean): void {
  row.dataset.vivo = vivo ? '1' : '0';
  const summary = row.querySelector('summary');
  if (!summary) return;
  const chip = summary.querySelector('.tool-diff-live');
  if (vivo && !chip) {
    const c = document.createElement('span'); c.className = 'tool-diff-live'; c.textContent = 'en curso';
    summary.insertBefore(c, summary.querySelector('.tool-diff-count'));
  }
  if (!vivo && chip) chip.remove();
}

function contar(view: DiffView, requested: boolean): string {
  if (requested) return 'archivo nuevo';
  if (view.added === null) return 'sin cambio visible';
  if (!view.added && !view.removed) return 'sin cambios';
  return `+${view.added} −${view.removed}`;
}

// El resumen del archivo: ruta, delta y (si aplica) el aviso de que el par no es el archivo entero.
// El texto largo de limitaciones vive en el title: el cuerpo es el diff, no una disculpa.
function llenarFila(row: Detalle, path: string, oldText: string | undefined, newText: string, requested: boolean, vivo: boolean, fuente: 'acp' | 'input'): void {
  const view = formatToolDiff(oldText, newText);
  row.dataset.path = path;
  // El par del ACP es el exacto: si ya lo tenemos, el rawInput de la herramienta no lo pisa.
  row.dataset.fuente = fuente;
  row.dataset.vivo = vivo ? '1' : '0';
  const summary = row.querySelector('summary') || row.appendChild(document.createElement('summary'));
  summary.replaceChildren();
  const label = document.createElement('span'); label.className = 'tool-diff-path'; label.textContent = path;
  const count = document.createElement('span'); count.className = 'tool-diff-count'; count.textContent = contar(view, requested);
  summary.append(label, count);
  const previo = row.querySelector('pre.tool-diff-code');
  if (previo) previo.remove();
  if (view.lines.length) {
    const code = document.createElement('pre'); code.className = 'tool-diff-code';
    for (const change of view.lines) {
      const span = document.createElement('span'); span.className = change.kind === '+' ? 'add' : change.kind === '-' ? 'del' : 'context';
      span.textContent = change.kind + change.text; code.append(span, '\n');
    }
    row.append(code);
  }
  if (view.clipped) { const note = document.createElement('p'); note.className = 'tool-diff-note'; note.textContent = 'Vista recortada.'; row.append(note); }
  row.title = requested
    ? 'Archivo nuevo: no hay versión anterior.'
    : oldText === undefined
      ? 'La herramienta no informó la versión anterior; se muestra el contenido enviado.'
      : 'Par antes/después de la edición. No es el diff completo del archivo ni su estado actual en Git.';
  row.open = Math.min(view.lines.length || 1, MAX_VISIBLE) <= MAX_ABIERTO;
  marcarEstado(row, vivo);
}

// Una fila por archivo: si llega otro update del mismo path, se reemplaza el contenido de ESA fila
// (conservando lo que el usuario abrió o cerró a mano) en vez de apilar filas del mismo archivo.
function filaPara(list: HTMLElement, path: string): Detalle {
  const existente = [...list.querySelectorAll<Detalle>('.tool-diff')].find((row) => row.dataset.path === path);
  if (existente) return existente;
  const row = document.createElement('details') as Detalle;
  row.className = 'tool-diff';
  list.append(row);
  return row;
}

export function renderInlineToolDiff(card: ToolCard, update: ToolEvent, status: string): void {
  const body = card.querySelector<HTMLElement>('.tool-body');
  if (!body) return;
  if (update.rawInput && typeof update.rawInput === 'object') card.__toolInput = update.rawInput;
  const name = update._meta?.aegis?.toolCall?.toolName;
  if (name) card.dataset.toolName = name;
  let list = body.querySelector<HTMLElement>('.tool-diffs');
  const asegurarLista = (): HTMLElement => {
    if (!list) { list = document.createElement('div'); list.className = 'tool-diffs'; body.append(list); }
    return list;
  };
  const vivo = status !== 'completed' && status !== 'failed';
  // 1) Bloques ACP diff (el camino con el par exacto): valen en cualquier estado, también en curso.
  const blocks = Array.isArray(update.content) ? update.content.filter(b => b?.type === 'diff' && typeof b.newText === 'string') : [];
  if (blocks.length) {
    const contenedor = asegurarLista();
    for (const block of blocks.slice(0, 12)) {
      const path = pathLabel(block.path), oldText = text(block.oldText), newText = block.newText as string;
      const key = JSON.stringify([path, oldText, newText, vivo]);
      card.__diffKeys ||= new Set();
      const fila = filaPara(contenedor, path);
      if (card.__diffKeys.has(key)) { marcarEstado(fila, vivo); continue; }
      card.__diffKeys.add(key);
      llenarFila(fila, path, oldText, newText, oldText === undefined, vivo, 'acp');
    }
    return;
  }
  // 2) developer__edit / developer__write: el par before/after del rawInput identifica la
  // sustitución pedida. Se muestra YA (mientras la herramienta corre) y se repinta al terminar.
  // Si la herramienta falla, el par se retira: mostrar "antes/después" de un cambio que no se
  // aplicó es una mentira visual.
  const toolName = name || card.dataset.toolName || '';
  if (!/(?:^|__)(?:edit|write)$/.test(toolName)) return;
  const args = update.rawInput || card.__toolInput;
  if (!args || typeof args.path !== 'string') return;
  if (status === 'failed') {
    for (const fila of [...(list?.querySelectorAll<Detalle>('.tool-diff') || [])]) {
      if (fila.dataset.fuente === 'input') fila.remove();
    }
    return;
  }
  const before = text(args.before), after = text(args.after) ?? text(args.content);
  if (after === undefined || (before === undefined && !/(?:^|__)write$/.test(toolName))) return;
  const fila = filaPara(asegurarLista(), args.path);
  if (fila.dataset.fuente === 'acp') { marcarEstado(fila, vivo); return; } // el ACP ya describió este archivo mejor que el rawInput
  llenarFila(fila, pathLabel(args.path), before, after, before === undefined, vivo, 'input');
}

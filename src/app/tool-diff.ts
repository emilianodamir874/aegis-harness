// Los bloques ACP diff pertenecen al toolCallId; no se infiere autoría del estado de Git.
type DiffBlock = { type?: string; path?: unknown; oldText?: unknown; newText?: unknown };
type ToolEvent = { content?: DiffBlock[]; rawInput?: Record<string, unknown>; _meta?: { aegis?: { toolCall?: { toolName?: string } } } };
type ToolCard = HTMLElement & { __toolInput?: Record<string, unknown>; __diffKeys?: Set<string> };

const MAX_BYTES = 200_000;
const MAX_CORE = 360;
const MAX_VISIBLE = 240;
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

function diffRow(path: string, oldText: string | undefined, newText: string, requested: boolean): HTMLElement {
  const view = formatToolDiff(oldText, newText);
  const row = document.createElement('details'); row.className = 'tool-diff' + (requested ? ' tool-diff-request' : '');
  const summary = document.createElement('summary');
  const label = document.createElement('span'); label.className = 'tool-diff-path'; label.textContent = path;
  const count = document.createElement('span'); count.className = 'tool-diff-count';
  count.textContent = requested ? 'solicitud' : view.added === null ? (oldText === undefined ? 'contenido' : 'vista recortada') : `+${view.added} −${view.removed}`;
  summary.append(label, count); row.append(summary);
  const note = document.createElement('p'); note.className = 'tool-diff-note';
  note.textContent = requested
    ? oldText === undefined ? 'Contenido enviado; la versión anterior no se conoce.' : 'Sustitución solicitada; el archivo completo puede diferir.'
    : oldText === undefined ? 'La herramienta no informó la versión anterior; no se puede calcular el cambio.' : 'Cambio de esta herramienta; no representa el estado actual de Git.';
  row.append(note);
  if (view.lines.length) {
    const code = document.createElement('pre'); code.className = 'tool-diff-code';
    for (const change of view.lines) {
      const span = document.createElement('span'); span.className = change.kind === '+' ? 'add' : change.kind === '-' ? 'del' : 'context';
      span.textContent = change.kind + change.text; code.append(span, '\n');
    }
    row.append(code);
  }
  if (view.clipped) {
    const note = document.createElement('p'); note.className = 'tool-diff-note'; note.textContent = 'Vista recortada; el contenido completo no se muestra aquí.'; row.append(note);
  }
  return row;
}

export function renderInlineToolDiff(card: ToolCard, update: ToolEvent, status: string): void {
  const body = card.querySelector<HTMLElement>('.tool-body');
  if (!body) return;
  if (update.rawInput && typeof update.rawInput === 'object') card.__toolInput = update.rawInput;
  const name = update._meta?.aegis?.toolCall?.toolName;
  if (name) card.dataset.toolName = name;
  const blocks = Array.isArray(update.content) ? update.content.filter(b => b?.type === 'diff' && typeof b.newText === 'string') : [];
  if (blocks.length) {
    let list = body.querySelector<HTMLElement>('.tool-diffs');
    if (!list) { list = document.createElement('div'); list.className = 'tool-diffs'; body.append(list); }
    for (const block of blocks.slice(0, 12)) {
      const path = pathLabel(block.path), oldText = text(block.oldText), newText = block.newText as string;
      const key = JSON.stringify([path, oldText, newText]);
      card.__diffKeys ||= new Set();
      if (card.__diffKeys.has(key)) continue;
      card.__diffKeys.add(key);
      list.querySelector('.tool-diff-request')?.remove();
      list.append(diffRow(path, oldText, newText, false));
    }
    return;
  }
  // El replay sólo persiste respuesta de texto de algunas herramientas ACP; no simular un
  // diff del archivo. Mostrar la solicitud explícita de edición con etiqueta inequívoca.
  if (status !== 'completed' || body.querySelector('.tool-diffs')) return;
  const toolName = name || card.dataset.toolName || '';
  if (!/(?:^|__)(?:edit|write)$/.test(toolName)) return;
  const args = update.rawInput || card.__toolInput;
  if (!args || typeof args.path !== 'string') return;
  const before = text(args.before), after = text(args.after) ?? text(args.content);
  if (after === undefined || (before === undefined && !/(?:^|__)write$/.test(toolName))) return;
  const list = document.createElement('div'); list.className = 'tool-diffs';
  list.append(diffRow(pathLabel(args.path), before, after, true)); body.append(list);
}

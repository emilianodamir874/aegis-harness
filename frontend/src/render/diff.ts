// Diff de una edición de herramienta. Portado de src/app/tool-diff.ts con la misma mecánica:
// recorte por tamaño, LCS con ventana de contexto y límite de líneas visibles.
// Los bloques ACP diff pertenecen al toolCallId; no se infiere autoría del estado de Git.

const MAX_BYTES = 200_000;
const MAX_CORE = 360;
const MAX_VISIBLE = 240;

export type ChangeKind = '+' | '-' | ' ';

export interface Change {
  readonly kind: ChangeKind;
  readonly text: string;
}

export interface DiffView {
  readonly lines: readonly Change[];
  readonly added: number | null;
  readonly removed: number | null;
  readonly clipped: boolean;
}

const splitLines = (text: string): string[] =>
  text === '' ? [] : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');

export function formatToolDiff(oldText: string | undefined, newText: string): DiffView {
  if ((oldText?.length || 0) + newText.length > MAX_BYTES) {
    return { lines: [], added: null, removed: null, clipped: true };
  }
  const before = oldText === undefined ? [] : splitLines(oldText);
  const after = splitLines(newText);
  if (oldText === undefined) {
    const clipped = after.length > MAX_VISIBLE;
    return { lines: after.slice(0, MAX_VISIBLE).map((text) => ({ kind: ' ', text })), added: null, removed: null, clipped };
  }
  let start = 0;
  while (start < Math.min(before.length, after.length) && before[start] === after[start]) start += 1;
  let tail = 0;
  while (
    tail < before.length - start &&
    tail < after.length - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }
  const a = before.slice(start, before.length - tail);
  const b = after.slice(start, after.length - tail);
  if (a.length + b.length > MAX_CORE) return { lines: [], added: null, removed: null, clipped: true };

  const dp: Uint16Array[] = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const row = dp[i];
    const nextRow = dp[i + 1];
    if (!row || !nextRow) continue;
    for (let j = b.length - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? (nextRow[j + 1] ?? 0) + 1 : Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const changes: Change[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const row = dp[i];
    if (i < a.length && j < b.length && a[i] === b[j]) {
      changes.push({ kind: ' ', text: a[i] ?? '' });
      i += 1;
      j += 1;
    } else if (i < a.length && (j === b.length || (row?.[j + 1] ?? 0) >= (row?.[j] ?? 0))) {
      changes.push({ kind: '-', text: a[i] ?? '' });
      i += 1;
    } else {
      changes.push({ kind: '+', text: b[j] ?? '' });
      j += 1;
    }
  }
  const added = changes.filter((change) => change.kind === '+').length;
  const removed = changes.filter((change) => change.kind === '-').length;
  if (!added && !removed) return { lines: [], added: 0, removed: 0, clipped: false };

  const visible: Change[] = [];
  if (start) visible.push({ kind: ' ', text: before[start - 1] ?? '' });
  for (let k = 0; k < changes.length; k += 1) {
    const change = changes[k];
    if (!change) continue;
    const window = changes.slice(Math.max(0, k - 2), k + 3);
    if (change.kind !== ' ' || window.some((c) => c.kind !== ' ')) visible.push(change);
    else if (visible.at(-1)?.text !== '…') visible.push({ kind: ' ', text: '…' });
  }
  if (tail) visible.push({ kind: ' ', text: before[before.length - tail] ?? '' });
  return {
    lines: visible.slice(0, MAX_VISIBLE),
    added,
    removed,
    clipped: visible.length > MAX_VISIBLE,
  };
}

/** Texto de la cabecera de un diff: conteo, contenido nuevo o vista recortada. */
export const diffSummary = (view: DiffView, requested: boolean): string => {
  if (requested) return 'solicitud';
  if (view.added === null) return view.clipped ? 'vista recortada' : 'contenido';
  return `+${view.added} −${view.removed}`;
};

export const diffNote = (requested: boolean, hasBefore: boolean): string => {
  if (requested) return 'Contenido enviado; la versión anterior no se conoce.';
  if (!hasBefore) return 'La herramienta no informó la versión anterior; no se puede calcular el cambio.';
  return 'Edición completada; este par muestra el fragmento sustituido, no el diff ni el estado actual del archivo.';
};

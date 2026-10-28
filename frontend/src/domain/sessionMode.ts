/* Modo de sesiÃ³n: plan / revisar / ejecutar.
 *
 * Mismo mecanismo que el cliente actual (`web/src/session-mode.ts`): se fija con
 * `_aegis/unstable/tools/permissions/set`, que es el mismo RPC que usa el modo debate. No dibuja
 * nada por sÃ­ solo; el store lo aplica cuando el operador lo elige (paleta o barra del composer).
 *
 * - plan: las tools de escritura quedan en `never_allow`; el motor no se las manda al modelo.
 * - revisar: quedan en `ask_before`; cada escritura pide permiso y la tarjeta muestra el diff.
 * - ejecutar: se borran los overrides y manda `permission.yaml`.
 *
 * La preferencia es del operador, no del proceso: vive en localStorage y se aplica al elegirla.
 */

export type PermissionMode = 'plan' | 'revisar' | 'ejecutar';

export interface ToolPermissionEntry {
  readonly toolName: string;
  readonly permission: string;
}

export const PERMISSION_MODES: readonly PermissionMode[] = ['plan', 'ejecutar', 'revisar'];
export const PERMISSION_MODE_STORAGE_KEY = 'aegis.sessionMode';

export const PERMISSION_MODE_HINT: Record<PermissionMode, string> = {
  plan: 'Plan: no puede escribir. Las tools de escritura no se le mandan al modelo.',
  ejecutar: 'Ejecutar: permission.yaml manda, como siempre.',
  revisar: 'Revisar: cada escritura pide permiso y muestra el diff.',
};

const WRITE_TOOLS = ['shell', 'edit', 'write'];
const READ_ONLY_TOOLS = [
  'read_file',
  'grep',
  'tree',
  'read_image',
  'websearch__web_fetch',
  'websearch__web_search',
  'load_skill',
  'load',
  'chatrecall__chatrecall',
  'extensionmanager__search_available_extensions',
];

export const isPermissionMode = (value: unknown): value is PermissionMode =>
  value === 'plan' || value === 'revisar' || value === 'ejecutar';

/** Entradas de `tools/permissions/set` para un modo. `ejecutar` devuelve la lista vacÃ­a. */
export function entriesForMode(mode: PermissionMode): readonly ToolPermissionEntry[] {
  if (mode === 'ejecutar') return [];
  const permission = mode === 'plan' ? 'never_allow' : 'ask_before';
  return [
    ...WRITE_TOOLS.map((toolName) => ({ toolName, permission })),
    ...READ_ONLY_TOOLS.map((toolName) => ({ toolName, permission: 'always_allow' })),
  ];
}

export function readStoredMode(storage?: Pick<Storage, 'getItem'> | null): PermissionMode {
  try {
    const raw = storage?.getItem(PERMISSION_MODE_STORAGE_KEY);
    if (isPermissionMode(raw)) return raw;
  } catch {
    /* sin storage: ejecutar */
  }
  return 'ejecutar';
}

export function writeStoredMode(mode: PermissionMode, storage?: Pick<Storage, 'setItem'> | null): void {
  try {
    storage?.setItem(PERMISSION_MODE_STORAGE_KEY, mode);
  } catch {
    /* sin storage, el modo vive solo en esta pestaÃ±a */
  }
}

/** Siguiente modo en el ciclo plan â†’ ejecutar â†’ revisar. */
export function nextMode(mode: PermissionMode): PermissionMode {
  return PERMISSION_MODES[(PERMISSION_MODES.indexOf(mode) + 1) % PERMISSION_MODES.length] ?? 'ejecutar';
}

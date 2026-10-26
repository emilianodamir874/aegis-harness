/* Modos de sesion: plan / ejecutar / revisar (M5).
 *
 * Por que existe: hoy todo turno puede escribir. El mecanismo para frenarlo ya estaba en el server
 * (`_aegis/unstable/tools/permissions/set` con `sessionId`, el mismo que usa el modo debate), pero no
 * habia forma de elegirlo desde la UI. Este modulo le pone un chip de tres estados al composer.
 *
 * - plan: las tools de escritura quedan en `never_allow` para la sesion. Con el filtro del motor, el
 *   modelo no las ve en el set: no intenta escribir y se come un rechazo.
 * - revisar: las tools de escritura quedan en `ask_before`; cada una pide permiso y la tarjeta
 *   muestra el diff antes de aplicar.
 * - ejecutar: se borran los overrides de la sesion y manda `permission.yaml`, como siempre.
 *
 * El modo vive en localStorage porque es una preferencia del operador, no del proceso; se reaplica
 * al cambiar de sesion.
 */

interface ModeRpc {
  request<T = void>(method: string, params: Record<string, unknown>): Promise<T>;
}

declare global {
  interface Window {
    __aegisWeb?: { rpc?: ModeRpc; state?: { current?: { id?: string } } };
    __aegisSessionMode?: { apply: () => Promise<void>; current: () => string; set: (mode: Mode) => Promise<void> };
  }
}

type Mode = 'plan' | 'ejecutar' | 'revisar';

const STORAGE_KEY = 'aegis.sessionMode';
const ORDER: Mode[] = ['plan', 'ejecutar', 'revisar'];

const LABEL: Record<Mode, string> = {
  plan: 'plan',
  ejecutar: 'ejecutar',
  revisar: 'revisar',
};

const HINT: Record<Mode, string> = {
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

const CSS = `
.aegis-mode{margin-left:8px;padding:1px 8px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.05);color:inherit;font:11.5px/1.7 system-ui,Segoe UI,sans-serif;cursor:pointer;text-transform:lowercase;letter-spacing:.2px}
.aegis-mode:hover{background:rgba(255,255,255,.12)}
.aegis-mode[data-mode=plan]{border-color:rgba(147,162,184,.5);color:#c8d3e2}
.aegis-mode[data-mode=revisar]{border-color:rgba(251,191,36,.55);color:#fbbf24}
.aegis-mode[data-mode=ejecutar]{border-color:rgba(74,222,128,.45);color:#4ade80}
`;

let chip: HTMLButtonElement | null = null;
let appliedFor = '';

function readMode(): Mode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'plan' || raw === 'ejecutar' || raw === 'revisar') return raw;
  } catch {
    /* sin storage: ejecutar */
  }
  return 'ejecutar';
}

function writeMode(mode: Mode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* sin storage, el modo vive solo en esta pestana */
  }
}

function entriesFor(mode: Mode): Array<{ toolName: string; permission: string }> {
  if (mode === 'ejecutar') return [];
  const permission = mode === 'plan' ? 'never_allow' : 'ask_before';
  return WRITE_TOOLS.map((toolName) => ({ toolName, permission })).concat(
    READ_ONLY_TOOLS.map((toolName) => ({ toolName, permission: 'always_allow' })),
  );
}

function sessionId(): string {
  const state = window.__aegisWeb?.state as { current?: { id?: string } } | undefined;
  return (state?.current?.id as string) || '';
}

async function apply(): Promise<void> {
  const rpc = window.__aegisWeb?.rpc;
  const sid = sessionId();
  if (!rpc || !sid) return;
  const mode = readMode();
  try {
    await rpc.request('_aegis/unstable/tools/permissions/set', {
      toolPermissions: entriesFor(mode),
      sessionId: sid,
    });
    appliedFor = `${sid}:${mode}`;
    if (chip) chip.title = `${HINT[mode]} Click para cambiar (plan → ejecutar → revisar).`;
  } catch (error) {
    if (chip) chip.title = `No pude aplicar el modo ${mode}: ${String((error as Error).message || error)}`;
  }
}

function ensureChip(): HTMLButtonElement | null {
  if (chip && document.body.contains(chip)) return chip;
  const meta = document.querySelector('.composer-meta');
  if (!meta) return null;
  if (!document.getElementById('aegis-mode-style')) {
    const style = document.createElement('style');
    style.id = 'aegis-mode-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'aegis-mode';
  chip.addEventListener('click', () => {
    const next = ORDER[(ORDER.indexOf(readMode()) + 1) % ORDER.length];
    void set(next);
  });
  meta.appendChild(chip);
  return chip;
}

function renderChip(): void {
  const el = ensureChip();
  if (!el) return;
  const mode = readMode();
  el.textContent = LABEL[mode];
  el.dataset.mode = mode;
  el.title = `${HINT[mode]} Click para cambiar (plan → ejecutar → revisar).`;
  el.setAttribute('aria-label', `Modo de sesion: ${mode}. ${HINT[mode]}`);
}

async function set(mode: Mode): Promise<void> {
  writeMode(mode);
  renderChip();
  await apply();
}

function tick(): void {
  renderChip();
  const sid = sessionId();
  if (sid && appliedFor !== `${sid}:${readMode()}`) void apply();
}

// Un turno nuevo o un cambio de sesion puede reemplazar el agente: se reaplica.
document.addEventListener('aegis:session-changed', () => {
  appliedFor = '';
  void apply();
});
setInterval(tick, 1500);
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', tick);
} else {
  tick();
}

window.__aegisSessionMode = { apply, current: readMode, set };

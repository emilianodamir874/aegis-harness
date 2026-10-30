export type Modo = 'plan' | 'revisar' | 'ejecutar';

const MODOS: readonly Modo[] = ['plan', 'revisar', 'ejecutar'];
const TOOLS_ESCRITURA: readonly string[] = ['shell', 'edit', 'write'];
const TOOLS_LECTURA: readonly string[] = [
  'read_file', 'grep', 'tree', 'read_image', 'web_search', 'web_fetch', 'load_skill', 'load', 'chatrecall',
  'search_available_extensions',
];
const TIPOS_GENERICOS = new Set(['', 'tool', 'running', 'unknown', 'herramienta']);

export interface Cinta {
  texto: string;
  promesa: string;
}

export const CINTAS: Record<Modo, Cinta> = {
  plan: {
    texto: 'plan · no escribe · pedí revisar para ejecutar',
    promesa: 'no puede tocar el disco',
  },
  revisar: {
    texto: 'revisar · cada escritura espera tu sí',
    promesa: 'escribe cuando aprobás el diff',
  },
  ejecutar: {
    texto: 'ejecutar · permission.yaml manda',
    promesa: 'escribe sin preguntar',
  },
};

export interface ToolDeLista {
  name?: string;
  permission?: string | null;
}

export interface ToolUpdate {
  kind?: unknown;
  rawInput?: Record<string, unknown> | null;
  _meta?: { aegis?: { toolCall?: { toolName?: unknown } } };
}

export function esModo(valor: unknown): valor is Modo {
  return typeof valor === 'string' && (MODOS as readonly string[]).includes(valor);
}

function nombreCorto(nombre: unknown): string {
  const partes = String(nombre || '').split('__');
  return partes[partes.length - 1] || '';
}

function esNombreConocido(nombre: string): boolean {
  return nombre.split('__').some((parte) => TOOLS_ESCRITURA.includes(parte) || TOOLS_LECTURA.includes(parte));
}

export function esToolDeEscritura(nombre: string): boolean {
  const partes = String(nombre || '').split('__');
  const corto = partes[partes.length - 1] || '';
  return TOOLS_ESCRITURA.includes(corto) && partes.every((parte) => !TOOLS_LECTURA.includes(parte));
}

function permisoDeEscritura(tools: ToolDeLista[] | undefined | null): Map<string, string | null> {
  const permisos = new Map<string, string | null>();
  for (const tool of tools || []) {
    if (!tool?.name || !esToolDeEscritura(tool.name)) continue;
    const corto = nombreCorto(tool.name);
    if (tool.permission != null && !['always_allow', 'ask_before', 'never_allow'].includes(tool.permission)) continue;
    const permiso = tool.permission ?? null;
    const previo = permisos.get(corto);
    if (previo === 'never_allow' || permiso === 'never_allow') permisos.set(corto, 'never_allow');
    else if (previo === 'ask_before' || permiso === 'ask_before') permisos.set(corto, 'ask_before');
    else permisos.set(corto, permiso);
  }
  return permisos;
}

export function modoDesdeHerramientas(tools: ToolDeLista[] | undefined | null): Modo | null {
  if (!Array.isArray(tools)) return null;
  const permisos = permisoDeEscritura(tools);
  if (!TOOLS_ESCRITURA.every((nombre) => permisos.has(nombre))) return null;
  const niveles = TOOLS_ESCRITURA.map((nombre) => permisos.get(nombre));
  if (niveles.some((permiso) => permiso === 'never_allow')) return 'plan';
  if (niveles.some((permiso) => permiso === 'ask_before')) return 'revisar';
  return 'ejecutar';
}

/** Prioriza el nombre ACP; `kind` puede ser un estado genérico como "running". */
export function nombreToolDeUpdate(update: ToolUpdate | null | undefined): string {
  if (!update) return '';
  const metadata = update._meta?.aegis?.toolCall?.toolName;
  if (typeof metadata === 'string' && metadata.trim()) {
    const nombre = metadata.trim();
    return esNombreConocido(nombre) ? nombre : '';
  }

  const kind = String(update.kind || '').trim();
  if (!TIPOS_GENERICOS.has(kind.toLowerCase())) {
    const nombre = kind.split(/[ /]/)[0];
    return esNombreConocido(nombre) ? nombre : '';
  }

  const input = update.rawInput || {};
  if (input.command != null) return 'shell';
  if (input.old_string != null || input.new_string != null || input.oldText != null || input.newText != null) return 'edit';
  if (input.content != null && (input.path != null || input.file_path != null)) return 'write';
  return '';
}

export function cortaElStream(modo: Modo, nombreTool: string, status: string): boolean {
  return modo === 'revisar'
    && (status === 'pending' || status === 'in_progress')
    && esToolDeEscritura(nombreTool);
}

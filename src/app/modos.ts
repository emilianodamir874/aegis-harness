// Modos de sesión vistos desde la UI: `plan` no escribe, `revisar` pide permiso por escritura y
// `ejecutar` manda permission.yaml. El motor no manda el modo en `session/load` (AegisMode quedó
// en autonomía permanente), así que se deriva del permiso del override de sesión sobre `write`,
// que es exactamente lo que aplica la extensión `mode` del crate aegis.
//
// Este archivo no toca el DOM: son las reglas y los textos, para poder probarlas en Node.

export type Modo = 'plan' | 'revisar' | 'ejecutar';

export const MODOS: Modo[] = ['plan', 'revisar', 'ejecutar'];

/** Las tres tools que la extensión `mode` considera escritura. */
export const TOOLS_ESCRITURA: string[] = ['shell', 'edit', 'write'];

/** Una tool de escritura con su nombre corto o con prefijo de extensión (`developer__write`). */
export function esToolDeEscritura(nombre: string): boolean {
  const corto = String(nombre || '').split('__').pop() || '';
  return TOOLS_ESCRITURA.includes(corto);
}

export function esModo(valor: unknown): valor is Modo {
  return typeof valor === 'string' && (MODOS as string[]).includes(valor);
}

export interface Cinta {
  /** Lo que dice la cinta fija al pie del último mensaje. */
  texto: string;
  /** Etiqueta corta para el chip de la cabecera. */
  chip: string;
  /** Qué promete el modo, en una línea. */
  promesa: string;
}

export const CINTAS: Record<Modo, Cinta> = {
  plan: {
    texto: 'plan · no escribe · pedí revisar para ejecutar',
    chip: 'Plan',
    promesa: 'no puede tocar el disco',
  },
  revisar: {
    texto: 'revisar · cada escritura espera tu sí',
    chip: 'Revisar',
    promesa: 'escribe cuando aprobás el diff',
  },
  ejecutar: {
    texto: 'ejecutar · permission.yaml manda',
    chip: 'Ejecutar',
    promesa: 'escribe sin preguntar',
  },
};

/** Herramienta tal como la devuelve `_aegis/unstable/tools/list`. */
export interface ToolDeLista {
  name?: string;
  permission?: string | null;
}

/**
 * Modo derivado de la lista de tools de la sesión.
 *
 * Gana el override más permisivo de las tres de escritura, porque es el que decide si el agente
 * puede tocar algo: si alguna quedó en `never_allow` el modo es plan, si alguna quedó en
 * `ask_before` es revisar, y sin overrides es ejecutar (permission.yaml).
 */
export function modoDesdeHerramientas(tools: ToolDeLista[] | undefined | null): Modo {
  const porNombre = new Map<string, string | null>();
  for (const t of tools || []) {
    if (!t || !t.name) continue;
    const corto = String(t.name).split('__').pop() || '';
    if (TOOLS_ESCRITURA.includes(corto)) porNombre.set(corto, t.permission ?? null);
  }
  const niveles = TOOLS_ESCRITURA.map((n) => porNombre.get(n));
  if (niveles.some((p) => p === 'never_allow')) return 'plan';
  if (niveles.some((p) => p === 'ask_before')) return 'revisar';
  return 'ejecutar';
}

/**
 * Parte el texto en párrafos cerrados y el que todavía se está escribiendo.
 *
 * En plan el mensaje se pinta como hoja: se muestran sólo los párrafos terminados (separados por
 * línea en blanco) y el que sigue abierto lleva la pluma. Así el bloque no se re-mide entero en
 * cada token y la lectura no salta.
 */
export function parrafosCerrados(texto: string): { cerrados: string; abierto: string } {
  const t = String(texto == null ? '' : texto);
  const i = t.lastIndexOf('\n\n');
  if (i < 0) return { cerrados: '', abierto: t };
  const cerrados = t.slice(0, i);
  const abierto = t.slice(i + 2);
  // Un cierre seguido sólo de espacios todavía no es un párrafo terminado.
  if (!abierto.trim()) return { cerrados, abierto: '' };
  return { cerrados, abierto };
}

/** ¿Este tool call es una escritura que en `revisar` tiene que cortar el stream? */
export function cortaElStream(modo: Modo, nombreTool: string, status: string): boolean {
  if (modo !== 'revisar') return false;
  if (status !== 'pending' && status !== 'in_progress') return false;
  return esToolDeEscritura(nombreTool);
}

/** Texto de la cita en línea que reemplaza a la tool card en `plan`. */
export function citaDeLectura(nombreTool: string, payload: Record<string, unknown> | undefined): string {
  const corto = String(nombreTool || '').split('__').pop() || 'herramienta';
  const p = payload || {};
  const valor = String(p.path || p.file_path || p.pattern || p.query || p.url || '');
  const verbo = corto === 'read_file' ? 'leyó'
    : corto === 'grep' || corto === 'search' ? 'buscó'
    : corto === 'tree' ? 'miró el árbol de'
    : corto === 'read_image' ? 'miró la imagen'
    : corto === 'load_skill' ? 'cargó la skill'
    : corto === 'load' ? 'cargó'
    : corto.startsWith('web') ? 'consultó la web'
    : 'usó ' + corto;
  return valor ? `${verbo} ${valor}` : verbo;
}

// Set de iconos de la web.
//
// Dos familias, un mismo lenguaje: trazo de 1.5 sobre grilla de 16 con margen 2 (se leen a
// 13-15 px y no se empastan), `stroke="currentColor"` y sin relleno salvo los puntos.
//
//   TOOL_ICON  -> que herramienta es (se elige por el kind del protocolo o por el payload)
//   UI_ICON    -> cromo de la interfaz: estados, acciones, fases del turno
//
// El icono de una herramienta NUNCA se cambia por un spinner: el estado va como clase
// (`is-running`, `is-done`, `is-err`) y lo anima el CSS. Asi se lee que corre sin perder
// de vista que herramienta es.

export const TOOL_ICON: Record<string, string> = {
  // terminal: prompt con chevron y linea
  shell: '<path d="M3.4 5.2 6 7.8l-2.6 2.6"/><path d="M8.2 10.6h4.4"/>',
  // archivo con esquina doblada y renglon
  read: '<path d="M4 2.6h4.4L12 6.2v7.2H4z"/><path d="M8.4 2.6v3.6H12"/><path d="M5.8 9.6h4.4"/>',
  // lapiz
  write: '<path d="M3 13.4l.8-2.8 5.9-5.9 2 2-5.9 5.9z"/><path d="M9.3 5.1l2 2"/>',
  // imagen con sol y montanas
  image: '<rect x="2.6" y="3.4" width="10.8" height="9.2" rx="1.6"/><circle cx="5.6" cy="6.4" r="1"/><path d="M2.8 11.2 6 8.2l2 2 1.6-1.5 3.2 3.1"/>',
  // lupa
  search: '<circle cx="7.2" cy="7.2" r="3.6"/><path d="M10 10 13.4 13.4"/>',
  // globo terraqueo (web / url)
  glob: '<circle cx="8" cy="8" r="5.2"/><path d="M2.8 8h10.4"/><path d="M8 2.8c1.7 1.7 1.7 8.7 0 10.4"/><path d="M8 2.8c-1.7 1.7-1.7 8.7 0 10.4"/>',
  // llaves de codigo
  code: '<path d="M5.8 5.2 3.2 8l2.6 2.8"/><path d="M10.2 5.2 12.8 8l-2.6 2.8"/><path d="M9.2 3.6 6.8 12.4"/>',
  // x
  cross: '<path d="M4.6 4.6l6.8 6.8"/><path d="M11.4 4.6l-6.8 6.8"/>',
  // punto (fallback)
  dot: '<circle cx="8" cy="8" r="2.4"/>',
  // check (herramienta completada que no necesita tipo)
  check: '<path d="M3.6 8.4 6.6 11.4 12.4 4.8"/>',
  // editar / patchear: mismo lapiz pero con renglon, para no confundir con write
  edit: '<path d="M3 12.8h10"/><path d="M6.2 10.6 5.4 8l5.2-5.2 2 2L8 10z"/>',
  // borrar
  delete: '<path d="M3.4 4.8h9.2"/><path d="M6.4 4.8V3.4h3.2v1.4"/><path d="M4.8 4.8l.7 8.2h5l.7-8.2"/><path d="M6.9 7v3.8M9.1 7v3.8"/>',
  // memoria: cerebro simplificado en tres surcos
  memory: '<path d="M6.4 3.2a2.2 2.2 0 0 0-2.2 2.2 2 2 0 0 0-.6 3.6A2.2 2.2 0 0 0 6.4 12.8h1.2V3.2z"/><path d="M9.6 3.2v9.6h1.2a2.2 2.2 0 0 0 2.2-3.8 2 2 0 0 0-.6-3.6 2.2 2.2 0 0 0-2.8-2.2"/>',
  // skill: estrella de cuatro puntas
  skill: '<path d="M8 2.6l1.3 3.5 3.5 1.3-3.5 1.3L8 12.2l-1.3-3.5L3.2 7.4l3.5-1.3z"/>',
  // plan / tareas: lista con checks
  plan: '<path d="M5.6 4.4h7.6M5.6 8h7.6M5.6 11.6h7.6"/><path d="M3 4.4h.01M3 8h.01M3 11.6h.01"/>',
  // red / fetch / mcp
  network: '<circle cx="8" cy="3.6" r="1.6"/><circle cx="4" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><path d="M7.2 5 4.8 10.6M8.8 5l2.4 5.6M5.6 12h4.8"/>',
  // git / diff
  git: '<circle cx="5" cy="4.2" r="1.6"/><circle cx="5" cy="11.8" r="1.6"/><path d="M5 5.8v4.4"/><path d="M11 8.4V6.4a2 2 0 0 0-2-2H6.6"/>',
  // descarga
  download: '<path d="M8 3v6.4"/><path d="M5.2 7l2.8 2.8L10.8 7"/><path d="M3.4 12.6h9.2"/>',
  // reloj / espera
  clock: '<circle cx="8" cy="8" r="5.2"/><path d="M8 5v3.2l2.2 1.4"/>',

  // ---- familia ampliada -------------------------------------------------------
  // navegador: ventana con barra de direcciones y tres puntos
  browser: '<rect x="2.4" y="3.4" width="11.2" height="9.2" rx="1.6"/><path d="M2.4 6.2h11.2"/><circle cx="4.4" cy="4.8" r=".55" fill="currentColor" stroke="none"/><circle cx="6.2" cy="4.8" r=".55" fill="currentColor" stroke="none"/><path d="M5 8.4h6"/>',
  // mcp / conector: dos piezas encastradas
  mcp: '<path d="M6.4 3v3.2M9.6 3v3.2"/><rect x="4.6" y="6.2" width="6.8" height="3.2" rx="1.2"/><path d="M8 9.4v3.6"/>',
  // http: flecha de ida y vuelta
  http: '<path d="M2.6 6.2h8.2"/><path d="M8.6 4.2 10.8 6.2 8.6 8.2"/><path d="M13.4 9.8H5.2"/><path d="M7.4 7.8 5.2 9.8l2.2 2"/>',
  // base de datos: tres discos
  db: '<ellipse cx="8" cy="4.2" rx="5" ry="1.8"/><path d="M3 4.2v7.6c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4.2"/><path d="M3 8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8"/>',
  // documento de texto
  doc: '<path d="M4 2.6h5L12 5.6v7.8H4z"/><path d="M9 2.6v3h3"/><path d="M5.8 8h4.4M5.8 10.4h3"/>',
  // tabla / hoja de calculo
  table: '<rect x="2.6" y="3.6" width="10.8" height="8.8" rx="1.2"/><path d="M2.6 6.6h10.8M6.6 6.6v5.8"/>',
  // voz / audio
  voice: '<rect x="6.2" y="2.6" width="3.6" height="6" rx="1.8"/><path d="M4.4 7.8v.4a3.6 3.6 0 0 0 7.2 0v-.4"/><path d="M8 11.8v1.6"/>',
  // permiso / candado
  lock: '<rect x="3.6" y="7.2" width="8.8" height="6.2" rx="1.6"/><path d="M5.8 7.2V5.6a2.2 2.2 0 0 1 4.4 0v1.6"/>',
  // compactar: dos flechas al centro
  compact: '<path d="M4 3.4v3.2M4 6.6h3.2"/><path d="M12 12.6v-3.2M12 9.4H8.8"/><path d="M4 6.6 8 10.4M12 9.4 8 5.6"/>',
  // capas / contexto
  layers: '<path d="M8 2.6 13.2 5.4 8 8.2 2.8 5.4z"/><path d="M2.8 8.4 8 11.2l5.2-2.8"/><path d="M2.8 11 8 13.8l5.2-2.8"/>',
  // chispa / generando
  spark: '<path d="M8 2.4v3.2M8 10.4v3.2M2.4 8h3.2M10.4 8h3.2"/><path d="M4.8 4.8l1.6 1.6M9.6 9.6l1.6 1.6M11.2 4.8 9.6 6.4M6.4 9.6 4.8 11.2"/>',
  // ojo (visible para el modelo)
  eye: '<path d="M1.8 8s2.3-3.8 6.2-3.8S14.2 8 14.2 8s-2.3 3.8-6.2 3.8S1.8 8 1.8 8Z"/><circle cx="8" cy="8" r="1.9"/>',
  // ojo tachado (el modelo no lo ve)
  eyeOff: '<path d="M2.6 3.2l10.8 9.6"/><path d="M6.4 4.6A7.3 7.3 0 0 1 8 4.4c3.9 0 6.2 3.6 6.2 3.6a10 10 0 0 1-2.4 2.6"/><path d="M4.4 5.9A10.4 10.4 0 0 0 1.8 8s2.3 3.6 6.2 3.6c.9 0 1.7-.2 2.4-.5"/>',
  // deshacer / reactivar contexto
  undo: '<path d="M3.2 7.4h6.2a3.2 3.2 0 0 1 0 6.4H6.4"/><path d="M5.6 4.6 3 7.4l2.6 2.6"/>',
  // chevron a la derecha (plegar/desplegar)
  chevron: '<path d="M6 4l4 4-4 4"/>',
  // pila de lineas: densidad / presentacion
  frame: '<path d="M2.8 3.6h10.4v8.8H2.8z"/><path d="M5 6.4h6M5 9h4"/>',
  // copiar
  copy: '<rect x="5.4" y="5.4" width="7" height="8" rx="1.4"/><path d="M10.6 5.4V4.2A1.2 1.2 0 0 0 9.4 3H4.4A1.2 1.2 0 0 0 3.2 4.2v6"/>',
  // regenerar
  refresh: '<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13.2 2.8v2.8h-2.8"/>',
};

// Palabras clave -> tipo. El orden importa: gana la primera que matchea.
// Las regex son deliberadamente anchas: el protocolo manda kinds genericos ("running",
// "tool", "call") y el icono tiene que salir del payload, no del nombre.
const RULES: Array<[RegExp, string]> = [
  [/shell|terminal|bash|powershell|exec|cmd|command|pty/, 'shell'],
  [/screenshot|image|vision|photo|ocr|canvas/, 'image'],
  [/grep|search|find|query|lookup|recall|glob|ls\b|list/, 'search'],
  [/memory|remember|fact/, 'memory'],
  [/skill/, 'skill'],
  [/todo|task|plan|schedul|goal|grind/, 'plan'],
  [/patch|edit|replace|apply|diff|hunk/, 'edit'],
  [/delete|remove|unlink|rm\b|trash/, 'delete'],
  [/write|create|save|touch|mkdir|append|upload/, 'write'],
  [/sql|database|query_db|table_/, 'db'],
  [/pdf|docx|document|markdown|report/, 'doc'],
  [/mcp|plugin|connector/, 'mcp'],
  [/http|request|api|rest/, 'http'],
  [/browser|puppeteer|playwright|navigate|click/, 'browser'],
  [/fetch|web|browse|url|curl/, 'glob'],
  [/git|commit|branch|checkout/, 'git'],
  [/download|export/, 'download'],
  [/audio|voice|speech|transcri|tts/, 'voice'],
  [/permission|approve|ask|consent/, 'lock'],
  [/compact|summar|context/, 'compact'],
  [/read|file|cat|open|tree|view|stat|head|tail/, 'read'],
  [/code|script|typescript|eval|run|test|lint|build/, 'code'],
];

/** Tipo de icono para un kind de herramienta (acepta nombres con -, _ o espacios). */
export function toolKindOf(kind: string): string {
  const raw = String(kind || '').toLowerCase();
  if (TOOL_ICON[raw]) return raw;
  const name = raw.replace(/[_-]/g, ' ').trim();
  for (const [re, icon] of RULES) if (re.test(name)) return icon;
  return 'dot';
}

export type ToolStatus = 'run' | 'ok' | 'err';

/** SVG del icono de herramienta. `status` decide el trazo (x para fallo) y la clase de animacion. */
export function toolIconSvg(kind: string, status?: ToolStatus | 'failed' | 'completed' | 'pending', extraClass = ''): string {
  const failed = status === 'failed' || status === 'err';
  const running = status === 'run' || status === 'pending';
  const resolved = failed ? 'cross' : toolKindOf(kind);
  const stateCls = failed ? ' is-err' : running ? ' is-running' : ' is-done';
  const cls = 'tico' + (extraClass ? ' ' + extraClass : '') + ' tico-' + resolved + stateCls;
  return '<svg class="' + cls + '" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" '
    + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + TOOL_ICON[resolved] + '</svg>';
}

/**
 * Icono de cromo: devuelve el markup para insertar con innerHTML.
 * Tamanio por defecto 14 px; el color sale de `currentColor`.
 */
export function uiIcon(name: string, opts?: { size?: number; cls?: string }): string {
  const path = TOOL_ICON[name] || TOOL_ICON.dot;
  const size = opts && opts.size ? opts.size : 14;
  const cls = 'ui-ico' + (opts && opts.cls ? ' ' + opts.cls : '') + ' ui-ico-' + name;
  return '<svg class="' + cls + '" viewBox="0 0 16 16" width="' + size + '" height="' + size + '" fill="none" '
    + 'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" '
    + 'aria-hidden="true" focusable="false">' + path + '</svg>';
}

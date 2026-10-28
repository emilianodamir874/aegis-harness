// Iconos de herramienta: se elige por nombre que manda el server, con fallback por
// palabras clave del nombre (o del payload cuando no hay kind).
// Trazos a 1.5 sobre una grilla de 16 con margen de 2: se leen a 14px y no se empastan.
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
};

// Palabras clave -> tipo. El orden importa: gana la primera que matchea.
const RULES: Array<[RegExp, string]> = [
  [/shell|terminal|bash|powershell|exec|cmd|command/, 'shell'],
  [/screenshot|image|vision|photo|ocr/, 'image'],
  [/grep|search|find|query|lookup|recall|glob|ls\b/, 'search'],
  [/memory|remember|recall_/, 'memory'],
  [/skill/, 'skill'],
  [/todo|task|plan|schedul/, 'plan'],
  [/patch|edit|replace|apply/, 'edit'],
  [/delete|remove|unlink|rm\b/, 'delete'],
  [/write|create|save|touch|mkdir|append/, 'write'],
  [/read|file|cat|open|tree|view|stat|head|tail/, 'read'],
  [/fetch|http|web|browse|url|curl|mcp|browser|network/, 'glob'],
  [/git|diff|commit|branch/, 'git'],
  [/download|upload|export/, 'download'],
  [/code|script|typescript|eval|run|test/, 'code'],
];

export function toolKindOf(kind: string): string {
  const raw = String(kind || '').toLowerCase();
  if (TOOL_ICON[raw]) return raw;
  const name = raw.replace(/[_-]/g, ' ').trim();
  for (const [re, icon] of RULES) if (re.test(name)) return icon;
  return 'dot';
}

export function toolIconSvg(kind: string, status?: string, extraClass = ''): string {
  const resolved = status === 'failed' ? 'cross' : toolKindOf(kind);
  const cls = 'tico' + (extraClass ? ' ' + extraClass : '') + ' tico-' + resolved;
  return '<svg class="' + cls + '" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" '
    + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + TOOL_ICON[resolved] + '</svg>';
}

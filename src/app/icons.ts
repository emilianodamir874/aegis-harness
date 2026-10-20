// Icono por tipo de herramienta: se elige por el nombre que manda el server.
export const TOOL_ICON: Record<string, string> = {
  shell: '<path d="M4.6 5.4 7.2 8l-2.6 2.6M9.4 11h3.2"/>',
  read: '<path d="M4 2.8h4.6L12 6.2v7H4z"/><path d="M8.4 2.8v3.4H12"/><path d="M6 9.6h4"/>',
  write: '<path d="M3 13.2l.9-2.9 6-6 2 2-6 6z"/><path d="M9.4 4.9l2 2"/>',
  image: '<rect x="2.6" y="3.4" width="10.8" height="9.2" rx="1.6"/><path d="M2.6 10.2 5.6 7.4l2.2 2.2 1.8-1.8 3 2.8"/>',
  search: '<circle cx="7.4" cy="7.4" r="3.8"/><path d="M10.2 10.2 13.4 13.4"/>',
  glob: '<circle cx="8" cy="8" r="5.2"/><path d="M2.8 8h10.4M8 2.8c1.6 1.6 1.6 8.8 0 10.4M8 2.8c-1.6 1.6-1.6 8.8 0 10.4"/>',
  code: '<path d="M5.6 5.4 3 8l2.6 2.6M10.4 5.4 13 8l-2.6 2.6"/>',
  cross: '<path d="M4.8 4.8l6.4 6.4M11.2 4.8l-6.4 6.4"/>',
  dot: '<circle cx="8" cy="8" r="2.6"/>',
};

export function toolIconSvg(kind: string, status?: string): string {
  if (status === 'failed') kind = 'cross';
  const name = String(kind || '').toLowerCase().replace(/[_-]/g, ' ').trim();
  if (!TOOL_ICON[kind]) {
    kind = /shell|terminal|bash|powershell|exec|cmd/.test(name) ? 'shell'
      : /image|screenshot|vision|photo/.test(name) ? 'image'
      : /search|grep|find|glob|recall/.test(name) ? 'search'
      : /write|edit|create|patch|save|apply/.test(name) ? 'write'
      : /read|file|cat|open|list|tree|view/.test(name) ? 'read'
      : /fetch|http|web|browse|url|curl/.test(name) ? 'glob'
      : /code|script|typescript|eval|run|test/.test(name) ? 'code'
      : 'dot';
  }
  return '<svg class="tico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + TOOL_ICON[kind] + '</svg>';
}

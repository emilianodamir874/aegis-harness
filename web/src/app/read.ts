// Lectura en voz alta: parseo del bloque "Para escuchar" y limpieza de markdown.
// Sin DOM ni estado: entran strings, salen strings (mas la URL del TTS local).

const TICK = String.fromCharCode(96); // comilla invertida (para armar los patrones de code fences)

export type Heading = { idx: number; len: number };

export function readHeading(t: unknown): Heading | null {
  const re = /^[ \t]*#{1,6}[ \t]*(?:[^\w\n]{0,4}[ \t]*)?(?:para[ \t]+(?:escuchar|leer|oir|oír)|lectura[ \t]+en[ \t]+voz)[^\n]*$/im;
  const m = re.exec(String(t || ''));
  return m ? { idx: m.index, len: m[0].length } : null;
}

// devuelve el texto crudo del bloque (sin el encabezado); termina en el proximo encabezado
export function readBlock(t: unknown): string {
  const h = readHeading(t);
  if (!h) return '';
  const rest = String(t).slice(h.idx + h.len);
  const end = rest.search(/^[ \t]*#{1,6}[ \t]/m);
  return (end >= 0 ? rest.slice(0, end) : rest).trim();
}

// pasa markdown a texto hablable
export function readClean(s: unknown): string {
  return String(s || '')
    .replace(new RegExp(TICK + TICK + TICK + '[\\s\\S]*?' + TICK + TICK + TICK, 'g'), ' ')  // bloques de codigo
    .replace(new RegExp(TICK + '([^' + TICK + ']*)' + TICK, 'g'), '$1')                      // codigo inline
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')                                                   // imagenes
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')                                                 // links -> texto
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '')                                         // vinetas
    .replace(/^[ \t]*>[ \t]?/gm, '')                                                          // citas
    .replace(/[#*_~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Motor del server (edge o Piper). `rate` > 1 = mas rapido (el server lo traduce a length_scale
// de Piper o al porcentaje de edge).
export function ttsUrlFor(voice: string, text: string, rate?: number): string {
  var r = (typeof rate === 'number' && rate > 0.5 && rate < 2) ? '&rate=' + rate.toFixed(3) : '';
  return '/tts?voice=' + encodeURIComponent(voice) + '&text=' + encodeURIComponent(text) + r;
}

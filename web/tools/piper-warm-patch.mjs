import { readFileSync, writeFileSync } from 'node:fs';
const p = 'C:/Aegis-Proyects/web/server.mjs';
let s = readFileSync(p, 'utf8');
const antes = s.length;
const NL = String.fromCharCode(13, 10);
const Q = String.fromCharCode(39);
const cortar = (ini, fin, nuevo, etiqueta) => {
  const i = s.indexOf(ini);
  if (i < 0) throw new Error('no encontre inicio: ' + etiqueta);
  const j = s.indexOf(fin, i + ini.length);
  if (j < 0) throw new Error('no encontre fin: ' + etiqueta);
  s = s.slice(0, i) + nuevo + s.slice(j + fin.length);
  console.log('  ok: ' + etiqueta);
};
const insertar = (ancla, nuevo, etiqueta) => {
  const i = s.indexOf(ancla);
  if (i < 0) throw new Error('no encontre ancla: ' + etiqueta);
  s = s.slice(0, i) + nuevo + s.slice(i);
  console.log('  ok: ' + etiqueta);
};
// 1) import del modulo del proceso vivo
const imp = 'import { piperVivo, piperDespertar } from ' + Q + './piper-vivo.mjs' + Q + ';' + NL;
insertar("const PIPER_EXE = ", imp, 'import');
// 2) piperTts pasa a ser el camino rapido y el cuerpo viejo queda como piperSuelto
const wrapper = [
  '// Camino rapido: el proceso vivo ya tiene el modelo cargado. Si falla, se arranca uno nuevo',
  '// (piperSuelto), que es como se hacia antes.',
  'async function piperTts(texto, voz, rate) {',
  '  const modelo = await vozPiperValida(voz);',
  '  const ritmo = Number(rate) > 0.5 && Number(rate) < 2 ? 1 / Number(rate) : 1;',
  '  const clave = modelo + ritmo.toFixed(3) + texto;',
  '  const guardado = _ttsCache.get(clave);',
  '  if (guardado) return guardado;',
  '  let audio;',
  '  try {',
  '    audio = await piperVivo(texto, modelo, ritmo);',
  '  } catch (e) {',
  '    audio = await piperSuelto(texto, modelo, ritmo);',
  '  }',
  '  if (_ttsCache.size >= TTS_CACHE_MAX) _ttsCache.delete(_ttsCache.keys().next().value);',
  '  _ttsCache.set(clave, audio);',
  '  return audio;',
  '}',
  'async function piperSuelto(texto, modelo, ritmo) {',
  '  const { spawn } = await import(' + Q + 'node:child_process' + Q + ');',
].join(NL);
cortar('async function piperTts(texto, voz, rate) {', 'const ritmo = Number(rate) > 0.5 && Number(rate) < 2 ? 1 / Number(rate) : 1;  // >1 = mas lento', wrapper, 'piperTts -> vivo + suelto');
// 3) despertar el proceso al arrancar (antes de definir el handler)
insertar('const handler = async (req, res) => {', 'piperDespertar().catch(() => {});' + NL + NL, 'despertar al arrancar');
writeFileSync(p, s);
console.log('  bytes: ' + antes + ' -> ' + s.length);
for (const t of ['piper-vivo.mjs', 'piperVivo', 'piperSuelto', 'piperDespertar', 'piperVivoListo']) {
  console.log('  ' + t + ' -> ' + (s.split(t).length - 1));
}

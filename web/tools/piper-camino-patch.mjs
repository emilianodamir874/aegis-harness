import { readFileSync, writeFileSync } from 'node:fs';
const p = 'C:/Aegis-Proyects/web/server.mjs';
let s = readFileSync(p, 'utf8');
const antes = s.length;
const NL = String.fromCharCode(13, 10);
const Q = String.fromCharCode(39);
const insertar = (ancla, nuevo, etiqueta) => { const i = s.indexOf(ancla); if (i < 0) throw new Error('no encontre: ' + etiqueta); s = s.slice(0, i) + nuevo + s.slice(i); console.log('  ok: ' + etiqueta); };
// marca de camino (vivo o suelto) para poder medir y diagnosticar
insertar('async function piperTts(texto, voz, rate) {', 'let _caminoTts = ' + Q + 'vivo' + Q + ';' + NL + NL, 'variable de camino');
s = s.replace('    audio = await piperVivo(texto, modelo, ritmo);', '    audio = await piperVivo(texto, modelo, ritmo);' + NL + '    _caminoTts = ' + Q + 'vivo' + Q + ';');
s = s.replace('    audio = await piperSuelto(texto, modelo, ritmo);', '    audio = await piperSuelto(texto, modelo, ritmo);' + NL + '    _caminoTts = ' + Q + 'suelto' + Q + ';');
insertar("          'x-aegis-tts-engine': 'piper',", "          'x-aegis-tts-path': _caminoTts," + NL, 'cabecera de camino');
writeFileSync(p, s);
console.log('  bytes: ' + antes + ' -> ' + s.length);
for (const t of ['_caminoTts', 'x-aegis-tts-path']) console.log('  ' + t + ' -> ' + (s.split(t).length - 1));

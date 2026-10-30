import { readFileSync, writeFileSync } from 'node:fs';
const p = 'C:/Aegis-Proyects/web/server.mjs';
let s = readFileSync(p, 'utf8');
const antes = s.length;
const cortar = (ini, fin, nuevo, etiqueta) => {
  const i = s.indexOf(ini);
  if (i < 0) throw new Error('no encontre inicio: ' + etiqueta);
  const j = s.indexOf(fin, i + ini.length);
  if (j < 0) throw new Error('no encontre fin: ' + etiqueta);
  s = s.slice(0, i) + nuevo + s.slice(j + fin.length);
  console.log('  ok: ' + etiqueta);
};
cortar('// Motores que acaban de fallar', 'const MOTOR_ROTO_MS = 10 * 60 * 1000;\r\n', '', 'restos de motores remotos');
const nuevaPiper = [
  '// UNICO motor: Piper local. Se borraron edge-tts (Microsoft contesta 403 desde que cambio el',
  '// esquema de token) y Groq (exige aceptar terminos y no tiene voz en espanol): solo servian',
  '// para fallar y meter latencia.',
  "const PIPER_VOZ = 'es_AR-daniela-high';",
  'const _ttsCache = new Map();          // texto+voz ->Buffer, para no resintetizar lo mismo',
  'const TTS_CACHE_MAX = 24;',
  'let _vocesPiper = null;',
  'async function vozPiperValida(voz) {',
  "  const fss = await import('node:fs');",
  '  try {',
  '    if (!_vocesPiper) {',
  '      _vocesPiper = new Set(',
  "        fss.readdirSync(PIPER_DIR).filter((f) => f.endsWith('.onnx')).map((f) => f.slice(0, -5))",
  '      );',
  '    }',
  '  } catch (e) { _vocesPiper = new Set([PIPER_VOZ]); }',
  "  const v = String(voz || '').replace(/[^A-Za-z0-9_.-]/g, '');",
  '  return _vocesPiper.has(v) ? v : PIPER_VOZ;   // voz de otro motor (es-AR-TomasNeural) cae a la local',
  '}',
  'async function piperTts(texto, voz, rate) {',
  "  const { spawn } = await import('node:child_process');",
  '  const modelo = await vozPiperValida(voz);',
  "  const ritmo = Number(rate) > 0.5 && Number(rate) < 2 ? 1 / Number(rate) : 1;  // >1 = mas lento",
  "  const clave = modelo + '|' + ritmo.toFixed(3) + '|' + texto;",
  '  const guardado = _ttsCache.get(clave);',
  '  if (guardado) return guardado;',
  '  const audio = await new Promise((resolve, reject) => {',
  '    // -f - escribe el WAV en stdout: sin archivo temporal (menos I/O y nada que limpiar).',
  '    const p = spawn(PIPER_EXE, [',
  "      '-m', PIPER_DIR + '/' + modelo + '.onnx',",
  "      '-f', '-',",
  "      '--length_scale', String(ritmo),",
  "      '--sentence_silence', '0.12',   // pausa mas corta entre oraciones (por defecto 0.2)",
  "      '-q',",
  '    ]);',
  '    const partes = [];',
  "    let err = '';",
  '    p.stdout.on("data", (d) => partes.push(d));',
  '    p.stderr.on("data", (d) => { err += d.toString(); });',
  '    p.on("error", reject);',
  '    p.on("close", (code) => {',
  '      const buf = Buffer.concat(partes);',
  "      if (code !== 0) return reject(new Error('piper exit ' + code + ' ' + err.slice(0, 200)));",
  "      if (!buf || buf.length < 100) return reject(new Error('piper sin audio: ' + err.slice(0, 150)));",
  '      resolve(buf);',
  '    });',
  '    p.stdin.write(String(texto));',
  '    p.stdin.end();',
  '  });',
  '  if (_ttsCache.size >= TTS_CACHE_MAX) _ttsCache.delete(_ttsCache.keys().next().value);',
  '  _ttsCache.set(clave, audio);',
  '  return audio;',
  '}',
  ''].join('\r\n');
cortar('async function piperTts(texto, voz) {', '\r\n}\r\n', nuevaPiper, 'piperTts nuevo');
const vozNueva = [
  "      // La voz por defecto es la de Piper; si el cliente manda una de otro motor, piperTts la",
  "      // valida contra los modelos instalados y cae a la local.",
  "      const voz = String(url.searchParams.get('voice') || cfg.ttsVoice || PIPER_VOZ);"].join('\r\n');
cortar("      const voz = String(url.searchParams.get('voice') || cfg.ttsVoice ||", "'es-AR-TomasNeural'));", vozNueva, 'voz por defecto');
const rutaNueva = [
  '        // Los parametros engine/model se aceptan y se ignoran: la web puede seguir mandando',
  '        // engine=edge de una config vieja y ahora se sintetiza igual con Piper.',
  '        const audio = await piperTts(texto, voz, rate);',
  "        if (!audio || !audio.length) throw new Error('sin audio');",
  '        res.writeHead(200, {',
  "          'content-type': 'audio/wav',",
  "          'content-length': String(audio.length),",
  "          'cache-control': 'no-store',",
  "          'x-aegis-tts-engine': 'piper',",
  '        });',
  '        res.end(audio);'].join('\r\n');
cortar("        const modelo = String(url.searchParams.get('model')", '        res.end(audio);', rutaNueva, 'ruta solo piper');
writeFileSync(p, s);
console.log('  bytes: ' + antes + ' -> ' + s.length);
for (const t of ['edgeTts', 'groqTts', 'EDGE_TOKEN', '_motoresRotos', 'conMotor', 'PIPER_VOZ', 'vozPiperValida', 'sentence_silence', '_ttsCache']) {
  console.log("  '" + t + "' -> " + (s.split(t).length - 1));
}

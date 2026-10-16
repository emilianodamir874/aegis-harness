import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync, readFileSync } from 'node:fs';
const EXE = 'C:/Aegis-Proyects/core/state/piper/bin/piper/piper.exe';
const VOZ = 'C:/Aegis-Proyects/core/state/piper/voices/es_AR-daniela-high.onnx';
const DIR = 'C:/Aegis-Proyects/tmp/piper-warm';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
const set = () => new Set(readdirSync(DIR).filter((f) => f.endsWith('.wav')));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
async function esperarCompleto(antes, limiteMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < limiteMs) {
    const nuevas = [...set()].filter((f) => !antes.has(f));
    if (nuevas.length) {
      const ruta = DIR + '/' + nuevas[0];
      const a = statSync(ruta).size;
      await dormir(80);
      const b = statSync(ruta).size;
      if (a > 1000 && a === b) return { ms: Date.now() - t0, ruta: ruta, kb: Math.round(b / 1024), cabecera: readFileSync(ruta).slice(0, 4).toString('ascii') };
    }
    await dormir(15);
  }
  return { ms: Date.now() - t0, error: true };
}
const p = spawn(EXE, ['-m', VOZ, '-d', DIR, '-q', '--length_scale', '0.98', '--sentence_silence', '0.12']);
let err = '';
p.stderr.on('data', (d) => { err += d.toString(); });
p.stdout.on('data', () => {});
await dormir(1800);   // tiempo de carga del modelo (una sola vez)
const frases = ['Primera frase de prueba.', 'Segunda frase distinta, un poco mas larga que la anterior para ver la diferencia.', 'Tercera frase corta.', 'Hola otra vez, cuarta frase.'];
for (const f of frases) {
  const antes = set();
  p.stdin.write(f + '\n');
  const r = await esperarCompleto(antes, 25000);
  console.log('  ' + (r.error ? 'FALLO tras ' + r.ms + ' ms' : r.ms + ' ms  ' + r.kb + ' KB  cabecera=' + r.cabecera + '  (' + f.slice(0, 30) + ')'));
}
p.kill();
console.log('  stderr: ' + (err.trim() ? err.trim().slice(0, 150) : '(vacio)'));

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, statSync, readFileSync, unlinkSync } from "node:fs";
const EXE = "C:/Aegis-Proyects/core/state/piper/bin/piper/piper.exe";
const VOZ_DIR = "C:/Aegis-Proyects/core/state/piper/voices";
const DIR = "C:/Aegis-Proyects/tmp/piper-vivo";
const IDLE_MS = 5 * 60 * 1e3;
const TIMEOUT_MS = 3e4;
const viv = { proc: null, clave: "", cola: Promise.resolve(), ultimo: 0, dir: false };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
function prepararDir() {
  if (viv.dir) return;
  mkdirSync(DIR, { recursive: true });
  try {
    for (const f of readdirSync(DIR)) if (f.endsWith(".wav")) unlinkSync(DIR + "/" + f);
  } catch (e) {
  }
  viv.dir = true;
}
function listo(voz, ritmo) {
  const clave = voz + "|" + ritmo.toFixed(3);
  if (viv.proc && viv.clave === clave) return viv.proc;
  if (viv.proc) {
    try {
      viv.proc.kill();
    } catch (e) {
    }
    viv.proc = null;
  }
  prepararDir();
  const proc = spawn(EXE, [
    "-m",
    VOZ_DIR + "/" + voz + ".onnx",
    "-d",
    DIR,
    "-q",
    "--length_scale",
    String(ritmo),
    "--sentence_silence",
    "0.12"
  ]);
  proc.stdout.on("data", () => {
  });
  proc.stderr.on("data", () => {
  });
  proc.on("exit", () => {
    if (viv.proc === proc) viv.proc = null;
  });
  viv.proc = proc;
  viv.clave = clave;
  viv.ultimo = Date.now();
  return proc;
}
async function piperDespertar(voz, ritmo) {
  const v = voz || "es_AR-daniela-high";
  const r = typeof ritmo === "number" ? ritmo : 0.98;
  try {
    listo(v, r);
    await piperVivo("Listo.", v, r);
  } catch (e) {
  }
}
function piperVivo(texto, voz, ritmo) {
  const tarea = async () => {
    if (viv.proc && Date.now() - viv.ultimo > IDLE_MS) {
      try {
        viv.proc.kill();
      } catch (e) {
      }
      viv.proc = null;
    }
    const proc = listo(voz, ritmo);
    const antes = new Set(readdirSync(DIR).filter((f) => f.endsWith(".wav")));
    proc.stdin.write(String(texto).replace(/[\r\n]+/g, " ") + "\n");
    viv.ultimo = Date.now();
    const t0 = Date.now();
    while (Date.now() - t0 < TIMEOUT_MS) {
      const nuevas = readdirSync(DIR).filter((f) => f.endsWith(".wav") && !antes.has(f));
      if (nuevas.length) {
        const ruta = DIR + "/" + nuevas[0];
        const a = statSync(ruta).size;
        await dormir(60);
        if (a > 1e3 && a === statSync(ruta).size) {
          const buf = readFileSync(ruta);
          try {
            unlinkSync(ruta);
          } catch (e) {
          }
          return buf;
        }
      }
      await dormir(15);
    }
    try {
      proc.kill();
    } catch (e) {
    }
    if (viv.proc === proc) viv.proc = null;
    throw new Error("piper vivo sin respuesta en " + TIMEOUT_MS + " ms");
  };
  const encadenada = viv.cola.then(tarea, tarea);
  viv.cola = encadenada.catch(() => {
  });
  return encadenada;
}
export {
  piperDespertar,
  piperVivo
};

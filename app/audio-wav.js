function pcmToWav(samples, sampleRate) {
  const bytesPorMuestra = 2;
  const dataBytes = samples.length * bytesPorMuestra;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const escribirTexto = (offset, texto) => {
    for (let i = 0; i < texto.length; i++) view.setUint8(offset + i, texto.charCodeAt(i));
  };
  escribirTexto(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  escribirTexto(8, "WAVE");
  escribirTexto(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPorMuestra, true);
  view.setUint16(32, bytesPorMuestra, true);
  view.setUint16(34, 16, true);
  escribirTexto(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * bytesPorMuestra, s < 0 ? s * 32768 : s * 32767, true);
  }
  return new Uint8Array(buffer);
}
function crearAudioContext() {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  return new Ctor();
}
const DICTADO_SAMPLE_RATE = 16e3;
const ALFABETO_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function bytesToBase64(bytes) {
  const partes = [];
  let trozo = "";
  const total = bytes.length;
  for (let i = 0; i < total; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < total ? bytes[i + 1] : 0;
    const b2 = i + 2 < total ? bytes[i + 2] : 0;
    trozo += ALFABETO_B64[b0 >> 2] + ALFABETO_B64[(b0 & 3) << 4 | b1 >> 4] + (i + 1 < total ? ALFABETO_B64[(b1 & 15) << 2 | b2 >> 6] : "=") + (i + 2 < total ? ALFABETO_B64[b2 & 63] : "=");
    if (trozo.length >= 8192) {
      partes.push(trozo);
      trozo = "";
    }
  }
  partes.push(trozo);
  return partes.join("");
}
async function blobToWav16k(blob) {
  const ctx = crearAudioContext();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const frames = Math.max(1, Math.ceil(decoded.duration * DICTADO_SAMPLE_RATE));
    const offline = new OfflineAudioContext(1, frames, DICTADO_SAMPLE_RATE);
    const fuente = offline.createBufferSource();
    fuente.buffer = decoded;
    fuente.connect(offline.destination);
    fuente.start();
    const renderizado = await offline.startRendering();
    return pcmToWav(renderizado.getChannelData(0), DICTADO_SAMPLE_RATE);
  } finally {
    try {
      await ctx.close();
    } catch {
    }
  }
}
export {
  DICTADO_SAMPLE_RATE,
  blobToWav16k,
  bytesToBase64,
  pcmToWav
};

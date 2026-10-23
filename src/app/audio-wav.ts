/*
 * Conversion del audio grabado a WAV PCM 16 kHz mono.
 *
 * Por que existe: MediaRecorder en Chrome/Android solo produce `audio/webm;codecs=opus`. El motor
 * de dictado local decodifica con symphonia, que no tiene decoder de Opus, asi que el blob moria en
 * `Internal error` con "Failed to create audio decoder - please ensure browser sends WAV format
 * audio" (reproducido mandando un webm de 14 KB por ACP). Decodificar en el navegador con WebAudio
 * y mandar WAV deja el motor con el formato que ya sabe leer, sin agregar dependencias de audio en
 * Rust.
 */

/** Encabezado RIFF + datos PCM entrelazados de 16 bits, mono. */
export function pcmToWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytesPorMuestra = 2;
  const dataBytes = samples.length * bytesPorMuestra;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const escribirTexto = (offset: number, texto: string) => {
    for (let i = 0; i < texto.length; i++) view.setUint8(offset + i, texto.charCodeAt(i));
  };

  escribirTexto(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  escribirTexto(8, 'WAVE');
  escribirTexto(12, 'fmt ');
  view.setUint32(16, 16, true);          // tamano del bloque fmt
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, 1, true);           // canales
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPorMuestra, true);  // bytes por segundo
  view.setUint16(32, bytesPorMuestra, true);               // alineacion de bloque
  view.setUint16(34, 16, true);                            // bits por muestra
  escribirTexto(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * bytesPorMuestra, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Uint8Array(buffer);
}

function crearAudioContext(): AudioContext {
  const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
  return new Ctor();
}

/** 16 kHz mono: la frecuencia que espera whisper y un cuarto de los bytes de 44.1/48 kHz. */
export const DICTADO_SAMPLE_RATE = 16000;

const ALFABETO_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** base64 sin `btoa(String.fromCharCode(...))`: con 1 MB de audio eso revienta el stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  const partes: string[] = [];
  let trozo = '';
  const total = bytes.length;
  for (let i = 0; i < total; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < total ? bytes[i + 1] : 0;
    const b2 = i + 2 < total ? bytes[i + 2] : 0;
    trozo += ALFABETO_B64[b0 >> 2]
      + ALFABETO_B64[((b0 & 3) << 4) | (b1 >> 4)]
      + (i + 1 < total ? ALFABETO_B64[((b1 & 15) << 2) | (b2 >> 6)] : '=')
      + (i + 2 < total ? ALFABETO_B64[b2 & 63] : '=');
    if (trozo.length >= 8192) { partes.push(trozo); trozo = ''; }
  }
  partes.push(trozo);
  return partes.join('');
}

/**
 * Graba en webm/opus, decodifica con WebAudio y devuelve WAV 16 kHz mono.
 * El remuestreo lo hace OfflineAudioContext, que promedia en vez de tirar muestras.
 */
export async function blobToWav16k(blob: Blob): Promise<Uint8Array> {
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
    try { await ctx.close(); } catch { /* el contexto ya estaba cerrado */ }
  }
}

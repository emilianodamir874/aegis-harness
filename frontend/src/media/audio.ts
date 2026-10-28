// Dictado y lectura en voz alta.
//
// Dictado: MediaRecorder (webm/opus) -> decodeAudioData -> WAV PCM 16 bits mono 16 kHz, que es lo
// que acepta `_aegis/unstable/dictation/transcribe` (mimeType audio/wav).
// Lectura: el server expone GET /tts?text=...&voice=... y devuelve audio; se reproduce por tramos
// de frase para poder cortar en el acto.

const TARGET_RATE = 16_000;

function writeString(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

/** Decodifica el audio grabado y lo devuelve como WAV monocanal 16 kHz en base64. */
export async function blobToWavBase64(blob: Blob): Promise<string> {
  const bytes = await blob.arrayBuffer();
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(bytes.slice(0));
    const channels = decoded.numberOfChannels;
    const length = Math.max(1, Math.round((decoded.length * TARGET_RATE) / decoded.sampleRate));
    const offline = new OfflineAudioContext(1, length, TARGET_RATE);
    const source = offline.createBufferSource();
    const mono = offline.createBuffer(1, decoded.length, decoded.sampleRate);
    const mixed = mono.getChannelData(0);
    for (let channel = 0; channel < channels; channel += 1) {
      const data = decoded.getChannelData(channel);
      for (let i = 0; i < data.length; i += 1) mixed[i] = (mixed[i] ?? 0) + (data[i] ?? 0) / channels;
    }
    source.buffer = mono;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    const wav = encodeWav(rendered.getChannelData(0), TARGET_RATE);
    return arrayBufferToBase64(wav);
  } finally {
    void context.close();
  }
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}

/** Parte un texto en tramos de frase que el server acepta (1200 caracteres máximo). */
export function speechChunks(text: string, max = 900): string[] {
  const clean = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?…]+[.!?…]*/g) ?? [clean];
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if ((current + sentence).length > max && current) {
      chunks.push(current.trim());
      current = '';
    }
    current += sentence;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export interface SpeechPlayer {
  speak: (text: string) => Promise<void>;
  stop: () => void;
  readonly speaking: boolean;
}

/**
 * Reproduce la lectura en voz alta. Una sola cola; `stop` corta el audio en curso y vacía lo que
 * falta (el operador pidió silencio, no "terminá la frase").
 */
export function createSpeechPlayer(voice = 'es-AR-ElenaNeural'): SpeechPlayer {
  let audio: HTMLAudioElement | null = null;
  let generation = 0;
  let speaking = false;
  return {
    get speaking() {
      return speaking;
    },
    async speak(text: string) {
      const chunks = speechChunks(text);
      const mine = ++generation;
      speaking = chunks.length > 0;
      for (const chunk of chunks) {
        if (mine !== generation) return;
        const url = `/tts?voice=${encodeURIComponent(voice)}&text=${encodeURIComponent(chunk)}`;
        const element = new Audio(url);
        audio = element;
        await new Promise<void>((resolve) => {
          const done = (): void => resolve();
          element.addEventListener('ended', done, { once: true });
          element.addEventListener('error', done, { once: true });
          void element.play().catch(done);
        });
        if (mine !== generation) return;
      }
      speaking = false;
      audio = null;
    },
    stop() {
      generation += 1;
      speaking = false;
      if (audio) {
        audio.pause();
        audio.src = '';
        audio = null;
      }
    },
  };
}

export interface DictationHandle {
  stop: () => Promise<Blob>;
  cancel: () => void;
}

/** Arranca la grabación. `getUserMedia` sólo existe en contexto seguro (https o localhost). */
export async function startDictation(): Promise<DictationHandle> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('El dictado necesita https o localhost');
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream);
  const parts: Blob[] = [];
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size > 0) parts.push(event.data);
  });
  recorder.start();
  const stopTracks = (): void => {
    for (const track of stream.getTracks()) track.stop();
  };
  return {
    stop: () =>
      new Promise<Blob>((resolve) => {
        recorder.addEventListener(
          'stop',
          () => {
            stopTracks();
            resolve(new Blob(parts, { type: recorder.mimeType || 'audio/webm' }));
          },
          { once: true },
        );
        recorder.stop();
      }),
    cancel: () => {
      try {
        recorder.stop();
      } catch {
        // ya estaba detenido
      }
      stopTracks();
    },
  };
}

// Mide msedge-tts (Node, sin Python): latencia por frase y bytes.
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const FRASE = 'Buenas tardes. Esta es la medición de la voz de Microsoft desde Node.';
const tts = new MsEdgeTTS();

async function decir(texto) {
  const t0 = Date.now();
  await tts.setMetadata('es-AR-ElenaNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = tts.toStream(texto);
  const buf = await new Promise((resolve, reject) => {
    const partes = [];
    audioStream.on('data', (d) => partes.push(d));
    audioStream.on('end', () => resolve(Buffer.concat(partes)));
    audioStream.on('error', reject);
  });
  return { ms: Date.now() - t0, bytes: buf.length };
}

try {
  console.log('frio:   ' + JSON.stringify(await decir(FRASE)));
  console.log('warm 1: ' + JSON.stringify(await decir(FRASE + ' Segunda frase distinta.')));
  console.log('warm 2: ' + JSON.stringify(await decir(FRASE + ' Tercera frase distinta.')));
} catch (e) {
  console.log('ERROR ' + e.message);
}
process.exit(0);

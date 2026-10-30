import { createHash, randomUUID } from 'crypto';
import pkg from 'file:///C:/Aegis-Proyects/web/tools/tts-deps/node_modules/ws/index.js';
const WebSocket = pkg.WebSocket || pkg;
const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';

// 1) Hora del servidor de Microsoft vs. la nuestra
let fechaServidor = null;
try {
  const r = await fetch('https://api.msedgeservices.com/tts/cognitiveservices/websocket/v1', { method: 'GET' });
  fechaServidor = r.headers.get('date');
  console.log('HTTPS status: ' + r.status + ' | date del servidor: ' + fechaServidor);
} catch (e) { console.log('HTTPS fallo: ' + e.message); }
const ahoraLocal = new Date();
console.log('hora local (UTC): ' + ahoraLocal.toUTCString());
let desfaseSeg = null;
if (fechaServidor) { desfaseSeg = (new Date(fechaServidor).getTime() - ahoraLocal.getTime()) / 1000; console.log('desfase servidor-local: ' + desfaseSeg.toFixed(0) + ' s'); }

function gec(baseMs) {
  let t = baseMs / 1000 + 11644473600;
  t = t - (t % 300);
  return createHash('sha256').update(Math.floor(t * 1e7) + TOKEN, 'ascii').digest('hex').toUpperCase();
}
function intento(nombre, urlHost, ver, voz, baseMs) {
  return new Promise((resolve) => {
    const id = randomUUID().replace(/-/g, '');
    const url = urlHost + '?TrustedClientToken=' + TOKEN + '&Sec-MS-GEC=' + gec(baseMs) + '&Sec-MS-GEC-Version=' + ver + '&ConnectionId=' + id;
    let bytes = 0, estado = '(sin respuesta)';
    const ws = new WebSocket(url, { headers: { Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', Pragma: 'no-cache' } });
    const fin = setTimeout(() => { try { ws.close(); } catch (e) {} resolve({ nombre, estado, bytes }); }, 10000);
    ws.on('unexpected-response', (r, res) => { estado = 'HTTP ' + res.statusCode; });
    ws.on('open', () => {
      estado = 'ABIERTO';
      const f = new Date(baseMs).toUTCString();
      ws.send('X-Timestamp:' + f + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}');
      ws.send('X-RequestId:' + id + '\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:' + f + '\r\nPath:ssml\r\n\r\n<speak version=\'1.0\' xmlns=\'http://www.w3.org/2001/10/synthesis\' xml:lang=\'es-AR\'><voice name=\'' + voz + '\'>Hola Emiliano, prueba de voz.</voice></speak>');
    });
    ws.on('message', (d, bin) => { if (bin) bytes += d.length; else if (d.toString().includes('turn.end')) { estado = 'turn.end'; clearTimeout(fin); try { ws.close(); } catch (e) {} resolve({ nombre, estado, bytes }); } });
    ws.on('error', (e) => { estado += ' err:' + ((e && e.message) || '').slice(0, 50); });
    ws.on('close', (c) => { clearTimeout(fin); resolve({ nombre, estado, bytes, close: c }); });
  });
}
const N = 'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1';
const V = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const baseServidor = fechaServidor ? new Date(fechaServidor).getTime() : Date.now();
const casos = [
  ['NUEVO + hora del SERVIDOR', N, '2-155.0.4283.45', 'es-AR-TomasNeural', baseServidor],
  ['NUEVO + hora servidor -5min', N, '2-155.0.4283.45', 'es-AR-ElenaNeural', baseServidor - 300000],
  ['VIEJO + hora del SERVIDOR', V, '1-143.0.3650.75', 'es-AR-TomasNeural', baseServidor],
  ['NUEVO + hora servidor +6min', N, '2-155.0.4283.45', 'es-MX-DaliaNeural', baseServidor + 360000],
];
for (const [n, h, v, voz, bm] of casos) { const r = await intento(n, h, v, voz, bm); console.log(r.nombre + ' -> ' + r.estado + ' | bytes=' + r.bytes); }

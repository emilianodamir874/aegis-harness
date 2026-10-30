import { createHash, randomUUID } from 'crypto';
import pkg from 'file:///C:/Aegis-Proyects/web/tools/tts-deps/node_modules/ws/index.js';
const WebSocket = pkg.WebSocket || pkg;
const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
function gec() {
  let t = Date.now() / 1000 + 11644473600;
  t = t - (t % 300);
  return createHash('sha256').update(Math.floor(t * 1e7) + TOKEN, 'ascii').digest('hex').toUpperCase();
}
const O = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
function intento(nombre, host, ver, voz) {
  return new Promise((resolve) => {
    const id = randomUUID().replace(/-/g, '');
    const url = host + '?TrustedClientToken=' + TOKEN + '&Sec-MS-GEC=' + gec() + '&Sec-MS-GEC-Version=' + ver + '&ConnectionId=' + id;
    let bytes = 0, estado = '(sin respuesta)';
    const ws = new WebSocket(url, { headers: { Origin: O, 'User-Agent': UA, Pragma: 'no-cache' } });
    const fin = setTimeout(() => { try { ws.close(); } catch (e) {} resolve({ nombre, estado, bytes }); }, 10000);
    ws.on('unexpected-response', (r, res) => { estado = 'HTTP ' + res.statusCode; });
    ws.on('open', () => {
      estado = 'ABIERTO';
      const f = new Date().toUTCString();
      ws.send('X-Timestamp:' + f + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}');
      ws.send('X-RequestId:' + id + '\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:' + f + '\r\nPath:ssml\r\n\r\n<speak version=\'1.0\' xmlns=\'http://www.w3.org/2001/10/synthesis\' xml:lang=\'es-AR\'><voice name=\'' + voz + '\'>Hola Emiliano, prueba de voz.</voice></speak>');
    });
    ws.on('message', (d, bin) => { if (bin) bytes += d.length; else if (d.toString().includes('turn.end')) { estado = 'turn.end'; clearTimeout(fin); try { ws.close(); } catch (e) {} resolve({ nombre, estado, bytes }); } });
    ws.on('error', (e) => { estado += ' err:' + ((e && e.message) || '').slice(0, 50); });
    ws.on('close', (c) => { clearTimeout(fin); resolve({ nombre, estado, bytes, close: c }); });
  });
}
const NUEVO = 'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1';
const VIEJO = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const casos = [
  ['NUEVO host + v2-155 + Tomas', NUEVO, '2-155.0.4283.45', 'es-AR-TomasNeural'],
  ['NUEVO host + v2-155 + Elena', NUEVO, '2-155.0.4283.45', 'es-AR-ElenaNeural'],
  ['NUEVO host + v2-155 + Elvira(ES)', NUEVO, '2-155.0.4283.45', 'es-ES-ElviraNeural'],
  ['NUEVO host + v2-155 + Dalia(MX)', NUEVO, '2-155.0.4283.45', 'es-MX-DaliaNeural'],
  ['NUEVO host + v1-143 viejo', NUEVO, '1-143.0.3650.75', 'es-AR-TomasNeural'],
  ['VIEJO host (control)', VIEJO, '1-130.0.2849.68', 'es-AR-TomasNeural'],
];
for (const [n, h, v, voz] of casos) { const r = await intento(n, h, v, voz); console.log(r.nombre + ' -> ' + r.estado + ' | bytes=' + r.bytes); }

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
const UA130 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
const CH = { 'Sec-CH-UA': '"Microsoft Edge";v="130", "Chromium";v="130", "Not?A_Brand";v="99"', 'Sec-CH-UA-Mobile': '?0', 'Sec-CH-UA-Platform': '"Windows"', 'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8', 'Accept-Encoding': 'gzip, deflate, br' };
function intento(nombre, headers, params) {
  return new Promise((resolve) => {
    const id = randomUUID().replace(/-/g, '');
    const url = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=' + TOKEN + params + '&ConnectionId=' + id;
    let bytes = 0, estado = '(sin respuesta)';
    const ws = new WebSocket(url, { headers });
    const fin = setTimeout(() => { try { ws.close(); } catch (e) {} resolve({ nombre, estado, bytes }); }, 9000);
    ws.on('unexpected-response', (r, res) => { estado = 'HTTP ' + res.statusCode; });
    ws.on('open', () => {
      estado = 'ABIERTO';
      const f = new Date().toString();
      ws.send('X-Timestamp:' + f + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}');
      ws.send('X-RequestId:' + id + '\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:' + f + 'Z\r\nPath:ssml\r\n\r\n<speak version=\'1.0\' xmlns=\'http://www.w3.org/2001/10/synthesis\' xml:lang=\'es-AR\'><voice name=\'es-AR-TomasNeural\'>Hola, prueba.</voice></speak>');
    });
    ws.on('message', (d, bin) => { if (bin) bytes += d.length; else if (d.toString().includes('turn.end')) { estado = 'turn.end'; clearTimeout(fin); try { ws.close(); } catch (e) {} resolve({ nombre, estado, bytes }); } });
    ws.on('error', (e) => { estado += ' err:' + ((e && e.message) || '').slice(0, 60); });
    ws.on('close', (c) => { clearTimeout(fin); resolve({ nombre, estado, bytes, close: c }); });
  });
}
const G = (v) => '&Sec-MS-GEC=' + gec() + '&Sec-MS-GEC-Version=' + v;
const casos = [
  ['v130 + client hints', { Origin: O, 'User-Agent': UA130, Pragma: 'no-cache', ...CH }, G('1-130.0.2849.68')],
  ['v131', { Origin: O, 'User-Agent': UA130, Pragma: 'no-cache', ...CH }, G('1-131.0.2903.86')],
  ['v133', { Origin: O, 'User-Agent': UA130, Pragma: 'no-cache', ...CH }, G('1-133.0.3065.84')],
  ['v134 + hints', { Origin: O, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0', Pragma: 'no-cache', ...CH }, G('1-134.0.3124.51')],
  ['formato webm-24khz', { Origin: O, 'User-Agent': UA130, Pragma: 'no-cache', ...CH }, G('1-130.0.2849.68')],
];
for (const [n, h, p] of casos) { const r = await intento(n, h, p); console.log(r.nombre + ' -> ' + r.estado + ' | bytes=' + r.bytes + ' | close=' + r.close); }

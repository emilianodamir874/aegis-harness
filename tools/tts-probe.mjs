// Sonda de edge-tts: prueba variantes de handshake y dice el motivo real (no toca el server vivo).
import { createHash, randomUUID } from 'crypto';
import pkg from 'file:///C:/Aegis-Proyects/web/tools/tts-deps/node_modules/ws/index.js';
const WebSocket = pkg.WebSocket || pkg;

const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
function gec() {
  let t = Date.now() / 1000 + 11644473600;
  t = t - (t % 300);
  return createHash('sha256').update(Math.floor(t * 1e7) + TOKEN, 'ascii').digest('hex').toUpperCase();
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function intento(nombre, headers, extraParams) {
  return new Promise((resolve) => {
    const id = randomUUID().replace(/-/g, '');
    const base = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=' + TOKEN;
    const url = base + (extraParams || '') + '&ConnectionId=' + id;
    const t0 = Date.now();
    let bytes = 0, nota = '';
    const ws = new WebSocket(url, { headers });
    ws.binaryType = 'arraybuffer';
    const fin = setTimeout(() => { nota = nota || 'timeout'; try { ws.close(); } catch (e) {} resolve({ nombre, nota, bytes, ms: Date.now() - t0 }); }, 12000);
    ws.on('open', () => {
      nota = 'abierto; ';
      const fecha = new Date().toString();
      ws.send('X-Timestamp:' + fecha + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n'
        + '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}');
      ws.send('X-RequestId:' + id + '\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:' + fecha + 'Z\r\nPath:ssml\r\n\r\n'
        + "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='es-AR'><voice name='es-AR-TomasNeural'>Hola, prueba de voz.</voice></speak>");
    });
    ws.on('message', (data, isBin) => {
      if (isBin) { bytes += data.length; return; }
      const s = data.toString();
      if (s.includes('turn.end')) { nota += 'turn.end'; clearTimeout(fin); try { ws.close(); } catch (e) {} resolve({ nombre, nota, bytes, ms: Date.now() - t0 }); }
      else if (s.length < 300) nota += '[' + s.replace(/\s+/g, ' ').slice(0, 120) + '] ';
    });
    ws.on('error', (e) => { nota += 'ERROR: ' + (e && e.message ? e.message : String(e)); });
    ws.on('unexpected-response', (req, res) => {
      let cuerpo = '';
      res.on('data', (c) => (cuerpo += c.toString().slice(0, 200)));
      res.on('end', () => { nota += 'HTTP ' + res.statusCode + ' ' + JSON.stringify(res.headers).slice(0, 220) + ' cuerpo=' + cuerpo.replace(/\s+/g, ' ').slice(0, 160); });
    });
    ws.on('close', (code, reason) => { clearTimeout(fin); resolve({ nombre, nota: nota + ' cerrado ' + code + ' ' + reason.toString(), bytes, ms: Date.now() - t0 }); });
  });
}

const O = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const casos = [
  ['A actual (Origin+UA+GEC)', { Origin: O, 'User-Agent': UA }, '&Sec-MS-GEC=' + gec() + '&Sec-MS-GEC-Version=1-130.0.2849.68'],
  ['B +Pragma/Cache', { Origin: O, 'User-Agent': UA, Pragma: 'no-cache', 'Cache-Control': 'no-cache' }, '&Sec-MS-GEC=' + gec() + '&Sec-MS-GEC-Version=1-130.0.2849.68'],
  ['C sin GEC', { Origin: O, 'User-Agent': UA }, ''],
  ['D Edge UA real', { Origin: O, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', Pragma: 'no-cache' }, '&Sec-MS-GEC=' + gec() + '&Sec-MS-GEC-Version=1-130.0.2849.68'],
  ['E Origin edge://', { Origin: 'edge://settings', 'User-Agent': UA }, '&Sec-MS-GEC=' + gec() + '&Sec-MS-GEC-Version=1-130.0.2849.68'],
];
for (const [n, h, p] of casos) {
  const r = await intento(n, h, p);
  console.log(r.nombre + ' -> ' + r.nota + ' | bytes=' + r.bytes + ' | ' + r.ms + 'ms');
}

import { chromium } from 'playwright';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1600"><rect width="2400" height="1600" fill="#456"/></svg>';
const b64 = Buffer.from(svg).toString('base64');
const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://127.0.0.1:3788/', { waitUntil: 'networkidle', timeout: 30000 });
const r = await p.evaluate(async (dataUri) => {
  const host = document.getElementById('messages') || document.querySelector('.messages') || document.body;
  const caja = document.createElement('div');
  caja.className = 'msg-user';
  const img = document.createElement('img');
  img.className = 'att-img';
  img.alt = 'adjunto';
  caja.innerHTML = '<p>texto antes</p>';
  caja.appendChild(img);
  const p2 = document.createElement('p');
  p2.textContent = 'texto despues';
  caja.appendChild(p2);
  host.appendChild(caja);
  img.src = dataUri;
  await new Promise((ok) => (img.complete ? ok() : img.addEventListener('load', ok), setTimeout(ok, 1500)));
  const rectCaja = caja.getBoundingClientRect();
  const rectImg = img.getBoundingClientRect();
  const rectTxt = p2.getBoundingClientRect();
  const dato = {
    anchoCaja: Math.round(rectCaja.width),
    anchoImagen: Math.round(rectImg.width),
    altoImagen: Math.round(rectImg.height),
    desborda: rectImg.right > rectCaja.right + 1 || rectImg.width > rectCaja.width + 1,
    tapaTexto: rectTxt.top < rectImg.bottom - 1,
  };
  caja.remove();
  return dato;
}, 'data:image/svg+xml;base64,' + b64);
console.log(JSON.stringify(r));
await b.close();

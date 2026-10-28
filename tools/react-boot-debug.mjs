// DiagnÃ³stico del arranque en mÃ³vil emulado: Â¿no abre sesiÃ³n, o el CSS esconde el composer?
// SÃ³lo lectura. Uso: node tools/react-boot-debug.mjs "http://127.0.0.1:3790/app-react/?acp=proxy"
import { chromium, devices } from 'playwright';

const url = process.argv[2] || 'http://127.0.0.1:3790/app-react/?acp=proxy';
const browser = await chromium.launch();
const context = await browser.newContext(devices['Pixel 7']);
const page = await context.newPage();
const consola = [];
page.on('console', (msg) => consola.push(`${msg.type()}: ${msg.text().slice(0, 160)}`));
page.on('pageerror', (error) => consola.push(`pageerror: ${String(error).slice(0, 200)}`));
const rpc = [];
page.on('websocket', (ws) => {
  ws.on('framesent', (frame) => {
    try {
      const data = JSON.parse(String(frame.payload));
      if (data.method) rpc.push(`â†’ ${data.method}`);
    } catch {
      /* binario o no JSON */
    }
  });
  ws.on('framereceived', (frame) => {
    try {
      const data = JSON.parse(String(frame.payload));
      if (data.id !== undefined && data.result !== undefined) rpc.push(`â† resultado id=${data.id}`);
      if (data.method) rpc.push(`â† nota ${data.method}`);
    } catch {
      /* binario o no JSON */
    }
  });
});

const estado = async () => {
  return page.evaluate(() => {
    const visible = (sel) => {
      const node = document.querySelector(sel);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return { ancho: Math.round(rect.width), alto: Math.round(rect.height), display: style.display, visibility: style.visibility };
    };
    return {
      nodos: document.querySelectorAll('*').length,
      filasSidebar: document.querySelectorAll('.sb-row').length,
      composer: visible('.composer'),
      wrap: visible('.composer-wrap'),
      sidebar: visible('.sidebar'),
      transcript: visible('.transcript, .scroll'),
      titulo: document.querySelector('.topbar h1, .title')?.textContent ?? null,
      rects: [...document.querySelectorAll('.sidebar, .main, .scroll, .composer-wrap')].map((n) => { const r = n.getBoundingClientRect(); return `: x= y= w= h=`; }),
      centro: (() => { const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2); return el ? el.className || el.tagName : null; })(),
    };
  });
};

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sidebar', { timeout: 20000 });
  await page.waitForTimeout(4000);
  const antes = await estado();

  // Si no hay composer, probar abrir una sesiÃ³n a mano: separa "no auto-abre" de "CSS lo esconde".
  let trasClick = null;
  if (!antes.composer || antes.composer.ancho === 0) {
    const fila = page.locator('.sb-row .sb-item').first();
    if (await fila.count()) {
      await fila.click();
      await page.waitForTimeout(2500);
      trasClick = await estado();
    }
  }

  console.log(
    JSON.stringify(
      { antes, trasClick, rpc: rpc.slice(0, 24), consola: consola.slice(0, 12) },
      null,
      2,
    ),
  );
} catch (error) {
  console.log(JSON.stringify({ fallo: String(error && error.message), rpc: rpc.slice(0, 20), consola: consola.slice(0, 12) }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}

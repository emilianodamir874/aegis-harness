import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const dest = 'C:/Users/Emiliano/backups/aegis-diagramas';
await mkdir(dest, { recursive: true });
const { outputFiles } = await build({ entryPoints: [resolve(root, 'src/app/markdown.ts')], bundle: true, platform: 'node', format: 'esm', write: false });
const { md } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const css = await readFile(resolve(root, 'app/app.css'), 'utf8');
const casos = [
  ['flujo', 'A[Cliente] --> B[Proxy]\nB -->|403| C{Autenticación}\nC -.-> D[Registro]\nC ==> E[Motor]\nE --> F[Respuesta]'],
  ['ramas', 'A[Solicitud de trabajo] --> B{Permisos}\nB -->|sí| C[Ejecutar]\nB -->|no| D[Solicitar aprobación]\nC --> E[Resultado]\nD --> E'],
  ['ciclo', 'A[Inicio] --> B[Proceso]\nB --> C{¿Listo?}\nC -->|no| B\nC -->|sí| D(Fin)'],
];
const browser = await chromium.launch({ headless: true });
for (const [name, grafo] of casos) {
  for (const [device, width] of [['escritorio', 1024], ['movil', 390]]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
    const html = md(`\`\`\`grafo\n${grafo}\n\`\`\``);
    await page.setContent(`<html><meta charset="utf-8"><style>${css}</style><style>body{margin:0;background:var(--bg);padding:18px}main{max-width:760px;margin:auto;color:var(--text);font:16px/1.7 Arial,sans-serif}</style><main><h2>Diagrama · ${name}</h2><div class="content">${html}</div></main></html>`);
    const result = await page.evaluate(() => {
      const fig = document.querySelector('.grafo-lamina');
      const svg = fig?.querySelector('svg');
      const canvas = fig?.querySelector('.grafo-canvas');
      const rects = [...(svg?.querySelectorAll('.grafo-nodo') || [])].map((el) => el.getBoundingClientRect());
      let solapamientos = 0;
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) solapamientos++;
      }
      return { fig: !!fig, nodos: rects.length, aristas: svg?.querySelectorAll('path.grafo-arista').length, solapamientos,
        anchoSvg: svg?.getBoundingClientRect().width, anchoLienzo: canvas?.getBoundingClientRect().width,
        paginaDesborda: document.documentElement.scrollWidth > innerWidth + 1, scrollInterno: canvas?.scrollWidth > canvas?.clientWidth + 1 };
    });
    const path = resolve(dest, `${name}-${device}.png`);
    await page.locator('main').screenshot({ path });
    console.log(`${name} ${device}`, JSON.stringify(result), path);
    if (!result.fig || result.nodos < 3 || result.aristas < 2 || result.solapamientos || result.paginaDesborda) process.exitCode = 1;
    await page.close();
  }
}
await browser.close();

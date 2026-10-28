// Auditoría de UI con Playwright: mide lo que se puede medir en lugar de opinar.
// - contraste real de cada texto visible contra su fondo efectivo (WCAG AA: 4,5 / 3,0 para grande)
// - targets táctiles chicos (<24 px es el mínimo de WCAG 2.2 AA)
// - desborde horizontal, medidas de lectura, saltos de foco
// Uso: node tools/ui-audit.mjs "http://127.0.0.1:3790/app-react/?acp=proxy" [ancho] [alto]
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://127.0.0.1:3790/app-react/?acp=proxy';
const ancho = Number(process.argv[3] || 1440);
const alto = Number(process.argv[4] || 900);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: ancho, height: alto } });
const errores = [];
page.on('pageerror', (error) => errores.push(String(error).slice(0, 200)));
page.on('console', (msg) => {
  if (msg.type() === 'error') errores.push(msg.text().slice(0, 200));
});

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.composer', { timeout: 30000 });
await page.waitForTimeout(1200);

const informe = await page.evaluate(() => {
  const parse = (color) => {
    const m = String(color).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(',').map((n) => Number(n.trim()));
    return { r, g, b, a };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const fondoEfectivo = (node) => {
    let actual = node;
    while (actual) {
      const estilo = getComputedStyle(actual);
      const c = parse(estilo.backgroundColor);
      if (c && c.a > 0.85) return c;
      actual = actual.parentElement;
    }
    return { r: 28, g: 27, b: 25, a: 1 }; // --bg
  };
  const ratio = (a, b) => {
    const la = lum(a);
    const lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };

  const visibles = [...document.querySelectorAll('body *')].filter((node) => {
    const rect = node.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    if (node.children.length > 0) return false; // sólo hojas con texto
    const texto = (node.textContent ?? '').trim();
    return texto.length > 1 && getComputedStyle(node).visibility !== 'hidden';
  });

  const bajos = [];
  for (const node of visibles) {
    const estilo = getComputedStyle(node);
    const color = parse(estilo.color);
    if (!color) continue;
    const tamano = parseFloat(estilo.fontSize);
    const peso = Number(estilo.fontWeight) || 400;
    const grande = tamano >= 24 || (tamano >= 18.66 && peso >= 700);
    const minimo = grande ? 3 : 4.5;
    const r = ratio(color, fondoEfectivo(node));
    if (r < minimo) {
      bajos.push({
        texto: (node.textContent ?? '').trim().slice(0, 40),
        clase: String(node.className || node.tagName).slice(0, 40),
        ratio: Number(r.toFixed(2)),
        minimo,
        px: tamano,
      });
    }
  }

  const targets = [...document.querySelectorAll('button, a, select, summary, [role="button"]')]
    .filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })
    .map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        texto: (node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 32),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      };
    })
    .filter((t) => Math.min(t.w, t.h) < 24);

  const transcript = document.querySelector('.transcript');
  const prosa = [...document.querySelectorAll('.transcript p')].slice(0, 40);
  const anchos = prosa.map((p) => Math.round(p.getBoundingClientRect().width));

  return {
    bajos: bajos.slice(0, 14),
    totalBajos: bajos.length,
    targetsChicos: targets.slice(0, 10),
    totalTargetsChicos: targets.length,
    medidas: {
      transcript: transcript ? Math.round(transcript.getBoundingClientRect().width) : null,
      parrafoMax: anchos.length ? Math.max(...anchos) : null,
      desborde: document.documentElement.scrollWidth > window.innerWidth + 1,
    },
    foco: (() => {
      const activo = document.activeElement;
      return activo ? activo.tagName.toLowerCase() : null;
    })(),
  };
});

console.log(JSON.stringify({ viewport: `${ancho}x${alto}`, ...informe, errores }, null, 2));
await browser.close();

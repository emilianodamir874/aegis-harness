// Diagramas del chat: dos caminos, cero dependencias.
//
// 1. `esAscii(cuerpo)` detecta arte ASCII (cajas con +--, flechas -->, líneas verticales,
//    dibujos con caracteres de bloque). Se pinta como <figure class="diagrama"> con tipografía
//    monoespaciada y line-height apretado: se lee como dibujo, no como código.
// 2. `grafoSvg(texto)` convierte un grafo declarativo mínimo a SVG:
//
//        A[Cliente] --> B[Proxy]
//        B -->|403| C{Auth}
//        C -.-> D[Log]
//
//    Nodos `A[rectángulo]`, `A(óvalo)`, `A{rombo}`; flechas `-->`, `--->`, `-.->`, `==>` con
//    etiqueta opcional `-->|texto|`. El layout es por capas (BFS desde las raíces), sin cruces
//    sofisticados: alcanza para leer un flujo de un vistazo.
//
// Todo es puro: entra string, sale string. Sin DOM, sin librerías.

const NODO_ENTERO = /^([A-Za-z0-9_.-]+)\s*([[({])([^\])}]*)([\])}])$/;
const ID_SIMPLE = /^[A-Za-z0-9_.-]+$/;
const FLECHA = /\s*(-\.->|==>|--->|-->)\s*/;

const normalizaNodo = (id, abierto, texto, cerrado) => ({
  id,
  forma: abierto === '{' && cerrado === '}' ? 'rombo' : abierto === '(' && cerrado === ')' ? 'ovalo' : 'rect',
  texto: String(texto == null ? '' : texto).trim() || id,
});

const parseNodo = (texto) => {
  const t = String(texto).trim();
  const m = NODO_ENTERO.exec(t);
  if (m) return normalizaNodo(m[1], m[2], m[3], m[4]);
  if (ID_SIMPLE.test(t)) return { id: t, forma: 'rect', texto: t };
  const id = t.replace(/[^\w.-]+/g, (s) => s.trim()) || t;
  return { id, forma: 'rect', texto: t };
};

/** ¿El bloque parece un dibujo y no código? Cajas, flechas o caracteres de bloque. */
export const esAscii = (cuerpo) => {
  const lineas = String(cuerpo == null ? '' : cuerpo).split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lineas.length < 2) return false;
  const dibujo = lineas.filter((l) =>
    /[┌┐└┘├┤┬┴┼│─━┃┏┓┗┛╔╗╚╝║═╭╮╰╯▶◀▲▼]/.test(l)
    || /\+[-=]{2,}\+/.test(l)
    || /-{1,}->|<-{1,}|=>/.test(l)
    || /^\s*\|.*\|\s*$/.test(l)).length;
  const codigo = lineas.filter((l) =>
    /[;{}]\s*$/.test(l) || /^\s*(fn |def |class |impl |pub |let |const |var |import |from |#include|SELECT|CREATE )/.test(l)).length;
  return dibujo >= 2 && dibujo >= codigo;
};

/** Convierte el grafo declarativo a SVG. Devuelve '' si no hay al menos una arista. */
export const grafoSvg = (texto) => {
  const nodos = new Map();
  const aristas = [];
  const registra = (n) => { if (n && n.id && !nodos.has(n.id)) nodos.set(n.id, n); };

  for (const linea of String(texto == null ? '' : texto).split(/\r?\n/)) {
    const limpia = linea.replace(/\s*#.*$/, '').trim();
    if (!limpia) continue;
    const flecha = FLECHA.exec(limpia);
    if (flecha) {
      const izq = limpia.slice(0, flecha.index).trim();
      let der = limpia.slice(flecha.index + flecha[0].length).trim();
      let etiqueta = '';
      const et = /^\|\s*([^|]*)\s*\|\s*/.exec(der);
      if (et) { etiqueta = et[1].trim(); der = der.slice(et[0].length).trim(); }
      const desde = parseNodo(izq);
      const hasta = parseNodo(der);
      registra(desde);
      registra(hasta);
      aristas.push({ desde: desde.id, hasta: hasta.id, etiqueta });
      continue;
    }
    // Línea sin flecha: declaraciones sueltas `A[Texto] B{otro}` para nodos aislados.
    const sueltos = limpia.match(/[A-Za-z0-9_.-]+\s*[[({][^\])}]*[\])}]/g) || (ID_SIMPLE.test(limpia) ? [limpia] : []);
    for (const s of sueltos) registra(parseNodo(s));
  }
  if (!aristas.length) return '';

  // Capas por BFS desde las raíces (nodos sin entrantes). Los ciclos caen a la última capa vista.
  const entrantes = new Map([...nodos.keys()].map((id) => [id, 0]));
  for (const a of aristas) entrantes.set(a.hasta, (entrantes.get(a.hasta) || 0) + 1);
  const capa = new Map();
  const salientes = new Map();
  for (const a of aristas) {
    if (!salientes.has(a.desde)) salientes.set(a.desde, []);
    salientes.get(a.desde).push(a.hasta);
  }
  const raices = [...nodos.keys()].filter((id) => !entrantes.get(id));
  const pendientes = [...raices];
  for (const id of raices) capa.set(id, 0);
  let vueltas = 0;
  while (pendientes.length && vueltas++ < 500) {
    const id = pendientes.shift();
    for (const sig of salientes.get(id) || []) {
      const propuesta = (capa.get(id) || 0) + 1;
      if (!capa.has(sig) || capa.get(sig) < propuesta) {
        capa.set(sig, propuesta);
        pendientes.push(sig);
      }
    }
  }
  for (const id of nodos.keys()) if (!capa.has(id)) capa.set(id, 0);

  // Geometría: filas = capas, columnas = orden de aparición.
  const ANCHO = 168;
  const ALTO = 46;
  const GAP_X = 34;
  const GAP_Y = 30;
  const PAD = 18;
  const porCapa = new Map();
  for (const id of nodos.keys()) {
    const c = capa.get(id) || 0;
    if (!porCapa.has(c)) porCapa.set(c, []);
    porCapa.get(c).push(id);
  }
  const cols = Math.max(...[...porCapa.values()].map((v) => v.length), 1);
  const filas = porCapa.size;
  const ancho = PAD * 2 + cols * ANCHO + (cols - 1) * GAP_X;
  const alto = PAD * 2 + filas * ALTO + (filas - 1) * GAP_Y;

  const caja = new Map();
  for (const [c, ids] of [...porCapa.entries()].sort((a, b) => a[0] - b[0])) {
    const filaAncho = ids.length * ANCHO + (ids.length - 1) * GAP_X;
    const x0 = (ancho - filaAncho) / 2;
    ids.forEach((id, i) => {
      caja.set(id, { x: x0 + i * (ANCHO + GAP_X), y: PAD + c * (ALTO + GAP_Y) });
    });
  }

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const centro = (id) => { const b = caja.get(id); return { x: b.x + ANCHO / 2, y: b.y + ALTO / 2 }; };

  let svg = `<svg class="grafo" viewBox="0 0 ${Math.round(ancho)} ${Math.round(alto)}" width="${Math.round(ancho)}" height="${Math.round(alto)}" role="img" aria-label="Diagrama de flujo">`
    + '<defs><marker id="grafo-punta" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
    + '<path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/></marker></defs>';

  for (const a of aristas) {
    const d = caja.get(a.desde);
    const h = caja.get(a.hasta);
    if (!d || !h) continue;
    const cd = centro(a.desde);
    const ch = centro(a.hasta);
    // Sale por el borde inferior de uno y entra por el superior del otro cuando están en
    // capas distintas; si comparten capa, se conecta costado con costado.
    let x1; let y1; let x2; let y2; let path;
    if ((capa.get(a.desde) || 0) === (capa.get(a.hasta) || 0)) {
      const aDerecha = d.x <= h.x;
      x1 = aDerecha ? d.x + ANCHO : d.x;
      y1 = cd.y;
      x2 = aDerecha ? h.x : h.x + ANCHO;
      y2 = ch.y;
      path = `M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`;
    } else {
      const haciaAbajo = (capa.get(a.hasta) || 0) > (capa.get(a.desde) || 0);
      x1 = cd.x;
      y1 = haciaAbajo ? d.y + ALTO : d.y;
      x2 = ch.x;
      y2 = haciaAbajo ? h.y : h.y + ALTO;
      const my = (y1 + y2) / 2;
      path = `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
    }
    svg += `<path class="grafo-arista" d="${path}" marker-end="url(#grafo-punta)"/>`;
    if (a.etiqueta) {
      svg += `<text class="grafo-etq" x="${(x1 + x2) / 2 + 6}" y="${(y1 + y2) / 2 - 4}">${esc(a.etiqueta)}</text>`;
    }
  }

  for (const [id, n] of nodos) {
    const b = caja.get(id);
    if (!b) continue;
    const cx = b.x + ANCHO / 2;
    const cy = b.y + ALTO / 2;
    if (n.forma === 'rombo') {
      svg += `<polygon class="grafo-nodo" points="${cx},${b.y} ${b.x + ANCHO},${cy} ${cx},${b.y + ALTO} ${b.x},${cy}"/>`;
    } else if (n.forma === 'ovalo') {
      svg += `<rect class="grafo-nodo" x="${b.x}" y="${b.y}" width="${ANCHO}" height="${ALTO}" rx="${ALTO / 2}"/>`;
    } else {
      svg += `<rect class="grafo-nodo" x="${b.x}" y="${b.y}" width="${ANCHO}" height="${ALTO}" rx="8"/>`;
    }
    const palabras = n.texto.split(/\s+/);
    const lineas = [];
    let actual = '';
    for (const p of palabras) {
      const prueba = actual ? `${actual} ${p}` : p;
      if (prueba.length > 22 && actual) { lineas.push(actual); actual = p; } else actual = prueba;
    }
    if (actual) lineas.push(actual);
    const visibles = lineas.slice(0, 2);
    if (lineas.length > 2) visibles[1] = `${visibles[1].slice(0, 19)}…`;
    const yBase = cy - (visibles.length - 1) * 7 + 4;
    visibles.forEach((l, i) => {
      svg += `<text class="grafo-txt" x="${cx}" y="${yBase + i * 14}" text-anchor="middle">${esc(l)}</text>`;
    });
  }

  return `${svg}</svg>`;
};

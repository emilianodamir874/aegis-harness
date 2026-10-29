import { Graph, layout } from '@dagrejs/dagre';

type Forma = 'rect' | 'ovalo' | 'rombo';
type Nodo = { id: string; texto: string; forma: Forma; lineas: string[]; width: number; height: number };
type Arista = { desde: string; hasta: string; etiqueta: string; tipo: string };

const NODO = /^([A-Za-z][\w.-]{0,39})(?:\[([^\]]{0,180})\]|\(([^)]{0,180})\)|\{([^}]{0,180})\})?$/;
const FLECHA = /\s*(-->|-\.->|==>)\s*/;
const MAX_NODOS = 28;
const MAX_ARISTAS = 42;

const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const numero = (n: number): string => String(Math.round(n * 10) / 10);

function partir(texto: string, max = 25): string[] {
  const lineas: string[] = [];
  for (const parrafo of texto.split(/\\n|\n/)) {
    let actual = '';
    for (const palabra of parrafo.split(/\s+/).filter(Boolean)) {
      let resto = palabra;
      while (resto.length > max) {
        if (actual) { lineas.push(actual); actual = ''; }
        lineas.push(resto.slice(0, max));
        resto = resto.slice(max);
      }
      if (!resto) continue;
      if (actual.length + resto.length + (actual ? 1 : 0) > max) { lineas.push(actual); actual = resto; }
      else actual = actual ? `${actual} ${resto}` : resto;
    }
    if (actual) lineas.push(actual);
  }
  return lineas.length ? lineas : [''];
}

function leerNodo(raw: string): Nodo | null {
  const m = NODO.exec(raw.trim());
  if (!m) return null;
  const [, id, rect, ovalo, rombo] = m;
  const texto = (rect ?? ovalo ?? rombo ?? id).trim() || id;
  const forma: Forma = rombo !== undefined ? 'rombo' : ovalo !== undefined ? 'ovalo' : 'rect';
  const lineas = partir(texto, forma === 'rombo' ? 16 : 25);
  const longitud = Math.max(...lineas.map((linea) => Array.from(linea).length));
  const ancho = forma === 'rombo'
    ? Math.max(172, Math.min(290, Math.ceil((longitud * 7.8 + 28) * 2)))
    : Math.max(136, Math.min(250, Math.ceil(longitud * 7.6 + 46)));
  const height = forma === 'rombo' ? Math.max(92, lineas.length * 20 + 55) : Math.max(62, lineas.length * 19 + 31);
  return { id, texto, forma, lineas, width: ancho, height };
}

function analizar(texto: string): { nodos: Map<string, Nodo>; aristas: Arista[] } | null {
  const nodos = new Map<string, Nodo>();
  const aristas: Arista[] = [];
  for (const original of texto.split(/\r?\n/)) {
    const linea = original.trim();
    if (!linea || linea.startsWith('#')) continue;
    const flecha = FLECHA.exec(linea);
    if (!flecha) {
      const nodo = leerNodo(linea);
      if (!nodo) return null;
      nodos.set(nodo.id, nodo);
      continue;
    }
    const origen = leerNodo(linea.slice(0, flecha.index));
    let destino = linea.slice(flecha.index + flecha[0].length).trim();
    const etiqueta = /^\|([^|]{0,80})\|\s*/.exec(destino);
    if (etiqueta) destino = destino.slice(etiqueta[0].length);
    const fin = leerNodo(destino);
    if (!origen || !fin) return null;
    // Un uso posterior de A[Etiqueta] completa la declaración previa A (sin etiqueta).
    for (const nodo of [origen, fin]) if (!nodos.has(nodo.id) || nodo.texto !== nodo.id) nodos.set(nodo.id, nodo);
    aristas.push({ desde: origen.id, hasta: fin.id, etiqueta: etiqueta?.[1].trim() || '', tipo: flecha[1] });
    if (nodos.size > MAX_NODOS || aristas.length > MAX_ARISTAS) return null;
  }
  return aristas.length ? { nodos, aristas } : null;
}

export const esAscii = (cuerpo: string): boolean => {
  const lineas = String(cuerpo ?? '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lineas.length < 2) return false;
  const dibujo = lineas.filter((l) => /[┌┐└┘├┤┬┴┼│─━┃┏┓┗┛╔╗╚╝║═╭╮╰╯▶◀▲▼]/.test(l)
    || /\+[-=]{2,}\+/.test(l) || /-{1,}->|<-{1,}|=>/.test(l) || /^\s*\|.*\|\s*$/.test(l)).length;
  const codigo = lineas.filter((l) => /[;{}]\s*$/.test(l)
    || /^\s*(fn |def |class |impl |pub |let |const |var |import |from |#include|SELECT|CREATE )/.test(l)).length;
  return dibujo >= 2 && dibujo >= codigo;
};

function curva(puntos: { x: number; y: number }[]): string {
  if (puntos.length < 2) return '';
  // Los puntos de Dagre ya están calculados alrededor de los nodos. El camino pasa por ellos,
  // y redondea esquinas; no calcula rectas a ojo atravesando las cajas.
  let d = `M ${numero(puntos[0].x)} ${numero(puntos[0].y)}`;
  for (let i = 1; i < puntos.length - 1; i++) {
    const a = puntos[i - 1], b = puntos[i], c = puntos[i + 1];
    const r = Math.min(12, Math.hypot(b.x - a.x, b.y - a.y) / 3, Math.hypot(c.x - b.x, c.y - b.y) / 3);
    const ab = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const bc = Math.hypot(c.x - b.x, c.y - b.y) || 1;
    d += ` L ${numero(b.x - (b.x - a.x) * r / ab)} ${numero(b.y - (b.y - a.y) * r / ab)}`;
    d += ` Q ${numero(b.x)} ${numero(b.y)} ${numero(b.x + (c.x - b.x) * r / bc)} ${numero(b.y + (c.y - b.y) * r / bc)}`;
  }
  const fin = puntos[puntos.length - 1];
  return `${d} L ${numero(fin.x)} ${numero(fin.y)}`;
}

export const grafoSvg = (entrada: string): string => {
  const fuente = String(entrada ?? '');
  const analizado = analizar(fuente);
  if (!analizado) return '';
  const { nodos, aristas } = analizado;
  const grafo = new Graph({ multigraph: true });
  grafo.setGraph({ rankdir: 'TB', align: 'UL', nodesep: 56, edgesep: 24, ranksep: 84, marginx: 32, marginy: 30 });
  grafo.setDefaultEdgeLabel(() => ({}));
  for (const nodo of nodos.values()) grafo.setNode(nodo.id, { width: nodo.width, height: nodo.height });
  aristas.forEach((arista, i) => grafo.setEdge(arista.desde, arista.hasta, {
    minlen: 1, weight: 2,
    width: arista.etiqueta ? Math.max(48, Array.from(arista.etiqueta).length * 7 + 22) : 0,
    height: arista.etiqueta ? 23 : 0,
  }, String(i)));
  try { layout(grafo); } catch { return ''; }
  const { width, height } = grafo.graph();
  if (!Number.isFinite(width) || !Number.isFinite(height) || width > 4200 || height > 5200) return '';
  const w = Math.ceil(width), h = Math.ceil(height);
  // Los SVG conviven en el mismo transcript: un id de marker fijo haría que todas las
  // flechas apuntasen al marker del primer diagrama (y se mezclasen entre temas y replays).
  let hash = 2166136261;
  for (let i = 0; i < fuente.length; i++) hash = Math.imul(hash ^ fuente.charCodeAt(i), 16777619);
  const punta = `grafo-punta-${(hash >>> 0).toString(36)}`;
  // viewBox natural + tamaño de origen: en escritorio se ajusta al ancho disponible; en móvil
  // la lámina permite scroll horizontal cuando reducirla volvería ilegible el texto.
  let html = `<figure class="grafo-lamina" data-grafo="1"><div class="grafo-canvas">`;
  html += `<svg class="grafo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Diagrama de flujo">`;
  html += `<defs><marker id="${punta}" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 1 1 L 10 6 L 1 11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>`;
  aristas.forEach((arista, i) => {
    const p = grafo.edge({ v: arista.desde, w: arista.hasta, name: String(i) });
    if (!p?.points?.length) return;
    const clase = arista.tipo === '-.->' ? 'grafo-arista es-punteada' : arista.tipo === '==>' ? 'grafo-arista es-fuerte' : 'grafo-arista';
    html += `<path class="${clase}" d="${curva(p.points)}" marker-end="url(#${punta})"/>`;
    if (arista.etiqueta && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      const ancho = Math.max(48, Array.from(arista.etiqueta).length * 7 + 22);
      html += `<g class="grafo-etiqueta" transform="translate(${numero(p.x)} ${numero(p.y)})"><rect x="${numero(-ancho / 2)}" y="-12" width="${numero(ancho)}" height="24" rx="9"/><text text-anchor="middle" dominant-baseline="middle">${escape(arista.etiqueta)}</text></g>`;
    }
  });
  for (const nodo of nodos.values()) {
    const p = grafo.node(nodo.id);
    if (!p) continue;
    const x = p.x - nodo.width / 2, y = p.y - nodo.height / 2;
    const clase = nodo.forma === 'rombo' ? 'grafo-nodo es-decision' : nodo.forma === 'ovalo' ? 'grafo-nodo es-ovalo' : 'grafo-nodo';
    html += `<g class="${clase}">`;
    if (nodo.forma === 'rombo') {
      html += `<path class="grafo-forma" d="M ${numero(p.x)} ${numero(y)} L ${numero(x + nodo.width)} ${numero(p.y)} L ${numero(p.x)} ${numero(y + nodo.height)} L ${numero(x)} ${numero(p.y)} Z"/>`;
    } else {
      html += `<rect class="grafo-forma" x="${numero(x)}" y="${numero(y)}" width="${nodo.width}" height="${nodo.height}" rx="${nodo.forma === 'ovalo' ? Math.round(nodo.height / 2) : 13}"/>`;
    }
    const inicio = p.y - ((nodo.lineas.length - 1) * 19) / 2;
    html += `<text class="grafo-texto" x="${numero(p.x)}" y="${numero(inicio)}" text-anchor="middle" dominant-baseline="middle">`;
    nodo.lineas.forEach((linea, i) => { html += `<tspan x="${numero(p.x)}" dy="${i ? 19 : 0}">${escape(linea)}</tspan>`; });
    html += '</text></g>';
  }
  return `${html}</svg></div><div class="grafo-pie"><span>Diagrama</span><span>${nodos.size} nodos · ${aristas.length} conexiones</span></div></figure>`;
};

// Panel de gasto y uso.
//
// Hasta ahora el panel mostraba solo lo que el motor manda por `usage_update`: el costo de esta
// sesión y lo que ocupa el contexto. Eso alcanza para saber "cuánto llevo acá", no para responder
// las preguntas que importan: cuánto gasté hoy, qué modelo se lleva la plata, a qué hora, si el
// cache está funcionando y cuánto va a costar el mes a este ritmo.
//
// Todo eso YA existe: el server web agrega la tabla `usage_ledger` (44.500 llamadas) en
// /stats.json?days=N. Este módulo lo convierte en el panel. Funciones puras: reciben datos y
// devuelven HTML, así el gate las prueba sin navegar.

import { esc } from './format';

export type FilaDia = { d: string; calls: number; cost: number; input: number; output: number; cache: number };
export type FilaModelo = {
  model: string; calls: number; cost: number; input: number; output: number;
  cacheRead?: number; cacheHitPct?: number; costPerCall?: number; share?: number; lastTs?: number;
};
export type FilaSesion = { sid: string; name?: string; calls: number; cost: number; input: number; output: number; lastTs?: number };
export type FilaHora = { h: number; calls: number; cost: number };
export type FilaLlamada = { sid: string; model: string; cost: number; input: number; output: number; ts: number };
export type FilaFuente = { source: string; calls: number; cost: number };
export type FilaProveedor = { provider: string; label?: string; calls: number; tokens: number; estimatedUsd: number; planUsd?: number | null };

export type Stats = {
  generatedAt?: string;
  days?: number;
  totals?: {
    calls?: number; cost?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number;
    noCostCalls?: number; withCostCalls?: number; sessions?: number; compactionCalls?: number;
    compactionCost?: number; cacheHitPct?: number;
  };
  percentiles?: { p50?: number; p95?: number; p99?: number; max?: number };
  daily?: FilaDia[];
  models?: FilaModelo[];
  hours?: FilaHora[];
  costSources?: FilaFuente[];
  sessions?: FilaSesion[];
  topCalls?: FilaLlamada[];
  byProvider?: FilaProveedor[];
  planWindow?: { periodDays?: number; daysInMonth?: number; factor?: number; prorated?: boolean };
  _error?: string;
};

export type CtxUso = {
  used?: number | null; limit?: number | null; cost?: number | null;
  inTok?: number | null; outTok?: number | null;
  autoCompactAt?: number | null; autoCompactPct?: number | null;
  /** Desglose de que compone el contexto, del server (`contextBreakdown`). */
  contextBreakdown?: Array<{ label?: string; kind?: string; tokens?: number; count?: number }>;
  last?: any; compactionLog?: any[]; modelUsage?: any[]; compactionCalls?: number | null;
};

const nf = new Intl.NumberFormat('es-AR');

export function tok(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace('.', ',') + ' k';
  // "1,00 M" se lee como precision falsa: si son millones redondos, se muestra "1 M".
  if (n < 1e9) return (n / 1e6).toFixed(2).replace('.', ',').replace(',00', '') + ' M';
  return (n / 1e9).toFixed(2).replace('.', ',').replace(',00', '') + ' B';
}

export function usd(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n === 0) return 'US$ 0';
  if (Math.abs(n) < 0.01) return 'US$ ' + n.toFixed(4).replace('.', ',');
  if (Math.abs(n) < 1) return 'US$ ' + n.toFixed(3).replace('.', ',');
  return 'US$ ' + nf.format(Math.round(n * 100) / 100);
}

const dia = (iso: string): string => {
  const p = String(iso || '').split('-');
  return p.length === 3 ? p[2] + '/' + p[1] : String(iso || '');
};

const hora = (ts: number | undefined): string => {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0')
    + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
};

/** Tabs del período. El elegido se marca con aria-pressed y clase is-on. */
export function tabsPeriodo(dias: number, cargando: boolean): string {
  const opciones: [number, string][] = [[1, 'Hoy'], [7, '7 días'], [30, '30 días'], [0, 'Todo']];
  return '<div class="gs-tabs" role="group" aria-label="Período">'
    + opciones.map(([d, t]) => '<button type="button" class="gs-tab' + (d === dias ? ' is-on' : '')
      + '" data-dias="' + d + '" aria-pressed="' + (d === dias) + '">' + t + '</button>').join('')
    + (cargando ? '<span class="gs-loading" aria-live="polite">…</span>' : '')
    + '</div>';
}

/** Barra horizontal proporcional. Ancho relativo al máximo del conjunto. */
function barras(filas: { etiqueta: string; valor: number; texto: string; nota?: string }[], max: number, clase = ''): string {
  const m = max > 0 ? max : 1;
  return '<div class="gs-bars' + (clase ? ' ' + clase : '') + '">' + filas.map((f) => {
    const pct = Math.max(f.valor > 0 ? 1.5 : 0, (f.valor / m) * 100);
    return '<div class="gs-bar"><span class="gs-bar-k">' + esc(f.etiqueta) + '</span>'
      + '<span class="gs-bar-t"><i style="width:' + pct.toFixed(1) + '%"></i></span>'
      + '<span class="gs-bar-v">' + f.texto + '</span>'
      + (f.nota ? '<span class="gs-bar-n">' + esc(f.nota) + '</span>' : '')
      + '</div>';
  }).join('') + '</div>';
}

function sec(t: string, glosa?: string): string {
  return '<div class="gs-sec"><span>' + esc(t) + '</span>' + (glosa ? '<em>' + esc(glosa) + '</em>' : '') + '</div>';
}

function fila(k: string, v: string, clase?: string): string {
  return '<div class="gs-r"><span>' + esc(k) + '</span><b' + (clase ? ' class="' + clase + '"' : '') + '>' + v + '</b></div>';
}

/**
 * Ventana del modelo: lo que la IA tiene cargado AHORA en este turno y cuánto le queda.
 * Es distinto del total de la sesión: `used` (usage_update) es el historial entero que el motor
 * reenvía, mientras que la última llamada (last.inputTokens + outputTokens) es lo que realmente
 * entró en la ventana. `limit` en cambio es el UMBRAL de compactación, no el techo del modelo: el
 * techo se deriva del porcentaje que manda el server.
 */
function ventanaModelo(ctx: CtxUso): string {
  const mu: any = ctx.last || {};
  const usado = mu.inputTokens != null ? (mu.inputTokens || 0) + (mu.outputTokens || 0) : null;
  const umbral = ctx.autoCompactAt || null;
  const pctAuto = ctx.autoCompactPct || null;
  const techo = umbral && pctAuto ? Math.round(umbral / (pctAuto > 1 ? pctAuto / 100 : pctAuto)) : (ctx.limit || null);
  const p = techo && usado != null ? Math.min(100, (usado / techo) * 100) : null;
  const libre = techo && usado != null ? Math.max(0, techo - usado) : null;
  const col = p == null ? 'var(--text-4)' : p >= 85 ? 'var(--danger)' : p >= 60 ? 'var(--warn)' : 'var(--ok)';
  if (usado == null) {
    return sec('Ventana del modelo')
      + '<div class="gs-nota">Se mide en el próximo turno: cuánto contexto recibe el modelo y cuánto le queda.</div>';
  }
  return sec('Ventana del modelo', 'este turno')
    + '<div class="gs-duo">'
    +   '<div class="gs-big"><b style="color:' + col + '">' + tok(usado) + '</b>'
    +     '<span>de ' + tok(techo) + ' · quedan ' + tok(libre) + '</span></div>'
    +   '<div class="gs-kpi"><b>' + Math.round(p || 0) + '%</b>'
    +     '<span>' + (umbral ? 'compacta en ' + tok(umbral) : 'sin umbral informado') + '</span></div>'
    + '</div>'
    + '<i class="gs-gauge-bar"><em style="width:' + (p || 0) + '%;background:' + col + '"></em></i>';
}

/**
 * Qué ocupa el contexto. Viene del `contextBreakdown` del motor: resultados de herramientas,
 * prompt de sistema, llamadas, pedidos del operador, turn context. Antes vivía en un panel
 * flotante aparte (context-meter.ts) que se abría desde la barrita del composer; ahora es una
 * sección de este panel, que es el único lugar donde se mira el contexto.
 */
function desglose(ctx: CtxUso): string {
  const filas = (ctx.contextBreakdown || [])
    .map((r) => ({ label: String(r.label || r.kind || '—'), tokens: Number(r.tokens || 0) }))
    .filter((r) => r.tokens > 0);
  if (!filas.length) return '';
  // "oculto por compactación" ya no viaja al modelo: se muestra, pero aparte y después.
  const aparte = (l: string) => /oculto/i.test(l);
  filas.sort((a, b) => (Number(aparte(a.label)) - Number(aparte(b.label))) || (b.tokens - a.tokens));
  const mayor = Math.max(...filas.filter((f) => !aparte(f.label)).map((f) => f.tokens), 1);
  const total = filas.filter((f) => !aparte(f.label)).reduce((n, f) => n + f.tokens, 0);
  return sec('Qué ocupa el contexto', tok(total))
    + barras(filas.map((f) => ({
      etiqueta: f.label,
      valor: f.tokens,
      texto: tok(f.tokens) + (aparte(f.label) ? ' · fuera del envío' : ''),
    })), mayor, 'gs-bars-ctx');
}

/** Bloque de esta sesión: es lo único que no viene de /stats.json. */
function sesionActual(ctx: CtxUso): string {
  const usado = ctx.used;
  const limite = ctx.limit;
  const pct = limite && usado != null ? Math.min(100, (usado / limite) * 100) : null;
  const col = pct == null ? 'var(--text-4)' : pct >= 80 ? 'var(--danger)' : pct >= 50 ? 'var(--warn)' : 'var(--ok)';
  const sesTok = ctx.inTok != null || ctx.outTok != null ? (ctx.inTok || 0) + (ctx.outTok || 0) : null;
  const mu: any = ctx.last || {};
  const llamadas = Array.isArray(ctx.modelUsage) && ctx.modelUsage.length
    ? ctx.modelUsage.reduce((n: number, m: any) => n + (m.calls || 0), 0) + (ctx.compactionCalls || 0) : null;
  const porPaso = llamadas && sesTok != null && llamadas > 0 ? Math.round(sesTok / llamadas) : null;
  const margen = limite && usado != null ? Math.max(0, limite - usado) : null;
  // Sin sesion abierta (o antes del primer turno) no hay nada que decir: tres filas con guion se
  // leen como un panel roto. Una linea alcanza.
  if (usado == null && ctx.cost == null) {
    return sec('Este chat') + '<div class="gs-nota">El costo y el contexto de este chat aparecen después del primer turno.</div>';
  }
  return sec('Este chat', 'en vivo')
    + '<div class="gs-duo">'
    +   '<div class="gs-big"><b>' + usd(ctx.cost) + '</b><span>' + (sesTok == null ? 'sin tokens medidos' : tok(sesTok) + ' tokens') + '</span></div>'
    +   '<div class="gs-gauge"><b style="color:' + col + '">' + (pct == null ? '—' : Math.round(pct) + '%') + '</b>'
    +     '<i><em style="width:' + (pct == null ? 0 : pct) + '%;background:' + col + '"></em></i>'
    +     '<span>' + (usado == null ? 'sin medir' : tok(usado) + ' de ' + tok(limite)) + '</span></div>'
    + '</div>'
    + fila('llamadas', llamadas == null ? '—' : String(llamadas) + (porPaso != null ? ' · ' + tok(porPaso) + ' por paso' : ''))
    + fila('último paso', mu.cost != null ? usd(mu.cost) : (mu.outputTokens != null ? tok(mu.outputTokens) + ' tok' : 'se llena con el próximo turno'))
    + fila('margen', margen == null ? '—' : tok(margen) + ' antes de compactar');
}

/** Bloque del período. Devuelve '' si no hay datos. */
function periodo(s: Stats): string {
  const t = s.totals || {};
  const pw = s.planWindow || {};
  const dias = s.days || 0;
  // Proyección mensual con el factor que ya calcula el server (días del mes / días del período).
  const proyeccion = t.cost != null && pw.factor ? t.cost / pw.factor : null;
  let out = '<div class="gs-duo">'
    + '<div class="gs-big"><b>' + usd(t.cost) + '</b><span>'
    + nf.format(t.calls || 0) + ' llamadas · ' + nf.format(t.sessions || 0) + ' chats</span></div>'
    + '<div class="gs-kpi"><b>' + (proyeccion == null ? '—' : usd(proyeccion)) + '</b><span>al mes a este ritmo</span></div>'
    + '</div>';
  const hoy = (s.daily || []).slice(-1)[0];
  if (hoy && dias !== 1) out += fila('hoy', usd(hoy.cost) + ' · ' + nf.format(hoy.calls) + ' llamadas');
  if (t.cacheHitPct != null) out += fila('cache', Math.round(t.cacheHitPct) + '% de la entrada vino de cache', 'ok');
  if (t.compactionCalls) out += fila('compactaciones', String(t.compactionCalls) + ' · ' + usd(t.compactionCost));
  return out;
}

/** Barras por día (los últimos N del período). */
function porDia(s: Stats): string {
  const d = (s.daily || []).slice(-10);
  if (!d.length) return '';
  const max = Math.max(...d.map((x) => x.cost));
  return sec('Gasto por día')
    + barras(d.map((x) => ({
      etiqueta: dia(x.d),
      valor: x.cost,
      texto: usd(x.cost),
      nota: nf.format(x.calls) + ' llamadas',
    })), max);
}

function porModelo(s: Stats): string {
  const m = (s.models || []).slice(0, 6);
  if (!m.length) return '';
  return sec('Por modelo')
    + m.map((x) => '<div class="gs-m">'
      + '<span class="gs-m-k">' + esc(x.model) + '</span>'
      + '<b class="gs-m-c">' + usd(x.cost) + '</b>'
      + '<i class="gs-m-b"><em style="width:' + Math.max(1, Math.round(x.share || 0)) + '%"></em></i>'
      + '<span class="gs-m-n">' + Math.round(x.share || 0) + '% · '
        + (x.costPerCall != null ? usd(x.costPerCall) + '/llam' : nf.format(x.calls) + ' llam')
        + (x.cacheHitPct != null ? ' · cache ' + Math.round(x.cacheHitPct) + '%' : '')
      + '</span></div>').join('');
}

function composicion(s: Stats): string {
  const t = s.totals || {};
  if (t.input == null) return '';
  // "100% de la entrada" y "93% de cache" al lado se leen como si sumaran: el cache ES parte de la
  // entrada. Se muestra la entrada partida en cache y fresca, y la salida aparte.
  const input = t.input || 0;
  const cache = Math.min(t.cacheRead || 0, input);
  const fresca = Math.max(0, input - cache);
  const pctEntrada = (n: number) => input > 0 ? Math.round((n / input) * 100) + '% de la entrada' : '';
  return sec('Qué se paga')
    + fila('entrada', tok(input) + ' tok')
    + fila('  de eso cache', tok(cache) + (input ? ' · ' + pctEntrada(cache) : ''))
    + fila('  fresca', tok(fresca) + (input ? ' · ' + pctEntrada(fresca) : ''))
    + fila('salida', tok(t.output) + ' tok')
    + (t.cacheWrite ? fila('cache escrito', tok(t.cacheWrite) + ' tok') : '');
}

function sesionesCaras(s: Stats): string {
  const l = (s.sessions || []).slice(0, 4);
  if (!l.length) return '';
  return sec('Chats más caros')
    + l.map((x) => '<div class="gs-s"><span class="gs-s-k">' + esc(String(x.name || x.sid).slice(0, 42)) + '</span>'
      + '<b>' + usd(x.cost) + '</b><span class="gs-s-n">' + nf.format(x.calls) + ' llam</span></div>').join('');
}

function llamadasCaras(s: Stats): string {
  const l = (s.topCalls || []).slice(0, 3);
  if (!l.length) return '';
  return sec('Llamadas más caras')
    + l.map((x) => fila(hora(x.ts) + ' · ' + String(x.model).slice(0, 18), usd(x.cost) + ' · ' + tok(x.input) + ' tok')).join('');
}

function procedencia(s: Stats): string {
  const f = s.costSources || [];
  const est = f.find((x) => x.source === 'estimated');
  const rep = f.find((x) => x.source === 'provider_reported');
  const p = s.percentiles || {};
  if (!est && !rep) return '';
  return sec('De dónde sale el número')
    + (est ? fila('estimado', nf.format(est.calls) + ' llam · ' + usd(est.cost)) : '')
    + (rep ? fila('informado', nf.format(rep.calls) + ' llam · ' + usd(rep.cost)) : '')
    + fila('mediana', usd(p.p50) + ' por llamada')
    + fila('p95', usd(p.p95))
    + fila('la más cara', usd(p.max));
}

/**
 * Cuerpo completo del panel. `s` es null mientras carga; `error` si el fetch falló.
 */
export function cuerpoGasto(o: { dias: number; stats: Stats | null; cargando: boolean; error?: string; ctx: CtxUso }): string {
  let out = tabsPeriodo(o.dias, o.cargando);
  if (o.error) {
    out += sec('Gasto del período') + '<div class="gs-nota">No se pudo leer el historial: ' + esc(o.error) + '</div>';
  } else if (!o.stats) {
    out += sec('Gasto del período') + '<div class="gs-nota">Leyendo el historial…</div>';
  } else if (o.stats._error) {
    out += sec('Gasto del período') + '<div class="gs-nota">No se pudo leer el historial: ' + esc(o.stats._error) + '</div>';
  } else {
    out += sec('Gasto del período', (o.stats.days ? o.stats.days + ' días' : 'todo el historial'));
    out += periodo(o.stats);
    out += porDia(o.stats);
    out += porModelo(o.stats);
    out += composicion(o.stats);
    out += sesionesCaras(o.stats);
    out += llamadasCaras(o.stats);
    out += procedencia(o.stats);
  }
  // Este chat va al final: es el dato mas chico y el que cambia solo mientras hay un turno.
  out += ventanaModelo(o.ctx);
  out += desglose(o.ctx);
  out += sesionActual(o.ctx);
  return out;
}

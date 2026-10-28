/* Medidor de contexto y costo en el composer (M1) + mapa de que ocupa el contexto (M2).
 *
 * Por que existe: el contexto y el costo viven en el popover de informacion del header
 * (`usageLines()`), o sea que se miran despues de decidir. El estudio los pide donde se decide:
 * una barra fina pegada al composer, siempre visible, que se abre al tocarla.
 *
 * No inventa estado: lee `window.__aegisWeb.usageState()` (el mismo objeto que usa el panel de
 * informacion, alimentado por `usage_update` del server) y `contextBreakdown`. Si el server todavia
 * no informo nada, la barra no se dibuja.
 */

interface BreakdownRow {
  label?: string;
  name?: string;
  key?: string;
  kind?: string;
  tokens?: number;
  value?: number;
  count?: number;
  chars?: number;
  messages?: number;
}

interface UsageState {
  used?: number;
  limit?: number;
  inTok?: number;
  outTok?: number;
  contextBreakdown?: BreakdownRow[];
  /** Tokens a los que el server compacta solo (campo `n` del wire: auto_compact_at). */
  n?: number;
  last?: Record<string, unknown>;
  model?: string;
  provider?: string;
}

interface PriceRow {
  input?: number | null;
  output?: number | null;
  inputEffective?: number | null;
}

declare global {
  interface Window {
    __aegisWeb?: {
      usageState?: () => UsageState | null;
      usageLines?: () => string[];
      state?: Record<string, unknown>;
    };
    __aegisCtxMeter?: { refresh: () => void };
  }
}

const COMPACT_RATIO = 0.8;
const TICK_MS = 1200;

const CSS = `
.ctx-meter{max-width:820px;margin:0 auto;display:flex;align-items:center;gap:10px;padding:2px 4px 6px;font:12px/1.4 system-ui,Segoe UI,sans-serif;color:#93a2b8;cursor:pointer;user-select:none;background:transparent;border:0;width:100%;text-align:left}
.ctx-meter:hover .ctx-track{background:rgba(255,255,255,.14)}
.ctx-meter .ctx-track{position:relative;flex:1;height:4px;border-radius:999px;background:rgba(255,255,255,.08);overflow:hidden}
.ctx-meter .ctx-fill{position:absolute;inset:0 auto 0 0;width:0;border-radius:999px;transition:width .3s ease,background .3s ease}
.ctx-meter .ctx-fill.ok{background:#4ade80}
.ctx-meter .ctx-fill.warn{background:#fbbf24}
.ctx-meter .ctx-fill.bad{background:#f87171}
.ctx-meter .ctx-mark{position:absolute;top:-2px;bottom:-2px;width:2px;background:rgba(255,255,255,.45)}
.ctx-meter .ctx-label{white-space:nowrap;font-variant-numeric:tabular-nums}
.ctx-meter .ctx-cost{white-space:nowrap;color:#c8d3e2}
@media (max-width:640px){.ctx-meter .ctx-long{display:none}}
.ctx-map{position:fixed;z-index:9200;background:var(--panel,#14181f);color:var(--fg,#e7edf5);border:1px solid rgba(255,255,255,.1);border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.5);padding:12px 14px;width:min(460px,92vw);font:12.5px/1.45 system-ui,Segoe UI,sans-serif}
.ctx-map h3{margin:0 0 8px;font-size:13px;font-weight:650}
.ctx-map .row{display:grid;grid-template-columns:120px 1fr auto;gap:8px;align-items:center;margin:5px 0}
.ctx-map .bar{height:6px;border-radius:999px;background:rgba(255,255,255,.08);overflow:hidden}
.ctx-map .bar i{display:block;height:100%;background:#5b8def}
.ctx-map .num{color:#93a2b8;font-variant-numeric:tabular-nums}
.ctx-map .foot{display:flex;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap}
.ctx-map button{cursor:pointer;background:rgba(255,255,255,.06);color:inherit;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:4px 9px;font:inherit}
.ctx-map button:hover{background:rgba(255,255,255,.12)}
.ctx-map .muted{color:#93a2b8}
`;

function fmtTok(n: number): string {
  if (!Number.isFinite(n)) return '?';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'k';
  return String(Math.round(n));
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 0.01) return '$' + n.toFixed(4);
  return '$' + n.toFixed(2);
}

function rowTokens(row: BreakdownRow): number {
  for (const key of ['tokens', 'value', 'count', 'chars'] as const) {
    const raw = row[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  }
  return 0;
}

function rowLabel(row: BreakdownRow): string {
  const label = row.label || row.name || row.kind || row.key || 'otros';
  return String(label).replace(/[_-]+/g, ' ');
}

function ensureStyle(): void {
  if (document.getElementById('aegis-ctx-style')) return;
  const style = document.createElement('style');
  style.id = 'aegis-ctx-style';
  style.textContent = CSS;
  document.head.appendChild(style);
}

function turnCost(usage: UsageState): number {
  const last = (usage.last || {}) as Record<string, unknown>;
  for (const key of ['estimatedCostUsd', 'costUsd', 'cost_usd', 'cost']) {
    const raw = last[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  }
  return 0;
}

function modelLabel(usage: UsageState): string {
  if (usage.model) return String(usage.model);
  const state = (window.__aegisWeb?.state || {}) as Record<string, unknown>;
  for (const key of ['model', 'modelName', 'activeModel']) {
    const raw = state[key];
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
  }
  // El texto de `#meta-right` trae "16% · 165.2k/1M tok · $0.927": tomarlo como nombre de modelo
  // metia "16% — en uso" en el selector. Como ultimo recurso se usa el chip del composer, que si
  // muestra el modelo, y se descarta cualquier candidato con forma de cifra.
  const chip = document.querySelector<HTMLElement>('.model-chip, [data-role="model"], #model-chip');
  const candidato = (chip?.textContent || '').trim();
  if (candidato && !/^\d/.test(candidato) && !candidato.includes('%')) return candidato;
  return '';
}

interface Meter {
  root: HTMLButtonElement;
  fill: HTMLDivElement;
  label: HTMLSpanElement;
  cost: HTMLSpanElement;
  mark: HTMLDivElement;
}

let prices: Record<string, PriceRow> = {};
let pricesLoaded = false;

/// Tarifas por 1M tokens, derivadas del propio store (`/prices.json`). No son factura: si el modelo
/// no aparece, el tooltip lo dice en vez de inventar un numero.
function loadPrices(): void {
  if (pricesLoaded) return;
  pricesLoaded = true;
  fetch('/prices.json', { cache: 'force-cache' })
    .then((response) => (response.ok ? response.json() : {}))
    .then((data: Record<string, PriceRow>) => {
      prices = data || {};
    })
    .catch(() => {
      prices = {};
    });
}

function priceFor(provider: string, model: string): PriceRow | null {
  if (!model) return null;
  const exact = provider ? prices[`${provider}/${model}`] : undefined;
  if (exact) return exact;
  const suffix = `/${model}`;
  for (const [key, row] of Object.entries(prices)) {
    if (key.startsWith('_')) continue;
    if (key.endsWith(suffix)) return row;
  }
  return null;
}

function providerLabel(usage: UsageState | null): string {
  if (usage?.provider) return String(usage.provider);
  const state = (window.__aegisWeb?.state || {}) as Record<string, unknown>;
  for (const key of ['provider', 'providerName']) {
    const raw = state[key];
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
  }
  return '';
}

let meter: Meter | null = null;
let map: HTMLDivElement | null = null;

function buildMeter(): Meter {
  const root = document.createElement('button');
  root.type = 'button';
  root.className = 'ctx-meter';
  root.setAttribute('aria-label', 'Contexto y costo del turno. Tocar para ver el desglose.');

  const track = document.createElement('div');
  track.className = 'ctx-track';
  const fill = document.createElement('div');
  fill.className = 'ctx-fill ok';
  const mark = document.createElement('div');
  mark.className = 'ctx-mark';
  mark.style.display = 'none';
  track.append(fill, mark);

  const label = document.createElement('span');
  label.className = 'ctx-label';
  const cost = document.createElement('span');
  cost.className = 'ctx-cost';

  root.append(track, label, cost);
  root.addEventListener('click', () => toggleMap(root));
  return { root, fill, label, cost, mark };
}

function placeMeter(): Meter | null {
  if (meter && document.body.contains(meter.root)) return meter;
  const wrap = document.querySelector('footer.composer-wrap');
  if (!wrap) return null;
  ensureStyle();
  meter = buildMeter();
  wrap.insertBefore(meter.root, wrap.firstChild);
  return meter;
}

function renderMeter(usage: UsageState | null): void {
  const m = placeMeter();
  if (!m) return;
  const used = typeof usage?.used === 'number' ? usage.used : null;
  if (used == null) {
    m.root.style.display = 'none';
    return;
  }
  m.root.style.display = 'flex';
  const limit = typeof usage?.limit === 'number' && usage.limit > 0 ? usage.limit : null;
  const techo = typeof usage?.n === 'number' && usage.n > 0 ? usage.n : limit ? limit * COMPACT_RATIO : 0;
  const pct = techo ? Math.min(100, (used / techo) * 100) : 0;
  const tone = pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : 'ok';
  m.fill.style.width = (limit ? pct : 100) + '%';
  m.fill.className = 'ctx-fill ' + tone;

  if (limit) {
    // El trigger lo manda el server (auto_compact_at). El 0,8 fijo mentia: con techo de 350k en un
    // modelo de 1M la marca se dibujaba en 800k y parecia que faltaba un mundo cuando en realidad
    // estabas a un turno de la compactacion automatica.
    const trigger = typeof usage?.n === 'number' && usage.n > 0 ? usage.n : limit * COMPACT_RATIO;
    const ratio = Math.min(1, trigger / limit);
    m.mark.style.display = 'block';
    m.mark.style.left = ratio * 100 + '%';
    m.label.textContent = `contexto ${fmtTok(used)} de ${fmtTok(trigger)} · ${fmtTok(Math.max(0, trigger - used))} libres`;
    m.label.title = `ventana ${fmtTok(limit)} · compacta sola a ~${fmtTok(trigger)}`;
  } else {
    m.mark.style.display = 'none';
    m.label.textContent = `contexto ${fmtTok(used)} tok`;
    m.label.title = 'el server no informo el limite de contexto';
  }
  const usd = turnCost(usage as UsageState);
  const model = modelLabel(usage as UsageState);
  const provider = providerLabel(usage);
  m.cost.textContent = [usd ? `turno ${fmtUsd(usd)}` : '', model].filter(Boolean).join(' · ');

  // M7: el chip explica con que tarifa se esta midiendo.
  const price = priceFor(provider, model);
  const lines = [`modelo: ${model || 'sin informar'}`];
  if (provider) lines.push(`proveedor: ${provider}`);
  if (price) {
    const input = typeof price.input === 'number' ? `entrada $${price.input.toFixed(2)} / 1M` : 'entrada sin tarifa';
    const output = typeof price.output === 'number' ? `salida $${price.output.toFixed(2)} / 1M` : 'salida sin tarifa';
    lines.push(`${input} · ${output}`);
    if (typeof price.inputEffective === 'number') lines.push(`efectivo $${price.inputEffective.toFixed(2)} / 1M de entrada (mezcla real del store)`);
  } else {
    lines.push('sin tarifa derivada para este modelo: el costo del turno sale del usage del server');
  }
  if (usd) lines.push(`este turno: ${fmtUsd(usd)}`);
  m.cost.title = lines.join('\n');
}

function closeMap(): void {
  if (map) {
    map.remove();
    map = null;
  }
}

function toggleMap(anchor: HTMLElement): void {
  if (map) {
    closeMap();
    return;
  }
  const usage = window.__aegisWeb?.usageState?.() || null;
  const rows = (usage?.contextBreakdown || []).map((row) => ({ label: rowLabel(row), tokens: rowTokens(row) }));
  rows.sort((a, b) => b.tokens - a.tokens);

  map = document.createElement('div');
  map.className = 'ctx-map';
  const title = document.createElement('h3');
  const used = typeof usage?.used === 'number' ? usage.used : rows.reduce((sum, r) => sum + r.tokens, 0);
  title.textContent = `Que ocupa el contexto · ${fmtTok(used)} tok`;
  map.appendChild(title);

  if (!rows.length) {
    const muted = document.createElement('div');
    muted.className = 'muted';
    muted.textContent = 'El server todavia no mando el desglose de este turno.';
    map.appendChild(muted);
  } else {
    const total = rows.reduce((sum, r) => sum + r.tokens, 0) || used || 1;
    for (const row of rows) {
      const line = document.createElement('div');
      line.className = 'row';
      const label = document.createElement('span');
      label.textContent = row.label;
      const bar = document.createElement('div');
      bar.className = 'bar';
      const inner = document.createElement('i');
      inner.style.width = Math.max(1, (row.tokens / total) * 100) + '%';
      bar.appendChild(inner);
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = fmtTok(row.tokens);
      line.append(label, bar, num);
      map.appendChild(line);
    }
    const biggest = rows[0];
    const hint = document.createElement('div');
    hint.className = 'muted';
    hint.textContent = `la mayor: ${biggest.label} (${fmtTok(biggest.tokens)} tok)`;
    map.appendChild(hint);
  }

  const foot = document.createElement('div');
  foot.className = 'foot';
  const compact = document.createElement('button');
  compact.textContent = 'Compactar ahora';
  compact.addEventListener('click', () => {
    const input = document.querySelector<HTMLTextAreaElement>('.composer textarea, .composer [contenteditable="true"], #input');
    if (input) {
      if (input instanceof HTMLTextAreaElement) {
        input.value = '/compact';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
      } else {
        input.textContent = '/compact';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      closeMap();
    }
  });
  const close = document.createElement('button');
  close.textContent = 'Cerrar';
  close.addEventListener('click', closeMap);
  foot.append(compact, close);

  // M7 (segunda mitad): cambiar el modelo de esta sesion sin salir del mapa. La lista sale de las
  // tarifas conocidas del store; el que no figure se puede escribir a mano.
  const models = Object.keys(prices).filter((key) => !key.startsWith('_'));
  if (models.length) {
    const row = document.createElement('div');
    row.className = 'foot';
    row.style.width = '100%';
    const select = document.createElement('select');
    select.style.cssText = 'flex:1;min-width:0;font:inherit;color:inherit;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:4px 6px';
    // El modelo en uso va primero y preseleccionado. Los nombres `…-max` / `…-low` de la tabla de
    // tarifas son variantes de effort, no modelos distintos: se muestran como "modelo · effort" y se
    // elige la fila que coincide con el modelo Y con el effort que muestra el chip de la barra.
    const EFFORTS = ['max', 'high', 'medium', 'low', 'minimal'];
    const conocer = (key: string) => {
      const nombre = key.split('/').slice(1).join('/') || key;
      const effort = EFFORTS.find((e) => nombre.endsWith(`-${e}`)) || '';
      return { value: nombre, base: effort ? nombre.slice(0, -(effort.length + 1)) : nombre, effort, label: key };
    };
    const opciones = models.map(conocer);
    const nombres = new Set(opciones.map((o) => o.value));
    // La verdad esta en la sesion (configOptions), no en el texto de los chips: leer el modelo y el
    // effort de ahi evita que el selector caiga en "elegi uno" cuando el chip dice otra cosa.
    const sesion = (window as any).__aegisWeb?.state?.current;
    const opcionesSesion: any[] = Array.isArray(sesion?.configOptions) ? sesion.configOptions : [];
    const valorSesion = (id: string): string => {
      const encontrado = opcionesSesion.find((o) => o && o.id === id);
      return encontrado ? String(encontrado.currentValue ?? encontrado.value ?? '') : '';
    };
    const effortSesion = valorSesion('thinking_effort');
    let actual = valorSesion('model') || modelLabel((usage || {}) as UsageState);
    const chips = (document.querySelector('#chips')?.textContent || '').trim();
    if (!nombres.has(actual)) {
      // el modelo puede venir con effort pegado, o sin figurar en la tabla
      const porBase = opciones.find((o) => o.base === actual);
      const porChip = opciones.find((o) => o.value && chips.includes(o.value));
      actual = porBase?.value || porChip?.value || '';
    }
    // El effort se lee de los chips uno por uno: el texto del contenedor trae todo junto
    // ("Open Design auto deepseek-v4.1-flash max") y el regex sobre eso no siempre matchea.
    // Se buscan las palabras sueltas de todos los nodos de la fila de chips: el valor puede venir con
    // iconos o texto pegado y la comparacion exacta fallaba.
    const palabras = [...document.querySelectorAll('#chips *')].flatMap((n) =>
      (n.textContent || '').toLowerCase().split(/[^a-z]+/).filter(Boolean),
    );
    const effortEnUso =
      (EFFORTS.includes(effortSesion) ? effortSesion : '') ||
      [...palabras].reverse().find((p) => EFFORTS.includes(p)) ||
      '';
    // Con effort en uso se exige la fila con ese effort; sin effort, la fila pelada.
    const indiceActual = opciones.findIndex(
      (o) => (o.value === actual || o.base === actual) && o.effort === effortEnUso,
    );
    if (indiceActual > 0) {
      const [enUso] = opciones.splice(indiceActual, 1);
      opciones.unshift(enUso);
    }
    if (!actual) {
      const vacia = document.createElement('option');
      vacia.value = '';
      vacia.textContent = '— el modelo en uso no figura en las tarifas: elegí uno —';
      vacia.selected = true;
      select.appendChild(vacia);
    }
    const elegido = indiceActual >= 0 ? opciones[0] : undefined;
    for (const opcion of opciones) {
      const option = document.createElement('option');
      option.value = opcion.value;
      option.textContent = opcion.effort ? `${opcion.label} · effort ${opcion.effort}` : opcion.label;
      option.selected = !!elegido && opcion.value === elegido.value && opcion.effort === elegido.effort;
      select.appendChild(option);
    }
    const aplicar = document.createElement('button');
    aplicar.textContent = 'Aplicar modelo';
    aplicar.addEventListener('click', async () => {
      const rpc = (window.__aegisWeb as unknown as { rpc?: { request<T = void>(m: string, p: Record<string, unknown>): Promise<T> } })?.rpc;
      const state = (window.__aegisWeb?.state || {}) as { current?: { id?: string } };
      const sid = state.current?.id;
      if (!rpc || !sid) return;
      aplicar.disabled = true;
      try {
        if (!select.value) {
          aplicar.textContent = 'elegí un modelo primero';
          aplicar.disabled = false;
          return;
        }
        // El wire usa `value`, no `valueId`: con valueId el server respondia -32602 Invalid params y
        // el boton no hacia nada. Verificado contra v102 por ACP.
        const r = await rpc.request<{ configOptions?: unknown[] }>('session/set_config_option', {
          sessionId: sid,
          configId: 'model',
          value: select.value,
        });
        // El effort viaja como sufijo del modelo en open_design: si eligen `...-max`, se fija tambien
        // el chip de effort para que la barra y el mapa digan lo mismo.
        const effort = /-(max|high|medium|low|minimal)$/.exec(select.value)?.[1];
        if (effort) {
          await rpc.request('session/set_config_option', {
            sessionId: sid,
            configId: 'thinking_effort',
            value: effort,
          });
        }
        if (r && Array.isArray(r.configOptions)) {
          document.dispatchEvent(new CustomEvent('aegis:config-changed', { detail: r.configOptions }));
        }
        closeMap();
      } catch (error) {
        aplicar.textContent = 'falló: ' + String((error as Error).message || error).slice(0, 40);
      } finally {
        aplicar.disabled = false;
      }
    });
    row.append(select, aplicar);
    map.appendChild(row);
  }

  map.appendChild(foot);

  document.body.appendChild(map);
  const rect = anchor.getBoundingClientRect();
  const top = Math.max(8, rect.top - map.offsetHeight - 10);
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - map.offsetWidth - 8);
  map.style.top = `${top}px`;
  map.style.left = `${left}px`;
  const dismiss = (event: MouseEvent) => {
    if (map && !map.contains(event.target as Node) && event.target !== anchor) {
      closeMap();
      document.removeEventListener('mousedown', dismiss);
    }
  };
  document.addEventListener('mousedown', dismiss);
}

function refresh(): void {
  try {
    renderMeter(window.__aegisWeb?.usageState?.() || null);
  } catch {
    /* el medidor nunca rompe el composer */
  }
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMap();
});

loadPrices();
setInterval(refresh, TICK_MS);
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', refresh);
} else {
  refresh();
}
window.__aegisCtxMeter = { refresh };

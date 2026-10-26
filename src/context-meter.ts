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
.ctx-meter{display:flex;align-items:center;gap:10px;padding:2px 4px 6px;font:12px/1.4 system-ui,Segoe UI,sans-serif;color:#93a2b8;cursor:pointer;user-select:none;background:transparent;border:0;width:100%;text-align:left}
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
  const meta = document.getElementById('meta-right');
  const text = (meta?.textContent || '').trim();
  return text.split(/\s+/).slice(0, 1).join(' ');
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
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  const tone = pct >= 75 ? 'bad' : pct >= 50 ? 'warn' : 'ok';
  m.fill.style.width = (limit ? pct : 100) + '%';
  m.fill.className = 'ctx-fill ' + tone;

  if (limit) {
    const trigger = limit * COMPACT_RATIO;
    m.mark.style.display = 'block';
    m.mark.style.left = COMPACT_RATIO * 100 + '%';
    m.label.textContent = `contexto ${fmtTok(used)} / ${fmtTok(limit)} (${Math.round(pct)}%)`;
    m.label.title = `compacta sola a ~${fmtTok(trigger)} · margen ${fmtTok(Math.max(0, trigger - used))} tok`;
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

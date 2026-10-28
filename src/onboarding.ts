/* Estado vacio que ensena (M12).
 *
 * Por que existe: la bienvenida dice "Aegis esta listo" y nada mas. Quien abre la app por primera vez
 * no sabe con que modelo habla, cuanto cuesta, que puede hacer el agente en esta maquina ni por donde
 * empezar en ESTE proyecto.
 *
 * Agrega una tarjeta debajo de `#welcome-meta` con datos reales: modelo y tarifa (del uso de
 * la sesion y `/prices.json`), herramientas (rpc `tools/list`) y objetivos (`/goals.json`).
 * Si un dato no llega, la fila no se dibuja: no se inventa.
 */

interface WelcomeRpc {
  request<T = void>(method: string, params: Record<string, unknown>): Promise<T>;
}

declare global {
  interface Window {
    __aegisWelcome?: { refresh: () => void };
  }
}

const CSS = `
.aegis-onboard{margin:26px auto 0;max-width:560px;text-align:left;border:1px solid rgba(255,255,255,.09);border-radius:12px;padding:14px 16px;background:rgba(255,255,255,.02)}
.aegis-onboard h3{margin:0 0 10px;font-size:12.5px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:#93a2b8}
.aegis-onboard dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:0;font-size:13px}
.aegis-onboard dt{color:#93a2b8}
.aegis-onboard dd{margin:0;color:inherit}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'k';
  return String(Math.round(n));
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

async function collect(): Promise<Array<[string, string]>> {
  const rows: Array<[string, string]> = [];

  const usage = (window.__aegisWeb as unknown as { usageState?: () => Record<string, unknown> | null })?.usageState?.() || null;
  const model = usage && typeof usage.model === 'string' ? usage.model : '';
  if (model) rows.push(['modelo', model]);

  const prices = await getJson<Record<string, { input?: number | null; output?: number | null }>>('/prices.json');
  if (prices && model) {
    for (const [key, row] of Object.entries(prices)) {
      if (key.startsWith('_')) continue;
      if (!key.endsWith('/' + model)) continue;
      const input = typeof row.input === 'number' ? `$${row.input.toFixed(2)}` : '?';
      const output = typeof row.output === 'number' ? `$${row.output.toFixed(2)}` : '?';
      rows.push(['tarifa', `entrada ${input} / salida ${output} por 1M tok (estimada del store, no factura)`]);
      break;
    }
  }

  const limit = usage && typeof usage.limit === 'number' ? usage.limit : 0;
  const trigger = usage && typeof usage.autoCompactAt === 'number' ? usage.autoCompactAt : 0;
  if (limit) rows.push(['contexto', `${fmtTok(limit)} tok${trigger ? ` · compacta a ${fmtTok(trigger)} tok` : ''}`]);

  const rpc = (window.__aegisWeb as unknown as { rpc?: WelcomeRpc })?.rpc;
  if (rpc) {
    try {
      const tools = await rpc.request<{ tools?: Array<{ name?: string }> }>('tools/list', {});
      const names = (tools?.tools || []).map((tool) => String(tool.name || '')).filter(Boolean);
      if (names.length) {
        const escritura = ['write', 'edit', 'shell'].filter((n) => names.some((name) => name.endsWith(n)));
        rows.push(['tools', `${names.length} disponibles · escritura: ${escritura.join(', ') || 'ninguna'}`]);
      }
    } catch {
      /* sin tools/list no se inventa el dato */
    }
  }

  const goals = await getJson<{ items?: Array<{ text?: string; title?: string }> }>('/goals.json');
  const recent = (goals?.items || []).slice(0, 3).map((g) => String(g.text || g.title || '').trim()).filter(Boolean);
  if (recent.length) rows.push(['objetivos', recent.join(' · ')]);

  return rows;
}

async function refresh(): Promise<void> {
  const welcome = document.getElementById('welcome');
  if (!welcome || welcome.hidden || welcome.offsetParent === null) return;
  if (!document.getElementById('aegis-onb-style')) {
    const style = el('style');
    style.id = 'aegis-onb-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const rows = await collect();
  // Sin turno abierto todavia no hay modelo ni uso: la tarjeta se dibuja igual.

  let card = document.getElementById('aegis-onboard');
  if (card) card.remove();
  card = el('div', 'aegis-onboard');
  card.id = 'aegis-onboard';
  card.appendChild(el('h3', undefined, 'Con qué estás hablando'));

  if (rows.length) {
    const dl = el('dl');
    for (const [term, value] of rows) {
      dl.appendChild(el('dt', undefined, term));
      dl.appendChild(el('dd', undefined, value));
    }
    card.appendChild(dl);
  } else {
    card.appendChild(el('p', undefined, 'Todavía no hay turno en esta sesión: el modelo, la tarifa y el consumo aparecen acá después del primero.'));
  }

  const meta = document.getElementById('welcome-meta');
  if (meta && meta.parentElement) meta.parentElement.insertBefore(card, meta.nextSibling);
  else welcome.appendChild(card);
}

let last = 0;
function tick(): void {
  const now = Date.now();
  if (now - last < 4000) return;
  last = now;
  void refresh();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', tick);
} else {
  tick();
}
setInterval(tick, 4000);

window.__aegisWelcome = { refresh: () => void refresh() };

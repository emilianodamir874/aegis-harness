/* Estado vacio que ensena (M12).
 *
 * Por que existe: la bienvenida dice "Aegis esta listo" y nada mas. Quien abre la app por primera vez
 * no sabe con que modelo habla, cuanto cuesta, que puede hacer el agente en esta maquina ni por donde
 * empezar en ESTE proyecto.
 *
 * Agrega una tarjeta debajo de `#welcome-meta` con datos reales, no copy: modelo y tarifa (del uso de
 * la sesion y `/prices.json`), tools disponibles (rpc `tools/list` si esta), ultimos objetivos
 * (`/goals.json`) y skills del store (rpc de sources). Si un dato no llega, la fila no se dibuja: no
 * inventa.
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
.aegis-onboard .sug{margin-top:12px;display:flex;flex-direction:column;gap:6px}
.aegis-onboard .sug button{text-align:left;cursor:pointer;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:7px 10px;color:inherit;font:inherit}
.aegis-onboard .sug button:hover{background:rgba(255,255,255,.11)}
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

function composerInput(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>('.composer textarea');
}

function fillComposer(text: string): void {
  const input = composerInput();
  if (!input) return;
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
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
  if (limit) rows.push(['contexto', `${fmtTok(limit)} tok · compacta sola al 80 %`]);

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

function suggestions(rows: Array<[string, string]>): string[] {
  const model = rows.find(([k]) => k === 'modelo')?.[1] || '';
  const out: string[] = [];
  out.push('¿En qué está trabajando este proyecto? Leé el README, el AGENTS y los últimos commits, y resumí el estado en cinco líneas.');
  if (model) out.push(`Corré la suite de evaluación del harness y decime si hay regresiones desde la última corrida.`);
  out.push('Revisá los últimos errores de los logs y proponé el arreglo más barato, con el archivo y la línea.');
  return out.slice(0, 3);
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
  if (!rows.length) return;

  let card = document.getElementById('aegis-onboard');
  if (card) card.remove();
  card = el('div', 'aegis-onboard');
  card.id = 'aegis-onboard';
  card.appendChild(el('h3', undefined, 'Con qué estás hablando'));

  const dl = el('dl');
  for (const [term, value] of rows) {
    dl.appendChild(el('dt', undefined, term));
    dl.appendChild(el('dd', undefined, value));
  }
  card.appendChild(dl);

  const sug = el('div', 'sug');
  for (const text of suggestions(rows)) {
    const button = el('button');
    button.type = 'button';
    button.textContent = text;
    button.addEventListener('click', () => fillComposer(text));
    sug.appendChild(button);
  }
  card.appendChild(sug);

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

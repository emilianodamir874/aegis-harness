/* Estado del harness en un panel: version desplegada vs proceso vivo, store y knobs de contexto.
   Lee /doctor.json (solo lectura, autenticado). La pregunta que responde es la que hoy se contesta
   con cinco comandos de PowerShell: "¿esto que corre es lo que creo que es?". */
interface DoctorVersion {
  desplegada: string | null; exe: string | null; commit: string | null; sha256: string | null;
  version: string | null; promovidaEl: string | null; por: string | null;
}
interface DoctorCheck { nombre: string; estado: string; detalle: string }
interface DoctorGate {
  cuando: string | null; estado: string | null; profundo: boolean | null; tag: string | null;
  motivos: string[]; chequeos: DoctorCheck[];
}
interface DoctorReport {
  ahora: string;
  version: DoctorVersion;
  ultimoBuild: { tag: string | null; perfil: string | null; sha256: string | null; cuando: string | null; dirty: boolean | null } | null;
  serve: { vivo: boolean; pid?: number | null; uptimeS?: number | null; backend?: unknown; error?: string | null };
  store: { dbBytes: number | null; walBytes: number | null; shmBytes: number | null };
  compactacion: { techoTokens: number | null; umbral: number | null };
  gate: DoctorGate | null;
}
declare global {
  interface Window {
    __aegisDoctor?: { open: () => Promise<void>; close: () => void; refresh: () => Promise<void> };
  }
}

const STYLE = `
.aegis-doctor-shade{position:fixed;inset:0;z-index:9250;background:rgba(0,0,0,.7);display:grid;place-items:center;padding:16px}
.aegis-doctor{background:var(--panel,#14181f);color:var(--fg,#eef);border:1px solid var(--border,.35);border-radius:10px;width:min(720px,100%);max-height:90dvh;display:flex;flex-direction:column;font:14px/1.5 system-ui,Segoe UI,sans-serif}
.aegis-doctor header{display:flex;gap:8px;align-items:center;padding:12px;border-bottom:1px solid var(--border,.35)}
.aegis-doctor h2{font-size:17px;margin:0;flex:1}
.aegis-doctor button{font:inherit;background:transparent;color:inherit;border:1px solid var(--border,.45);border-radius:6px;padding:4px 10px;cursor:pointer}
.aegis-doctor button:hover{background:var(--bg-hover,rgba(255,255,255,.06))}
.aegis-doctor button:focus-visible{outline:2px solid var(--accent,#d97757);outline-offset:2px}
@media (pointer:coarse){.aegis-doctor header{flex-wrap:wrap}.aegis-doctor h2{flex:1 0 100%}.aegis-doctor button{min-height:44px}}
.aegis-doctor main{overflow:auto;padding:12px}
.aegis-doctor table{width:100%;border-collapse:collapse}
.aegis-doctor th,.aegis-doctor td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--border-soft,.2);vertical-align:top}
.aegis-doctor th{color:var(--text-4,#a2a098);font-weight:600;width:38%}
.aegis-doctor td{font-family:ui-monospace,Consolas,monospace;font-size:12.5px;overflow-wrap:anywhere}
.aegis-doctor .ok{color:var(--ok,#7ddc9a)}
.aegis-doctor .bad{color:var(--danger,#ff8a8a)}
.aegis-doctor .note{padding:10px 12px;border-top:1px solid var(--border,.35);color:var(--text-3,#b8b6ad);font-size:12.5px}
`;

let shade: HTMLDivElement | null = null;
let main: HTMLElement | null = null;
let note: HTMLElement | null = null;
let serial = 0;
let previousFocus: HTMLElement | null = null;
const inertBefore = new Map<HTMLElement, boolean>();

function modalKeys(event: KeyboardEvent): void {
  if (!shade) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }
  if (event.key !== 'Tab') return;
  const buttons = Array.from(shade.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
  if (!buttons.length) { event.preventDefault(); return; }
  const first = buttons[0], last = buttons[buttons.length - 1];
  if (event.shiftKey && (document.activeElement === first || !shade.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !shade.contains(document.activeElement))) {
    event.preventDefault();
    first.focus();
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtBytes(n: number | null | undefined): string {
  if (typeof n !== 'number' || n < 0) return '--';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function fmtUptime(s: number | null | undefined): string {
  if (typeof s !== 'number' || s < 0) return '--';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? h + ' h ' + m + ' min' : m + ' min';
}

function fmtTok(n: number | null | undefined): string {
  if (typeof n !== 'number' || n <= 0) return '--';
  return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);
}

/// Fila de la tabla. `clase` pinta el valor (ok/bad) sin cambiar el texto: el diagnostico tiene
/// que leerse igual en un screenshot que en la consola.
function row(k: string, v: Node | string, clase?: 'ok' | 'bad'): HTMLTableRowElement {
  const tr = el('tr');
  tr.append(el('th', k));
  const td = el('td');
  if (typeof v === 'string') td.textContent = v;
  else td.append(v);
  if (clase) td.className = clase;
  tr.append(td);
  return tr;
}

function build(): void {
  if (shade) return;
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const style = el('style');
  style.textContent = STYLE;
  document.head.append(style);

  shade = el('div');
  shade.className = 'aegis-doctor-shade';
  shade.addEventListener('click', (event) => { if (event.target === shade) close(); });

  const card = el('div');
  card.className = 'aegis-doctor';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', 'Estado del harness');

  const header = el('header');
  const title = el('h2', 'Estado del harness');
  const again = el('button', 'Actualizar');
  again.addEventListener('click', () => void refresh());
  const closeBtn = el('button', 'Cerrar');
  closeBtn.addEventListener('click', close);
  header.append(title, again, closeBtn);

  main = el('main');
  note = el('div');
  note.className = 'note';
  note.textContent = 'Solo lectura. La version desplegada la fija el puntero; el proceso vivo puede ser otro hasta el proximo swap.';

  card.append(header, main, note);
  shade.append(card);
  // El resto de la aplicación no recibe Tab ni clic mientras el diálogo esté abierto.
  for (const child of Array.from(document.body.children)) {
    if (child instanceof HTMLElement && child !== shade) {
      inertBefore.set(child, child.inert);
      child.inert = true;
    }
  }
  document.body.append(shade);
  document.addEventListener('keydown', modalKeys, true);
  closeBtn.focus();
}

function close(): void {
  if (!shade) return;
  ++serial; // Ignorar respuestas de fetch que lleguen después del cierre.
  document.removeEventListener('keydown', modalKeys, true);
  shade.remove();
  shade = null; main = null; note = null;
  for (const [node, wasInert] of inertBefore) node.inert = wasInert;
  inertBefore.clear();
  if (previousFocus?.isConnected) previousFocus.focus();
  previousFocus = null;
}

async function refresh(): Promise<void> {
  if (!main) return;
  const mine = ++serial;
  const view = main;
  view.replaceChildren(el('p', 'Consultando el harness...'));
  let report: DoctorReport | null = null;
  let error: string | null = null;
  try {
    const respuesta = await fetch('./doctor.json', { cache: 'no-store', credentials: 'same-origin' });
    if (!respuesta.ok) throw new Error('HTTP ' + respuesta.status);
    report = (await respuesta.json()) as DoctorReport;
  } catch (err) {
    error = String((err as Error).message || err);
  }
  if (mine !== serial || !main) return;
  if (!report) {
    view.replaceChildren(el('p', 'No se pudo leer el estado: ' + (error || 'error desconocido')));
    return;
  }

  const tabla = el('table');
  const tbody = el('tbody');
  const v = report.version;

  // El contraste que importa: lo que dice el puntero contra lo que corre.
  const pendiente = !!v.desplegada && v.exe && !v.exe.includes(v.desplegada);
  tbody.append(
    row('version desplegada', v.desplegada || 'sin puntero', v.desplegada ? 'ok' : 'bad'),
    row('ejecutable', v.exe ? v.exe.split('\\').pop() || v.exe : '--'),
    row('build', [v.version, v.commit].filter(Boolean).join(' · ') || '--'),
    row('sha256', v.sha256 ? v.sha256.slice(0, 16) + '...' : '--'),
    row('promovida', v.promovidaEl ? v.promovidaEl.replace('T', ' ').slice(0, 19) + ' por ' + (v.por || '?') : '--'),
  );
  if (pendiente) {
    tbody.append(row('aviso', 'el ejecutable apunta a un tag distinto al desplegado', 'bad'));
  }

  const serve = report.serve;
  tbody.append(
    row('serve', serve.vivo
      ? 'vivo · pid ' + (serve.pid ?? '?') + ' · ' + fmtUptime(serve.uptimeS)
      : 'CAIDO · ' + (serve.error || 'sin respuesta'), serve.vivo ? 'ok' : 'bad'),
  );

  if (report.ultimoBuild) {
    const b = report.ultimoBuild;
    tbody.append(row('ultimo build',
      [b.tag, b.perfil, b.cuando ? b.cuando.replace('T', ' ').slice(0, 19) : ''].filter(Boolean).join(' - ') || '--',
      b.dirty === false ? 'ok' : undefined));
    if (b.dirty) tbody.append(row('arbol al compilar', 'con cambios sin commitear', 'bad'));
  }

  tbody.append(
    row('store', fmtBytes(report.store.dbBytes), (report.store.dbBytes ?? 0) > 0 ? 'ok' : 'bad'),
    row('wal', fmtBytes(report.store.walBytes)),
    row('compactacion', report.compactacion.techoTokens
      ? 'techo ' + fmtTok(report.compactacion.techoTokens) + ' · umbral ' + (report.compactacion.umbral ?? '?')
      : 'sin techo configurado'),
  );

  tabla.append(tbody);
  const nodos: Node[] = [tabla];

  // Chequeos del health-gate: el mismo diagnostico que usan el watchdog y el canario real. Se
  // muestran tal cual, con su detalle, porque "sano" sin el detalle no dice nada.
  const g = report.gate;
  if (g) {
    const titulo = el('h3', 'Chequeos del health-gate');
    titulo.style.font = '600 13px system-ui, sans-serif';
    titulo.style.margin = '16px 0 6px';
    const tablaGate = el('table');
    const cuerpo = el('tbody');
    cuerpo.append(row('informe',
      (g.cuando || '--').replace('T', ' ').slice(0, 19) + ' - ' + (g.profundo ? 'profundo' : 'rapido'),
      g.estado === 'sano' ? 'ok' : 'bad'));
    for (const c of g.chequeos) cuerpo.append(row(c.nombre, c.detalle || '--', c.estado === 'ok' ? 'ok' : 'bad'));
    if (g.motivos.length) cuerpo.append(row('motivos', g.motivos.join('; '), 'bad'));
    tablaGate.append(cuerpo);
    nodos.push(titulo, tablaGate);
  }
  view.replaceChildren(...nodos);
  if (note) {
    note.textContent = 'Leido ' + (report.ahora ? report.ahora.replace('T', ' ').slice(0, 19) : '--')
      + '. Solo lectura; los tamanos son de disco, no del store abierto.';
  }
}

async function open(): Promise<void> {
  build();
  await refresh();
}

window.__aegisDoctor = { open, close, refresh };

// Boton en la barra superior, al lado de los otros paneles. Se crea una sola vez aunque el
// modulo se cargue antes de que exista el topbar (el listener espera al DOM).
function wireButton(): void {
  if (document.getElementById('btn-doctor')) return;
  const host = document.querySelector('.topbar-actions') || document.querySelector('.topbar');
  if (!host) return;
  const btn = document.createElement('button');
  btn.id = 'btn-doctor';
  btn.type = 'button';
  btn.className = 'icon-btn';
  btn.title = 'Estado del harness';
  btn.setAttribute('aria-label', 'Estado del harness');
  btn.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 8h2l1.5-3 2 6 1.5-3H14"/></svg>';
  btn.addEventListener('click', () => void open());
  host.append(btn);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireButton);
else wireButton();

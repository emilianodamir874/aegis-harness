/* Navegación: el chat conserva su DOM y scroll; Actividad y Archivos son los diálogos reales. */
import { medirAreaUtil, type AreaUtil } from './app/viewport';
declare global {
  interface Window {
    __aegisMemory?: { open: () => void };
    __aegisArtifacts?: { open: () => void; close: () => void };
  }
}

type View = 'chat' | 'activity' | 'files';
const mobile = (): boolean => window.matchMedia('(max-width: 880px)').matches;

// Diagnóstico del teclado: con ?vv=1 en la URL se reporta el modo de viewport que está usando
// el navegador. Sin el flag no se manda nada.
const MODO = (() => {
  try { return new URLSearchParams(location.search).has('vv'); } catch { return false; }
})();
const reportar = (kind: string, msg: unknown, extra?: Record<string, unknown>): void => {
  try {
    fetch('/client-log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, msg: String(msg).slice(0, 4000), url: location.href, ua: navigator.userAgent, ...extra }),
    }).catch(() => {});
  } catch {}
};

function closeMobileDrawer(): void {
  if (mobile()) document.getElementById('btn-close-drawer')?.click();
}

function wire(): void {
  const sidebar = document.getElementById('sidebar');
  const bar = document.getElementById('workspace-switch');
  const buttons: Record<View, HTMLElement | null> = {
    chat: document.getElementById('view-chat'),
    activity: document.getElementById('view-activity'),
    files: document.getElementById('view-files'),
  };
  const artVisible = (): boolean => {
    const el = document.querySelector<HTMLElement>('.aegis-art-backdrop');
    return !!el && getComputedStyle(el).display !== 'none';
  };
  const activityVisible = (): boolean => !!document.querySelector('.aegis-activity-backdrop');
  const syncView = (): void => {
    const active: View = activityVisible() ? 'activity' : artVisible() ? 'files' : 'chat';
    for (const [view, button] of Object.entries(buttons)) {
      if (view === active) button?.setAttribute('aria-current', 'page');
      else button?.removeAttribute('aria-current');
    }
  };
  function show(view: View): void {
    closeMobileDrawer();
    if (view !== 'activity') window.__aegisActivity?.close();
    if (view !== 'files') window.__aegisArtifacts?.close();
    if (view === 'activity') void window.__aegisActivity?.open();
    if (view === 'files') window.__aegisArtifacts?.open();
    syncView();
    if (view === 'chat' && mobile()) buttons.chat?.focus({ preventScroll: true });
  }
  buttons.chat?.addEventListener('click', () => show('chat'));
  buttons.activity?.addEventListener('click', () => show('activity'));
  buttons.files?.addEventListener('click', () => show('files'));
  document.getElementById('btn-files')?.addEventListener('click', () => {
    if (mobile()) show('files'); else window.__aegisArtifacts?.open();
    closeMobileDrawer();
  });
  document.getElementById('btn-memory')?.addEventListener('click', () => {
    closeMobileDrawer(); window.__aegisMemory?.open();
  });
  document.getElementById('btn-activity')?.addEventListener('click', () => {
    if (mobile()) show('activity'); else void window.__aegisActivity?.open();
    closeMobileDrawer();
  });
  // Los diálogos se pueden cerrar con Escape, con su botón o tocando el fondo.
  // Observar solo hijos directos y el atributo display del backdrop reutilizado.
  let artBackdrop: HTMLElement | null = null;
  const artObserver = new MutationObserver(syncView);
  const bodyObserver = new MutationObserver(() => {
    const next = document.querySelector<HTMLElement>('.aegis-art-backdrop');
    if (next !== artBackdrop) {
      artObserver.disconnect(); artBackdrop = next;
      if (next) artObserver.observe(next, { attributes: true, attributeFilter: ['style'] });
    }
    syncView();
  });
  bodyObserver.observe(document.body, { childList: true });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') queueMicrotask(syncView); });

  // El área útil se publica SIEMPRE, aunque no exista la barra de vistas: el teclado del
  // teléfono no puede depender de que exista un <nav>.
  const syncViewport = (): void => {
    const app = document.querySelector<HTMLElement>('.app');
    const movil = mobile();
    const area: AreaUtil = movil ? medirAreaUtil(altoUtil) : { alto: 0, top: 0, teclado: 0, fuente: 'visual' };
    const altoAnterior = altoUtil;
    if (!movil) {
      for (const el of [sidebar, app, bar]) {
        el?.style.removeProperty('--drawer-height'); el?.style.removeProperty('--drawer-top');
        el?.style.removeProperty('--mobile-visible-height'); el?.style.removeProperty('--mobile-visible-top');
      }
      document.documentElement.style.removeProperty('--mobile-visual-bottom');
      return;
    }
    altoUtil = area.alto;
    // Referencia del alto real sin teclado: se toma SOLO con el campo sin foco, así el resize
    // del navegador (que puede llegar antes que el foco) nunca se confunde con el teclado.
    if (!document.getElementById('input')?.matches(':focus')) altoBase = Math.max(altoBase, area.alto);
    sidebar?.style.setProperty('--drawer-height', `${area.alto}px`);
    sidebar?.style.setProperty('--drawer-top', `${area.top}px`);
    app?.style.setProperty('--mobile-visible-height', `${area.alto}px`);
    app?.style.setProperty('--mobile-visible-top', `${area.top}px`);
    // `innerHeight` es el layout: cuando el teclado NO lo achica (Chrome con resize-visual-only)
    // esta resta es el alto real del teclado. La usa el composer para no quedar debajo cuando
    // el .app se estira a propósito (ver `#input:focus` en el CSS de móvil).
    document.documentElement.style.setProperty('--mobile-visual-bottom', `${Math.max(0, window.innerHeight - area.alto - area.top)}px`);
    document.documentElement.dataset.vvModo = area.fuente;
    // El alto útil cambió: se avisa para que el transcript se re-anclu al fondo. Sin esto, al
    // abrir el teclado en Android el .app se achica pero el scroll queda donde estaba y lo que
    // uno escribe queda fuera de vista.
    if (area.alto !== altoAnterior) {
      window.dispatchEvent(new CustomEvent('aegis:viewporth', { detail: { height: area.alto, top: area.top, teclado: area.teclado, fuente: area.fuente } }));
    }
    if (MODO) {
      const ahora = Date.now();
      if (area.alto !== altoAnterior && ahora - ultimoAviso > 700) {
        ultimoAviso = ahora;
        reportar('kb', `alto=${area.alto} top=${area.top} layout=${document.documentElement.clientHeight} inner=${window.innerHeight} vv=${window.visualViewport?.height ?? -1} teclado=${area.teclado} fuente=${area.fuente}`);
      }
    }
  };
  // --- Tercera vía: el navegador no achica NADA al abrir el teclado ---
  // Si al enfocar el campo no baja ninguna de las medidas, el teclado está dibujado encima y
  // solo queda estimar su alto. La estimación es por dispositivo y estable, así que el primer
  // valor medido se recuerda: en cuanto una medición real aparece, se guarda y se usa.
  const CLAVE_KB = 'aegis.kb.alto';
  const leerKb = (): number => {
    try {
      const n = Number(localStorage.getItem(CLAVE_KB) || 0);
      return Number.isFinite(n) && n > 120 ? n : 0;
    } catch { return 0; }
  };
  const guardarKb = (n: number): void => {
    if (!(n > 120)) return;
    try { localStorage.setItem(CLAVE_KB, String(Math.round(n))); } catch {}
  };
  let enfoqueEn = 0;
  let estimado = 0;
  let estimadoAplicadoEn = 0;
  // Alto SIN teclado: se toma mientras el campo NO tiene foco, y es la referencia contra la que
  // se decide si el navegador ya recortó. Antes usaba el alto del momento del foco, y como el
  // resize del navegador puede llegar ANTES que el foco, se estimaba teclado sobre una pantalla
  // ya recortada y se restaba dos veces (medido: .app de 163 px).
  let altoBase = 0;
  // ¿Este navegador reporta el teclado? Apenas lo reporta una vez, la estimación queda prohibida:
  // recortar la UI cuando NO hay teclado es peor que no hacer nada.
  let modoReal = false;
  const ponerTeclado = (px: number): void => {
    estimado = modoReal ? 0 : px;
    document.querySelector<HTMLElement>('.app')?.style.setProperty('--mobile-teclado', `${estimado}px`);
  };
  const ajustarTeclado = (enfocado: boolean, area: AreaUtil): void => {
    // Traza automática (máximo una línea cada 8 s): sin esto, cada iteración del teclado en el
    // teléfono es a ciegas. Queda en logs/client.log con kind "kb".
    if (Date.now() - ultimoAviso > 8000) {
      ultimoAviso = Date.now();
      reportar('kb', `alto=${area.alto} base=${altoBase} layout=${document.documentElement.clientHeight} inner=${window.innerHeight} vv=${window.visualViewport?.height ?? -1} teclado=${area.teclado} fuente=${area.fuente} enfocado=${enfocado} estimado=${estimado}`);
    }
    if (!enfocado) { altoBase = Math.max(altoBase, area.alto); ponerTeclado(0); return; }
    if (!altoBase) altoBase = area.alto;
    const recortado = !!(area.teclado > 120) || area.alto < altoBase - 40;
    if (recortado) { modoReal = true; guardarKb(altoBase - area.alto); ponerTeclado(0); return; }
    if (Date.now() - enfoqueEn < 320) return; // el teclado todavía está abriendo
    // Cuánto medía el alto cuando se aplicó la estimación: sirve para deshacerla cuando el teclado
    // se cierra sin blur (botón atrás de Android) y el alto vuelve al de antes.
    estimadoAplicadoEn = area.alto;
    // Teclado estimado: 38 % del área sin teclado. Medido en el A56 (411x777): el teclado con su
    // barra de sugerencias ocupa ~287-300 px, o sea 0.37-0.39. Con 0.5 quedaba un hueco de ~90 px
    // entre el composer y el teclado (visto en el teléfono real); con 0.42, ~30 px.
    ponerTeclado(leerKb() || Math.round(Math.max(180, Math.min(altoBase * 0.38, altoBase - 200))));
  };
  let altoUtil = 0;
  let ultimoAviso = 0;
  const input = document.getElementById('input');
  // Verificación, no limpieza: una estimación de teclado NO se borra porque el alto se haya
  // quedado quieto (el teclado abierto no cambia nada, que es justo por lo que se estimó), pero
  // SÍ se borra si el alto volvió al de antes de estimar: eso es el teclado cerrándose sin blur.
  // La primera versión soltaba en cualquier toque fuera del composer y en cada resize, y con
  // resize-visual-only el navegador manda resize mientras uno escribe: la estimación duraba dos
  // frames y quedaba un hueco entre el composer y el teclado (visto en el teléfono).
  const verificar = (): void => {
    if (!estimado) return;
    if (!input?.matches(':focus')) { ponerTeclado(0); return; }
    if (medirAreaUtil(altoUtil).alto + 40 < estimadoAplicadoEn) ponerTeclado(0);
  };
  // Si toca el transcript dejó de escribir: se libera la estimación sin esperar al blur, porque
  // en Android el botón atrás esconde el teclado SIN sacar el foco. Tampoco se escucha 'scroll'
  // del transcript: el re-anclaje automático al fondo lo dispara y borraría la estimación en el
  // mismo frame en que se pone.
  document.getElementById('messages')?.addEventListener('pointerdown', () => { if (estimado) ponerTeclado(0); }, { passive: true });
  window.addEventListener('touchstart', (ev: Event) => {
    if (!estimado) return;
    const t = ev.target as Node | null;
    if (t && document.querySelector('.composer-wrap')?.contains(t)) return;
    verificar();
  }, { passive: true });
  const medirYAjustar = (): void => {
    syncViewport();
    const area = medirAreaUtil(altoUtil);
    ajustarTeclado(!!document.getElementById('input')?.matches(':focus'), area);
    verificar();
  };
  if (input) {
    input.addEventListener('focus', () => {
      enfoqueEn = Date.now();
      setTimeout(medirYAjustar, 340);
      setTimeout(medirYAjustar, 700);
    });
    input.addEventListener('blur', () => {
      setTimeout(() => { syncViewport(); ajustarTeclado(false, medirAreaUtil(altoUtil)); }, 60);
    });
  }
  syncViewport();
  window.addEventListener('resize', syncViewport);
  // Girar el teléfono cambia el alto real: la referencia de "sin teclado" se vuelve a tomar.
  window.addEventListener('orientationchange', () => { altoBase = 0; syncViewport(); });
  window.visualViewport?.addEventListener('resize', syncViewport);
  window.visualViewport?.addEventListener('scroll', syncViewport);
  // Corrección inmediata: si el navegador avisa del alto DESPUÉS de que se estimó el teclado
  // (Chrome a veces lo hace tarde), la estimación sobra en el mismo frame. Se registra después
  // de syncViewport para que el alto ya esté actualizado cuando verificar() mida.
  window.addEventListener('resize', verificar);
  window.visualViewport?.addEventListener('resize', verificar);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire, { once: true });
else wire();
export {};

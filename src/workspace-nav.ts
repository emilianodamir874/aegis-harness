/* Navegación: el chat conserva su DOM y scroll; Actividad y Archivos son los diálogos reales. */
declare global {
  interface Window {
    __aegisMemory?: { open: () => void };
    __aegisArtifacts?: { open: () => void; close: () => void };
  }
}

type View = 'chat' | 'activity' | 'files';
const mobile = (): boolean => window.matchMedia('(max-width: 880px)').matches;

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
  document.getElementById('btn-changes')?.addEventListener('click', () => {
    const runtime = (window as Window & { __aegisWeb?: { state?: { current?: { cwd?: string } } } }).__aegisWeb;
    closeMobileDrawer();
    void window.__aegisChanges?.open(runtime?.state?.current?.cwd || '');
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

  if (!sidebar || !bar) return;
  const syncViewport = (): void => {
    const app = document.querySelector<HTMLElement>('.app');
    if (!mobile()) {
      for (const el of [sidebar, app, bar]) {
        el?.style.removeProperty('--drawer-height'); el?.style.removeProperty('--drawer-top');
        el?.style.removeProperty('--mobile-visible-height'); el?.style.removeProperty('--mobile-visible-top');
      }
      document.documentElement.style.removeProperty('--mobile-visual-bottom');
      return;
    }
    const viewport = window.visualViewport;
    const height = Math.max(0, viewport?.height ?? window.innerHeight);
    const top = viewport?.offsetTop ?? 0;
    sidebar.style.setProperty('--drawer-height', `${height}px`);
    sidebar.style.setProperty('--drawer-top', `${top}px`);
    app?.style.setProperty('--mobile-visible-height', `${height}px`);
    app?.style.setProperty('--mobile-visible-top', `${top}px`);
    document.documentElement.style.setProperty('--mobile-visual-bottom', `${Math.max(0, window.innerHeight - height - top)}px`);
    // El alto util cambio: puede ser el teclado abriendose o cerrándose. Se avisa para que el
    // transcript se re-ancle al fondo. Sin esto, al abrir el teclado en Android el .app se acorta
    // pero el scroll queda donde estaba y lo que uno escribe queda fuera de vista.
    if (height !== ultimoAlto) {
      ultimoAlto = height;
      window.dispatchEvent(new CustomEvent('aegis:viewporth', { detail: { height, top } }));
    }
  };
  let ultimoAlto = -1;
  syncViewport();
  window.addEventListener('resize', syncViewport);
  window.visualViewport?.addEventListener('resize', syncViewport);
  window.visualViewport?.addEventListener('scroll', syncViewport);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire, { once: true });
else wire();
export {};

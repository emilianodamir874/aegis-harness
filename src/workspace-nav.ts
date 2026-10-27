/* Accesos visibles al espacio de trabajo; los paneles existentes son la fuente de verdad.
 * No sintetizar actividad: el transcript y su runbar son el estado disponible hoy.
 */
declare global {
  interface Window {
    __aegisMemory?: { open: () => void };
    __aegisArtifacts?: { open: () => void };
  }
}

function closeMobileDrawer(): void {
  if (window.matchMedia('(max-width: 880px)').matches) {
    document.getElementById('btn-close-drawer')?.click();
  }
}

function wire(): void {
  document.getElementById('btn-files')?.addEventListener('click', () => {
    closeMobileDrawer();
    window.__aegisArtifacts?.open();
  });
  document.getElementById('btn-memory')?.addEventListener('click', () => {
    closeMobileDrawer();
    window.__aegisMemory?.open();
  });
  document.getElementById('btn-activity')?.addEventListener('click', () => {
    closeMobileDrawer();
    // La actividad real ya está en el chat (tool cards, runbar y objetivo).
    // Sin endpoint de actividad agregada, no mostrar una lista ficticia.
    const messages = document.getElementById('messages');
    messages?.scrollTo({ top: messages.scrollHeight, behavior: 'smooth' });
    messages?.focus({ preventScroll: true });
  });
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  const syncDrawer = (): void => {
    if (!window.matchMedia('(max-width: 880px)').matches) {
      sidebar.style.removeProperty('--drawer-height');
      sidebar.style.removeProperty('--drawer-top');
      return;
    }
    const viewport = window.visualViewport;
    // En teclado móvil el viewport visual puede ser menor que 100dvh.
    const height = viewport?.height ?? window.innerHeight;
    sidebar.style.setProperty('--drawer-height', `${Math.max(0, height)}px`);
    sidebar.style.setProperty('--drawer-top', `${viewport?.offsetTop ?? 0}px`);
  };
  syncDrawer();
  window.addEventListener('resize', syncDrawer);
  window.visualViewport?.addEventListener('resize', syncDrawer);
  window.visualViewport?.addEventListener('scroll', syncDrawer);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wire, { once: true });
} else {
  wire();
}
export {};

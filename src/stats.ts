/**
 * Botón de gasto del topbar.
 *
 * Este módulo llegó a construir un panel propio completo —overlay con tarjetas de KPI, tablas por
 * modelo, "contra el plan"— y se montaba encima del panel de gasto que vive en el chasis de
 * paneles. Dos paneles con los mismos datos y dos estéticas: el operador los veía como "el panel
 * viejo" y "el panel nuevo", y pidió que quede uno solo.
 *
 * El panel único es `src/app/gasto.ts`, dentro de `#usage-panel`, y lo abre `openUsagePop()`.
 * Lo único que queda acá es el botón de las barras verticales del topbar, que es la puerta de
 * entrada que el operador usa: lo crea este módulo (para no tocar el markup de index.html) y
 * delega en el panel único.
 */

interface AegisWeb {
  abrirGasto?: () => void;
}

function boton(): HTMLButtonElement | null {
  const ref = document.getElementById('btn-goals');
  if (!ref) return null;
  const previo = document.getElementById('btn-gasto-top');
  if (previo) return previo as HTMLButtonElement;
  const b = document.createElement('button');
  b.id = 'btn-gasto-top';
  b.className = ref.className;
  b.type = 'button';
  b.title = 'Gasto y uso';
  b.setAttribute('aria-label', 'Gasto y uso');
  b.setAttribute('aria-haspopup', 'dialog');
  b.setAttribute('aria-controls', 'usage-panel');
  b.innerHTML = '<svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true">'
    + '<path d="M3 16V9M7.6 16V4M12.2 16v-5M16.8 16V7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
  ref.insertAdjacentElement('beforebegin', b);
  return b;
}

function abrir(): void {
  const w = window as unknown as { __aegisWeb?: AegisWeb };
  if (w.__aegisWeb?.abrirGasto) {
    w.__aegisWeb.abrirGasto();
    return;
  }
  // El bundle de la app arranca después de este módulo: se reintenta una vez.
  setTimeout(() => w.__aegisWeb?.abrirGasto?.(), 120);
}

const b = boton();
if (b) b.addEventListener('click', abrir);

// Sin overlay propio. `open` se conserva para el palette y los atajos, apuntando al panel único.
(window as unknown as { __aegisStats?: unknown }).__aegisStats = {
  open: abrir,
  close: () => document.querySelector('#usage-panel .panel-x')?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
};

export {};

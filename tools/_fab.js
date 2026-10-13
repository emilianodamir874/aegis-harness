  // Boton flotante 'ir al final': aparece cuando te alejas del ultimo mensaje.
  (function initJumpBottom() {
    const box = $('#messages');
    if (!box) return;
    const btn = document.createElement('button');
    btn.id = 'jump-bottom';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Ir al ultimo mensaje');
    btn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" width="17" height="17"><path d="M8 3v10M3.6 8.6 8 13l4.4-4.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    btn.addEventListener('click', () => scrollBottom(true));
    const host = document.querySelector('.main') || document.body;
    host.appendChild(btn);
    const sync = () => {
      const gap = box.scrollHeight - box.scrollTop - box.clientHeight;
      btn.classList.toggle('show', gap > 240);
    };
    box.addEventListener('scroll', sync, { passive: true });
    setInterval(sync, 1200);
  })();
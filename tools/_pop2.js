  // ---------- popover de contexto: chico, anclado al readout, estilo Claude ----------
  let usagePop = null;
  function closeUsagePop() { if (usagePop) usagePop.hidden = true; }
  function buildUsagePop() {
    if (usagePop) return usagePop;
    const w = document.createElement('div');
    w.id = 'usage-pop';
    w.hidden = true;
    w.innerHTML =
      '<div class="up-h"><span>Contexto</span><i class="up-verdict"></i><b class="up-pct">--</b></div>' +
      '<div class="up-meter"><i></i><em></em></div>' +
      '<div class="up-sub"></div>' +
      '<div class="up-rows"></div>' +
      '<div class="up-foot"></div>';
    document.body.appendChild(w);
    usagePop = w;
    document.addEventListener('pointerdown', (e) => {
      if (!usagePop || usagePop.hidden) return;
      const a = $('#meta-right');
      if (usagePop.contains(e.target) || (a && a.contains(e.target))) return;
      closeUsagePop();
    }, true);
    window.addEventListener('resize', placeUsagePop);
    window.addEventListener('scroll', placeUsagePop, true);
    return w;
  }
  function placeUsagePop() {
    const w = usagePop;
    const a = $('#meta-right');
    if (!w || w.hidden || !a) return;
    const r = a.getBoundingClientRect();
    const pw = w.offsetWidth, ph = w.offsetHeight;
    let top = r.top - ph - 9;
    const above = top >= 8;
    if (!above) top = r.bottom + 9;
    let left = r.right - pw;
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    w.dataset.above = above ? '1' : '0';
    w.style.left = Math.round(left) + 'px';
    w.style.top = Math.round(Math.max(8, top)) + 'px';
  }
  const niceTok = (n) => {
    if (n == null) return '--';
    if (n < 1000) return String(n);
    if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
    return (n / 1000000).toFixed(2).replace(/\.00$/, '') + 'M';
  };
  const popRow = (k, v) => '<div class="up-row"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>';
  function openUsagePop() {
    const w = buildUsagePop();
    const s = state.usage || {};
    const mp = modelParts() || {};
    const pct = s.limit && s.used != null ? Math.min(100, (s.used / s.limit) * 100) : null;
    const trig = s.limit ? s.limit * COMPACT_RATIO : null;
    const col = pct == null ? 'var(--text-4)' : pct >= COMPACT_RATIO * 100 ? 'var(--danger)' : pct >= 50 ? 'var(--warn)' : 'var(--ok)';
    w.querySelector('.up-pct').textContent = pct == null ? '--' : Math.round(pct) + '%';
    w.querySelector('.up-pct').style.color = col;
    const vd = w.querySelector('.up-verdict');
    vd.textContent = pct == null ? 'sin medir todavia' : pct >= COMPACT_RATIO * 100 ? 'va a compactar' : pct >= 50 ? 'mas de la mitad' : 'holgado';
    const bar = w.querySelector('.up-meter i');
    bar.style.background = col === 'var(--text-4)' ? 'var(--text-4)' : 'linear-gradient(90deg, ' + col + ', ' + col + ')';
    w.querySelector('.up-meter em').style.left = Math.round(COMPACT_RATIO * 100) + '%';
    w.querySelector('.up-sub').innerHTML = s.used == null ? 'todavia sin datos de uso' :
      '<b>' + niceTok(s.used) + '</b> de ' + niceTok(s.limit) + ' tok' + (trig ? '  ·  compacta a ' + niceTok(trig) + ' (' + Math.round(COMPACT_RATIO * 100) + '%)' : '');
    const mu = s.last || {};
    const cachePct = mu.cacheReadTokens != null && (mu.inputTokens || 0) + mu.cacheReadTokens > 0
      ? Math.round((mu.cacheReadTokens / ((mu.inputTokens || 0) + mu.cacheReadTokens)) * 100) + '%' : '--';
    w.querySelector('.up-rows').innerHTML =
      popRow('ultimo paso', 'entrada ' + niceTok(mu.inputTokens) + '  ·  salida ' + niceTok(mu.outputTokens) +
        (mu.elapsedMs != null ? '  ·  ' + (mu.elapsedMs / 1000).toFixed(1) + 's' : '')) +
      popRow('cache', cachePct + (mu.timeToFirstTokenMs != null ? '  ·  1er token ' + (mu.timeToFirstTokenMs / 1000).toFixed(1) + 's' : '')) +
      popRow('sesion', 'entrada ' + niceTok(s.inTok) + '  ·  salida ' + niceTok(s.outTok)) +
      popRow('margen', s.limit && s.used != null && trig ? niceTok(Math.max(0, trig - s.used)) + ' tok antes de compactar' : '--');
    w.querySelector('.up-foot').textContent =
      (mp.model || 'modelo ?') + (mp.effort ? '  ·  esfuerzo ' + mp.effort + (mp.fromAlias ? ' (alias)' : '') : '') + (s.cost != null ? '  ·  ' + fmtCost(s.cost) : '');
    w.hidden = false;
    placeUsagePop();
    bar.style.transition = 'none';
    bar.style.width = '0%';
    requestAnimationFrame(() => { bar.style.transition = ''; bar.style.width = (pct == null ? 0 : pct) + '%'; });
  }
  if (!window.__usagePopKeys) {
    window.__usagePopKeys = true;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && usagePop && !usagePop.hidden) { closeUsagePop(); e.stopPropagation(); } }, true);
  }
  // ---------- panel de contexto: al tocar el readout se despliega un medidor ----------
  let usagePop = null;
  const RING_CIRC = 2 * Math.PI * 52;
  function closeUsagePop() { if (usagePop) usagePop.hidden = true; }
  function buildUsagePop() {
    if (usagePop) return usagePop;
    const w = document.createElement('div');
    w.id = 'usage-pop';
    w.hidden = true;
    w.innerHTML =
      '<div class="up-backdrop"></div>' +
      '<div class="up-card" role="dialog" aria-modal="true" aria-label="Uso y contexto">' +
        '<button class="up-x" aria-label="Cerrar">×</button>' +
        '<div class="up-head">' +
          '<div class="up-ring">' +
            '<svg viewBox="0 0 120 120"><circle class="up-track" cx="60" cy="60" r="52"></circle>' +
            '<circle class="up-arc" cx="60" cy="60" r="52"></circle></svg>' +
            '<div class="up-ring-txt"><b>--</b><span></span></div>' +
          '</div>' +
          '<div class="up-headinfo"><div class="up-model"></div><div class="up-effort"></div><div class="up-verdict"></div></div>' +
        '</div>' +
        '<div class="up-sec"><h4>Contexto</h4><div class="up-bars"></div></div>' +
        '<div class="up-sec"><h4>Ultimo paso</h4><div class="up-grid up-last"></div></div>' +
        '<div class="up-sec"><h4>Acumulado en la sesion</h4><div class="up-grid up-acc"></div></div>' +
        '<div class="up-note"></div>' +
      '</div>';
    document.body.appendChild(w);
    usagePop = w;
    w.querySelector('.up-backdrop').addEventListener('click', closeUsagePop);
    w.querySelector('.up-x').addEventListener('click', closeUsagePop);
    return w;
  }
  const niceTok = (n) => {
    if (n == null) return '--';
    if (n < 1000) return String(n);
    if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
    return (n / 1000000).toFixed(2).replace(/\.00$/, '') + 'M';
  };
  const tile = (t, n, s) => '<div class="up-tile"><div class="t">' + esc(t) + '</div><div class="n">' + esc(String(n)) + '</div>' +
    (s ? '<div class="s">' + esc(s) + '</div>' : '') + '</div>';
  function openUsagePop() {
    const w = buildUsagePop();
    const s = state.usage || {};
    const mp = modelParts() || {};
    const pct = s.limit && s.used != null ? Math.min(100, (s.used / s.limit) * 100) : null;
    const trig = s.limit ? s.limit * COMPACT_RATIO : null;
    w.querySelector('.up-model').textContent = mp.model || 'modelo sin informar';
    w.querySelector('.up-effort').textContent = mp.effort ? 'esfuerzo: ' + mp.effort + (mp.fromAlias ? '  (lo fija el alias del modelo)' : '') : 'esfuerzo: sin chip (el server no expone opciones)';
    const v = w.querySelector('.up-verdict');
    if (pct == null) { v.textContent = 'Todavia no hay un request medido en esta sesion.'; v.style.color = 'var(--text-3)'; }
    else if (pct >= COMPACT_RATIO * 100) { v.textContent = 'En la zona de compactacion: el proximo request puede resumir el historial.'; v.style.color = 'var(--danger)'; }
    else if (pct >= 50) { v.textContent = 'Mas de medio contexto usado; queda aire pero conviene mirarlo.'; v.style.color = 'var(--warn)'; }
    else { v.textContent = 'Contexto holgado: margen de sobra antes de compactar.'; v.style.color = 'var(--ok)'; }
    // anillo
    const arc = w.querySelector('.up-arc');
    const col = pct == null ? 'var(--text-4)' : pct >= COMPACT_RATIO * 100 ? 'var(--danger)' : pct >= 50 ? 'var(--warn)' : 'var(--ok)';
    arc.style.stroke = col;
    w.querySelector('.up-ring-txt b').textContent = pct == null ? '--' : Math.round(pct) + '%';
    w.querySelector('.up-ring-txt span').textContent = s.used == null ? '' : niceTok(s.used) + (s.limit ? '/' + niceTok(s.limit) : '');
    // barras
    const bars = w.querySelector('.up-bars');
    bars.innerHTML =
      (pct == null ? '' : '<div class="up-row"><span class="k">usado</span><div class="up-meter"><i></i><em style="left:' + Math.round(COMPACT_RATIO * 100) + '%"></em></div><span class="v">' + Math.round(pct) + '%</span></div>') +
      (trig == null ? '' : '<div class="up-row"><span class="k">compacta a</span><span style="flex:1;color:var(--text-3)">' + niceTok(trig) + ' tok (' + Math.round(COMPACT_RATIO * 100) + '% del limite)</span></div>') +
      (trig == null || s.used == null ? '' : '<div class="up-row"><span class="k">margen</span><span style="flex:1;color:var(--text-3)">' + niceTok(Math.max(0, trig - s.used)) + ' tok antes de que compacte sola</span></div>');
    const meter = bars.querySelector('.up-meter i');
    if (meter) requestAnimationFrame(() => { meter.style.width = Math.round(pct) + '%'; });
    // ultimo paso
    const mu = s.last || {};
    const cachePct = mu.cacheReadTokens != null && (mu.inputTokens || 0) + mu.cacheReadTokens > 0
      ? Math.round((mu.cacheReadTokens / ((mu.inputTokens || 0) + mu.cacheReadTokens)) * 100) + '%' : null;
    w.querySelector('.up-last').innerHTML =
      tile('entrada', niceTok(mu.inputTokens), 'tokens del prompt') +
      tile('salida', niceTok(mu.outputTokens), 'incluye el razonamiento') +
      tile('cache', cachePct == null ? '--' : cachePct, 'leido de cache') +
      tile('tiempo', mu.elapsedMs == null ? '--' : (mu.elapsedMs / 1000).toFixed(1) + 's', mu.timeToFirstTokenMs == null ? '' : '1er token ' + (mu.timeToFirstTokenMs / 1000).toFixed(1) + 's');
    w.querySelector('.up-acc').innerHTML =
      tile('entrada acumulada', niceTok(s.inTok), 'toda la sesion') +
      tile('salida acumulada', niceTok(s.outTok), 'toda la sesion') +
      tile('costo', s.cost == null ? '--' : fmtCost(s.cost), 'estimado por el server') +
      tile('limite', niceTok(s.limit), 'ventana del modelo');
    const stepsLeft = s.limit && trig ? Math.max(0, Math.floor((trig - (s.used || 0)) / Math.max(1, mu.inputTokens || 0))) : null;
    w.querySelector('.up-note').innerHTML =
      'El <b>contexto</b> es lo que se reenvia en cada request (historial + herramientas + adjuntos), no lo que escribis. ' +
      'El <b>razonamiento</b> de cada paso se cuenta dentro de la <b>salida</b>, por eso la salida pesa mas de lo que se ve en el chat. ' +
      (stepsLeft ? 'Al ritmo del ultimo paso quedan ~<b>' + stepsLeft + '</b> pasos antes de compactar. ' : '') +
      'Cuando llega a <b>' + Math.round(COMPACT_RATIO * 100) + '%</b> del limite el historial se resume solo (<b>GOOSE_AUTO_COMPACT_THRESHOLD</b>).';
    // animar el anillo desde 0 para que se vea el despliegue
    arc.style.transition = 'none';
    arc.style.strokeDashoffset = String(RING_CIRC);
    w.hidden = false;
    requestAnimationFrame(() => {
      arc.style.transition = '';
      arc.style.strokeDashoffset = String(RING_CIRC * (1 - (pct == null ? 0 : pct) / 100));
    });
  }
  if (!window.__usagePopKeys) {
    window.__usagePopKeys = true;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && usagePop && !usagePop.hidden) { closeUsagePop(); e.stopPropagation(); } }, true);
  }
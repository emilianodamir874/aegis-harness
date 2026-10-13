import io, sys
APP='C:/goose-web/app/app.js'; CSSF='C:/goose-web/app/app.css'
def rd(p):
    with io.open(p,'r',encoding='utf-8',newline='') as f: return f.read()
def wr(p,s):
    with io.open(p,'w',encoding='utf-8',newline='') as f: f.write(s)
raw = rd(APP)
SEP = chr(13)+chr(10) if (chr(13)+chr(10)) in raw else chr(10)
def rep(old, new, n=1):
    global raw
    c = raw.count(old)
    if c != n:
        print('FAIL count=%d (esperaba %d) %r' % (c, n, old[:70])); sys.exit(1)
    raw = raw.replace(old, new)

# 1) cache %: input_tokens YA incluye lo cacheado -> el hit rate es cache/input
rep("      ? Math.round((mu.cacheReadTokens / ((mu.inputTokens || 0) + mu.cacheReadTokens)) * 100) + '%' : '--';",
    "      ? Math.round((mu.cacheReadTokens / Math.max(1, mu.inputTokens || 0)) * 100) + '%' : '--';")
rep("        const den = (mu.inputTokens || 0) + mu.cacheReadTokens;" + SEP +
    "        if (den > 0) b.push('cache ' + Math.round((mu.cacheReadTokens / den) * 100) + '%');",
    "        if ((mu.inputTokens || 0) > 0) b.push('cache ' + Math.round((mu.cacheReadTokens / mu.inputTokens) * 100) + '%');")
# la fila de cache ahora dice tambien los tokens
rep("      popRow('cache', cachePct + (mu.timeToFirstTokenMs != null ? '  ·  1er token ' + (mu.timeToFirstTokenMs / 1000).toFixed(1) + 's' : '')) +",
    "      popRow('cache', cachePct + (mu.cacheReadTokens != null ? '  (' + niceTok(mu.cacheReadTokens) + ' de ' + niceTok(mu.inputTokens) + ')' : '') + (mu.timeToFirstTokenMs != null ? '  ·  1er token ' + (mu.timeToFirstTokenMs / 1000).toFixed(1) + 's' : '')) +")

# 2) icono por tipo de herramienta
rep("    const ic = el.querySelector('.tool-ic');" + SEP +
    "    ic.innerHTML = status === 'pending' || status === 'in_progress' ? '<span class="spin"></span>' : '';",
    "    const ic = el.querySelector('.tool-ic');" + SEP +
    "    ic.innerHTML = status === 'pending' || status === 'in_progress'" + SEP +
    "      ? '<span class="spin"></span>'" + SEP +
    "      : toolIconSvg(String(u.kind || u.title || '').split(/[ /]/)[0], status === 'failed' ? 'failed' : 'ok');")

# 3) animacion de entrada en mensajes vivos (no en el replay)
rep("    el.className = 'msg-user' + (opts && opts.queued ? ' queued' : '');",
    "    el.className = 'msg-user' + (opts && opts.queued ? ' queued' : '');" + SEP +
    "    if (!replay) el.classList.add('in');")
rep("    if (!thought && !state.replaying) rec.el.classList.add('streaming');",
    "    if (!thought && !state.replaying) { rec.el.classList.add('streaming'); rec.el.classList.add('in'); }")

# 4) helpers de iconos antes del primer uso
k = raw.index('  function toolUpsert(')
raw = raw[:k] + rd('C:/goose-web/tools/_icons.js') + raw[k:]

# 5) boton "ir al final"
rep("  if (!window.__usagePopKeys) {",
    "  // Boton flotante 'ir al final': aparece al alejarte del ultimo mensaje.
" +
    "  (function initJumpBottom() {
" +
    "    const btn = document.createElement('button');
" +
    "    btn.id = 'jump-bottom';
" +
    "    btn.type = 'button';
" +
    "    btn.setAttribute('aria-label', 'Ir al ultimo mensaje');
" +
    "    btn.innerHTML = '<svg width="17" height="17" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3.6 8.6 8 13l4.4-4.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
" +
    "    btn.addEventListener('click', () => scrollBottom(true));
" +
    "    const host = document.querySelector('.main');
" +
    "    if (host) host.appendChild(btn);
" +
    "    const box = $('#messages');
" +
    "    const sync = () => {
" +
    "      if (!box) return;
" +
    "      const gap = box.scrollHeight - box.scrollTop - box.clientHeight;
" +
    "      btn.classList.toggle('show', gap > 240);
" +
    "    };
" +
    "    if (box) { box.addEventListener('scroll', sync, { passive: true }); setInterval(sync, 1200); }
" +
    "  })();
" +
    "  if (!window.__usagePopKeys) {")

wr(APP, raw)
css = rd(CSSF)
wr(CSSF, css + rd('C:/goose-web/tools/_icons.css'))
print('OK iconos+animaciones+cache')

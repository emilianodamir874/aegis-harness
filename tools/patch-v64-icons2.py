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

rep("      ? Math.round((mu.cacheReadTokens / ((mu.inputTokens || 0) + mu.cacheReadTokens)) * 100) + '%' : '--';",
    "      ? Math.round((mu.cacheReadTokens / Math.max(1, mu.inputTokens || 0)) * 100) + '%' : '--';")
rep("        const den = (mu.inputTokens || 0) + mu.cacheReadTokens;" + SEP +
    "        if (den > 0) b.push('cache ' + Math.round((mu.cacheReadTokens / den) * 100) + '%');",
    "        if ((mu.inputTokens || 0) > 0) b.push('cache ' + Math.round((mu.cacheReadTokens / mu.inputTokens) * 100) + '%');")
rep("      popRow('cache', cachePct + (mu.timeToFirstTokenMs != null ? '  \u00b7  1er token ' + (mu.timeToFirstTokenMs / 1000).toFixed(1) + 's' : '')) +",
    "      popRow('cache', cachePct + (mu.cacheReadTokens != null ? '  (' + niceTok(mu.cacheReadTokens) + ' de ' + niceTok(mu.inputTokens) + ')' : '') + (mu.timeToFirstTokenMs != null ? '  \u00b7  1er token ' + (mu.timeToFirstTokenMs / 1000).toFixed(1) + 's' : '')) +")
rep("    const ic = el.querySelector('.tool-ic');" + SEP +
    "    ic.innerHTML = status === 'pending' || status === 'in_progress' ? '<span class="spin"></span>' : '';",
    "    const ic = el.querySelector('.tool-ic');" + SEP +
    "    ic.innerHTML = status === 'pending' || status === 'in_progress'" + SEP +
    "      ? '<span class="spin"></span>'" + SEP +
    "      : toolIconSvg(String(u.kind || u.title || '').split(/[ /]/)[0], status === 'failed' ? 'failed' : 'ok');")
rep("    el.className = 'msg-user' + (opts && opts.queued ? ' queued' : '');",
    "    el.className = 'msg-user' + (opts && opts.queued ? ' queued' : '');" + SEP +
    "    if (!replay) el.classList.add('in');")
rep("    if (!thought && !state.replaying) rec.el.classList.add('streaming');",
    "    if (!thought && !state.replaying) { rec.el.classList.add('streaming'); rec.el.classList.add('in'); }")
k = raw.index('  function toolUpsert(')
raw = raw[:k] + rd('C:/goose-web/tools/_icons.js') + raw[k:]
rep("  if (!window.__usagePopKeys) {", rd('C:/goose-web/tools/_fab.js') + SEP + SEP + "  if (!window.__usagePopKeys) {")
wr(APP, raw)
wr(CSSF, rd(CSSF) + rd('C:/goose-web/tools/_icons.css'))
print('OK iconos+animaciones+cache')

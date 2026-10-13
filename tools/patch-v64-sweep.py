import io, sys
P = 'C:/goose-web/app/app.js'
with io.open(P, 'r', encoding='utf-8', newline='') as f:
    raw = f.read()
SEP = chr(13) + chr(10) if (chr(13) + chr(10)) in raw else chr(10)
LF = chr(10)
lines = raw.split(SEP)
print('lines=%d' % len(lines))

def ins(n, text, prefix):
    i = n - 1
    if not lines[i].startswith(prefix):
        print('FAIL insert %d prefix: %r' % (n, lines[i][:90])); sys.exit(1)
    lines[i:i] = text.split(LF)

def dele(n, prefix):
    i = n - 1
    if not lines[i].startswith(prefix):
        print('FAIL delete %d prefix: %r' % (n, lines[i][:90])); sys.exit(1)
    del lines[i]

# (descending order)
ins(1657, """    // Recien aca se puede decidir: el probe de arriba ya dijo que NO hay run vivo.
    // Antes esto corria dentro de renderSession, es decir ANTES de adoptar: una carta
    // pendiente de un run que si estaba vivo quedaba marcada como interrumpida.
    sweepInterruptedTools();""", "    if (!state.busy) flushPendingSteers();")

ins(1652, "      unsweepInterruptedTools(); // el run esta vivo: ninguna carta debe quedar como interrumpida",
    "      adoptRun(probe.runId, ")

dele(1106, "    sweepInterruptedTools(); // herramientas sin resultado")

ins(915, """
  // Reverso del sweep: si el run sigue vivo, una carta NO debe quedar marcada como
  // interrumpida (el sweep pudo haber corrido antes de adoptar). Idempotente.
  function unsweepInterruptedTools() {
    let n = 0;
    for (const el of state.tools.values()) {
      const t = el.querySelector('.tool-title .tint');
      if (!t) continue;
      t.remove();
      el.classList.remove('err');
      n++;
    }
    return n;
  }
""".strip(LF), "  // Refresco del turno adoptado sin reconstruir el DOM")

ins(844, """    // Auto-correccion: si la carta habia quedado marcada como interrumpida por un sweep
    // prematuro y ahora llega el resultado real, se limpia sola (sin recargar la vista).
    const stale = el.querySelector('.tool-title .tint');
    if (stale && status !== 'pending' && status !== 'in_progress') stale.remove();""",
    "    const ic = el.querySelector('.tool-ic');")

with io.open(P, 'w', encoding='utf-8', newline='') as f:
    f.write(SEP.join(lines))
print('OK app.js -> %d lines' % len(lines))

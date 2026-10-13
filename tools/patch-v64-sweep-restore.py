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
        print('FAIL insert %d: %r' % (n, lines[i][:90])); sys.exit(1)
    lines[i:i] = text.split(LF)

def rep(a, b, text, prefix):
    i, j = a - 1, b - 1
    if not lines[i].startswith(prefix):
        print('FAIL replace %d: %r' % (a, lines[i][:90])); sys.exit(1)
    lines[i:j+1] = text.split(LF)

# (descending)
ins(1124, """    // Marca YA las herramientas que quedaron sin resultado: el replay no debe dejar
    // spinners eternos. Si despues el probe de checkAdoptedRun encuentra el run VIVO,
    // unsweepInterruptedTools() lo deshace y devuelve el spinner (ver ahi).
    sweepInterruptedTools();""",
    "    flushRender(); // pinta lo que haya quedado pendiente del replay")

rep(922, 932, """  function unsweepInterruptedTools() {
    let n = 0;
    for (const el of state.tools.values()) {
      const t = el.querySelector('.tool-title .tint');
      if (!t) continue;
      t.remove();
      el.classList.remove('err');
      // El run sigue vivo: la carta tiene que volver a girar (el sweep le saco el spin).
      const ic = el.querySelector('.tool-ic');
      if (ic && !ic.querySelector('.spin')) ic.innerHTML = '<span class="spin"></span>';
      n++;
    }
    return n;
  }""", "  function unsweepInterruptedTools() {")

with io.open(P, 'w', encoding='utf-8', newline='') as f:
    f.write(SEP.join(lines))
print('OK app.js -> %d lines' % len(lines))

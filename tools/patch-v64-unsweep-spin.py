import io, sys
P = 'C:/goose-web/app/app.js'
with io.open(P, 'r', encoding='utf-8', newline='') as f:
    raw = f.read()
SEP = chr(13) + chr(10) if (chr(13) + chr(10)) in raw else chr(10)
lines = raw.split(SEP)
def rep(a, b, text, prefix):
    i, j = a - 1, b - 1
    if not lines[i].startswith(prefix):
        print('FAIL replace %d: %r' % (a, lines[i][:90])); sys.exit(1)
    lines[i:j+1] = text.split(chr(10))
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
print('OK unsweep spinner')

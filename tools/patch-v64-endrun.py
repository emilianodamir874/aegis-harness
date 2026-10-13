import io, sys
P = 'C:/goose-web/app/app.js'
with io.open(P, 'r', encoding='utf-8', newline='') as f:
    raw = f.read()
SEP = chr(13) + chr(10) if (chr(13) + chr(10)) in raw else chr(10)
old = '''  function endRun(text) {
    state.adopted = false;
    stopRunWatch();
    if (state.busy) setBusy(false, text);
  }'''.replace(chr(10), SEP)
new = '''  function endRun(text) {
    state.adopted = false;
    stopRunWatch();
    if (state.busy) setBusy(false, text);
    // El turno ya cerro (activeRunId=null): recien ahora una carta que sigue girando
    // es una interrupcion real. Con el run vivo no se toca (ver checkAdoptedRun).
    sweepInterruptedTools();
  }'''.replace(chr(10), SEP)
if raw.count(old) != 1:
    print('FAIL endRun count=%d' % raw.count(old)); sys.exit(1)
raw = raw.replace(old, new)
with io.open(P, 'w', encoding='utf-8', newline='') as f:
    f.write(raw)
print('OK endRun')

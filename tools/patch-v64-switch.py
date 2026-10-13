import io, sys
P = 'C:/goose-web/app/app.js'
with io.open(P, 'r', encoding='utf-8', newline='') as f:
    raw = f.read()
SEP = chr(13) + chr(10) if (chr(13) + chr(10)) in raw else chr(10)
LF = chr(10)
lines = raw.split(SEP)
print('lines=%d sep=%s' % (len(lines), repr(SEP)))

def ins(n, text, prefix):
    i = n - 1
    if not lines[i].startswith(prefix):
        print('FAIL insert %d prefix: %r' % (n, lines[i][:90])); sys.exit(1)
    lines[i:i] = text.split(LF)

def rep(a, b, text, prefix):
    i, j = a - 1, b - 1
    if not lines[i].startswith(prefix):
        print('FAIL replace %d prefix: %r' % (a, lines[i][:90])); sys.exit(1)
    lines[i:j+1] = text.split(LF)

rep(2121, 2121, "  report('boot', 'app cargada (v6.4)');", "  report('boot', 'app cargada (v6")

rep(2029, 2029, "  $('#btn-new').addEventListener('click', () => { releaseViewRun(); newSession(); });",
    "    $('#btn-new').addEventListener('click'")

ins(1287, "      if (!state.current || state.current.id !== mySession) return; // cambiaste de chat: no tocar esta vista",
    "      if (loMandoComoIndicacion")

ins(1273, "      if (!state.current || state.current.id !== mySession) return; // cambiaste de chat: no tocar esta vista",
    "      // El server nombra en el propio error")

ins(1267, "      if (!state.current || state.current.id !== mySession) return; // cambiaste de chat: no tocar esta vista",
    "      if (res && res.usage")

ins(1262, "    const mySession = state.current.id;", "    setBusy(true, 'Goose est")

ins(1233, """
  // Suelta la vista de un turno en curso SIN cerrarlo: el run sigue vivo en el
  // server. Se usa al cambiar de chat, crear otro nuevo o dejar una sesion
  // adoptada, para que la vista nueva no herede la barra ni el boton Detener.
  function releaseViewRun() {
    state.busy = false;
    state.adopted = false;
    state.runId = null;
    $('#btn-send').hidden = false;
    $('#btn-stop').hidden = true;
    $('#btn-attach').classList.remove('busy');
    runBarHide();
    clearStreaming();
    stopRunWatch();
    updateMetaHints();
  }
""".strip(LF), "  function updateMetaHints() {")

rep(1073, 1078, """  async function openSession(entry) {
    // Cambiar de chat con un turno en curso es valido: el run sigue vivo en el
    // server y esta vista deja de representarlo. Al volver, checkAdoptedRun lo
    // re-adopta (barra + Detener + refresco). Nunca cortamos el run por esto.
    if (state.busy || state.adopted) releaseViewRun();
    stopRunWatch();
    await renderSession(entry);
    await checkAdoptedRun();
  }""", "  async function openSession(entry) {")

with io.open(P, 'w', encoding='utf-8', newline='') as f:
    f.write(SEP.join(lines))
print('OK app.js -> %d lines' % len(lines))

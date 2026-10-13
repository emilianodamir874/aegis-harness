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

def rep(n, text, prefix):
    i = n - 1
    if not lines[i].startswith(prefix):
        print('FAIL replace %d: %r' % (n, lines[i][:90])); sys.exit(1)
    lines[i:i+1] = text.split(LF)

# finishSettle: el historial NO prueba consumo cuando el server la tenia encolada.
rep(1629, """      // OJO: estar en el historial NO prueba que el turno la haya consumido.
      // clear_active_run -> discard_pending_steers tira las steers aceptadas y ya
      // persistidas. Si el server nos dijo que la tenia ENCOLADA (queuedSteer) y no
      // llego el eco, el turno cerro sin leerla: se reenvia como mensaje.
      const serverHeldIt = !!(info && info.serverQueued);
      if (text && textInServerHistory(text) && !serverHeldIt) {""",
    "      if (text && textInServerHistory(text)) {")

# Marca: el server la tiene encolada sin consumir.
ins(334, "          state.steers.get(g.queuedSteer.messageId).serverQueued = true;",
    "          setQueuedNote(state.steers.get(g.queuedSteer.messageId)")

with io.open(P, 'w', encoding='utf-8', newline='') as f:
    f.write(SEP.join(lines))
print('OK app.js -> %d lines' % len(lines))

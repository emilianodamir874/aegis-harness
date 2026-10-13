# Inserta la seccion v6 en el README de goose-web (antes de la v5) y suma pitfalls.
import io, sys

P = r'C:\goose-web\README.md'
t = io.open(P, encoding='utf-8').read()
io.open(P + '.bak-v6', 'wb').write(t.encode('utf-8'))

V6 = """## Qué hay de nuevo en v6 (2026-10-12 — recargar en medio de un turno)

Reporte de Emiliano: *"cuando recargaba la página ya perdía el streaming, no podía
pausarlo ni continuaba; requería recargar activamente para ver las actualizaciones"*.
Reproducido en vivo y arreglado en el cliente (sin tocar el backend):

- **La causa, medida:** al recargar, las notificaciones del turno siguen yendo a la
  conexión que lanzó el `session/prompt` (la que murió con la recarga), así que la
  pestaña nueva no recibe **ni un chunk**. Verificado con `tools/reload-probe.mjs`
  contra el server real: conexión nueva + `session/load` en medio de un turno → 0
  `agent_message_chunk`, 0 `tool_call` (solo `usage_update`). No había forma de que
  el cliente "viera" el progreso: había que volver a recargar y leer el historial.
- **El turno se adopta al abrir la página.** Al arrancar (o al reconectar el WS, o al
  abrir otra sesión) el cliente **pregunta si hay un run activo** y, si lo hay, entra
  en modo adoptado: aparece la **barra de turno con Detener** aunque la herramienta
  esté en silencio, y el cronómetro corre. `session/cancel` se rutea al dueño del run,
  así que **Detener corta igual** desde la pestaña recargada.
  Cómo se pregunta: `_goose/unstable/session/steer` con un `expectedRunId` imposible —
  el server valida el run **antes** de tocar al agente, de modo que no encola nada y
  contesta el run real en `error.data.actualRunId` (o "no active run to steer"). Es la
  única lectura pública de "¿está corriendo?"; `session/info` no lo expone.
- **Refresco sin recargar a mano.** Mientras el turno está adoptado, cada 2,5 s se
  consulta `_goose/unstable/session/info` (barato): si `messageCount`/`lastMessageAt`
  creció, la conversación se recarga sola (`session/load` con el turno adoptado
  preservado: barra, cronómetro, Detener y las indicaciones en cola siguen ahí). Al
  terminar el run la barra pasa a "El turno terminó (otra conexión)" y el último
  refresco trae la respuesta final.
- **Un mensaje durante un turno desconocido ya no se pierde.** Si el cliente cree que
  no hay run, `session/prompt` falla con *"session already has active run `run_x`"*:
  el cliente lee ese id, adopta el turno y **manda el texto como indicación**
  (burbuja "en cola"), en vez de mostrar un error de conexión.
- **Indicaciones que el turno no consume: se reenvían.** El server **descarta** los
  steers que quedaron en la cola cuando el run cierra (`clear_active_run` →
  `discard_pending_steers`), así que la burbuja quedaba "en cola" para siempre sin
  respuesta. Ahora, al terminar el turno, cada indicación sin eco se verifica contra
  la conversación persistida (¿el server la persistió como mensaje?) y, si no llegó,
  se **reencola como mensaje normal** con aviso ("queda sin respuesta: se reenvía").
  Las indicaciones pendientes también sobreviven a una recarga (`localStorage`), así
  que un steer escrito justo antes de recargar se reenvía al volver.
- Medido en móvil (390×844) con `scripts/goose-web-reload-test.mjs --mobile` y
  `goose-web-phone-audit.mjs`: ver la sección de verificación.

"""

anchor = '## Qu\u00e9 hay de nuevo en v5'
if t.count(anchor) != 1:
    sys.exit('ancla README no unica: %d' % t.count(anchor))
t = t.replace(anchor, V6 + anchor, 1)

PIT_A = '- `window.__gooseWeb` ahora tambi\u00e9n expone `dropSocket()`'
PIT_B = """- **Turno adoptado / recarga**: las notificaciones van a la conexión que lanzó el
  prompt; una pestaña recargada **nunca** recibe ese streaming. No inventes "reconectar
  el stream": hay que sondear (`activeRunId()` = steer con `expectedRunId` imposible) y
  refrescar con `session/info` + `session/load`. `setBusy(false)` **no** puede cerrar un
  turno adoptado (`state.adopted`): el run vive en el server.
- **Steers**: `state.steers` guarda `{el, text, atts}` (no solo el nodo) y al terminar el
  turno se resuelven en `finishSettle()`: eco → recibida; sin eco y sin rastro en el
  historial persistido → **reencolar como prompt**. `state.suppressSettle` evita reencolar
  por una caída de red (ahí el run puede seguir vivo y consumirla después).
- `window.__gooseWeb` ahora tambi\u00e9n expone `dropSocket()`"""
if t.count(PIT_A) != 1:
    sys.exit('ancla pitfalls no unica: %d' % t.count(PIT_A))
t = t.replace(PIT_A, PIT_B, 1)

io.open(P, 'w', encoding='utf-8', newline='').write(t)
print('README v6 listo, bytes:', len(t))

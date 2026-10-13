# goose-web

Acceso a goose del fork de Emiliano desde el navegador por LAN (sin instalar nada en los dispositivos).

- **UI (web):** http://192.168.100.34:3788  (local: http://127.0.0.1:3788)
- **Backend:** `goose serve` (ACP sobre WebSocket) en 0.0.0.0:3284
- Comparte sesiones, proveedores y configuración con el CLI/desktop (misma máquina).

## Qué es (v3 — cliente de chat propio, tipo Hermes web)

`app/` contiene un cliente de chat propio — HTML + CSS + JS sin dependencias, sin Electron:
sidebar de sesiones (búsqueda, grupos por fecha, renombrar y borrar inline), chat con streaming
en vivo, tarjetas de tool calls (expandibles), bloques de pensamiento colapsables, chips de
Proveedor / Mode / Modelo, **tarjeta de permisos con botones** (permitir/una vez/siempre/rechazar),
**adjuntar imágenes** (pegar captura o botón +, con redimensionado automático), copiar código y
mensajes, markdown con listas/títulos/citas, atajos (Ctrl+K buscar, Esc cerrar), drawer en móvil,
reconexión automática y manifest para "Agregar a pantalla de inicio". Estética oscura basada en
los tokens de Hermes web (chrome `#0d0d0e`, tarjetas `#161618`, acento `#0053fd`).

- `server.mjs` sirve `app/` y genera `/config.js` en cada request (URL del WS con token —
  los secretos nunca viven en archivos estáticos), con `ETag` + `no-cache`, CSP y `/client-log`.
- La v1 (renderer del desktop embutido con shim) quedó archivada en `dist/` como rollback — no se sirve.

## Files

- `app/` — index.html, app.css, app.js (el cliente de chat).
- `config.json` — puertos, host LAN, secret key, cwd, appConfig.
- `server.mjs` — static server + `/config.js` + `/client-log` + `/healthz`.
- `tools/` — probes ACP (`probe2.mjs`, `probe-config.mjs`, `ls-sessions.mjs`),
  `cleanup-test-sessions.mjs`, `sample-context.txt` (archivo de prueba para adjuntos), `shots/` (capturas).
- `scripts/` — start/stop/setup/launch (tarea programada `Goose_Web`).
- `logs/` — server/serve + `requests.log` + `client.log` (reportes de dispositivos reales).

## Code Mode como vía principal (2026-10-12 — backend v2)

- `goose-serve-v2.exe` (build 16:18; `rustls-tls,scheduler,bundled-mcp,chat-recall,acp-http,code-mode`) reemplaza a v1 en `scripts/start-goose-web.ps1` (backup `.bak-pre-v2`; el binario v1 queda en disco para rollback).
- **Sesiones NUEVAS del web corren Code Mode** (extensión `code_execution` habilitada en la config): el agente trabaja vía `execute_typescript`/`list_functions`. Las sesiones VIEJAS retomadas NO lo heredan (el set de extensiones queda fijado al crear la sesión) — para cm, chat nuevo (memoria vía chatrecall). Verificado: `tools/smoke-serve-v2.mjs` (nueva → `execute typescript` → resultado OK) + resume de `_22` (sin `execute_typescript`).
- El CLI principal también: `goose.cmd` → `goose-codemode-v2.exe` (backup `.bak-pre-cm-main`); `goose-cm.cmd` queda de alias.

## Cambiar de chat con un turno en curso (2026-10-12)

- `openSession`, `newSession` y el handler de `#btn-new` ya no bloquean cuando hay un run en curso: la vista se libera (`detachRunView()`), el run sigue vivo en el server, y al volver `checkAdoptedRun()` lo re-adopta (barra + Detener + refresco). `sendText` no toca la UI si la resolución del prompt llega con la vista en otro chat; `onUpdate` filtra por `sessionId` (ya en v6.2).
- Ojo: el handler del botón `+ Nuevo chat` tenía su PROPIA guarda (`Esperá a que termine…`) además de la de `newSession` — eliminada; no reintroducir guardas bloqueantes (el único aviso válido es informativo).
- Tests (3, verdes): `ui/desktop/scripts/goose-web-switch-check.mjs` (run adoptado), `-newchat-check.mjs` (+ Nuevo chat con turno activo), `-owner-switch-check.mjs` (turno propio; run verificado VIVO desde afuera durante el cambio). Backups: `app/app.js.bak-pre-detach`, `.bak-pre-btnnew`.
- Nota: si el turno propio termina mientras estás en otro chat, no se muestran "fin del turno"/temporizador (no se toca la vista ajena); al volver la conversación está completa.
- **Watchdog de turno huérfano (v6.3+wd, 2026-10-12)**: si un `session/prompt` propio queda sin respuesta porque el run murió en silencio (sin run activo en el server), el cliente lo detecta (doble sonda con gracia de 4 s, tick 15 s, solo en modo dueño) y **libera la consola + reenvía la cola + settleSteers** — mata el caso "después de mandar un mensaje no puedo enviar más" (caso real: sesión _36, 12/10 17:27). Test: `goose-web-watchdog-sanity.mjs`. Backup: `app/app.js.bak-pre-watchdog`. Headers de versión: `v6.3+detach+wd`.
- **Steer descartado al cierre (fix "+sc", 2026-10-12)**: `clear_active_run` descarta las indicaciones encoladas al cerrar un run → quedaban persistidas SIN respuesta (casos reales: "vos podes sacar screenshots" 17:27 y "Vamos con todo!!" 18:08 en _36). Antes, `finishSettle`/`flushPendingSteers` marcaban "recibida" si el texto estaba en el historial — pero **persistido ≠ consumido**. Ahora `steerAnsweredInHistory()` exige RESPUESTA DEL ASISTENTE DESPUÉS de la indicación (burbujas `.msg-a`); si no la hay, se reencola como mensaje y `flushQueue` la envía (run nuevo). Además `endAdoptedRun()` ahora también settlea (antes, un turno ADOPTADO no revisaba sus steers al terminar: hueco #1). Test determinista: `goose-web-swallow3-check.mjs` (steer → Detener → nota "se reenvía como mensaje" a los ~4 s → respuesta del asistente ✓). Backup: `app/app.js.bak-pre-sc`. Versión: `v6.3+detach+wd+sc`.

## Qué hay de nuevo en v6.1 (2026-10-12 — fin de turno adoptado + cursor fantasma)

Tres bugs de v6 cazados con `ui/desktop/scripts/goose-web-end-transition.mjs`, `goose-web-fresh-check.mjs` y `goose-web-live-cursor.mjs`:

1. **El fin de turno adoptado jamás se detectaba**: al terminar el run, el sondeo (`session/steer` con `expectedRunId` imposible) recibe `error.message:"Invalid params"` con `error.data:"no active run to steer"` (string) — el cliente testeaba `message` y quedaba `known:false` para siempre: barra "Turno en curso" y cursor eternos. Fix en `activeRunId()`: combinar `message` + `data` (string u objeto) y buscar ahí; el caso activo trae `data.actualRunId` (objeto) o el id embebido (`run_[0-9a-f-]+`).
2. **Cursor fantasma en el replay**: `streamAppend` agregaba `.streaming` también durante el replay (`state.replaying`) y nadie lo limpiaba al cerrar → cada carga de una sesión mostraba el cursor pegado en el último mensaje (reporte del operador: "no termina más el streaming cuando claramente terminó"). Fix doble: `if (!thought && !state.replaying)` + `clearStreaming()` al final de `renderSession`.
3. Verificado además: Detener desde una pestaña adoptada corta el run (`stopReason: cancelled` en 11 s) y la adopción al abrir/recargar funciona (barra + aviso + refresco periódico). El boot reporta `v6.1` en `logs/client.log`.

Backups: `app/app.js.bak-v6-pre-sondeo`. Sondeo crudo: `tools/probe-steer-shape.mjs`.

## Qué hay de nuevo en v6.3 (2026-10-12 — tablas markdown)

Reporte con foto: en el chat se veían los `|` crudos y la fila de guiones (`|---|---|---|`) como
texto (el renderer no tenía tablas, así que mis tablas de métricas llegaban ilegibles al teléfono).

`mdBlocks` ahora reconoce fila de encabezado + separador (`|---|:--:|`) + filas, con alineación por
celda (`:---`, `:---:`, `---:`), formato inline dentro de las celdas (`**negrita**`, `` `código` ``,
`<strong>`, `<em>`, enlaces automáticos) y envoltura `.tbl-wrap` con **scroll horizontal propio** en
el teléfono (la página nunca desborda). Un bloque de código con pipes sigue siendo código y una línea
con un solo `|` no se confunde con tabla.

Verificado con `ui/desktop/scripts/goose-web-md-tables.mjs` (8 casos: básica, alineación, sin
cuerpo, con texto antes/después, inline en celdas, code con pipes, falso positivo, listas/citas) y
humo sobre el replay real: la sesión de 1.167 mensajes pinta 372 elementos en 1,9 s sin errores y ya
muestra 1 tabla que antes salía como texto crudo (la corrección aplica a todo el historial).

Limitación conocida (previa, no de esta versión): los enlaces markdown `[texto](url)` no se
renderizan como enlace; sólo se autoenlazan las URLs sueltas.

## Qué hay de nuevo en v6.2 (2026-10-12 — tecleo en el teléfono + avances del turno adoptado)

Queja del operador: *"cuando escribo en el teléfono llegan tarde los caracteres"*. Medido antes de
tocar nada (Chrome móvil 390×844 + CPU 4x como proxy del teléfono; sesión de 781 y de 1167 mensajes):

| Caso | p50 tecla→frame | long tasks |
| --- | --- | --- |
| Reposo, sesión de 1167 mensajes (13.343 nodos) | 3,1 ms | 0 |
| Con run activo (streaming propio o adoptado) | ~19 ms (≈1 frame) | 0 |
| **Refresco del turno adoptado = rebuild completo del DOM** | — | **2.310 ms repartidos, máx. 206 ms** |

Costo por tecla del cliente: 0,77–0,85 ms (`autosize`+menú de comandos agrupados en un rAF). O sea:
el lag no venía del composer ni del streaming, venía de **reconstruir toda la conversación**
(`clearMessages` + replay de `session/load`) en una sesión larga, que en un teléfono son cientos de
ms de main thread bloqueado: la tecla que cae dentro de ese bloque llega tarde.

Además, con `goose-web-watch-probe.mjs` se midió que **el `messageCount` que ve una conexión que NO
es dueña del run viene congelado** (18 polls seguidos con la misma clave durante 45 s de
herramientas): el resync por cambio de clave de v6 casi nunca disparaba en el caso del teléfono.

Cambios (sólo cliente; el backend no necesita rebuild):

1. **Refresco suave** (`softResync`): el `session/load` sigue trayendo toda la conversación, pero lo
   que llega se bufferiza (`SOFT`) y al final sólo se pinta **lo nuevo**: los mensajes ya pintados se
   saltan comparando texto, los de usuario por `messageId` (`data-mid`), las cartas de herramienta
   sólo se reaplican si son nuevas / estaban girando / quedaron sin contenido. Nunca se borra el DOM
   ni se pierden scroll, adjuntos, cola ni indicaciones. Costo medido: **18–21 ms** por refresco.
2. **No se refresca mientras el usuario teclea** (`lastTypedAt`, guarda de 2,5 s) y mínimo de 12 s
   entre refrescos; si el replay del server pesa mucho, el intervalo se espacia solo (15 s → 30 s →
   60 s). Verificado: 8–9 refrescos postergados durante 25 s de tecleo, 0 toques al DOM.
3. **Respaldo periódico** (15 s) porque el `messageCount` de una conexión ajena puede venir congelado:
   así la pestaña recargada **sí** ve avances sola (medido: 1 → 7 mensajes en 35 s sin recargar).
4. **Herramientas sin resultado** (`sweepInterruptedTools`): si no hay run activo y una carta quedó
   girando, se marca `err` + "· interrumpido (sin resultado)". Verificado en una sesión real que
   quedó con 2 llamadas `pending` tras un run muerto: 0 girando, 2 marcadas, 0 falsos positivos.
5. Diferido sigue estando `resyncAdoptedRun` (rebuild completo) para el `session/load` inicial y como
   herramienta de depuración (`window.__gooseWeb.resync`).

Verificado además en esta ronda (lo que faltaba de v6): Detener desde la pestaña recargada corta el
run (960–1317 ms, `stopReason: cancelled`); reloj de la barra corriendo tras la recarga; mensaje
escrito durante una herramienta silenciosa entra como indicación; y un steer **no consumido** (se
detiene el turno dentro de la herramienta) se reencola al terminar: aviso "Una indicación quedó sin
respuesta en ese turno: se reenvía como mensaje.", burbuja limpia y turno nuevo enviado.

Pendiente medido y **no** arreglado: el `session/load` **inicial** de una sesión grande sigue
reproduciendo todo (p95 78 ms y un long task de 323 ms en la cola del replay con 1167 mensajes).
Tipear justo después de abrir una sesión enorme todavía puede sentirse lento: el próximo paso es
render por tramos / virtualizar el replay (no tocar el throttle del composer, que ya está fino).

Backups: `app/app.js.bak-v62` y `app/app.css.bak-v62` (estado verificado posterior a los cambios).

## Qué hay de nuevo en v6 (2026-10-12 — recargar en medio de un turno)

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

## Qué hay de nuevo en v5 (2026-10-12 · feedback del celular)

Tres cosas reportadas desde el teléfono (390 px), con medición antes/después usando
`ui/desktop/scripts/goose-web-phone-audit.mjs` (Playwright, viewport 390×844, isMobile):

- **Los desplegables del header no se veían.** En ≤880 px los chips vivían en la misma fila
  del título: el chip de **proveedor se ocultaba** (`display:none` en ≤480 px) y el del
  **modelo se truncaba a 88 px** (`deepseek-v4.1-f…`). Medido: 2 de 3 visibles, 1 legible.
  Ahora en móvil el header va en **dos líneas** — ☰ + título arriba, y los chips en su propia
  fila a ancho completo, alineados a la izquierda, sin máscara de corte y con tope de 64vw.
  Medido: **3 de 3 visibles y sin truncar** (`Open Design` 107 px, `auto` 61 px,
  `deepseek-v4.1-flash-max` 174 px), sin scroll horizontal a 390 px. El topbar pasa de 51 a 90 px.
- **Escribir rápido en el composer perdía caracteres.** El trabajo no estaba en un solo lugar:
  el handler de `input` leía layout (`autosize()`) *dentro* del evento que ve el teclado, no había
  guard de composición del IME, y mientras el agente streameaba el cliente re-parseaba el markdown
  y reemplazaba el `innerHTML` de **todo** el mensaje hasta 60 veces por segundo (costo que crece
  con el largo del texto). Ahora: (a) el trabajo del composer va agrupado en un
  `requestAnimationFrame` (`scheduleComposer`) y no se toca el textarea durante
  `compositionstart/end`; (b) el mensaje que está creciendo se re-renderiza como máximo cada
  `STREAM_RENDER_MS = 90 ms` (con borde final garantizado) y el throttle no aplica en el replay;
  (c) el textarea pide `enterkeyhint="send"` para que el teclado del teléfono muestre "Enviar".

  **Lo medido, sin maquillar** (`goose-web-phone-audit.mjs`, 390×844, sesión de 1080 mensajes):
  tecla → frame pintado p50 **7.9 ms en reposo** y **12.7 ms con texto entrando en vivo**, sin un
  solo frame perdido (17 ms), con el renderer en ~0.6% de CPU y ~5 layouts/s durante el stream.
  La comparación A/B del throttle (activado vs `live=false`, o sea el comportamiento viejo) dio
  **12.7 vs 12.7 ms**: en este equipo, con CPU de escritorio y mensajes de 2-3 KB, el costo por
  frame es submilisegundo y el techo de 11 renders/s no se nota. Es una medida preventiva para
  mensajes largos en la CPU de un teléfono, no algo que pueda demostrar acá.
  Y el síntoma original (**teclas que se pierden**) es del IME de Android: chrome headless no tiene
  teclado de Android, así que no se puede reproducir experimentalmente — lo que sí se hizo es quitar
  del camino del evento todo lo que puede desincronizarlo. Si vuelve a pasar, mirar `logs/client.log`
  (reporta `error`/`rejection` del cliente) antes de tocar el código.
- **No se notaba cuándo terminaba el streaming ni se podía cortar.** El único indicio era el
  cursor ▍ (que cualquier tool call borraba) y el ícono del botón de enviar cambiando de ↑ a ■.
  Ahora hay una **barra de turno** arriba del composer: spinner + cronómetro + botón
  **Detener** grande, y al terminar pasa a "Respuesta completa · 12,3 s" (6 s) más una marca
  `fin del turno · 12,3 s` en la conversación, que queda donde terminó el texto. Medido: con el
  turno en curso, `#btn-stop` visible y la barra con el cronómetro corriendo; **Detener corta en
  75 ms** (runbar → "Turno detenido · 34,8 s") y el composer vuelve a aceptar texto enseguida.
  Ojo con este detalle del modelo: `deepseek-v4.1-flash-max` pasó **~30 s sin emitir un solo
  carácter** antes del primer chunk de texto — con la UI vieja eso era una pantalla muda.
  Además el cliente ahora **adopta** runs que no arrancó él (chunks que llegan sin turno local:
  otra conexión, o la pestaña recargada mid-turn) y el corte se puede pedir igual.
- **Bugs de fondo que dejaban la UI trabada** (por eso "no puedo detenerlo"): las peticiones RPC
  pendientes **nunca se rechazaban** cuando caía el WebSocket, así que un `session/prompt`
  colgado dejaba `state.busy = true` para siempre — sin envío y sin Detener hasta recargar.
  Ahora `ws.onclose` rechaza lo pendiente, el turno se cierra con aviso ("Se cortó la conexión:
  el turno se interrumpió") y la cola de mensajes espera a la reconexión. Verificado cortando el
  socket real en medio de un turno (`__gooseWeb.dropSocket()`): la UI sale de "busy" sola, la barra
  avisa del corte, el composer vuelve a aceptar texto y la reconexión no deja nada trabado.
  Y si el server no confirma el corte en 12 s, la barra lo dice y deja reintentar en vez de
  quedarse en "Deteniendo…".

## Qué hay de nuevo en v4 (2026-10-12)

Sobre la base v3, todo verificado con los checks de `ui/desktop/scripts`:

- **Estado vacío explícito**: al abrir una sesión sin mensajes se imprime un welcome propio
  ("Sesión sin mensajes" + título de la sesión); el welcome de chat nuevo mantiene saludo + sugerencias.
- **Adjuntos**: además de imágenes (pegar / botón +), se adjuntan **archivos de texto** como contexto
  (`file input` y **arrastrar y soltar sobre la ventana** con overlay `#dropzone`). Límites: 6 adjuntos,
  256 KB por archivo de texto (se recortan los primeros 80 000 caracteres), 12 MB por imagen.
- **Menú por sesión (⋮)**: renombrar, **exportar a Markdown / JSON** (`_goose/unstable/session/export`,
  descarga real vía Blob) y **archivar / desarchivar** (`_goose/unstable/session/archive|unarchive`).
  Las archivadas van a un grupo "Archivadas" plegable, con tag y acciones propias.
- **Slash commands**: autocompletado en el composer (`_goose/unstable/slash-commands/list` y/o la
  notificación `available_commands_update`): ↑↓ para elegir, Tab/Enter inserta, Esc cierra.
- **Steering**: con el agente trabajando, **Enter manda una indicación al vuelo**
  (`_goose/unstable/session/steer` con `expectedRunId`, tomado de
  `session_info_update._meta.goose.activeRunId`). La burbuja se marca "en cola" y pasa a
  "indicación recibida por el agente" cuando el server la levanta. Si no hay run al que apuntar
  (o el steer falla), el mensaje queda en cola local y sale al terminar el turno.
- **Paginación del sidebar**: `session/list` devuelve 50 por página con `nextCursor`; ahora se
  sigue el cursor con botón "Cargar más sesiones" (antes las sesiones >50 eran invisibles).
- **Rendimiento del replay**: un solo `requestAnimationFrame` para todos los registros sucios y sin
  autoscroll durante la carga. Sesión de 1166 mensajes: primera pintura 431 ms → 23 ms, total
  2.78 s → 1.35 s (medido con `goose-web-perf.mjs`).
- Toasts para confirmaciones, `#meta-left` con atajos (oculto en teléfono), hint de steering mientras
  el agente trabaja, y `window.__gooseWeb` como superficie mínima de depuración (estado + showWelcome).

## Backend / auth

`C:/goose/target/debug/goose-serve-v2.exe serve --host 0.0.0.0 --port 3284 --platform desktop
--enable-scheduler --with-builtin developer --allowed-origin http://192.168.100.34:3788
--allowed-origin http://127.0.0.1:3788 --allowed-origin http://localhost:3788`, con
`GOOSE_SERVER__SECRET_KEY` (de `config.json`). Los browsers no pueden setear headers en un
WebSocket: la autenticación va como `?token=` en la URL del WS (el server lo acepta).

## Verificación

```bash
cd C:/goose/ui/desktop
node scripts/goose-web-app-check.mjs     # e2e completo: conexión, enviar+streaming, chips,
                                         # permisos, rename, imagen, borrado, replay, móvil
node scripts/goose-web-viewports.mjs     # barrido 360→1920 (abre una sesión para medir los chips;
                                         # cero desbordes horizontales)
node scripts/goose-web-features.mjs      # features v4: welcome vacío, adjuntos de texto + drag&drop,
                                         # export md/json (descarga), archivar/desarchivar, slash, steering
node scripts/goose-web-perf.mjs          # tiempo de replay de las 3 sesiones más grandes
node scripts/goose-web-shots.mjs         # capturas desktop/móvil
node scripts/goose-web-phone-audit.mjs   # móvil 390×844: desplegables del header, costo de tipear
                                         # (reposo / streaming, A/B del throttle) y estado del turno
                                         # (Detener, caída del WebSocket, reconexión)

# v6.2 — tecleo y turno adoptado (móvil + CPU 4x vía CDP; el backend debe estar sirviendo la app)
node scripts/goose-web-stream-typing.mjs    # reposo vs streaming vs recién terminado, con costo real
                                            # de render/tecla (window.__gooseWeb.metrics)
node scripts/goose-web-typing-big.mjs       # sesión larga (importa una copia) + turno adoptado:
                                            # ventana A (poll encendido) vs B (apagado)
node scripts/goose-web-soft-check.mjs       # refresco suave: fase tecleando (debe postergar),
                                            # fase reposo (debe traer lo nuevo barato) y marca de
                                            # herramientas interrumpidas
node scripts/goose-web-watch-probe.mjs      # trazas del poll: ticks, session/info, messageCount
                                            # congelado en conexiones que no son dueñas del run
node scripts/goose-web-deadrun-live.mjs     # busca sesiones con herramientas sin resultado y
                                            # verifica la marca; mide el refresco que trae avances
node scripts/goose-web-steer-settle.mjs     # steer no consumido -> reencolado + aviso + reenvío
node scripts/goose-web-typing-check.mjs     # adopción + Detener desde la pestaña recargada
```

Probes ACP crudos y utilidades en `C:/goose-web/tools/` (probe2/3/4/5, ls-sessions,
cleanup-test-sessions). Los checks se corren DESPRENDIDOS (Start-Process + log):
el wrapper de background mata node con "stdin is not a tty".

## Ops

```powershell
# start/stop (no elevado)
powershell -NoProfile -File C:\goose-web\scripts\start-goose-web.ps1
powershell -NoProfile -File C:\goose-web\scripts\stop-goose-web.ps1

# autostart (ya instalado; corre al iniciar sesión)
schtasks /Run /TN Goose_Web
```

Firewall (TCP 3788 + 3284, Private/LocalSubnet) y tarea `Goose_Web` ya instalados el 2026-10-12.

## Security notes

- Solo LAN (bind 0.0.0.0 + firewall acotado a Private/LocalSubnet). NO exponer a internet.
- Auth = secret key de `config.json` (inyectada al vuelo en `/config.js`); rotar editando el config y reiniciando ambos procesos.
- Sin TLS: http/ws plano en la red local (mismo modelo que el dashboard de Hermes).

## Pitfalls / reglas para agentes (leer antes de tocar el código)

- `app/*` son estáticos: no hay build; recargar y probar. `server.mjs` mantiene `no-cache` + ETag y el token se inyecta por request en `/config.js` — nunca en archivos estáticos.
- `[hidden]` es pisado por cualquier `display:` — existe la regla global `[hidden]{display:none!important}`; no la saques.
- Menús flotantes (chips): se abren como "portal" a `document.body` con `position:fixed` (`openMenu`). NO volver a anidarlos: la fila de chips tiene overflow + máscara y cualquier menú anidado queda clipeado (bug ya sufrido).
- Streaming: UNA entrada por messageId en `state.msgs`; cuando una herramienta cierra el bloque, el siguiente chunk reemplaza la entrada — no re-indexar la clave (fragmenta el texto en un elemento por chunk).
- UI inline (renombrar / confirmar borrado): `state.hold` pausa `renderList()` mientras hay un editor abierto, y tras cada refresh hay que re-buscar las entradas por id (los objetos de sesión se reemplazan).
- Código: `.msg-a pre { white-space: pre }` (sin wrap; scroll horizontal). El wrap por herencia rompe los comandos.
- Permisos de herramientas PERSISTEN en el server por herramienta: contestar "allow always" en una prueba desactiva los prompts futuros. Reset: `_goose/unstable/tools/permissions/set` con `{toolPermissions:[{toolName, permission:'ask_before'}]}`.
- Pruebas: correr los checks DESPRENDIDOS (`Start-Process` + log) — el wrapper de background mata node con "stdin is not a tty". Limpiar sesiones de prueba con `tools/cleanup-test-sessions.mjs`.
- Menús portal: el navegador hace `scrollIntoView` al clickear un botón fuera de vista, y ese scroll
  cerraba el menú antes de poder tocarlo. `openMenu` deja una ventana de 500 ms (`menuOpenedAt`) en la
  que el scroll no cierra menús. No sacarla.
- Título: el server **auto-titula** la sesión después del primer turno (con su propia llamada al modelo)
  y puede anunciarlo *después* de un rename del usuario. `titleLock` ignora `session_info_update.title`
  por 15 s tras un rename manual. No tocar el orden.
- Replay: un solo `flushRender` por frame para todos los registros sucios y `scrollBottom` no hace nada
  con `state.replaying = true`. Si volvés a medir `scrollHeight` por chunk (o a scrollear por mensaje)
  el replay de 1000+ mensajes se cae a ~3 s por layout thrashing.
- Steering: requiere `expectedRunId`; se obtiene de `session_info_update._meta.goose.activeRunId` (null
  cuando el run termina). La confirmación de pickup llega como `user_message_chunk` con el **mismo
  messageId** que devolvió `session/steer` — por eso la burbuja local no se duplica.
- Archivadas: el server **no** filtra archivadas en `session/list`; vienen con `_meta.archivedAt` y el
  cliente las separa en el grupo "Archivadas". `session/list` pagina de a 50: seguir `nextCursor`.
- Todo es LAN: no exponer a internet; no tocar `config.json` (secret key), los scripts de arranque ni las reglas de firewall.
- **Header en móvil**: en ≤880 px los chips van en su PROPIA fila (`flex: 1 0 100%`, `order: 5`).
  No volver a meterlos en la fila del título, ni ocultar el chip de proveedor, ni truncar el del
  modelo a 88 px: era exactamente el reporte "no veo todos los desplegables". Sin `mask-image`
  en esa fila (el degradado hacía parecer cortado lo que sí estaba).
- **Composer/IME**: el handler de `input` NO puede leer layout ni re-renderizar nada. Todo el
  trabajo va por `scheduleComposer()` (un rAF por ráfaga) y se ignora mientras `composing`
  (composición del teclado Android/iOS): tocar el textarea en medio de una composición es lo que
  hacía perder caracteres al tipear rápido. `autosize()` deja `lastComposerValue` sincronizado.
- **Streaming**: un registro con `live = true` (mensaje que está creciendo) se re-renderiza como
  máximo cada 90 ms; el borde final lo garantiza el `setTimeout` de `flushRender`. Durante el
  replay todos los registros quedan con `live = false` (se pinta una sola vez al final) — si el
  throttle se activa en el replay, la primera pintura de una sesión de 1000+ mensajes se cae.
- **Estado del turno**: los indicadores no pueden depender solo del `session/prompt` local. Si
  llegan chunks/herramientas con `!state.busy` el run se adopta (`noteRunActivity`), y
  `session_info_update._meta.goose.activeRunId = null` cierra el turno adoptado. `stopRun()`
  notifica `session/cancel` y tiene red de seguridad a los 12 s (no dejar "Deteniendo…" eterno).
- **RPC colgado**: `rpc.onclose` rechaza las promesas pendientes. Sacarlo reintroduce la UI trabada
  (`state.busy` en true para siempre → no envía, no corta, y todo lo que escribís se va a steering).
- **Turno adoptado / recarga**: las notificaciones van a la conexión que lanzó el
  prompt; una pestaña recargada **nunca** recibe ese streaming. No inventes "reconectar
  el stream": hay que sondear (`activeRunId()` = steer con `expectedRunId` imposible) y
  refrescar con `session/info` + `session/load`. `setBusy(false)` **no** puede cerrar un
  turno adoptado (`state.adopted`): el run vive en el server.
- **Steers**: `state.steers` guarda `{el, text, atts}` (no solo el nodo) y al terminar el
  turno se resuelven en `finishSettle()`: eco → recibida; sin eco y sin rastro en el
  historial persistido → **reencolar como prompt**. `state.suppressSettle` evita reencolar
  por una caída de red (ahí el run puede seguir vivo y consumirla después).
- `window.__gooseWeb` ahora también expone `dropSocket()` (solo para los checks: cortar el WS real).
- **Sondeo de run (v6.1)**: la respuesta del server a un steer con `expectedRunId` imposible SIEMPRE trae `error.message:"Invalid params"`; lo útil va en `error.data` como **string** ("no active run to steer") o **objeto** (`{actualRunId}`). Buscar "no active run" solo en `message` jamás matchea → el fin de turno no se detecta y la barra/cursor quedan eternos. No volver a simplificar ese parseo.
- **Cursor de streaming (v6.1)**: `streamAppend` NO debe agregar `.streaming` durante el replay (`state.replaying`) y `renderSession` DEBE limpiar con `clearStreaming()` al terminar; si no, cada carga de sesión deja un cursor pegado en el último mensaje.
- **Scripts de check**: los Playwright tienen que vivir en `ui/desktop/scripts/` (import resuelve desde `ui/desktop/node_modules`; un script suelto en `C:/goose-web/tools` explota con `ERR_MODULE_NOT_FOUND`).
- **`session/info` de una conexión que NO es dueña del run viene congelado (v6.2)**: el `messageCount`/`lastMessageAt` no se mueve mientras el run trabaja (medido: 18 polls con la misma clave en 45 s). El dueño sí lo ve crecer. Por eso el resync no puede depender sólo del cambio de clave: hay que refrescar periódicamente. No "arreglar" sacando el respaldo.
- **Refresco del turno adoptado: NUNCA `clearMessages()` + replay (v6.2)**: reconstruir el DOM de una sesión larga cuesta ~2,3 s de main thread bloqueado (tramos de 206 ms) y en el teléfono las teclas llegan tarde. Usar `softResync()` (bufferiza y pinta sólo lo nuevo). El rebuild completo queda para la carga inicial de la sesión y para depurar (`window.__gooseWeb.resync`).
- **Teclado (v6.2)**: el costo por tecla del cliente es <1 ms (medido) — no buscar el lag ahí. Antes de "optimizar el composer", medir con `goose-web-stream-typing.mjs` y `goose-web-soft-check.mjs` (CPU 4x): lo caro es render/layout de conversaciones grandes, no el composer.
- **`page.evaluate` en Playwright acepta UN solo argumento**: `page.evaluate(fn, a, b)` tira "Too many arguments"; pasar un objeto.
- **Bug de runtime del serve (2026-10-12, sin arreglar)**: un run murió en silencio justo después de que el tool terminó (`tools/stream-typing.json` se escribió completo y el resultado nunca llegó); en la sesión quedaron 2 `tool_call` con último estado `pending`. Sirve de caso de prueba para `sweepInterruptedTools()` (la UI ahora las marca "interrumpido").
- **Tablas markdown (v6.3)**: `mdBlocks` recorre las líneas con índice (`for (let _i ...)`) para poder mirar la línea siguiente (el separador) y saltear las filas consumidas. Si volvés a `for (const line of lines)` se rompen las tablas. Las celdas pasan por `inline()`: cualquier formato nuevo hay que agregarlo ahí, no en `tableHtml`.
- **`window.__gooseWeb.state.sessions` usa `sessionId`**, no `id` (el `id` aparece en `state.current`). Los scripts de check que escriben `localStorage['gweb.last']` desde la lista se equivocan con `s.id` y quedan 3 minutos esperando un replay vacío.


## v6.3 (backend: serve v3) - watchdog de runs + spill de imagenes

Detalle completo y procedimiento de swap: **docs/v6.3-serve-v3.md**. Resumen:

- **Watchdog de runs por fin**: cada evento del stream marca progreso; si un run pasa
  GOOSE_RUN_STALL_TIMEOUT_SECS (default 900 s, 0 desactiva) sin avanzar, el server emite un
  **error visible al cliente**, pone activeRunId=null y cancela el run. Antes ese caso dejaba la
  UI muda hasta recargar (sesion 20261012_23, 39 min muertos).
- **Cancelacion no pedida = aviso visible**: si un turno termina cancelado y no lo pidio el cliente
  (conexion caida, cancel interno), ahora se ve el motivo en vez de nada.
- **Imagenes de tools con tope**: GOOSE_MAX_TOOL_IMAGE_BASE64_SIZE (default 1.500.000 chars b64
  ~ 1,1 MB). Las imagenes grandes se escriben a archivo y queda un puntero, igual que el texto.
  Antes el cap solo miraba texto: la DB tenia 137 mensajes >60k chars / 54,6 MB de imagenes.
- **Cap de texto verificado**: GOOSE_MAX_TOOL_RESPONSE_SIZE se mide en CHARs (default 200.000;
  el usuario tiene 60.000) y si funciona (el texto de assistant topea en 78 KB).
- **Binario nuevo, no en uso**: goose-serve-v3.exe. v2 sigue siendo el que corre hasta hacer el swap.

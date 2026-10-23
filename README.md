# aegis-web

> **Nota de rutas (2026-10-22).** Las secciones fechadas 2026-10-12/13 describen el deploy cuando
> vivía en `C:\goose-web` con el cliente bajo `ui/desktop/scripts/` y los binarios en `src\target`.
> Nada de eso existe hoy: el deploy es este árbol, los probes y checks viven en `web\tools\`, el
> serve se resuelve del puntero `core\state\current-version.json` y el arranque está en
> `## Backend / auth`. Las rutas viejas se dejan como registro de lo que se midió, no como instrucción.

## Cierre de integracion (2026-10-23): busqueda, login, permisos, media y contexto

Segunda tanda sobre la base `beb49d6`. Cierra los huecos funcionales que quedaban fuera del
rediseño, sin tocar la arquitectura (TypeScript sin framework, esbuild, `app/` estatico).

- **Busqueda de texto completo en los mensajes.** `session/list` tiene contrato para esto
  (`_meta.query`), pero medido contra el store real (86k mensajes) **no respondio en 240 s**:
  el hub escanea con `instr(LOWER(json_extract(...)))` y bloquea el pool. La base ya mantiene
  el indice FTS5 `messages_fts` (triggers del hub, `unicode61 remove_diacritics 2`), asi que
  `tools/search-index.mjs` lo consulta en un proceso aparte y en solo lectura (mismo patron
  que `stats-index`). Expone `GET /search.json?q=&limit=` y el sidebar agrega la seccion
  «En los mensajes» con fragmentos resaltados; clickear abre sesiones que no estaban en la
  pagina cargada. Reglas: todas las palabras deben aparecer (prefijos), acentos y mayusculas
  plegados, `userVisible=false` y sesiones `sub_agent` excluidas, tope de 20 sesiones
  («Ver más resultados» pide 50) y cada fragmento indica quién lo dijo (vos / aegis).
  Medido: 70–120 ms contra el store real y 68 ms sobre 20k mensajes de fixture.
- **Login alineado al sistema visual** (`loginPage()` en `server.ts`): misma paleta y
  tipografia, marca, error accesible (`role=alert` + `aria-invalid`), 16px en movil, safe-area
  y `prefers-reduced-motion`. El CSP se mantiene igual (`default-src 'none'`, estilos
  inline), por eso el CSS sigue embebido: es requisito de seguridad, no deuda. Ademas el
  `next` viaja en el `action`, asi que despues del login se vuelve a la pantalla pedida
  (antes siempre caia en `/`).
- **Permisos**: la tarjeta ahora deduplica por id de request, expira cuando el turno termina
  (`Expirar sin respuesta`), no roba el foco si hay un borrador en curso, anuncia con
  `role=status`, y si el socket esta caido no falsea «respondido» (deja reintentar).
- **Lectura y microfono**: `aria-pressed` real en `#btn-read` y `#btn-mic` (antes quedaba
  fijo en `false`). Tests nuevos cubren pedido de TTS por bloque, corte, apagado, fallo del
  server, dictado completo (grabar → transcribir por RPC → insertar texto → liberar pistas),
  permiso denegado y navegador sin soporte.
- **Panel de informacion de la conversacion**: el titulo del header es un boton que abre
  id, carpeta completa, mensajes, creada/actualizada y estado, con «Copiar ID», «Copiar ruta»
  y «Exportar Markdown». Renombrar/archivar/borrar siguen en la fila del sidebar: son
  gestion, y borrar no gana nada al lado del titulo.

Tests: `npm test` corre ahora **9 suites** (`client-regressions`, `server-regressions`,
`search-index`, `search-e2e`, `permission-e2e`, `media-e2e`, `ui-mobile`, `ui-shell`, `gasto`).
`search-e2e` levanta un proxy aislado con `server.ts` real y una fixture; `media-e2e` sirve la
app en 127.0.0.1 (contexto seguro) con micro falso y `/tts` mockeado; `permission-e2e` usa el
bundle real y el shape ACP real (`session/request_permission` como request del servidor).

**Deploy pendiente de reinicio.** `server.mjs` y `tools/search-index.mjs` ya estan en el arbol,
pero el proceso vivo sigue con el codigo anterior: `/search.json` responde 404 y `/login`
sirve la pagina vieja hasta reiniciar el proxy. Es a proposito (no se corta el stream de la
sesion en curso). Para publicarlo, en una ventana sin trabajo activo:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Aegis-Proyects\web\scripts\restart-node.ps1
```

Ese script reinicia **solo** el node del puerto web (verifica `web=` al final); no toca el
serve de aegis en 3284. Despues del reinicio,
`curl http://127.0.0.1:3788/search.json?q=revision` debe devolver `results`, y `/login` debe
mostrar «Acceso al harness». El cliente ya esta desplegado y degrada solo (oculta la seccion
si el endpoint no existe).

## UI v4 (2026-10-22): sistema visual y de interaccion

Rediseño completo de la capa de UI sobre la misma arquitectura (sin framework, DOM a mano,
CSS plano). El detalle de lo que se midió y por qué está en el comentario que abre la capa
`SISTEMA v4` al final de `app/app.css` y en los encabezados de `src/skills.ts` / `src/stats.ts`.

- **Tokens únicos.** Un solo bloque `:root` (se eliminó el `:root` duplicado del rediseño
  anterior). Paleta cálida ya desplegada, con escala derivada: `--bg-input`, `--bg-hover`,
  `--bg-active`, `--line-strong`, `--on-accent`, `--shadow-pop`, `--measure`, `--dur-fast`, `--ease`.
  `--text-4` subió de 0.44 a 0.56 para que la metadata de 11px cumpla AA sobre el fondo.
- **Tipografía.** El cuerpo de las respuestas deja el serif (16px/1.72) y usa la sans de la UI
  a 15px/1.65; el serif queda solo en el saludo. Código y metadatos en mono con
  `font-variant-numeric: tabular-nums` donde hay números.
- **Medida y alineación.** Mensajes, composer, goalbar y menú de comandos comparten
  `--measure` (760px): el composer queda alineado con el texto.
- **Filas de sesión.** Una sola acción (⋯) reservada en el layout; renombrar / exportar /
  archivar / copiar ID / **borrar con confirmación** viven en ese menú. Flechas, Home/End
  recorren la lista; Esc limpia el buscador. La búsqueda ignora acentos y también matchea el id.
- **Header.** `h1` = título del chat + subtítulo con la carpeta de trabajo (cwd) y el id en el
  `title`. Se fue el chip duplicado de modelo por defecto; el modelo aparece en la bienvenida.
- **Paneles.** Skills y Gasto comparten el chrome `.xpanel*` (header, buscador, cierre,
  botones, foco atrapado, Esc, `role=dialog aria-modal`). Skills suma buscador, contador en la
  barra lateral, filas con descripción envuelta y un editor en dos pasos. Gasto usa los tokens
  de la app (antes traía su propia paleta con fallbacks).
- **Teclado y AT.** `role=menu`/`menuitem` con foco inicial y devolución del foco al disparador,
  `aria-expanded` en chips, `aria-busy` en la conversación durante un turno, toasts con
  `role=status`, anuncio de conexión en una región `sr-only`, enlace "Saltar al compositor".
- **Feedback.** El botón de enviar se deshabilita si no hay texto ni adjuntos. `prefers-reduced-motion`
  desactiva animaciones y transiciones.

Verificación: `npm run typecheck && npm test` (5 suites: `client-regressions`, `server-regressions`,
`ui-mobile`, `ui-shell`, `gasto`). `tests/ui-shell.ts` cubre jerarquía, acciones por fila, menús con
teclado, panel de Skills, contraste de metadata y desborde/solapamiento a 1440/768/390.
`tools/ui-shots.mjs` captura antes/después con métricas del shell.
Deploy de los estáticos: `node tools/build-typescript.mjs` y copiar
`dist-ts/app/{app,skills,stats}.js` a `app/` (CSS y HTML se editan directamente en `app/`).

## Migracion TypeScript (en paralelo)

`src/app.ts`, `src/skills.ts`, `src/server.ts` y `src/piper-vivo.ts` son las fuentes
TypeScript del cliente, el panel de Skills, el proxy HTTPS/ACP y Piper. `npm ci`
instala solo herramientas de desarrollo; `npm run typecheck` verifica el proxy con
`strict: true` y el cliente con tipado gradual (la app heredada aun conserva
zonas dinamicas). `npm run build` genera `dist-ts/` con todos los estaticos. No altera el servicio
activo ni lee ni copia `config.json` o `auth.json`.

Para probar en paralelo, proporcionar `config.json` y `auth.json` **localmente**
en `dist-ts/`, ajustando los puertos de prueba y el origen ACP autorizado.
El servicio existente sigue leyendo `server.mjs` y `app/`: el build no publica
ni reinicia nada. Comparar con la web activa antes de promover; no poner claves
ni copias de `dist-ts` en Git.

Acceso a aegis del fork de Emiliano desde el navegador por LAN (sin instalar nada en los dispositivos).

- **UI (web):** http://192.168.100.34:3788  (local: http://127.0.0.1:3788)
- **Backend:** `aegis serve` (ACP sobre WebSocket) en 0.0.0.0:3284
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
- `scripts/` — start/stop/setup/launch (tarea programada `Aegis_Web`).
- `logs/` — server/serve + `requests.log` + `client.log` (reportes de dispositivos reales).

## Code Mode como vía principal (2026-10-12 — backend v2)

- `aegis-serve-v2.exe` (build 16:18; `rustls-tls,scheduler,bundled-mcp,chat-recall,acp-http,code-mode`) reemplaza a v1 en `scripts/start-aegis-web.ps1` (backup `.bak-pre-v2`; el binario v1 queda en disco para rollback).
- **Sesiones NUEVAS del web corren Code Mode** (extensión `code_execution` habilitada en la config): el agente trabaja vía `execute_typescript`/`list_functions`. Las sesiones VIEJAS retomadas NO lo heredan (el set de extensiones queda fijado al crear la sesión) — para cm, chat nuevo (memoria vía chatrecall). Verificado: `tools/smoke-serve-v2.mjs` (nueva → `execute typescript` → resultado OK) + resume de `_22` (sin `execute_typescript`).
- El CLI principal también: `aegis.cmd` → `aegis-codemode-v2.exe` (backup `.bak-pre-cm-main`); `aegis-cm.cmd` queda de alias.

## Cambiar de chat con un turno en curso (2026-10-12)

- `openSession`, `newSession` y el handler de `#btn-new` ya no bloquean cuando hay un run en curso: la vista se libera (`detachRunView()`), el run sigue vivo en el server, y al volver `checkAdoptedRun()` lo re-adopta (barra + Detener + refresco). `sendText` no toca la UI si la resolución del prompt llega con la vista en otro chat; `onUpdate` filtra por `sessionId` (ya en v6.2).
- Ojo: el handler del botón `+ Nuevo chat` tenía su PROPIA guarda (`Esperá a que termine…`) además de la de `newSession` — eliminada; no reintroducir guardas bloqueantes (el único aviso válido es informativo).
- Tests (3, verdes): `ui/desktop/scripts/aegis-web-switch-check.mjs` (run adoptado), `-newchat-check.mjs` (+ Nuevo chat con turno activo), `-owner-switch-check.mjs` (turno propio; run verificado VIVO desde afuera durante el cambio). Backups: `app/app.js.bak-pre-detach`, `.bak-pre-btnnew`.
- Nota: si el turno propio termina mientras estás en otro chat, no se muestran "fin del turno"/temporizador (no se toca la vista ajena); al volver la conversación está completa.
- **Watchdog de turno huérfano (v6.3+wd, 2026-10-12)**: si un `session/prompt` propio queda sin respuesta porque el run murió en silencio (sin run activo en el server), el cliente lo detecta (doble sonda con gracia de 4 s, tick 15 s, solo en modo dueño) y **libera la consola + reenvía la cola + settleSteers** — mata el caso "después de mandar un mensaje no puedo enviar más" (caso real: sesión _36, 12/10 17:27). Test: `aegis-web-watchdog-sanity.mjs`. Backup: `app/app.js.bak-pre-watchdog`. Headers de versión: `v6.3+detach+wd`.
- **Steer descartado al cierre (fix "+sc", 2026-10-12)**: `clear_active_run` descarta las indicaciones encoladas al cerrar un run → quedaban persistidas SIN respuesta (casos reales: "vos podes sacar screenshots" 17:27 y "Vamos con todo!!" 18:08 en _36). Antes, `finishSettle`/`flushPendingSteers` marcaban "recibida" si el texto estaba en el historial — pero **persistido ≠ consumido**. Ahora `steerAnsweredInHistory()` exige RESPUESTA DEL ASISTENTE DESPUÉS de la indicación (burbujas `.msg-a`); si no la hay, se reencola como mensaje y `flushQueue` la envía (run nuevo). Además `endAdoptedRun()` ahora también settlea (antes, un turno ADOPTADO no revisaba sus steers al terminar: hueco #1). Test determinista: `aegis-web-swallow3-check.mjs` (steer → Detener → nota "se reenvía como mensaje" a los ~4 s → respuesta del asistente ✓). Backup: `app/app.js.bak-pre-sc`. Versión: `v6.3+detach+wd+sc`.

## Qué hay de nuevo en v6.1 (2026-10-12 — fin de turno adoptado + cursor fantasma)

Tres bugs de v6 cazados con `ui/desktop/scripts/aegis-web-end-transition.mjs`, `aegis-web-fresh-check.mjs` y `aegis-web-live-cursor.mjs`:

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

Verificado con `ui/desktop/scripts/aegis-web-md-tables.mjs` (8 casos: básica, alineación, sin
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

Además, con `aegis-web-watch-probe.mjs` se midió que **el `messageCount` que ve una conexión que NO
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
   herramienta de depuración (`window.__aegisWeb.resync`).

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
  Cómo se pregunta: `_aegis/unstable/session/steer` con un `expectedRunId` imposible —
  el server valida el run **antes** de tocar al agente, de modo que no encola nada y
  contesta el run real en `error.data.actualRunId` (o "no active run to steer"). Es la
  única lectura pública de "¿está corriendo?"; `session/info` no lo expone.
- **Refresco sin recargar a mano.** Mientras el turno está adoptado, cada 2,5 s se
  consulta `_aegis/unstable/session/info` (barato): si `messageCount`/`lastMessageAt`
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
- Medido en móvil (390×844) con `scripts/aegis-web-reload-test.mjs --mobile` y
  `aegis-web-phone-audit.mjs`: ver la sección de verificación.

## Qué hay de nuevo en v5 (2026-10-12 · feedback del celular)

Tres cosas reportadas desde el teléfono (390 px), con medición antes/después usando
`ui/desktop/scripts/aegis-web-phone-audit.mjs` (Playwright, viewport 390×844, isMobile):

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

  **Lo medido, sin maquillar** (`aegis-web-phone-audit.mjs`, 390×844, sesión de 1080 mensajes):
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
  socket real en medio de un turno (`__aegisWeb.dropSocket()`): la UI sale de "busy" sola, la barra
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
- **Menú por sesión (⋮)**: renombrar, **exportar a Markdown / JSON** (`_aegis/unstable/session/export`,
  descarga real vía Blob) y **archivar / desarchivar** (`_aegis/unstable/session/archive|unarchive`).
  Las archivadas van a un grupo "Archivadas" plegable, con tag y acciones propias.
- **Slash commands**: autocompletado en el composer (`_aegis/unstable/slash-commands/list` y/o la
  notificación `available_commands_update`): ↑↓ para elegir, Tab/Enter inserta, Esc cierra.
- **Steering**: con el agente trabajando, **Enter manda una indicación al vuelo**
  (`_aegis/unstable/session/steer` con `expectedRunId`, tomado de
  `session_info_update._meta.aegis.activeRunId`). La burbuja se marca "en cola" y pasa a
  "indicación recibida por el agente" cuando el server la levanta. Si no hay run al que apuntar
  (o el steer falla), el mensaje queda en cola local y sale al terminar el turno.
- **Paginación del sidebar**: `session/list` devuelve 50 por página con `nextCursor`; ahora se
  sigue el cursor con botón "Cargar más sesiones" (antes las sesiones >50 eran invisibles).
- **Rendimiento del replay**: un solo `requestAnimationFrame` para todos los registros sucios y sin
  autoscroll durante la carga. Sesión de 1166 mensajes: primera pintura 431 ms → 23 ms, total
  2.78 s → 1.35 s (medido con `aegis-web-perf.mjs`).
- Toasts para confirmaciones, `#meta-left` con atajos (oculto en teléfono), hint de steering mientras
  el agente trabaja, y `window.__aegisWeb` como superficie mínima de depuración (estado + showWelcome).

## Backend / auth

`C:\Aegis-Proyects\core\bin\aegis-current.exe serve --host 0.0.0.0 --port 3284 --platform desktop
--enable-scheduler --with-builtin developer --allowed-origin http://192.168.100.34:3788
--allowed-origin http://127.0.0.1:3788 --allowed-origin http://localhost:3788`, con
`AEGIS_SERVER__SECRET_KEY` (de `config.json`). El binario no se clava aca: `scripts\start-aegis-web.ps1`
lo resuelve del puntero `core\state\current-version.json` (fallback `core\bin\aegis-current.exe`). Los browsers no pueden setear headers en un
WebSocket: la autenticación va como `?token=` en la URL del WS (el server lo acepta).

## Verificación

```bash
cd C:\Aegis-Proyects\web\tools
node ui-audit.mjs                 # auditoría visual: viewports y capturas a C:/Users/Emiliano/tmp/ui-audit
node ui-medir.mjs                 # medición en viewport móvil 430x900 (scroll y latencia de tecleo)
node tabla-shots.mjs              # capturas del render real de tablas markdown, teléfono y escritorio
node stream-typing-check.mjs      # reposo vs streaming vs recién terminado (CPU 4x; window.__aegisWeb.metrics)
node typing-adopt-big.mjs         # sesión larga importada + turno adoptado, ventana con poll ON vs OFF
node soft-refresh-check.mjs       # refresco suave: fase tecleando (posterga) / fase reposo (trae) + interrumpidos
node watch-probe.mjs              # trazas del poll: ticks, session/info, messageCount, costo de cada resync
node deadrun-live-check.mjs       # herramientas sin resultado + refresco con avance real
node steer-settle-check.mjs       # steer no consumido -> reencolado + aviso + reenvío
node typing-adopt-check.mjs       # adopción + Detener desde la pestaña recargada
node client-watch-check.mjs       # contrato v6.4 session/watch sin browser (varias conexiones ACP)
node server-hardening-check.mjs   # rutas estáticas/endpoints endurecidos, sin tocar auth.json
```

Probes ACP crudos y utilidades en `C:\Aegis-Proyects\web\tools\` (probe2..probe7, ls-sessions,
cleanup-test-sessions, stats-index). Los checks se corren DESPRENDIDOS (Start-Process + log):
el wrapper de background mata node con "stdin is not a tty".

## Ops

```powershell
# start/stop (no elevado)
powershell -NoProfile -File C:\Aegis-Proyects\web\scripts\start-aegis-web.ps1
powershell -NoProfile -File C:\Aegis-Proyects\web\scripts\stop-aegis-web.ps1

# autostart (ya instalado; corre al iniciar sesión)
schtasks /Run /TN Aegis_Web
```

Firewall (TCP 3788 + 3284, Private/LocalSubnet) y tarea `Aegis_Web` ya instalados el 2026-10-12.

## v7 (2026-10-13) - tunel Cloudflare con login propio

Detalle completo: **docs/tunnel-cloudflare.md**. Resumen:

- **`server.mjs` v7** detecta los pedidos que llegan por el tunel (cabeceras `cf-*`, o Host que no
  es loopback / `publicHost` / IP privada) y a esos les exige **login propio** (`auth.json`, cookie
  `gw_auth` = expiracion + HMAC de la secret key, 30 dias, freno de 8 intentos por minuto). La LAN
  sigue abierta como siempre.
- **Un solo origen publico**: `/config.js` devuelve `wss://<host>/acp?token=...` y `server.mjs`
  **proxea el WebSocket** `/acp` a `127.0.0.1:3284` reescribiendo `Origin` a
  `http://127.0.0.1:3788` (el que ya estaba en `--allowed-origin`). El backend no se expone, el
  token no viaja a un segundo host y el tunel no necesita conocer la URL publica.
- **Watchdog + tarea**: `scripts/aegis-web-tunnel-watchdog.ps1` (+ `.vbs`) mantiene stack y tunel,
  escribe `tunnel-url.txt` / `tunnel-access.txt`; tarea programada `Aegis_Web_Tunnel` (al iniciar
  sesion + repeticion cada 10 min, residente cada 60 s, mutex para no duplicarse).
- **Verificado** end-to-end con `ui/desktop/scripts/aegis-web-tunnel-check.mjs` por la URL publica:
  puerta (302/401 y WS sin sesion rechazado), login, `Conectado`, 50 sesiones, replay real de 38
  mensajes, 0 errores de JS.
- La URL del quick tunnel **cambia** si cloudflared se reinicia (no hay cuenta Cloudflare): mirar
  `tunnel-url.txt`. URL fija = tunnel con nombre + Cloudflare Access (procedimiento en el doc).
- Backups: `server.mjs.bak-pre-tunnel`, `scripts/start-aegis-web.ps1.bak-pre-tunnel`.

## Security notes

- LAN (bind 0.0.0.0 + firewall acotado a Private/LocalSubnet) **y tunel Cloudflare** (v7) con login
  propio. El tunel exige la password de `auth.json`; la LAN sigue sin login, como antes.
- **Nunca** exponer 3284 directo a internet: el backend no tiene login, solo la secret key en la URL.
- Auth = secret key de `config.json` (inyectada al vuelo en `/config.js`); rotar editando el config y reiniciando ambos procesos.
- Sin TLS: http/ws plano en la red local (mismo modelo que el dashboard de Hermes).

## Pitfalls / reglas para agentes (leer antes de tocar el código)

- `app/*` son estáticos: no hay build; recargar y probar. `server.mjs` mantiene `no-cache` + ETag y el token se inyecta por request en `/config.js` — nunca en archivos estáticos.
- `[hidden]` es pisado por cualquier `display:` — existe la regla global `[hidden]{display:none!important}`; no la saques.
- Menús flotantes (chips): se abren como "portal" a `document.body` con `position:fixed` (`openMenu`). NO volver a anidarlos: la fila de chips tiene overflow + máscara y cualquier menú anidado queda clipeado (bug ya sufrido).
- Streaming: UNA entrada por messageId en `state.msgs`; cuando una herramienta cierra el bloque, el siguiente chunk reemplaza la entrada — no re-indexar la clave (fragmenta el texto en un elemento por chunk).
- UI inline (renombrar / confirmar borrado): `state.hold` pausa `renderList()` mientras hay un editor abierto, y tras cada refresh hay que re-buscar las entradas por id (los objetos de sesión se reemplazan).
- Código: `.msg-a pre { white-space: pre }` (sin wrap; scroll horizontal). El wrap por herencia rompe los comandos.
- Permisos de herramientas PERSISTEN en el server por herramienta: contestar "allow always" en una prueba desactiva los prompts futuros. Reset: `_aegis/unstable/tools/permissions/set` con `{toolPermissions:[{toolName, permission:'ask_before'}]}`.
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
- Steering: requiere `expectedRunId`; se obtiene de `session_info_update._meta.aegis.activeRunId` (null
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
  `session_info_update._meta.aegis.activeRunId = null` cierra el turno adoptado. `stopRun()`
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
- `window.__aegisWeb` ahora también expone `dropSocket()` (solo para los checks: cortar el WS real).
- **Sondeo de run (v6.1)**: la respuesta del server a un steer con `expectedRunId` imposible SIEMPRE trae `error.message:"Invalid params"`; lo útil va en `error.data` como **string** ("no active run to steer") o **objeto** (`{actualRunId}`). Buscar "no active run" solo en `message` jamás matchea → el fin de turno no se detecta y la barra/cursor quedan eternos. No volver a simplificar ese parseo.
- **Cursor de streaming (v6.1)**: `streamAppend` NO debe agregar `.streaming` durante el replay (`state.replaying`) y `renderSession` DEBE limpiar con `clearStreaming()` al terminar; si no, cada carga de sesión deja un cursor pegado en el último mensaje.
- **Scripts de check**: los Playwright tienen que vivir en `ui/desktop/scripts/` (import resuelve desde `ui/desktop/node_modules`; un script suelto en `C:/Aegis-Proyects/web/tools` explota con `ERR_MODULE_NOT_FOUND`).
- **`session/info` de una conexión que NO es dueña del run viene congelado (v6.2)**: el `messageCount`/`lastMessageAt` no se mueve mientras el run trabaja (medido: 18 polls con la misma clave en 45 s). El dueño sí lo ve crecer. Por eso el resync no puede depender sólo del cambio de clave: hay que refrescar periódicamente. No "arreglar" sacando el respaldo.
- **Refresco del turno adoptado: NUNCA `clearMessages()` + replay (v6.2)**: reconstruir el DOM de una sesión larga cuesta ~2,3 s de main thread bloqueado (tramos de 206 ms) y en el teléfono las teclas llegan tarde. Usar `softResync()` (bufferiza y pinta sólo lo nuevo). El rebuild completo queda para la carga inicial de la sesión y para depurar (`window.__aegisWeb.resync`).
- **Teclado (v6.2)**: el costo por tecla del cliente es <1 ms (medido) — no buscar el lag ahí. Antes de "optimizar el composer", medir con `aegis-web-stream-typing.mjs` y `aegis-web-soft-check.mjs` (CPU 4x): lo caro es render/layout de conversaciones grandes, no el composer.
- **`page.evaluate` en Playwright acepta UN solo argumento**: `page.evaluate(fn, a, b)` tira "Too many arguments"; pasar un objeto.
- **Bug de runtime del serve (2026-10-12, sin arreglar)**: un run murió en silencio justo después de que el tool terminó (`tools/stream-typing.json` se escribió completo y el resultado nunca llegó); en la sesión quedaron 2 `tool_call` con último estado `pending`. Sirve de caso de prueba para `sweepInterruptedTools()` (la UI ahora las marca "interrumpido").
- **Tablas markdown (v6.3)**: `mdBlocks` recorre las líneas con índice (`for (let _i ...)`) para poder mirar la línea siguiente (el separador) y saltear las filas consumidas. Si volvés a `for (const line of lines)` se rompen las tablas. Las celdas pasan por `inline()`: cualquier formato nuevo hay que agregarlo ahí, no en `tableHtml`.
- **`window.__aegisWeb.state.sessions` usa `sessionId`**, no `id` (el `id` aparece en `state.current`). Los scripts de check que escriben `localStorage['gweb.last']` desde la lista se equivocan con `s.id` y quedan 3 minutos esperando un replay vacío.


## v6.3 (backend: serve v3) - watchdog de runs + spill de imagenes

Detalle completo y procedimiento de swap: **docs/v6.3-serve-v3.md**. Resumen:

- **Watchdog de runs por fin**: cada evento del stream marca progreso; si un run pasa
  AEGIS_RUN_STALL_TIMEOUT_SECS (default 900 s, 0 desactiva) sin avanzar, el server emite un
  **error visible al cliente**, pone activeRunId=null y cancela el run. Antes ese caso dejaba la
  UI muda hasta recargar (sesion 20261012_23, 39 min muertos).
- **Cancelacion no pedida = aviso visible**: si un turno termina cancelado y no lo pidio el cliente
  (conexion caida, cancel interno), ahora se ve el motivo en vez de nada.
- **Imagenes de tools con tope**: AEGIS_MAX_TOOL_IMAGE_BASE64_SIZE (default 1.500.000 chars b64
  ~ 1,1 MB). Las imagenes grandes se escriben a archivo y queda un puntero, igual que el texto.
  Antes el cap solo miraba texto: la DB tenia 137 mensajes >60k chars / 54,6 MB de imagenes.
- **Cap de texto verificado**: AEGIS_MAX_TOOL_RESPONSE_SIZE se mide en CHARs (default 200.000;
  el usuario tiene 60.000) y si funciona (el texto de assistant topea en 78 KB).
- **Binario nuevo, no en uso**: aegis-serve-v3.exe. v2 sigue siendo el que corre hasta hacer el swap.

## Origin ACP configurable (staging)

`server.ts` takes the ACP `Origin` header from `AEGIS_ACP_ORIGIN` when set, otherwise
`http://127.0.0.1:<webPort>`. Un staging en 3978 contra el serve de produccion (que solo
autoriza 3788) debe arrancar con `AEGIS_ACP_ORIGIN=http://127.0.0.1:3788`; produccion no
necesita la variable.

## Panel "Gasto" (/stats.json)

`tools/stats-index.mjs` agrega la tabla `usage_ledger` de
`C:\Aegis-Proyects\state\data\sessions\sessions.db` (una fila por llamada, con costo, tokens
y cache) y `server.ts` la expone en `/stats.json?days=N` (0 = todo), con cache de 60 s y un
proceso hijo `node --experimental-sqlite` para no bloquear el event loop. El panel vive en
`src/stats.ts` y se autoinyecta como `app/stats.js` (boton "Gasto" en la barra lateral).
El costo sale del ledger; los modelos sin precio asignado aparecen con costo 0 y un aviso.

### «vs plan» (2026-10-23)

El numero que ya existia no cambia: sigue siendo el **costo estimado** por catalogo de precios
(`prices.json`), y es una **valuacion, no una factura**. Lo que se agrega es la lectura que
importa: cuanto valio a tarifa API lo consumido contra lo que se paga por el plan del proveedor.

- El plan se declara en `config.json` (no versionado), bloque `plans`, una entrada por valor de
  `usage_ledger.provider`:

  ```json
  "plans": {
    "chatgpt_codex": { "monthly_usd": 20, "label": "ChatGPT", "note": "Plus" },
    "opencode_go":   { "monthly_usd": 0,  "label": "OpenCode Go", "note": "" },
    "open_design":   { "monthly_usd": 0,  "label": "Open Design", "note": "" },
    "antigravity":   { "monthly_usd": 0,  "label": "Antigravity", "note": "" }
  }
  ```

- `monthly_usd` **0 o ausente = ese proveedor no se compara**. La columna de plan queda vacia y no
  se calcula diferencia: no se inventan precios.
- `delta = consumo estimado - plan del periodo`. **Positivo = le ganaste al plan ese monto** (el
  consumo a tarifa API valio mas que lo que pagaste); negativo = el plan salio mas caro que el
  consumo. El panel lo muestra con signo y color, y una linea de resumen: «contra planes: +USD X a
  favor» / «-USD X en contra».
- El periodo manda: si el rango elegido no es un mes calendario, el plan se **prorratea por dia**
  (`monthly_usd * dias del rango / dias del mes`) y el subtitulo lo dice. `planWindow` en la salida
  de `stats-index` publica `periodDays`, `daysInMonth`, `factor` y `prorated`.
- Los planes declarados sin consumo aparecen igual (delta negativo completo): saber que un plan se
  paga y no se usa es parte de la lectura.
- Las filas sin `provider` (la columna existe desde la migracion v20) **no se reparten a ojo**: se
  muestran aparte como «sin proveedor: N llamadas». Ojo: hoy esa bolsa no es solo historica — hay
  trafico actual que llega con `provider` nulo porque `session.provider_name` viene `None`
  (`crates/aegis/src/agents/state_machine/usage.rs:63`). Hasta que eso se arregle en el harness, la
  comparacion cubre solo lo que el ledger si atribuye.
- Salida nueva de `tools/stats-index.mjs`: `byProvider: [{ provider, label, calls, tokens,
  estimatedUsd, costKnownCalls, planUsd, deltaUsd, note }]`, `unknownProvider: { calls,
  estimatedUsd, tokens, costKnownCalls } | null`, `vsPlan: { providers, declared, estimatedUsd,
  planUsd, deltaUsd }` y `planWindow`. Los planes se leen de `config.json` (o de `AEGIS_WEB_CONFIG`,
  que usan las pruebas) y **solo se emiten los campos del plan**: `secretKey` nunca sale del
  proceso.
- Verificacion: `tests/stats-plan.ts` (suite `stats-plan`) crea un ledger de fixture con dos
  proveedores (uno con plan, otro sin), un plan sin consumo, filas con `provider` nulo y un periodo
  parcial de 7 dias; `tests/gasto.ts` comprueba que la seccion y sus columnas se renderizan. Contra
  el store real, los totales por proveedor de `stats-index` coinciden al ultimo decimal con la
  consulta SQL hecha a mano sobre el mismo rango (`window.since`/`window.until`).

## Herramientas y pruebas en TypeScript (2026-10-18)

Ya no queda codigo escrito a mano en JS. Los cuatro modulos de la app y las dos herramientas de
sqlite se escriben en `src/` y se compilan a `dist-ts/`:

| Fuente TS | Salida | La usa |
|---|---|---|
| `src/app.ts` | `app/app.js` | navegador |
| `src/skills.ts` | `app/skills.js` | navegador |
| `src/stats.ts` | `app/stats.js` | navegador |
| `src/server.ts` | `server.mjs` | node (server/proxy) |
| `src/piper-vivo.ts` | `piper-vivo.js` | node (TTS) |
| `src/tools/goals-index.ts` | `tools/goals-index.mjs` | proceso hijo (`--experimental-sqlite`) |
| `src/tools/stats-index.ts` | `tools/stats-index.mjs` | proceso hijo (`--experimental-sqlite`) |

`tools/*.mjs` de esas dos herramientas es **salida generada**: se sobrescribe en cada build, no se
edita a mano (el fuente esta en `src/tools/`). Se verifico que la salida JSON es identica a la
version JS anterior (mismo largo byte a byte para goals y stats).

### Pruebas (`tests/`, Playwright)

- `tests/ui-mobile.ts` — 390x844: sin desborde horizontal, panel Gasto abre con tap, 6 KPIs, ✕ fijo
  al scrollear y cierra. Read-only.
- `tests/gasto.ts` — 1440x950: KPIs con valor, barras, filas, cambio de rango 30d->7d y `/stats.json`.
  Read-only.
- `tests/reload-smoke.ts` — crea sesion, lanza un turno ACP externo de 12 s, **recarga en medio del
  turno** y verifica busy/runId y que la respuesta aparezca una sola vez. Borra la sesion. Cuesta un
  turno real: corre solo con `AEGIS_TEST_SMOKE=1`.

```
cd web
npm test                        # regresiones aisladas cliente/servidor + ui-mobile + gasto contra AEGIS_WEB_URL (default http://127.0.0.1:3788)
$env:AEGIS_TEST_SMOKE='1'; npm test
$env:AEGIS_WEB_URL='https://192.168.100.34:3789'; npm test
```

## Rebobinado y "Regenerar" (2026-10-18)

**Bug corregido**: rebobinar dos veces no limpiaba bien. Causa: el serve **omite**
`_meta.aegis.agentVisible` cuando un mensaje quedo oculto (solo manda `agentVisible: true` en los
visibles, ver `crates/aegis/src/acp/server/message_meta.rs`), y el cliente comparaba
`agentVisible === false`. Al re-renderizar el transcript (soft refresh, hub, recarga) los mensajes
rebobinados volvian a aparecer, asi que el segundo rebobinado no tenia nada que limpiar.
Ahora se marca oculto todo lo que llegue sin `agentVisible: true` (con el watermark
`aegis.hiddenFrom.<sid>` como red de seguridad si el mensaje no trae `_meta.aegis`) y el primer
mensaje que el usuario manda despues de rebobinar se guarda como punto de reanudacion
(`aegis.resume.<sid>`) para que el replay no lo oculte a el.

**Nuevo**: boton "↻ Regenerar" en la ultima respuesta. Rebobina el ultimo turno del usuario
(`back: 1`), oculta la respuesta vieja y reenvia el mismo texto automaticamente.

Regresion: `tests/rewind-regen.ts` (dentro de `AEGIS_TEST_SMOKE=1`).
Limitacion conocida: el boton de rebobinar aparece en los mensajes que vienen del serve (abrir o
recargar el chat); en el mensaje recien enviado aparece recien al recargar.

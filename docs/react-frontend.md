# Frontend React de Aegis: goal, arquitectura y paridad

Documento de continuidad. Cualquier chat nuevo puede retomar el trabajo leyendo esto y el estado
de `web/frontend/` (tests + `npm run build`).

## 0. Goal registrado

Mecanismo real de esta instalación: el comando `/goal` del agente. Guarda el estado en
`extension_data["goal.v0"]` de la sesión (`crates/aegis/src/session/extension_data.rs`,
`GoalState { goal, grind }`), lo procesa `ops_retry.rs` y responde "Goal set…". El turno siguiente
recibe el mensaje del sistema `Start working toward this goal now: **Goal:** …`, que es exactamente
el contexto con el que arrancó esta sesión. `/goal off|clear|none` lo borra; `/goal` a secas lo
muestra; `/grind` es la variante que empuja hasta `max_turns`. No hay otro mecanismo de goals en la
instalación (no existe `aegis-cli`; el scheduler es para recetas).

Texto registrado (resumen operativo; el original está en el goal de la sesión):

> Reescribir TODO el frontend web de Aegis en React + TypeScript estricto + Vite, manteniendo o
> mejorando todas las funciones del cliente actual. El server Node sigue siendo dueño de auth,
> endpoints auxiliares, assets y proxy WebSocket ACP; el motor Rust y el protocolo ACP no se tocan.
> Inventario de paridad ANTES de reemplazar. Trabajo aislado del frontend servido hasta alcanzar
> paridad; fixtures ACP offline; medir carga/interacción/scroll; publicar sólo tras superar gates y
> con rollback listo.

## 1. Arquitectura

```
web/frontend/
  index.html                 entrada de producción (sin <script src="/config.js">: lo carga main.tsx)
  src/acp/protocol.ts        tipos del cable ACP (camelCase, `sessionUpdate`, diff, permisos)
  src/acp/transport.ts       WebSocket + parseo JSON-RPC; no conoce el dominio
  src/acp/client.ts          JSON-RPC 2.0, correlación de ids, timeouts, backoff, notificaciones
  src/domain/ids.ts          SessionId/MessageId/ToolCallId/RunId branded
  src/domain/types.ts        entidades y AppState (una sola fuente de verdad)
  src/domain/reducer.ts      transiciones puras (reduce(state, event))
  src/domain/translate.ts    wire → eventos del dominio (puro)
  src/domain/selectors.ts    isRunning, transcript, último texto
  src/domain/store.ts        coordinador: watch/replay, adopción de runs, reintentos, permisos, cola
  src/render/{markdown,diff}.ts   port fiel de app/markdown.ts y app/tool-diff.ts
  src/media/audio.ts         dictado (MediaRecorder→WAV) y lectura (/tts)
  src/ui/*.tsx               shell, transcript, compositor, permisos, paleta, paneles, diálogos
  src/fixtures/server.ts     serve ACP de mentira (wire real) para tests y modo fixtures
  tests/                     59 pruebas: reducer, translate, store, render, UI, StrictMode
```

Decisiones:

- **React no es dueño del protocolo ni del estado.** `AppState` vive en `AegisStore`; React sólo
  se suscribe con `useSyncExternalStore`. El store agrupa las notificaciones en un frame (`rAF`);
  sin ese agrupado un replay de 500 frames dispara "maximum update depth exceeded" de React.
- **Identidades explícitas.** Cada mensaje, bloque, herramienta, run y permiso tiene id tipado. Los
  ids locales (`local:msg:*`) se adoptan al id del servidor con `message/adopt`; el eco del prompt
  no se duplica.
- **Dedupe por identidad y por contenido.** Un `user_message_chunk` con un `messageId` que ya existe
  se descarta; si coincide con una burbuja local pendiente, se adopta. Un bloque reiniciado
  reemplaza texto (`restart`).
- **Estados terminales.** Una herramienta `completed`/`failed` no vuelve a `pending`; al cerrar un
  turno las que quedaron girando se marcan `interrupted` (no "listas").
- **El replay es el mismo camino que el vivo.** `watch` devuelve notificaciones JSON-RPC completas y
  se pasan por el mismo `onNotification`; un `replay_gap` recarga el historial una sola vez
  (guarda contra el bucle gap→watch→gap).
- **assistant-ui: evaluado y no adoptado.** Su `ExternalStoreRuntime` asume que el runtime es dueño
  de los mensajes y del envío; en Aegis el mensaje tiene id de servidor, bloques con estado de
  streaming, tarjetas de herramienta con diff y permisos que llegan por el mismo socket. Se
  conservó la forma de transcript/compositor y se implementaron las piezas propias. La evaluación
  queda registrada acá; si más adelante se adopta, debe ser sólo para el render del bloque de texto.
- **CSS**: `app/app.css` se reusa tal cual (tokens, contrastes medidos, escala). `styles.css` agrega
  sólo lo nuevo. El CSS va empaquetado, no inyectado por JS.

## 2. Sirviendo sin tocar la app actual

`src/server.ts` gana una ruta aditiva `/app-react/*` que sirve `frontend/dist`:

- `/app-react/assets/*` → `Cache-Control: immutable` (nombres con hash de Vite).
- navegación desconocida sin extensión → `index.html` (SPA); asset inexistente → 404 real.
- `AEGIS_WEB_NO_SWEEP=1` permite arrancar una instancia de prueba sin ejecutar el barrido de
  pendientes en el store (el barrido escribe).
- La app de siempre (`/`) no cambia; el rollback es no publicar la ruta o borrar `frontend/dist`.

Verificado contra una instancia de prueba (3790, `dist-ts/server.mjs`):

| request | resultado |
|---|---|
| `GET /app-react/` | 200 text/html, 1046 bytes |
| `GET /app-react/assets/index-*.js` | 200 text/javascript, `immutable` |
| `GET /app-react/assets/index-*.css` | 200 text/css, `immutable` |
| `GET /app-react/assets/nope.js` | 404 |
| `GET /app-react/chats/123` | 200 text/html (SPA) |
| `GET /config.js` | 200 text/javascript, `no-store` |

## 3. Paridad: inventario y estado

Estado al cerrar esta sesión. `hecho` = implementado y con prueba ejecutada; `parcial` = funciona
el camino principal pero falta una parte del contrato; `pendiente` = no implementado.

| # | Función | Implementación actual | Contrato observable | Reemplazo | Prueba | Estado |
|---|---|---|---|---|---|---|
| 1 | Sesiones y workspaces | `app.ts` + `/ws/list`, `/ws/defaults` | listar, abrir, cwd por sesión | `store.refreshSessions/openSession`, Sidebar | `store.test` carga historial; UI lista | hecho (cwd: sólo lectura) |
| 2 | Streaming de texto | `agent_message_chunk` | chunks acumulados por messageId | `message/chunk` + `appendText` | `reducer.test` acumula; smoke real 59 msgs | hecho |
| 3 | Razonamiento | `agent_thought_chunk` | bloque aparte, colapsable | `kind:'thought'` + `<details>` | `reducer.test`, `translate.test` | hecho |
| 4 | Herramientas | `tool_call(_update)` | tarjeta con estado/salida | `ToolCard` + `tool/upsert` | `store.test` tool+diffs | hecho |
| 5 | Diffs | `tool-diff.ts` | par before/after, recorte | `render/diff.ts` | `render.test` 4 casos | hecho |
| 6 | Permisos | `session/request_permission` | tarjeta, opciones, respuesta | `PermissionCard` + `respondPermission` | UI test responde; otra sesión contada | hecho |
| 7 | Adjuntos | compositor + base64 | imagen/texto en prompt | `Composer` + `promptBlocks` | `translate.test` bloques | hecho (sin drag&drop) |
| 8 | Dictado | MediaRecorder→WAV→RPC | texto transcripto | `media/audio.ts` + `store.transcribe` | no probado con micrófono real | parcial |
| 9 | Lectura en voz alta | `/tts` | reproducir/cortar | `createSpeechPlayer` | no probado en navegador real | parcial |
| 10 | Compositor | textarea + Enter | enviar, multilinea | `Composer` | UI test Enter envía | hecho |
| 11 | Cola | mensajes mientras corre | orden, quitar | `queue/*` | `reducer.test` | hecho (flush sólo al abrir) |
| 12 | Steer | `session/steer` | indicación al run actual | `store.steer` | `store.test` con run activo | hecho |
| 13 | Cancelación | `session/cancel` | cierra run y permisos | `store.cancel` | `store.test` | hecho |
| 14 | Regeneración | `_aegis/…/retry` | repetir último turno | `store.retry` | no probado contra motor | parcial |
| 15 | Rewind | `_aegis/…/rewind` | ocultar cola, devolver texto | `store.rewind/rewindTo` | `reducer.test` hidden/resume | hecho (prefill: pendiente) |
| 16 | Modelos y modos | `set_config_option`, `set_mode` | chips en topbar | `Topbar` + store | no probado contra motor | parcial |
| 17 | Reconexión | backoff + re-watch | no declarar muerto un turno vivo | `AcpClient` + `onReady` + watch | `store.test` adopta run | hecho |
| 18 | Watch por sesión | `_aegis/…/watch` | cursor/epoch/replay | `watchSession` | `store.test` replay sin duplicar | hecho |
| 19 | Adopción de runs | `activeRunId` | run de otra conexión | `run/started adopted` | `store.test` | hecho |
| 20 | Replay parcial | `replayTail`/`replaySkipped` | avisar y cargar todo | tail-pill + `loadFullHistory` | `store.test` 120 omitidos→520 | hecho |
| 21 | Historial completo | `session/load full` | reemplazo sin duplicar | `openSession({full})` | `store.test` | hecho |
| 22 | Búsqueda de sesiones | `/search.json` + filtro local | título/id; contenido | filtro local + `ui/SearchResults.tsx` (FTS del store, debounce 250 ms, guarda de secuencia, descarta las ya visibles) | `tsc` + 62 tests + build; endpoint real 3790: 3 sesiones y 54 coincidencias con claves `sessionId,title,cwd,updatedAt,archived,titleMatch,matches[{role,ts,snippet}]` | hecho |
| 23 | Actividad | `activity.ts` | sesiones y estado | panel Actividad (desde estado) | UI abre | parcial (sin export/confirmaciones) |
| 24 | Cambios Git | `/changes.json` | archivos del cwd | panel Cambios (tabla `entries`, `?cwd=` de la sesión) | 401 anónimo; forma `{kind,cwd,entries,truncated}` leída en `src/server.ts`; `panels.test` del error 401 | parcial (falta repo real logueado) |
| 25 | Memoria | `/memory.json` | hechos | panel Memoria (tabla `facts`) | real 3790: 200, 186 hechos `{id,text,kind,tags,confidence,pinned,status,…}`; `panels.test` | hecho |
| 26 | Skills | `sources/*` | listar/crear/editar | panel Skills (list RPC) | `panels.test` con `sources/list`; RPC real sin ejercitar | parcial (CRUD pendiente) |
| 27 | Archivos | `/outbox.json` | listar/descargar | panel Archivos | real 3790: 200, 161 items `{name,bytes,mtime,ext,url}`; `panels.test` | hecho (descarga `/dl/` sin probar) |
| 28 | Estadísticas | `/stats.json` | tabla por día | panel Stats (tabla `daily` primero) | real 3790: 200 en 1,97 s, 19 días/14 modelos; `panels.test` | hecho |
| 29 | Contexto | `usage_update` | usado/límite/costo | panel Contexto + barra | `translate.test`; motor real mostró string→number | hecho |
| 30 | Doctor | `/doctor.json` | chequeos | panel Doctor (ruta `gate.chequeos`) | 401 anónimo (requiere login); forma leída en `src/server.ts` + `panels.test` | parcial (falta verlo logueado) |
| 31 | Paleta | `palette.ts` | comandos filtrables | `Palette` | UI test Ctrl+Shift+P | hecho |
| 32 | Split-view | `src/split-view.ts` (207 líneas) | segunda sesión al costado, foto vía `session/export` | `ui/SplitView` (Ctrl+Alt+2 y paleta), `aria-label` propio, refresco manual | `panelsExtra.test` con fixture: export de la otra sesión renderizado y botón Refrescar; build con el CSS nuevo | hecho |
| 33 | Ajustes | local | voz, lectura | panel Ajustes | UI (render) | parcial |
| 34 | Exportar | `session/export` | markdown/json | menú de la fila: Exportar `.md` / `.json` (blob + descarga, nombre saneado) | motor real: `{data}` string, 1,3 MB markdown / 3,3 MB JSON; smoke Playwright descargó «Aegis-Proyects disk cleanup.md» de 1 031 340 B con 0 errores | hecho |
| 35 | Renombrar/archivar/borrar | `_aegis/…` | menú de fila | Sidebar + diálogos | no probado contra motor | parcial |
| 36 | `/goal` del chat | barra de objetivo | mostrar/limpiar | `domain/goal.ts` + barra en App | `goal.test` 3 casos | hecho |
| 37 | Handoff entre sesiones | `src/handoff.ts` (263 líneas) | bloque objetivo/estado/decisiones/pasos desde el export del origen | `domain/handoff.ts` + `ui/HandoffDialog` (Ctrl+Alt+H y paleta); inserta en el composer | motor real: export de 1 040 213 caracteres → bloque de 2 781 con 4 secciones; smoke Playwright lo insertó en el composer, 0 errores | hecho |
| 37b | Onboarding del estado vacío | `src/onboarding.ts` (147 líneas) | `/prices.json` + `tools/list` + `/goals.json` | `ui/WelcomeCard`: modelo, tarifa, contexto, skills, objetivos; una sola petición por sesión y aviso visible cuando un dato no llega | `welcome.test` 3 casos; smoke Playwright mostró la fila `contexto: 1M tok` con el motor real; `tools/list` no existe (`-32601`) y por eso se usa `sources/list` | hecho salvo ver skills y objetivos en pantalla |
| 37c | Galería de artefactos | `src/artifacts.ts` (217 líneas) | `/outbox.json` y `?preview=1` → `{name,bytes,ext,binary,text,dataUrl}` | `ui/OutboxPanel`: lista + preview md/texto/imagen + Descargar `/dl/<nombre>` | endpoint real: preview de un `.md` de 20 147 B con `binary:false` y `text`; `panelsExtra.test` (lista, preview, 500) | hecho |
| 40 | Modo de permisos (plan/revisar/ejecutar) | `src/session-mode.ts` (183 líneas) | `_aegis/unstable/tools/permissions/set` | `domain/sessionMode.ts` + chip en el composer + 3 comandos de paleta | motor real: los tres payloads responden ok; 5 tests de dominio | hecho (efecto no legible: sin getter, `-32601`) |
| 38 | Accesibilidad | foco, aria, Escape | navegable por teclado | `Dialog` (trap), roles, skip-link | UI tests por rol | hecho (auditoría formal pendiente) |
| 39 | Build y publicación | esbuild → `app/` | assets versionados | Vite → `frontend/dist` + `/app-react` | build + curl de assets | hecho (publicación NO) |

Regla de cierre: el goal no se declara completo con `parcial`/`pendiente` en las filas que el
operador usa a diario (2–21, 24, 26, 29, 31, 36). Faltan 32, 36, 37 y cerrar 22–30 contra
endpoints reales.

## 4. Hitos

| Hito | Qué incluye | Estado |
|---|---|---|
| M0 | Inventario, goal registrado, arquitectura, build aislado | hecho |
| M1 | Cliente ACP tipado + store + reducer + fixtures offline | hecho (59 tests) |
| M2 | Shell React: sesiones, transcript, herramientas, diffs, permisos, compositor, cola, steer | hecho |
| M3 | Replay/reconexión/adopción/historial largo/dos chats/retry idempotente | hecho (tests) |
| M4 | Paneles de espacio de trabajo (actividad, cambios, archivos, memoria, skills, stats, doctor, contexto, ajustes, goals) | parcial |
| M5 | Búsqueda FTS, split-view, onboarding, handoff, artifacts, /goal del chat | pendiente |
| M6 | Medición móvil real (Android físico, no sólo Chromium emulado) y latencia por túnel | pendiente |
| M7 | Gates de publicación: comparación con la web actual, rollback, assets servidos | build+serve verificados; comparación y publicación pendientes |

## 5. Cómo correr y verificar

```powershell
cd C:\Aegis-Proyects\web\frontend
npm run typecheck
npm test                 # 59 tests
npm run build            # dist/ con assets hasheados
npm run dev              # 5174, proxy /acp al server real

# Cliente completo sin motor, con fixtures (desconexión, replay, permisos):
#   http://127.0.0.1:5174/fixtures.html

# Instancia de prueba del server (no toca la viva ni el barrido del store):
$env:AEGIS_WEB_PORT='3790'; $env:AEGIS_WEB_NO_SWEEP='1'; $env:AEGIS_WEB_TLS_DIR='C:/nonexistent-tls'
node dist-ts/server.mjs
node tools/react-smoke.mjs "http://127.0.0.1:3790/app-react/?acp=proxy"
```

`?acp=proxy` fuerza el WebSocket por el proxy `/acp` del mismo origen: en pruebas contra otra
instancia el `Origin` cambia y el serve rechaza el handshake directo con 403.

## 6. Lo que NO está verificado (declarado)

- Paridad completa: ver filas `parcial`/`pendiente` de la tabla. No se declara terminado.
- Móvil: no se midió en Android físico ni con latencia real de túnel; sólo viewport de escritorio en
  Chromium headless.
- Dictado y lectura en voz alta: código completo, sin prueba con micrófono ni audio reales.
- Paneles: `memoria`, `stats`, `archivos` y `goals` verificados contra el endpoint real (200 con datos);
  `cambios` y `doctor` exigen login y no se vieron poblados; `skills` sólo con el RPC simulado.
- Publicación: `/app-react/` está servido y verificado en una instancia de prueba (3790), pero la
  instancia viva (3788) todavía corre un `dist-ts` anterior y devuelve 404 en `/app-react/`. La app
  servida en `/` sigue siendo la actual. No se hizo swap.
- Renombrar se ejercitó contra el motor real (y falló su persistencia en `session/list`: ver §7);
  archivar/desarchivar se ejercitaron contra el motor real en una sesión desechable. Regeneración,
  rewind con prefill y exportar siguen sin ejercitarse contra el motor real.

## 7. Hallazgos medidos contra el motor real (2026-10-28)

Scripts de medición, todos contra la instancia viva vía el proxy del servidor web:

| script | qué hace |
|---|---|
| `tools/acp-lifecycle.mjs` | crea una sesión desechable, la renombra, archiva, desarchiva, observa, exporta y la borra |
| `tools/acp-list-shape.mjs` | imprime la forma real de una fila de `session/list` |
| `tools/panel-shapes.mjs` | imprime claves y conteos de los endpoints JSON de los paneles |
| `tools/fix-encoding.mjs` | detecta y repara archivos con bytes Latin-1 sueltos (Set-Content de PowerShell) |

Lo que el motor hace de verdad, con la consecuencia que tuvo en el cliente:

| hallazgo | evidencia | consecuencia en el cliente React |
|---|---|---|
| `session/list` devuelve 50 filas por página con `nextCursor` | 50 filas, `nextCursor` no nulo | `refreshSessions` pagina hasta 20 páginas; una sola página dejaría chats afuera |
| la fila es `{sessionId,cwd,title,updatedAt,_meta{messageCount,createdAt,lastMessageAt,userSetName,sessionType,hasRecipe,projectId,providerId,modelId}}` | `acp-list-shape.mjs` | el resumen sale de ahí; no hay `archivedAt` en el wire |
| `_aegis/unstable/session/rename` responde ok pero el título NO cambia en `session/list` y no llega `session_info_update` | `rename visible=false userSetName=undefined`; la única notificación fue `session/update` | el store guarda el título en un mapa local (`renamed`) y lo aplica al refrescar; sin eso el refresco cada 4 s borraba el nombre |
| archivar sí oculta la sesión de `session/list`; desarchivar la devuelve | `sigue en la lista=false` tras archivar | el archivado es del motor y además marca local: el reducer conserva el resumen en `archived` y no lo revive con una página vieja |
| `_aegis/unstable/session/export` existe y devuelve `{data}` | `export ok keys=data bytes=0` en sesión vacía | todavía sin botón en el cliente (fila 34) |
| una sesión nueva emite `usage_update` y `available_commands_update` sin pedir nada | notificaciones al crear | el arranque no debe asumir silencio hasta el primer prompt |
| `/changes.json` y `/doctor.json` exigen sesión iniciada (401 anónimo); `/memory.json`, `/stats.json`, `/outbox.json`, `/goals.json`, `/pending.json` no | pedidos directos a 3790 | los paneles con auth no se pueden verificar sin login: queda declarado como no verificado |

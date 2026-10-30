# 09 — Backend web Node (`web/`)

Auditoría del lado servidor de la UI web de Aegis. Fuente de verdad: `C:\Aegis-Proyects\web`,
repo git propio (remoto `backup` → `github.com/emilianodamir874/aegis-web`, rama `master`).
Medido el 2026-10-29 12:40-13:05, con el server vivo (PID 5016, arrancado 12:33) y sin tocarlo.

---

## 0. Lo primero: qué archivo corre de verdad

Hay **tres** archivos con el mismo nombre y ninguno es el que se edita.

| ruta | bytes | líneas | qué es | ¿se ejecuta? |
|---|---|---|---|---|
| `web/src/server.ts` | 93.245 | 1.979 | **fuente única** del backend (TS, `strict`) | no: se compila |
| `web/dist-ts/server.mjs` | 74.915 | 1.808 | artefacto esbuild, `platform: node`, `packages: external` | **sí** — PID 5016 |
| `web/server.mjs` | 72.677 | 1.765 | build viejo, versionado en git; mismas 21 rutas que `dist-ts` pero sin el escaneo de repos de `/changes.json` | no |

Evidencia:

```
$ Get-CimInstance Win32_Process | ? Name -like 'node*'
ProcessId CommandLine
5016      "...\node.exe" "C:\Aegis-Proyects\web\dist-ts\server.mjs"        (29/10 12:33)
```

Build: `web/tools/build-typescript.mjs:30` → `{ entry: 'src/server.ts', output: 'server.mjs', platform:'node', packages:'external' }`;
el `dist-ts/package.json` con `{"type":"module"}` lo escribe `build-typescript.mjs:85`. Los assets del cliente
sí se publican a `web/app/` (`build-typescript.mjs:71-75`, salvo `AEGIS_NO_PUBLISH=1`), pero **`server.mjs` no se
copia a la raíz**: la raíz quedó congelada en un build anterior.

`src/server.ts:221-222` resuelve la raíz con `MODULE_DIR` y, si el directorio del módulo se llama `src` o
`dist-ts`, sube un nivel: así el mismo archivo sirve desde fuente y desde `dist-ts/`, y `DIR` = `C:\Aegis-Proyects\web`.

---

## 1. Mapa de piezas (archivo:línea → qué hace → quién la llama)

### 1.1 Núcleo del proceso

| archivo:línea | qué hace | quién la llama |
|---|---|---|
| `src/server.ts:9-20` | imports: `node:http`, `https`, `net`, `crypto`, `zlib`, `child_process`, `fs/promises` | — |
| `src/server.ts:24-36` | `WS_ROOTS` desde `AEGIS_WORKSPACE_ROOTS` (default `C:\Aegis-Proyects;C:\Users\Emiliano`) + `wsInside()`: única frontera de todo lo que toca disco por pedido del navegador | `/ws/list`, `/ws/defaults`, `/changes.json`, `/file.json` |
| `src/server.ts:41-75` | `WS_DEFAULTS_FILE` = `<AEGIS_PATH_ROOT>/config/workspaces.defaults.json`; `withFileQueue` serializa por archivo; escritura tmp+rename | `/ws/defaults` |
| `src/server.ts:77-87` | `readJsonBody(req, maxBytes=65536)`: corta por bytes, nunca acumula | `/ws/defaults` POST, `/memory.json` POST |
| `src/server.ts:93-177` | memoria del operador: `state/data/memory/facts.jsonl`, IDs `F-0001`, orden por id, escritura atómica | `/memory.json` |
| `src/server.ts:98-120` | `sweepPendingAtStartup()`: al escuchar, barre confirmaciones huérfanas con `aegis-serve --sweep-pending` y, si el binario no tiene el flag, con `tools/sweep-pending.mjs` | `server.listen` (`:1949`) |
| `src/server.ts:179-217` | `workspaceList()`: navegación de carpetas acotada a `WS_ROOTS`, máx. 200 entradas, salta `.dot`, `node_modules`, `target` | `/ws/list` |
| `src/server.ts:252` | `cfg = JSON.parse(config.json)` en top-level await: el proceso no arranca sin `config.json` | todo |
| `src/server.ts:227-251` | caches de compresión `gzipBuf` (nivel 6) y `brotliBuf` (q11, modo texto), tope 40 entradas, clave = contenido | estáticos |
| `src/server.ts:257-288` | `outboxName()` + `openOutboxFile()`: nombre sin separadores ni dotfiles; `lstat` + `realpath` + `open` + re-verificación de inodo/dev para no seguir un symlink ni un swap de nombre | `/dl/<name>`, `/outbox.json` |
| `src/server.ts:292` | `logLine(file, line)` → `web/logs/<file>` (append, errores silenciados) | handler completo |
| `src/server.ts:1917-1954` | `http.createServer(handler)` + `server.listen(port,'0.0.0.0')`; `port` = `AEGIS_WEB_PORT` \| `cfg.webPort` \| 3788 | proceso |
| `src/server.ts:1959-1979` | HTTPS paralelo en 3789 con `core/state/tls/server.crt|.key` (para `getUserMedia`/dictado en LAN) | proceso |

### 1.2 Auth y exposición

| archivo:línea | qué hace | quién la llama |
|---|---|---|
| `src/server.ts:393-397` | lee `web/auth.json` (`{note,password,createdAt}`), tolera BOM; si falta → `auth=null` y **el túnel rechaza todo login** (`503 sin auth.json`, `:1020-1023`) | `/login` |
| `src/server.ts:398-423` | cookie `gw_auth` = `exp.HMAC(secretKey|authStamp, "gw|exp")` base64url, TTL 30 días, comparación `timingSafeEqual` | `authed()` |
| `src/server.ts:432-434` | `authed(req)` = cookie válida | `/doctor.json`, `/changes.json`, `/file.json`, `/tts`, upgrade `/acp` |
| `src/server.ts:436-463` | `isPrivateIp` / **`isTunnel`**: túnel si (a) peer loopback + cabecera `cf-*`, o (b) peer no-loopback y no-LAN, o (c) `Host` que no es loopback/`publicHost`/IP privada | cada request, `configFor`, gate `:1067` |
| `src/server.ts:466-480` | anti fuerza bruta: 8 fallos por IP / 60 s | `/login` POST |
| `src/server.ts:488-570` | `loginPage()` HTML autocontenido con CSP `default-src 'none'`; `safeNext()` bloquea `//`, `\`, `%5c`, control chars | `/login` |
| `src/server.ts:575-592` | `sameOriginRequest()`: `sec-fetch-site` ∈ {same-origin, none} + `Origin` == host esperado (https si TLS o túnel) | `/login`, `/config.js`, `/doctor.json`, `/changes.json`, `/file.json`, upgrade |
| `src/server.ts:1067-1075` | **puerta general del túnel**: si `isTunnel && !authed` → HTML pide `/login`, JSON/API recibe 401 | todo |
| `src/server.ts:1919-1944` | `onUpgrade`: sólo `/acp`; `sameOriginRequest` (403); `isTunnel && !authed` → 401; luego proxy | `http` y `https` |
| `src/server.ts:602-616` | `configFor(req)`: en túnel o TLS → `wss://<host>/acp?token=<secretKey>` (mismo origen, proxeado); en LAN http → `ws://<publicHost>:3284/acp?token=…` (directo al motor) | `/config.js` |

### 1.3 Puente con el motor y TTS

| archivo:línea | qué hace | quién la llama |
|---|---|---|
| `src/server.ts:648-693` | `proxyAcp`: clona cabeceras, fuerza `host=127.0.0.1:3284` y `origin=AEGIS_ACP_ORIGIN` (default `http://127.0.0.1:3788`, que está en `--allowed-origin` del serve), **borra** `cf-*`, `x-forwarded-*`, `x-real-ip`; `up.on('upgrade')` copia el handshake crudo y pipea en las dos direcciones; `up.on('response')` devuelve 401/403 tal cual; error → 502 y `logs/server.err.log` | `onUpgrade` |
| `src/server.ts:837-851` | `backendTcpReady()`: TCP connect a `127.0.0.1:servePort`, timeout 800 ms | `/healthz?backend=1`, watchdog |
| `src/server.ts:300-391` | `goalsIndex` / `statsIndex` / `searchIndex`: **proceso hijo** (`node --experimental-sqlite tools/*-index.mjs`) con `execFile`, cache 60 s (búsqueda 15 s, 40 entradas) | `/goals.json`, `/stats.json`, `/search.json` |
| `src/server.ts:1495-1517` | `/pending.json`: `tools/pending-index.mjs` en proceso hijo, cache 30 s, valida `JSON.parse` antes de cachear | panel Actividad / `app.ts:281` |
| `src/server.ts:1840-1915` | `doctorReport()`: puntero `core/state/current-version.json`, `last-build.json`, `health.json`, `fetch http://127.0.0.1:3284/health`, tamaños db/wal/shm, techo y umbral de compactación leídos de `state/config/config.yaml` por regex | `/doctor.json`, `src/doctor.ts:177` |
| `src/server.ts:695-833` | TTS local: `piperVivo` (proceso caliente, `src/piper-vivo.ts`), fallback `piperSuelto` (spawn por frase, `-f -` a stdout), `headroomWav` a −1,5 dBFS, cache 24 entradas, `ttsSlot()` con 2 en vuelo + 6 en espera | `/tts` |
| `src/server.ts:856-891` | `edgeTts` (msedge-tts): voz por WebSocket, serializado en una cola; si falla, la ruta cae a Piper (`:958-961`) | `/tts?engine=edge` |

### 1.4 Inventario completo de endpoints

`handler` empieza en `src/server.ts:893`. Rutas en orden de evaluación (la primera que matchea gana).

| método | ruta | línea | handler / efecto | auth |
|---|---|---|---|---|
| GET | `/tts` | 921 | sintetiza `?text` (≤1200 ch) con `engine` (piper\|edge), `voice`, `rate`, `ns`, `nw`; 401 túnel, 413 texto largo, 503 saturado, 502 error | túnel: cookie · LAN: abierta |
| ANY | `/healthz` | 983 | liveness (`ok:true`), `processReady`, `backendTcpReady`, `tunneled`, `authenticated`; `?backend=1` → 503 si el serve no escucha | **no** |
| ANY | `/logout` | 1002 | borra `gw_auth` (302 a `/login`), log en `auth.log` | no |
| GET/POST | `/login` | 1012 | GET formulario (o redirect si ya hay cookie); POST exige `sameOriginRequest`, `auth.json`, no bloqueado, contraseña timing-safe → set-cookie 30 días | no (es el login) |
| POST | `/client-log` | 1077 | logs del navegador → `logs/client.log`; corta en 40 KB, 413/408 | túnel: cookie |
| GET/POST | `/ws/defaults` | 1128 | GET: todos los defaults por workspace; POST `{root,defaults}` upsert (o delete si no hay `defaults`) con validación `wsInside` | túnel: cookie |
| GET | `/doctor.json` | 1166 | `doctorReport()`: versión desplegada vs viva, gate, store, compactación | **sí, incluso LAN** + sameOrigin |
| GET | `/changes.json` | 1185 | snapshot git del `cwd` de la sesión (o de `?repo=`), valida sesión en SQLite (proceso hijo, sólo `working_dir`), `denied()` de credenciales, junction/symlink real, `tools/changes-index.mjs --cwd\|--scan` | **sí** + sameOrigin |
| GET | `/file.json` | 1349 | texto + `sha256` + `mtime` + `lines` de un archivo ≤1,5 MB para el diff de aprobación; 403 fuera de raíces | **sí** + sameOrigin |
| GET | `/outbox.json` | 1421 | lista de `web/outbox` (`/dl/` por item) o `?name=X&preview=1` (texto o dataURL, ≤2 MB) | túnel: cookie |
| GET | `/pending.json` | 1495 | confirmaciones sin responder por sesión (SQLite en proceso hijo) | túnel: cookie |
| GET/POST | `/memory.json` | 1520 | GET lista `facts.jsonl`; POST `{action}`: `add` \| `confirm` \| `reject` \| `pin` \| `unpin` \| `consolidate` (este último ejecuta el binario `--memory-consolidate`) | túnel: cookie |
| GET | `/ws/list` | 1627 | navegación de carpetas para el selector de workspace | túnel: cookie |
| GET | `/prices.json` | 1635 | sirve `web/prices.json` (tarifas derivadas, no contractuales) | túnel: cookie |
| GET | `/goals.json` | 1643 | objetivos por sesión desde `extension_data` (proceso hijo + cache 60 s) | túnel: cookie |
| GET | `/search.json` | 1651 | FTS5 sobre `messages` (`?q`, `?limit` 1-50, cache 15 s) | túnel: cookie |
| GET | `/stats.json` | 1660 | `usage_ledger` agregado (`?days` 0-3650, 0 = todo) | túnel: cookie |
| GET | `/favicon.ico` | 1667 | 204 vacío | no |
| GET | `/config.js` | 1673 | **inyecta** `window.__AEGIS_APP__ = {acpUrl, cwd, host, version, tunnel, authed, defaultProvider, defaultModel, defaultEffort}`; `no-store`, `cross-origin-resource-policy: same-origin` | sameOrigin (no cookie) |
| GET | `/dl/<name>` | 1700 | descarga del outbox (`content-disposition: attachment`), tope 512 MB, streaming por `pipeline` | túnel: cookie |
| GET | todo lo demás | 1741-1808 | estáticos de `web/app` (raíz → `index.html`), versionado por hash en `index.html`, ETag, 304, br/gzip | túnel: cookie |
| WS | `/acp` | 1927 | proxy crudo al 3284 | sameOrigin + (túnel: cookie) |

Notas del inventario:

- **No hay SSE ni WebSocket propio**: la UI no consume eventos del Node, consume el ACP del motor.
- `/changes.json` **no lo llama ningún módulo de `src/`** (grep de `changes.json` en `web/src` sólo devuelve `server.ts`); sus consumidores vivos son `tests/changes-http.ts` (contrato completo: SQLite aislada, auth, origen, symlink) y `tools/verify-web-deploy.mjs:67-69`, que lo usa como huella conductual del deploy (401 anónimo). El `index.html` además sigue listando `changes.js` (`server.ts:1765`), archivo que ya no existe en `web/app/`.
- El *worker* SQLite inline de `/changes.json` (`server.ts:1225-1229`) es la única consulta SQL escrita en el server; el resto va por `web/tools/*-index.mjs`.

---

## 2. Cómo habla con el motor (3284)

| aspecto | implementación | evidencia |
|---|---|---|
| ¿spawnea el motor? | **No.** El Node no arranca ni supervisa `aegis-serve`: lo hace la tarea programada `Aegis Serve` (`core/ops/aegis-serve-launch.vbs`) y, como respaldo, `web/scripts/start-aegis-web.ps1:38-74` si el puerto no escucha. El Node sólo lo *chequea* (`/healthz`) y lo *proxea* | `server.ts:837`, `server.ts:648` |
| transporte | WebSocket ACP (JSON-RPC 2.0) del **navegador** al motor. El Node no interpreta ACP: copia bytes del `upgrade` | `server.ts:667-679` |
| LAN http | el navegador va **directo** a `ws://<publicHost>:3284/acp?token=<secretKey>` — el Node no está en el medio | `server.ts:611-613` |
| túnel / TLS | `wss://<host>/acp?token=…` contra el Node, que reescribe `host` y `origin` y borra cabeceras de proxy antes de reenviar | `server.ts:649-654` |
| multiplexación | **por conexión**: cada pestaña abre su propio WS y su propio `initialize`. La sesión se elige con `session/load`; varias conexiones pueden mirar la misma sesión vía hub (`_aegis/unstable/session/watch` + cursor, `hubWatchers`) | `app.ts:151-156`, `app.ts:4343-4360` |
| autorización del motor | `--allowed-origin` por cada origen (LAN http/https, loopback, URL del túnel leída de `tunnel-url.txt`) + `AEGIS_SERVER__SECRET_KEY` = `cfg.secretKey` + `?token=` | `start-aegis-web.ps1:40-59` |
| traducción ACP → UI | en el **cliente**: `session/update` (chunks de usuario/agente/razonamiento, tool_call, tool_call_update, plan, usage) y `_aegis/unstable/session/update` (`session/request_permission`, `replay_gap`, `activeRunId`) | `app.ts:313-336`, `app.ts:343-446` |

Consecuencia de diseño: el backend Node **no puede** cambiar el contrato con el motor; cualquier cosa que
requiera leer el stream (por ejemplo, contar tokens o cortar un turno) hay que hacerla en el motor o en `app.ts`.

---

## 3. Auth y exposición

| control | estado | detalle |
|---|---|---|
| bind | `0.0.0.0` en 3788 y 3789 | `server.ts:1947`, `server.ts:1968` |
| LAN | **abierta sin login**: `isTunnel()` devuelve `false` para peer privado con `Host` = IP privada o `publicHost` | `server.ts:447-463` |
| túnel | login por cookie firmada (`auth.json`), 8 intentos/min por IP, `sameOriginRequest` en el POST | `server.ts:466-480`, `:1015` |
| endpoints que igual piden cookie en LAN | `/doctor.json`, `/changes.json`, `/file.json` | `:1173`, `:1192`, `:1352` |
| CORS | **no hay `Access-Control-Allow-*`** en ninguna respuesta; el aislamiento es `sameOriginRequest` + CSP + `cross-origin-resource-policy: same-origin` en `/config.js` | `:575-592`, `:1695` |
| CSP | `default-src 'self'; script-src 'self'; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'` | `:636-640` |
| rate limit | sólo `/login` (8/60 s por IP) y TTS (2 en vuelo, 6 en cola). **Nada** en `/search.json`, `/stats.json`, `/changes.json` | `:466-480`, `:712-726` |
| secretos en claro | `config.json:7` `secretKey` (64 hex) viaja en `/config.js` y en el `?token=` del WS; `auth.json` sólo tiene `password` en claro | `config.example.json:2` avisa que `config.json` no se versiona |
| cloudflared | **sigue en el código y en disco**: `web/tools/cloudflared.exe` (55 MB) y dos watchdogs (`aegis-web-tunnel-watchdog.ps1:15`, `aegis-web-tunnel2.ps1:12`), tareas `Aegis_Web_Tunnel`. La variante portable v121 se armó *sin* cloudflared, pero el repo vivo no lo perdió | ver §6 |

---

## 4. Streaming al navegador

| pregunta | respuesta | evidencia |
|---|---|---|
| ¿SSE? | **No.** Único camino de eventos: WS ACP al motor (directo en LAN, proxeado en túnel/TLS) | `server.ts:1919-1943` |
| formato de evento | JSON-RPC 2.0 sin envoltorio extra. Notificaciones: `session/update` con `params.update.sessionUpdate` ∈ {`user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage_update`}; `_aegis/unstable/session/update` con `params.aegis.{agentVisible, activeRunId}`; `session/request_permission`; `_aegis/unstable/session/replay_gap` | `app.ts:352-446`, `app.ts:313-336` |
| batching de deltas | **en el cliente**: un chunk = un `streamAppend` al DOM; no hay coalescencia por tiempo en el server (el server no ve el payload) | `app.ts:383-396` |
| reconexión | sí, en el cliente: `onclose` rechaza los pendientes (si no, `session/prompt` colgado deja `busy` para siempre), backoff 1 s → ×2 → techo 15 s, `initialize` otra vez, y con hub habilitado `hubRewatch()` con el último cursor | `app.ts:200-215`, `app.ts:157-175` |
| turno durante un corte | con hub (`v6.4`) el run **no** muere con la conexión: el `watch` devuelve `activeRunId`; sin hub, la UI declara el turno interrumpido | `app.ts:164-175` |
| corte a ~100 s | el quick tunnel de Cloudflare no es un canal confiable: no tiene garantía de uptime y **no soporta SSE** ([trycloudflare docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)). Por eso (a) todo va por WS (que sí atraviesa), (b) el cliente reconecta y reengancha con cursor, (c) el *keep-alive* del link lo da el tráfico ACP, no un ping: **no hay ping/heartbeat propio en ningún lado** (`grep -i keepalive\|heartbeat\|ping` en `web/src` = 0 resultados), (d) el watchdog del túnel rearma cloudflared y stack cada 60 s | `app.ts:200-215`, `aegis-web-tunnel-watchdog.ps1:144-216` |
| corte del render | el watchdog distingue "HTTP 200" de "el navegador puede pintar": pide `/` con `Accept-Encoding: gzip, br`, exige `id="messages"` y un `app.js?v=<hash>` de >40 KB. Si falla, reinicia el cliente con enfriamiento de 15 min | `aegis-web-tunnel-watchdog.ps1:45-63`, `:153-175` |

---

## 5. Persistencia y estado del proceso

| qué | dónde | sobrevive al reinicio | línea |
|---|---|---|---|
| defaults por workspace (modelo, esfuerzo, modo) | `<AEGIS_PATH_ROOT>/config/workspaces.defaults.json` (tmp+rename, cola por archivo) | sí | `:41-75` |
| memoria del operador | `state/data/memory/facts.jsonl` (una línea JSON por hecho, ordenado por id) | sí | `:93-177` |
| outbox de descargas | `web/outbox` (único directorio de escritura para el cliente vía `/dl`) | sí | `:254-289` |
| logs | `web/logs/`: `requests.log` (llegada + fin con status y ms), `auth.log`, `client.log`, `tts.log`, `server.err.log` | sí (crecen sin poda propia: `requests.log` = 29,8 MB, `client.log` = 9,2 MB) | `:292`, `:908-918` |
| cache de goals/stats/search/pending | memoria del proceso (Map) | no | `:299`, `:328`, `:358`, `:94` |
| cache de gzip/brotli | memoria del proceso (Map, tope 40) | no | `:226-251` |
| cookie de sesión web | navegador (30 días) | sí, y se invalida rotando `authStamp` en `config.json` | `:398-403` |
| proceso TTS `piper` vivo | hijo del Node, idle 5 min, `C:\Aegis-Proyects\tmp\piper-vivo` como scratch | no | `src/piper-vivo.ts:6-20` |
| PID del motor, sesiones, uso | `sessions.db` del motor | sí — el Node sólo lee (siempre en proceso hijo, nunca en el event loop) | `:1222`, `:1502`, `:307`, `:336` |
| estado del watcher | `web/logs/.last-render-restart`, `.last-backend-restart` | sí (son las marcas de enfriamiento) | watchdog `:159-200` |

Auto-reparación (fuera del proceso Node, en `Aegis_Web` y `Aegis_Web_Tunnel`):

| pieza | qué hace |
|---|---|
| `scripts/aegis-web-launch.vbs` → `start-aegis-web.ps1` | levanta serve (3284) si no escucha y `node server.mjs` si el 3788 está libre — **lanza el `server.mjs` de la raíz, no `dist-ts`** |
| `scripts/restart-node.ps1` | mata por dueño del puerto, espera puerto libre, arranca `dist-ts/server.mjs`, verifica `/healthz` y el cache-busting |
| `scripts/aegis-web-tunnel-watchdog.ps1 -Loop` | cada 60 s: HTTP, render real, listener del backend (`processReady` + `backendTcpReady`), cloudflared, URL en `tunnel-url.txt` / `tunnel-access.txt` (con la contraseña en claro) |

---

## 6. Módulos `web/src/*.ts`

### 6.1 Servidor / compartidos

| archivo | líneas | responsabilidad | endpoints de los que depende |
|---|---|---|---|
| `server.ts` | 1.979 | todo el backend (§1) | — |
| `piper-vivo.ts` | 80 | proceso Piper caliente: stdin por frase, WAV leído del scratch dir, 1 frase por vez, idle 5 min | — (lo importa `server.ts:696`) |
| `tools/goals-index.ts` | 120 | índice de `/goal` desde `extension_data` de `sessions.db` (SQLite, `--experimental-sqlite`) | invocado por `/goals.json` |
| `tools/stats-index.ts` | 276 | agrega `usage_ledger`: por día, modelo, sesión, hora, fuente, proveedor + plan prorrateado | invocado por `/stats.json` |
| `tools/search-index.ts` | 176 | FTS5 sobre mensajes, snippets con marcas `\u0001/\u0002` | invocado por `/search.json` |
| `tools/changes-index.ts` | 182 | `git status/diff` de un cwd validado; `--scan` lista repos internos | invocado por `/changes.json` |

### 6.2 Cliente (mismo `src/`, compilado a `web/app/*.js`)

El cliente **no es backend**, pero define qué contrato consume. `client-bundle.ts` es el punto de entrada
único (13 `<script>` → 1 bundle, `build-typescript.mjs:10`).

| archivo | responsabilidad | endpoints / RPC |
|---|---|---|
| `app.ts` (7.361) | cliente ACP completo: RPC, sesiones, streaming, permisos, adjuntos, chips de modelo | WS `/acp`; `/config.js`, `/pending.json`, `/search.json`, `/file.json`, `/ws/defaults`, `/ws/list`, `/goals.json`, `/stats.json`, `/dl/`, `/tts`, `/logout` |
| `client-bundle.ts` | orden de carga: `app` primero, después paneles | — |
| `activity.ts` | foto de actividad read-only (no deriva inactividad de la ausencia de run) | `/pending.json`, RPC de sesiones |
| `artifacts.ts` | galería del outbox con preview ≤2 MB | `/outbox.json`, `/dl/<name>` |
| `context-meter.ts` | medidor de contexto y costo en el composer | `/prices.json` + `usage_update` |
| `doctor.ts` | panel de estado del harness | `/doctor.json` |
| `handoff.ts` | arma bloque de traspaso entre sesiones (sin split view) | sesión actual (DOM) |
| `memory.ts` | panel de memoria del operador | `/memory.json` |
| `onboarding.ts` | estado vacío que enseña (modelo, costo, qué puede hacer) | `/prices.json`, `/goals.json` |
| `palette.ts` | palette Ctrl/Cmd+K que junta comandos de todos los paneles | ninguno propio |
| `session-mode.ts` | API de modos (plan/revisar/ejecutar); ya no dibuja chip | RPC `session/set_mode` |
| `skills.ts` | panel de skills (fuente, descripción, contenido) | RPC del motor |
| `split-view.ts` | segunda sesión al costado, modo lectura | RPC `session/load` |
| `stats.ts` | botón de gasto del topbar (el panel vive en `app/gasto.ts`) | `/stats.json` |
| `workspace-nav.ts` | navegación: Actividad y Archivos como diálogos reales | `/ws/list`, `/ws/defaults` |
| `app/gasto.ts` (318) | panel de gasto: puro, `stats` → HTML | datos de `/stats.json` vía `app.ts:2385` |
| `app/format.ts` | formateo y disparador de compactación (`autoCompactAt/Pct`, 80 % por defecto) | — |
| `app/markdown.ts` | markdown → HTML (tablas con `data-label`, fences) | — |
| `app/sessions.ts` | render de la lista de sesiones (una acción por fila) | — |
| `app/search.ts` | resultados de `/search.json` escapados, marcas → `<mark>` | `/search.json` |
| `app/read.ts` | bloque «Para escuchar» → texto hablable + URL de `/tts` | `/tts` |
| `app/modos.ts` | reglas plan/revisar/ejecutar derivadas del permiso sobre `write` | — |
| `app/acts.ts`, `app/combo.ts`, `app/panel.ts` | menús de fila, combobox de modelo/proveedor, chasis de paneles | — |
| `app/audio-wav.ts` | `MediaRecorder` → WAV 16 kHz base64 para dictado | — |
| `app/historial.ts`, `app/variantes.ts`, `app/transcript-ui.ts`, `app/tool-diff.ts`, `app/viewport.ts`, `app/icons.ts` | navegación atrás/adelante, variantes de un turno, búsqueda en el transcript, diff de tools, viewport | — |

`tsconfig.server.json` sólo typechequea `src/server.ts`, `src/piper-vivo.ts`, `src/tools/goals-index.ts` y
`src/tools/stats-index.ts` — `search-index.ts` y `changes-index.ts` **no están en el `include`**.

---

## 7. Invariantes y trampas

| # | invariante | por qué | evidencia |
|---|---|---|---|
| 1 | El token del motor **nunca** está en un archivo estático | si estuviera en `app/`, cualquiera con la URL del túnel lo lee | `server.ts:1-2`, `:1673-1697` |
| 2 | `/config.js` exige `sameOriginRequest` | un `<script src>` de otro sitio puede leer el token aunque no haya CORS | `server.ts:1674-1680` |
| 3 | El `Origin` del navegador se valida **antes** de tocar el motor; el `Origin` que ve el motor es siempre el del proxy | si no, una página ajena abre el WS con la cookie del operador | `server.ts:1931-1936`, `:651` |
| 4 | `cf-*`/`x-forwarded-*` se borran al proxear | el motor no debe creer que un `Host`/IP lo eligió el cliente | `server.ts:652-654` |
| 5 | Ningún endpoint toca disco fuera de `WS_ROOTS`, `web/outbox`, `state/data/memory` o `<PATH_ROOT>/config` | el navegador no elige rutas, las elige el registro de la sesión | `server.ts:30-36`, `:1258`, `:1378` |
| 6 | SQLite siempre en proceso hijo | un `sessions.db` de ~534 MB bloquea el event loop y tumba el health check | `server.ts:96-97`, `:325-327`, `:353-357` |
| 7 | Lectura de archivos por `open` + verificación de inodo | `stat`→`read` es una carrera; un symlink puesto en el medio redirige la lectura | `server.ts:266-288`, `:1383-1405` |
| 8 | Escrituras de estado: tmp + rename (+ cola por archivo) | dos POST concurrentes a `/memory.json` perderían hechos | `server.ts:46-55`, `:67-71`, `:161-168` |
| 9 | La versión de los estáticos es el hash del contenido, no el mtime | el HTML se reescribe al vuelo con `?v=<hash>` | `server.ts:1760-1804` |
| 10 | `AEGIS_WEB_ROOT`/cliente React: muerto | el React se revirtió (`6fa990f revert(web): borrar el cliente React`) pero `start-aegis-web.ps1:19` y `restart-node.ps1:41-42` siguen leyendo `state/use-react-client`, y `state/` está vacío | `ls web/state` = vacío |
| 11 | Un solo `server.mjs` está vivo, pero **no el que edita el operador** | ver §0: hay que `npm run build` y reiniciar `dist-ts` | PID 5016 |
| 12 | `start-aegis-web.ps1` (tarea `Aegis_Web`, se ejecuta al arrancar la máquina) lanza la **raíz** `server.mjs` | tras un reboot la UI sirve un backend de ~1 semana atrás, sin `/changes.json` nuevo. El camino correcto es `restart-node.ps1` | `start-aegis-web.ps1:78`, `restart-node.ps1:46-48` |

---

## 8. Local vs GitHub

Verificado con `gh` (autenticado como `emilianodamir874`) el 2026-10-29.

| repositorio | ¿tiene `web/`? | evidencia |
|---|---|---|
| `emilianodamir874/aegis-harness` (motor) | **no** | `gh api repos/.../aegis-harness/contents/web` → 404 |
| `emilianodamir874/aegis-src` (motor, copia) | **no** | `gh api repos/.../aegis-src/contents/web` → 404 |
| `block/goose` (upstream) | no aplica: el servidor web Node no existe en goose | — |

| pieza | estado |
|---|---|
| repo propio del backend web | `emilianodamir874/aegis-web`, **privado**, rama única `master`, 13,7 MB, último push 2026-10-21 10:23 UTC |
| commits locales | **310**, HEAD `61908a9` (2026-10-29 12:44) |
| commits que el remoto no tiene | **209** (`git rev-list --count backup/master..HEAD`); detrás: 0 |
| `src/` en el remoto | 12 archivos (`server.ts`, `app.ts`, `app/format|icons|markdown|read|sessions.ts`, `skills.ts`, `stats.ts`, `piper-vivo.ts`, `tools/goals|stats-index.ts`) |
| `src/` local | **38 archivos** → 26 módulos (activity, artifacts, client-bundle, context-meter, doctor, handoff, memory, onboarding, palette, session-mode, split-view, workspace-nav, `app/{acts,audio-wav,combo,gasto,historial,modos,panel,tool-diff,transcript-ui,variantes,viewport,search}`, `tools/{search,changes}-index`) **existen sólo en disco** |
| `server.ts` local vs remoto | 209 commits de diferencia: auth endurecida (túnel exige cookie a cualquier peer no-loopback), `/pending.json`, `/memory.json`, `/ws/defaults`, `/ws/list`, `/doctor.json`, `/outbox.json`, brotli, `/file.json` con sha256 |
| `web/server.mjs` (raíz) | versionado localmente y **también** en el remoto, pero congelado |
| sin versionar / ajeno | `config.json` (secretKey), `auth.json`, `logs/`, `outbox/`, `state/`, `tools/cloudflared.exe`, `tunnel-*.txt`; WIP sin commitear: `app/app.js`, `app/bundle.js`, `src/app.ts`, `tests/ui-shell.ts`, `tools/ui-ux-check.mjs`, `tools/verify-web-deploy.mjs` |

Conclusión: **el 100 % del backend web actual existe sólo en disco**. Lo único que hay en GitHub es la
versión del 2026-10-20/21, y el `web/server.mjs` de la raíz da la falsa impresión de que "está versionado".

---

## 9. Referencias web (URL literal)

| tema | URL |
|---|---|
| `http.Server` evento `upgrade` (base del proxy `/acp`) | https://nodejs.org/api/http.html#event-upgrade |
| `server.listen()` / bind | https://nodejs.org/api/http.html#serverlisten |
| `https.createServer()` (3789) | https://nodejs.org/api/https.html#httpscreateserveroptions-requestlistener |
| `node:sqlite` `DatabaseSync` (lectura del store) | https://nodejs.org/api/sqlite.html |
| `zlib` brotli/gzip (`brotliBuf`, `gzipBuf`) | https://nodejs.org/api/zlib.html |
| WebSocket del navegador (`new WebSocket(CFG.acpUrl)`) | https://developer.mozilla.org/en-US/docs/Web/API/WebSocket |
| Server-Sent Events (lo que **no** se usa y por qué) | https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events |
| Fetch Metadata (`Sec-Fetch-Site`, base de `sameOriginRequest`) | https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Sec-Fetch-Site |
| Cloudflare Quick Tunnels — limitaciones (sin SLA, 200 requests en vuelo, **sin SSE**, hostname cambia) | https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/ |
| `cloudflared tunnel --url` (parámetros usados por el watchdog) | https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/#create-a-quick-tunnel |

---

## 10. Huecos, riesgos y deuda técnica

| # | hallazgo | evidencia | riesgo |
|---|---|---|---|
| 1 | Dos artefactos `server.mjs` con deriva; el launcher de la tarea programada arranca el viejo | `start-aegis-web.ps1:78` vs PID 5016 (`dist-ts/server.mjs`) | un reinicio de máquina degrada la UI a una versión de días atrás, sin aviso |
| 2 | `web/server.mjs` (raíz) sigue versionado y se lee como "fuente" | `git ls-files` + 72.677 B vs 74.915 B | editar el archivo equivocado (ya pasó con el bundle: comentario `build-typescript.mjs:66-70`) |
| 3 | `/changes.json` sin consumidor en el cliente, pero `index.html` sigue pidiendo `changes.js` (no existe) | `server.ts:1763-1765`; `web/app` no tiene `changes.js` | ~430 líneas de backend caras de mantener (validación de repo, junction, `denied`) sin uso; el hash de ese asset queda vacío |
| 4 | PIN de `server.ts` con TLS doble: 3788 y 3789 comparten handler, y el 3789 a veces no arranca | `logs/server.out.log`: `TLS error: listen EADDRINUSE 0.0.0.0:3789` | dictado por IP caído sin que nadie lo note (el watchdog no prueba 3789) |
| 5 | Sin rate limit fuera de `/login` y TTS | `server.ts` (no hay otro contador) | `/search.json` y `/stats.json` spawnean un `node` por request frío: 10 pestañas = 10 procesos |
| 6 | Sin heartbeat del WS: el corte lo detecta el `close` | `grep ping/keepalive` = 0 en `web/src` | cortes silenciosos de ~100 s del quick tunnel dependen del reenganche del cliente; en LAN directa al 3284 no hay proxy que mate la conexión |
| 7 | Logs sin poda propia (`requests.log` 29,8 MB, `client.log` 9,2 MB) y `client.log` acepta 40 KB por POST de cualquier cliente autenticado | `server.ts:1077-1125`, `web/logs/` | disco y ruido; `/client-log` es el único POST que escribe a disco sin validar contenido |
| 8 | `/login` sólo tiene contraseña: no hay usuario ni 2FA, y la cookie no es `Secure` si el túnel no manda `x-forwarded-proto` | `server.ts:1049-1053` | cookie viajando en claro en el tramo LAN http |
| 9 | `denied()` duplicado en `/changes.json` (`:1251`) y `/file.json` (`:1366`) con listas distintas (una bloquea `state`, `config`, `credentials`, la otra no) | comparar ambas regex | reglas de seguridad divergentes según el endpoint |
| 10 | `tools/cloudflared.exe` (55 MB) sigue en el repo y en `.gitignore`-landia; dos túneles y dos watchdogs | `web/tools/cloudflared.exe`, `scripts/aegis-web-tunnel2.ps1` | contradice la decisión del paquete portable v121 (sin cloudflared) y duplica superficie de exposición pública |
| 11 | `src/tools/search-index.ts` y `changes-index.ts` fuera de `tsconfig.server.json` | `tsconfig.server.json:14-19` | `npm run typecheck` puede pasar con esos dos rotos |
| 12 | `web/tools/` = ~250 scripts de diagnóstico (`_*`, `probe*`, `patch-v6*.py`, `.wav`, `user-photo.jpg`, `cloudflared.exe`) | listado de `web/tools` | ruido que ya provocó builds sobre archivos equivocados; nada de eso se ejecuta en producción |
| 13 | 209 commits sin pushear a `aegis-web` | `git rev-list --count backup/master..HEAD` | pérdida total del backend ante un fallo de disco (y el RAID 0 del sistema no tiene redundancia) |

---

## 11. No verificado

- **El corte a ~100 s no está documentado en el código ni en la doc de Cloudflare que leí.** Sé que el quick
  tunnel no tiene SLA y no soporta SSE (cita en §9); el número exacto de segundos de inactividad que tolera el
  borde de Cloudflare no lo pude confirmar con una fuente oficial, así que no lo afirmo. Lo que sí está
  verificado: el cliente no manda pings, reconecta con backoff 1→15 s y reengancha con cursor (§4).
- No ejecuté `/doctor.json`, `/changes.json` ni `/memory.json` contra el server vivo (regla: read-only y un
  turno del operador pasando por 3788). Su comportamiento está leído en código, no probado en esta sesión.
- No corrí `npm test` ni `npm run typecheck` (prohibido en esta tarea): no sé si el árbol actual compila.
  El WIP sin commitear (`src/app.ts`, `tests/ui-shell.ts`, `tools/ui-ux-check.mjs`, `tools/verify-web-deploy.mjs`)
  sugiere que hay un build a medio hacer.
- No verifiqué el contenido de `sessions.db` (extension_data de `/goal`, `usage_ledger`) ni que
  `tools/pending-index.mjs` siga existiendo con el nombre que usa `server.ts:1502` (existe en `web/tools`,
  no lo abrí).
- No verifiqué el estado de la tarea programada `Aegis_Web_Tunnel` más allá de que existe y está `Ready`.

# 04 — Transporte ACP y binario `aegis-serve`

Ámbito: el cable entre la UI (web o desktop) y el motor. Crates `aegis-server` (binario),
`aegis/src/acp/**` (implementación del Agent + transportes), `aegis-acp-macros`, `aegis-sdk-types`
(catálogo de métodos custom) y el extremo del cable en `web/server.mjs`.
Todo lo afirmado abajo se leyó del código en disco el **2026-10-29**; lo que no se pudo comprobar está
en *No verificado*.

Estado vivo verificado en la misma sesión:

| dato | valor observado |
|---|---|
| proceso | `aegis-v121.exe` PID 14468 |
| línea de comandos | `--host 0.0.0.0 --port 3284 --platform desktop --enable-scheduler --with-builtin developer --allowed-origin http://192.168.100.34:3788 ...` |
| `GET http://127.0.0.1:3284/health` | `ok` (200) |

---

## 1. Mapa de piezas (ruta:línea → qué hace → quién la llama)

### 1.1 Binario y arranque

| ruta:línea | qué hace | quién la llama |
|---|---|---|
| `crates/aegis-server/src/main.rs:50-152` | struct `Args`: todo el CLI del binario | `clap` en `main.rs:367` |
| `crates/aegis-server/src/main.rs:357-446` | `main`: sin argumentos imprime ayuda y sale 0 (`:361-365`); despacha los modos one-shot (print-paths, stdio, list-skills, sweep-pending, memory-consolidate, list-sessions, run-recipe) | SO / lanzador |
| `main.rs:163-179` | `print_paths()`: imprime config_dir, config.yaml, data_dir, sessions.db, state_dir, logs_dir, agents_home, version | `main.rs:369`, `serve():210` |
| `main.rs:181-190` | `list_skills()`: tabula `name\tdescription\tpath` vía `aegis::skills::list_installed_skills` | `main.rs:378` |
| `main.rs:192-207` | `list_sessions(limit)`: `SessionManager::list_all_sessions`, orden por `updated_at` desc | `main.rs:421` |
| `main.rs:383-401` | `--sweep-pending`: cierra confirmaciones de tools sin respuesta | `session::pending_confirmations::sweep_pending` |
| `main.rs:403-419` | `--memory-consolidate`: consolida memoria y escribe informe | `aegis::memory::store::consolidate` |
| `main.rs:209-336` | `serve()`: construye `AcpServer`, valida auth, arma router, bindea TLS o TCP | `main.rs:446` |
| `main.rs:338-355` | `init_logging()`: componente `serve`, JSON, `console` sólo si `AEGIS_LOG_CONSOLE` está definido | `main.rs:436` |
| `main.rs:154-161` | `generate_secret_key()`: `aegis-acp-<32 alfanuméricos>` cuando no hay env | `main.rs:268` |
| `crates/aegis-server/src/recipe_runner.rs` (135 l.) | ejecución headless de recetas en proceso | `main.rs:433` |

### 1.2 Transporte

| ruta:línea | qué hace | quién la llama |
|---|---|---|
| `crates/aegis/src/acp/transport/mod.rs:101-108` | `acp_http_options()`: `path: "/acp"`, CORS del crate con origen sintético, `health_endpoint: false` | `mod.rs:190` |
| `transport/mod.rs:188-196` | `create_acp_router_inner`: `AcpHttpServer::new(|| AegisAgentConnection::new(server))` → un agente por conexión; middleware de Origin para WS | `mod.rs:203` |
| `transport/mod.rs:198-211` | añade `auth::check_acp_token` si hay token, y capa CORS Aegis encima | `mod.rs:238-239` |
| `transport/mod.rs:225-248` | `create_router`: ACP + `/health` + `/status` + rutas del MCP app proxy | `main.rs:273` |
| `transport/mod.rs:27-99` | `AcpOriginPolicy`: loopback (http/https + localhost/127.x/::1) vs lista exacta vs loopback+exactos; `null` y `file://` sólo en `local_default` | `mod.rs:231-237` |
| `transport/mod.rs:110-149` | `enforce_websocket_origin`: valida `Origin` en el upgrade y lo **reescribe** a `http://aegis.local` (`:142-145`) | capa axum |
| `transport/auth.rs:15-36` | `check_acp_token`: acepta `X-Secret-Key` o `?token=`, comparación en tiempo constante (`subtle`) | capa axum |
| `transport/tls.rs:17-30, 80-86` | certificado autofirmado con `rcgen`; `AEGIS_TLS_CERT_PATH`+`AEGIS_TLS_KEY_PATH` o ninguno; fingerprint SHA-256 impreso como `AEGISD_CERT_FINGERPRINT=` (`:63`) | `main.rs:295` |
| `transport/tls.rs:88-148` | caché TLS en disco (`load_cached_tls`, `try_save_tls_to_cache`) | `setup_tls` |
| `acp/server.rs:3309-3330` | `serve(agent, read, write)`: camino **stdio** con `SacpAgent … ByteStreams` | `run()` |
| `acp/server.rs:3338-3362` | `AegisAgentConnection`: crea el agente en diferido y lo conecta al cliente HTTP | `AcpHttpServer` |
| `acp/server.rs:3364-3382` | `run(builtins, enable_scheduler)`: stdio sobre stdin/stdout (`.compat()`) | `main.rs:374-376` |
| `acp/server_factory.rs:29-64` | `AcpServer`: `OnceCell` de scheduler, `ActiveRunRegistry`, `SessionHub`, `LiveVoiceService` | `main.rs:229` |
| `acp/server_factory.rs:139-159` | `AgentManager` único del server; tope `AEGIS_MAX_ACTIVE_AGENTS` (**default 100**) | `create_agent` |
| `acp/server_factory.rs:70-94` | `start_scheduler()` / `scheduler()`: sólo si `--enable-scheduler`; `schedule.json` en `data_dir` | `main.rs:269` |

### 1.3 Despacho del protocolo

| ruta:línea | qué hace |
|---|---|
| `acp/server/dispatch.rs:4-511` | `HandleDispatchFrom<Client>`: la cadena `MatchDispatchFrom` con todos los métodos estándar |
| `dispatch.rs:17-19` | `Box::pin` del futuro: la máquina de estados mide ~85 KB y desborda el stack de tokio |
| `dispatch.rs:30-42` | `initialize` **inline** (no `spawn`) para no perder carrera contra `session/new` |
| `dispatch.rs:37-41` | `authenticate` responde `AuthenticateResponse::new()` sin hacer nada |
| `dispatch.rs:149-357` | `session/set_config_option` con ids `provider`/`mode`/`model`/`thinking_effort` |
| `dispatch.rs:359-388` | `session/set_mode` + notifica `CurrentModeUpdate` antes de responder |
| `dispatch.rs:472-507` | `otherwise`: request desconocido → `dispatch_custom_request`; notificación desconocida → drop silencioso |
| `acp/server/custom_dispatch.rs:4-31` | `#[custom_methods]` sobre `AegisAcpAgent`; caso especial `SaveRecipeRequest` y luego el dispatcher generado |
| `acp/server/custom_dispatch.rs:33-961` | 118 handlers `#[custom_method(Request)]` (conteo por grep de `method = "` en el crate de tipos) |
| `crates/aegis-acp-macros/src/lib.rs:50-235` | genera `handle_custom_request` (match por `matches_method`, `-32601` al final, `lib.rs:213`) y `custom_method_schemas` |

---

## 2. Transporte: stdio vs HTTP/WebSocket

| | **stdio** (`--stdio`) | **HTTP/WS** (default) |
|---|---|---|
| entrada | `aegis-serve --stdio` | `aegis-serve --host … --port …` |
| implementación | `acp/server.rs:3364` + `serve()` `:3309` | `transport/mod.rs:225` + `main.rs:326-332` |
| framing | JSON-RPC delimited sobre stdin/stdout (`ByteStreams`) | POST/GET/DELETE en `/acp` (WS para el stream) |
| endpoint | — | `http://127.0.0.1:3284/acp` (default `--host 127.0.0.1 --port 3284`, `main.rs:51-55`) |
| auxiliares | — | `/health`, `/status` (`mod.rs:242-243`), MCP app proxy (`mod.rs:244`) |
| auth | ninguna | `X-Secret-Key` o `?token=` (`auth.rs:20-31`) |
| TLS | no aplica | `--tls` o `AEGIS_TLS` o ambos paths (`main.rs:287-290`) |
| plataforma | **siempre** `AegisPlatform::AegisCli` (`server.rs:3374`) | `--platform cli\|desktop` (`main.rs:66-67`) |
| scheduler | `--enable-scheduler` (`server.rs:3377`) | igual |

Detalles que importan:

- **`require_token` no es “¿hay auth?” sino “¿hay secreto en el entorno?”**: `main.rs:238-242`
  (`require_token = env_secret.is_some()`). Con `AEGIS_SERVER__SECRET_KEY` puesta y
  `--dangerously-unauthenticated` a la vez, igual se exige token.
- Sin env y sin el flag, el binario **aborta** (`main.rs:243-247`). Con el flag sin env, genera un
  secreto aleatorio que nadie conoce y avisa por log (`main.rs:248-252`, `:268`).
- **Política de Origin** (`mod.rs:231-237`): si se pasa al menos un `--allowed-origin`, la política
  pasa a *exacta* y **se pierde** el permiso loopback; `null` y `file://` sólo existen en
  `local_default()`. El lanzador real pasa ocho `--allowed-origin`, incluido el host del túnel.
- El upgrade WS reescribe `Origin` a un valor sintético porque el crate upstream sólo acepta una
  allowlist exacta (`mod.rs:21-25`, `:142-145`). Consecuencia: dentro del handler nadie puede leer el
  Origin real.
- Cabeceras CORS permitidas y expuestas: `x-secret-key`, `acp-connection-id`, `acp-session-id`
  (`mod.rs:157-171`); las auxiliares usan `Any` (`mod.rs:177-186`).
- `ServerOptions.health_endpoint: false`: el sub-router ACP **no** trae `/health`; el `/health` que
  responde 200 lo pone `aux_routes`.

### Handshake y negociación de versión

1. Cliente → `initialize` con `clientCapabilities` (fs, terminal, `_meta.aegis.*`).
   - `fs` → `client_fs_capabilities`; `terminal` → `client_terminal` (`server.rs:2305-2308`).
   - `_meta.aegis`: `custom_notifications`, `recipe_parameter_requests`, `tool_call_label_enrichment`
     (`server.rs:2309-2327`), elicitation de formularios (`:2328-2330`), login shell path (`:2331-2333`).
   - Todo es `OnceCell`: **sólo la primera** `initialize` de la conexión cuenta.
2. Agente → `InitializeResponse` (`server.rs:2335-2357`):
   - `protocolVersion = ProtocolVersion::LATEST` = **v1** (el enum fija `LATEST = V1`,
     `agent-client-protocol-schema-1.9.1/src/version.rs:39`).
   - `agentInfo = { name: "aegis", version: CARGO_PKG_VERSION }`.
   - capacidades: `loadSession: true`; `session` con list/delete/close; `prompt` con
     `image: true`, `audio: false`, `embeddedContext: true`; `mcp.http: true`; `_meta` propio.
   - `authMethods = [{ id: "aegis-provider", name: "Configure Provider" }]`.
3. Cliente → `authenticate` (si hiciera falta): respuesta vacía, sin efectos (`dispatch.rs:37-41`).

---

## 3. Catálogo de métodos JSON-RPC

### 3.1 ACP estándar (los que el Agent implementa)

| método | tipo | handler | notas |
|---|---|---|---|
| `initialize` | request | `server.rs:2299` | inline, ver §2 |
| `authenticate` | request | `dispatch.rs:38` | no-op |
| `session/new` | request | `server.rs:2360` → `handle_new_session` (`new_session.rs`) | responde y **luego** emite notificaciones de setup (`dispatch.rs:52-68`) |
| `session/load` | request | `server.rs:2768` (`load_session.rs`, 760 l.) | idem (`dispatch.rs:89-107`) |
| `session/prompt` | request | `server.rs:2776` → `run_prompt_turn` (`:2826`) | corre en `spawn_prompt_task` con lease (`:2799-2808`) |
| `session/cancel` | **notification** | `server.rs:3063` | `mark_client_cancelled` + `token.cancel()` |
| `session/update` | notification (agente→cliente) | `response_builder.rs`, `tool_notifications.rs` | ver §4 |
| `session/set_mode` | request | `server.rs:3165` | emite `CurrentModeUpdate` antes de responder |
| `session/set_config_option` | request | `dispatch.rs:150-357` | ids: `provider`, `mode`, `model`, `thinking_effort` |
| `session/list` | request | `dispatch.rs:404` (`list_sessions.rs`) | capacidad anunciada |
| `session/delete` | request | `dispatch.rs:407` (`manage_sessions.rs`) | |
| `session/close` | request | `dispatch.rs:422` → `server.rs:3273` | marca `closed_session_ids` |
| `session/fork` | request | `dispatch.rs:437` (`fork_session.rs`) | |
| `session/request_permission` | request agente→cliente | `server.rs:2067-2132` | 4 opciones: `allow_always`, `allow_once`, `reject_once`, `reject_always` |
| `fs/read_text_file` | request agente→cliente | `acp/fs.rs:29-49` | `line`/`limit` opcionales, `.block_task()` |
| `fs/write_text_file` | request agente→cliente | `acp/fs.rs:51-64` | |
| `terminal/create` (+ salida/exit) | request agente→cliente | `acp/fs.rs:76-85`, `:317-395` | env `AGENT_SESSION_ID`, `cwd`, `outputByteLimit` |

Mutaciones fuera del turno (`session/set_model`, `update_provider`, `set_thinking_effort`) no son
métodos propios: se llegan por `session/set_config_option` (`dispatch.rs:182-193`).

### 3.2 Catálogo `_aegis/unstable/*` (118 métodos)

Todos viven en `crates/aegis-sdk-types/src/custom_requests*.rs` (`#[request(method = "…")]`) y su
handler en `acp/server/custom_dispatch.rs`. `:L` = línea del atributo del método.

| grupo | métodos (`:L`) | handler (custom_dispatch.rs) |
|---|---|---|
| sesión | `session/retry:15`, `session/unrewind:38`, `session/working-dir/update:226`, `session/frame-profile/set:251`, `session/system-prompt/set:267`, `session/steer:283`, `session/info:804`, `session/watch:825`, `session/unwatch:858`, `session/conversation/truncate:867`, `session/rewind:883`, `session/project/update:915`, `session/rename:924`, `session/archive:933`, `session/unarchive:941`, `session/export:949`, `session/import:974` | `:33-176`, `:698-752`, `:522-536` |
| extensions | `session/extensions/add:78`, `…/remove:87`, `session/extensions/list:592`, `config/extensions/list:544`, `…/add:562`, `…/remove:572`, `…/set-enabled:581` | `:33-47`, `:243-280` |
| tools / permisos | `tools/list:96`, `tools/call:144`, `tools/permissions/set:2459`, `resources/read:126` | `:49-79` |
| providers | `providers/list:1821`, `config/read:1034`, `config/status:1051`, `config/save:1069`, `config/delete:1081`, `config/authenticate:1092`, `secrets/list:1146`, `secrets/delete:1161`, `catalog/list:1325`, `setup/catalog/list:1343`, `catalog/template:1358`, `custom/{create:1423,read:1444,update:1463,delete:1485}`, `readiness/check:1838`, `supported-models/list:1858`, `inventory/refresh:1876`, `canonical-model-info:1192` | `:282-432` |
| config / prefs | `config/read:623`, `upsert:640`, `remove:651`, `read-all:661`, `preferences/read:605`, `save:614`, `defaults/{read:698,save:711,clear:721}`, `config/prompts/{list:402,get:414,save:431,reset:440}` | `:211-241`, `:434-504` |
| recipes | `recipes/{encode:298,decode:313,scan:327,save:339,parse:355,delete:367,list:374,schedule:384,slash-command:394,to-yaml:406}` | `:538-616` |
| schedules | `schedules/{list:27,create:40,delete:56,update:65,run-now:82,sessions/list:109,pause:125,unpause:134,running-job/kill:145,running-job/inspect:161}` | `:618-696` |
| sources / UX | `sources/{create:1591,list:1618,update:1691,delete:1717,export:1727,import:1746}`, `agent-mentions/list:1652`, `slash-commands/list:1672` | `:754-816` |
| apps | `apps/{list:170,export:185,import:198,delete:212}` | `:81-111` |
| voz | `session/live-voice/{availability:307,start:334,stop:354}`, `dictation/{transcribe:1761,config:1780}`, `dictation/models/{list:2362,download:2388,download/progress:2397,cancel:2425,delete:2433}` | `:178-201`, `:818-872` |
| inferencia local | `local-inference/models/{list:2180,download:2195,download/progress:2216,download/cancel:2234,delete:2245,evict:2256,settings/read:2267,settings/update:2284}`, `local-inference/huggingface/{search:2302,repo/variants:2321}`, `local-inference/chat-templates/builtin/list:2343` | `:874-961` |
| varios | `diagnostics/get:365`, `onboarding/import/{scan:760,apply:779}` | `:203-209`, `:506-520` |

Notificaciones salientes custom (no son `session/update`, van por su propio método):

| método | struct | archivo:línea |
|---|---|---|
| `_aegis/unstable/session/update` | `AegisSessionNotification { sessionId, update }` | `aegis-sdk-types/src/custom_notifications.rs:8-14` |
| `_aegis/unstable/providers/authentication/device-code` | `ProviderDeviceCodeNotification { providerId, userCode, verificationUri, expiresIn }` | `custom_notifications.rs:57-65` |

---

## 4. `session/update`: variantes y serialización

Hay **dos canales** y esto es la trampa principal del protocolo:

1. `session/update` estándar — enum externo `agent_client_protocol::schema::v1::SessionUpdate`,
   serde `#[serde(tag = "sessionUpdate", rename_all = "snake_case")]`
   (`agent-client-protocol-schema-1.9.1/src/v1/client.rs:91-99`). Variantes que Aegis emite hoy
   (conteo por grep en `acp/**.rs`): `agent_message_chunk` (8), `usage_update` (6),
   `tool_call_update` (6), `user_message_chunk` (4), `session_info_update` (4),
   `config_option_update` (3), `agent_thought_chunk` (3), `tool_call` (2), `current_mode_update` (2),
   `available_commands_update` (1). `plan` **no** se emite (0 usos) y `unstable_plan_operations`
   tampoco se compila.
2. `_aegis/unstable/session/update` — canal paralelo con `AegisSessionUpdate`, tag
   `sessionUpdate` en snake_case (`custom_notifications.rs:22-38`):
   `usage_update`, `status_message`, `message_usage`, `live_voice_interaction_ended`.
   Sólo se envía si el cliente anunció `_meta.aegis.customNotifications`
   (`server.rs:2315-2317`, `dispatch.rs:60`).

Campos del `usage_update` de Aegis (`custom_notifications.rs:74-112`), que es el que alimenta el
medidor de contexto de la UI: `used`, `contextLimit`, `accumulatedInputTokens`,
`accumulatedOutputTokens`, `accumulatedCost?`, `contextBreakdown[]` (`label`, `tokens`, `count`,
`detail?`), `autoCompactAt`, `autoCompactPct`, `compactionCalls`, `compactionInputTokens`,
`compactionOutputTokens`, `modelUsage[]` (`provider`, `model`, `calls`, `inputTokens`,
`outputTokens`), `compactionLog[]` (`at`, `beforeTokens`, `afterTokens`, `trigger`, `note?`).

`message_usage` (`:157-195`) lleva `messageId` + `usage{inputTokens, outputTokens, totalTokens,
cacheReadTokens, cacheWriteTokens, cost, costSource, elapsedMs, generationMs, timeToFirstTokenMs,
isCompaction}`; `costSource ∈ {provider_reported, estimated}`.

`status_message` (`:209-222`): `{ "type": "notice"|"progress", "message": "…" }`.

Serialización verificada por los tests del propio crate (`custom_notifications.rs:258-358`): el
`session_update` va en `camelCase` dentro del objeto, con el tag en snake_case.

Fan-out multi-conexión: `acp/server/hub.rs:1-45` — el transporte ACP no tiene fan-out (un buzón, un
suscriptor), así que `session/watch` registra la conexión como watcher de una sesión y recibe el
mismo stream, con ring buffer por sesión de **500 eventos / 2 MB**, `replay_gap` cuando el ring
descartó, y TTL de 600 s para sesiones sin watchers ni run activo.

---

## 5. Ciclo de vida del proceso

### Arranque

1. `core/ops/aegis-serve-launch.vbs` lee `core\state\current-version.json`, resuelve `exe`, y si ya
   hay un proceso `aegis-v%.exe` **no hace nada** (`WScript.Quit 0`). Si no, lanza en ventana oculta
   con la línea:
   `--host 0.0.0.0 --port 3284 --platform desktop --enable-scheduler --with-builtin developer`
   `--allowed-origin http://192.168.100.34:3788 … https://edinburgh-birth-detection-east.trycloudflare.com`.
2. `main()` → sin argumentos imprime ayuda y no escucha (`main.rs:361-365`) — protege al serve vivo.
3. `init_logging` → `register_builtin_extensions` (feature `bundled-mcp`, `main.rs:443-444`) →
   `serve()`.
4. `serve()`: `AcpServer::new` → valida secreto → `start_scheduler()` (falla sin abortar:
   `warn!` en `main.rs:269-271`) → `create_router` → bind TLS o TCP.

### Configuración

- No hay `--config`: la ruta sale de `Paths::config_dir()` (`main.rs:231`), gobernada por
  `AEGIS_PATH_ROOT`. `--print-paths` es la forma de no adivinar.
- Overrides por variables: `AEGIS_SERVER__SECRET_KEY` (auth), `AEGIS_TLS`, `AEGIS_TLS_CERT_PATH`,
  `AEGIS_TLS_KEY_PATH`, `AEGIS_LOG_CONSOLE`, `AEGIS_MAX_ACTIVE_AGENTS` (default 100,
  `server_factory.rs:151-153`), `ADDITIONAL_AGENT_SOURCE_ROOTS` (`main.rs:217-227`).
- Extensions built-in: `--with-builtin developer` → `AcpBuiltinSelection::from_requested`
  (`main.rs:215`); por defecto `developer` si el cliente no manda selección (tests
  `server.rs:3593-3605`).

### Si el proceso muere

- **`web/server.mjs` no lanza el binario**: es cliente. Conecta a `ws://<host>:3284/acp?token=…`
  (`server.mjs:495`), y expone un proxy WS inverso en `/acp` (`proxyAcp`, `server.mjs:525-570`).
  Si el upstream no responde, el proxy devuelve `502 Bad Gateway` (`server.mjs:562-570`).
- `server.mjs` sólo *invoca* el binario para tareas puntuales: `--sweep-pending` al arrancar
  (`:66-80`) y `--memory-consolidate` (`:1345-1356`), con `AEGIS_SERVE_BIN` como override.
- El watchdog real es `core/ops/selfheal.ps1`: `Get-PortOwner 3284` (`:301`), `Stop-Port 3284`
  (`:430`), `Wait-Port 3284 90` (`:433`), y delega la decisión en `core/ops/health-gate.ps1`
  (`:281`), que escribe `health.json` en `core/state`.
- Consecuencia: mientras el serve está caído, la UI queda con WS rechazado/502; la reconexión la
  hace el cliente ACP, no el servidor.

### Concurrencia

| nivel | qué se comparte |
|---|---|
| proceso | `SessionManager` (un pool SQLite), `AgentManager` (LRU de agentes, tope 100), `ActiveRunRegistry`, `SessionHub`, `LiveVoiceService`, scheduler (`server_factory.rs:34-43`, `:130-159`) |
| conexión | un `AegisAcpAgent` nuevo por conexión (`transport/mod.rs:189`, `server.rs:3353`), con su propio `client_cx`, capacidades del cliente y mapa `sessions` |
| sesión | un mismo `session_id` puede tener varias conexiones: los runs se resuelven por `active_runs` y el stream se comparte por el hub (`hub.rs:1-13`; tests `server_factory.rs:257-308`) |

Dentro de una conexión, cada request se atiende en su propia tarea (`cx.spawn`) salvo `initialize`.

---

## 6. Flags del binario (hoy)

| flag | tipo/default | efecto | ref |
|---|---|---|---|
| `--host` | `127.0.0.1` | bind | `main.rs:51` |
| `--port` | `3284` | bind | `main.rs:54` |
| `--tls` | flag | fuerza TLS (autofirmado si no hay paths) | `main.rs:57`, `:287` |
| `--tls-cert-path` / `--tls-key-path` | PATH | PEM; deben ir juntos | `main.rs:60-64`, `tls.rs:84` |
| `--platform` | `cli`\|`desktop`, default `cli` | `AegisPlatform` que ve el agente | `main.rs:66`, `:33-40` |
| `--with-builtin` | repetible, separado por coma | built-ins a cargar | `main.rs:69-76` |
| `--dangerously-unauthenticated` | flag | arranca sin exigir `AEGIS_SERVER__SECRET_KEY` | `main.rs:78-82` |
| `--allowed-origin` | repetible | allowlist exacta de Origin; **reemplaza** el default loopback | `main.rs:84-90` |
| `--enable-scheduler` | flag | scheduler de recetas (feature `scheduler`) | `main.rs:92-93` |
| `--print-paths` | flag | imprime store resuelto y sale | `main.rs:95-99`, `:163` |
| `--stdio` | flag | ACP por stdin/stdout | `main.rs:101-105`, `:374` |
| `--list-skills` | flag | tabula skills instaladas y sale | `main.rs:107-111`, `:181` |
| `--memory-consolidate` | flag | consolida memoria y sale | `main.rs:113-117`, `:403` |
| `--sweep-pending` | flag | cierra confirmaciones huérfanas y sale | `main.rs:119-123`, `:383` |
| `--list-sessions N` | N | N sesiones más recientes y sale | `main.rs:125-130`, `:192` |
| `--run-recipe PATH` | PATH | receta headless en proceso | `main.rs:132-137`, `:425` |
| `--text` | TEXT | prompt inicial de la receta | `main.rs:139-144` |
| `--recipe-cwd DIR` | DIR (absoluto) | cwd de la receta | `main.rs:146-151`, `:430` |

No existe `--config`, ni `--no-session` en este binario (ver *No verificado* y §8).

---

## 7. Invariantes y trampas

1. **`initialize` es inline por diseño**: si se pipelinea `session/new` detrás, las capacidades del
   cliente (fs/terminal) todavía no están puestas (`dispatch.rs:27-29`).
2. **Capacidades del cliente = `OnceCell`**: una segunda `initialize` en la misma conexión no cambia
   nada (`server.rs:2305-2333`).
3. **`session/new` responde antes de las notificaciones de setup** (`dispatch.rs:51-68`): un cliente
   que sólo espere la respuesta no ve `usage_update` inicial.
4. **`session/cancel` es notification**, no request: no hay respuesta ni confirmación
   (`dispatch.rs:143-148`, `server.rs:3063-3081`).
5. **Las notificaciones desconocidas se descartan en silencio** (`dispatch.rs:500-503`); los requests
   desconocidos caen en el catálogo custom y, si tampoco están, devuelven `-32601`
   (`aegis-acp-macros/src/lib.rs:213`).
6. **El lease del prompt viaja con la corrida, no con la respuesta**: si el futuro de la respuesta se
   dropea, la corrida no se abandona (`server.rs:2801-2808`, test `:3485`).
7. **Idempotencia de `session/prompt`** por `_meta.promptId` + hash blake3 del prompt
   (`server.rs:2784-2794`): mismo id ⇒ mismo resultado, no doble turno.
8. **`--allowed-origin` es aditivo sólo en apariencia**: al pasar uno, la política deja de aceptar
   loopback (`mod.rs:231-237`). Si falta `http://127.0.0.1:3788`, la UI local deja de poder abrir WS.
9. **El Origin se reescribe** para el crate upstream (`mod.rs:142-145`); cualquier lógica que dependa
   del Origin real (rate limit, auditoría) ve `http://aegis.local`.
10. **`--dangerously-unauthenticated` no neutraliza un secreto ya exportado** (`main.rs:242`).
11. **`/acp` no tiene health propio** (`mod.rs:106`); el 200 sale de `/health` (`:242`).
12. **`AegisAcpAgent` es por conexión, `AgentManager` por proceso**: dos conexiones a la misma sesión
    comparten `Arc<Agent>` (`server_factory.rs:41-43`), pero cada una tiene su propio mapa `sessions`.
13. **El orden de las capas** en `create_acp_router_with_policy` es auth dentro, CORS fuera
    (`mod.rs:203-210`): un preflight no pasa por el token.
14. **`session_id` ES el thread id** (`server.rs:2832`): cualquier tabla que use thread id ve lo mismo.
15. **`--with-builtin` sin valor de selección del cliente no desactiva nada**: si el cliente manda
    selección, ésa reemplaza a los built-ins (`server.rs:3694-3731`).
16. **`aegis-acp-macros` exige `Default` en el request type** para generar el schema
    (`lib.rs:191`): un tipo sin `Default` rompe el build del dispatcher.

---

## 8. Local vs GitHub

Verificado con `gh api` (2026-10-29):

| pieza | upstream `block/goose` | origen |
|---|---|---|
| `crates/aegis-server` (binario `aegis-serve`) | **no existe** (`crates/` no tiene `goose-server`) | **solo local**; el serve vivía dentro de `goose-cli` y se separó acá el 2026-10-20 |
| `crates/aegis-acp-macros` (293 l.) | existe como `crates/goose-acp-macros` | espejo de upstream, de-brandeado |
| `crates/aegis-sdk-types` (custom_requests 2259 l. + recipe 377 + schedule 159 + notify 333) | existe como `crates/goose-sdk-types` | espejo de upstream |
| `crates/aegis/src/acp/**` | existe `crates/goose/src/acp/` con el mismo set: `common.rs`, `handoff.rs`, `mcp_app_proxy.rs`, `mod.rs`, `provider.rs`, `response_builder.rs`, `server.rs`, `server/`, `server_factory.rs`, `templates/`, `tool_call_notifier.rs`, `transport/` | **base upstream + parches locales** |
| `acp/fs.rs`, `acp/tools.rs` | **no aparecen** en el listado de `crates/goose/src/acp/` | **solo local** |
| crates `aegis-*` en general | `origin/main` sólo tiene `goose-*` (`git ls-tree origin/main crates/`) | todo el árbol local está **fuera de `origin/main`** |

| dependencia | versión fijada | upstream ACP (tags) | estado |
|---|---|---|---|
| `agent-client-protocol` | `2.2.0` (`Cargo.toml:24`) | — | — |
| `agent-client-protocol-http` | `2.2.0` (`Cargo.toml:25`) | — | — |
| `agent-client-protocol-schema` | `=1.9.1` (`Cargo.toml:23`) | `v1.13.0` es el tag más nuevo (2026-10-29) | **atrasado 4 minors** |

Notas de historia local (`git log`): `a31556903` (`--sweep-pending`), `0d36c6f5b` (`AEGIS_LOG_CONSOLE`),
`a7413d4a4` (borrado de la feature `code-mode`), `8d559d0b5` (autonomía como único modo).

---

## 9. Referencias web

- Overview del protocolo (flujo initialize → session → prompt): https://agentclientprotocol.com/protocol/overview
- Schema v1 documentado: https://agentclientprotocol.com/protocol/schema
- Repo del protocolo (Zed Industries redirige a la org): https://github.com/agentclientprotocol/agent-client-protocol
  - schema v1: https://github.com/agentclientprotocol/agent-client-protocol/tree/main/schema/v1
  - schema v2 (draft): https://github.com/agentclientprotocol/agent-client-protocol/tree/main/schema/v2
- Transports: https://agentclientprotocol.com/protocol/transports
- Crates usados por Aegis:
  - https://crates.io/crates/agent-client-protocol/2.2.0
  - https://crates.io/crates/agent-client-protocol-http/2.2.0
  - https://crates.io/crates/agent-client-protocol-schema/1.9.1
- Upstream goose (crates): https://github.com/block/goose/tree/main/crates

---

## 10. Huecos, riesgos y deuda técnica

| # | hueco / riesgo | evidencia |
|---|---|---|
| 1 | **Schema ACP congelado en 1.9.1** mientras el protocolo va por 1.13.0: las variantes nuevas (`Notice`, `CompactionUpdate`, `PlanUpdate`, updates v2) no existen en el binario | `Cargo.toml:23` vs tags del repo |
| 2 | **`plan` nunca se emite**: la UI no puede pintar el plan del agente aunque el schema lo tenga | 0 usos de `SessionUpdate::Plan` en `acp/**` |
| 3 | **Dos canales de `session/update`** (estándar y `_aegis/unstable/session/update`): un cliente que no anuncie `customNotifications` pierde `status_message`, `message_usage`, `compactionLog` y el desglose de contexto | `custom_notifications.rs:8-14`, `server.rs:2315` |
| 4 | **`usage_update` duplicado**: existe el del schema y el de Aegis con campos distintos; confundirlos da medidores vacíos | `custom_notifications.rs:34` vs `v1/client.rs` `UsageUpdate` |
| 5 | **Dispatch de 117 métodos por comparación lineal de strings** (`matches_method` arm por arm) en cada request custom | `custom_dispatch.rs:33-961`, `lib.rs:113` |
| 6 | **Superficie custom sin versionar de verdad**: todo es `_aegis/unstable/*` y nada valida compatibilidad con la UI | `custom_requests.rs` |
| 7 | **`--allowed-origin` pisa el default loopback**: un flag de más deja fuera a la UI local sin error visible (sólo 403 en el upgrade) | `mod.rs:231-237` |
| 8 | **El proxy WS de la web no reintenta el upstream**: si el serve está caído, 502 hasta que el cliente reconecte | `server.mjs:525-570` |
| 9 | **`server.rs` con 4.7k líneas** y 24 submódulos en `acp/server/`: cualquier cambio de protocolo toca un archivo enorme | `acp/server.rs` |
| 10 | **Backups `.bak` dentro de `crates/`**: `acp/server.rs.bak-local-titles` (4306 l.) y `tool_calls/enrichment.rs.bak-local-titles` | listado de archivos |
| 11 | **`authenticate` es no-op**: el agente anuncia `aegis-provider` como método de auth pero no valida nada; la auth real es el token de transporte | `dispatch.rs:37-41` vs `auth.rs` |
| 12 | **Secret efímero con `--dangerously-unauthenticated` sin env**: se genera uno aleatorio que nadie conoce y `require_token` queda en `false`, así que el endpoint acepta cualquiera | `main.rs:242-252`, `:268` |

---

## No verificado

- No se abrió un WebSocket real contra `3284` ni se completó un handshake `initialize`/`session/new`
  en vivo: sólo se comprobó `GET /health` = `ok` y la línea de comandos del proceso PID 14468.
- No se enumeró el contenido de `crates/goose/src/acp/server/` ni `transport/` en upstream, así que la
  comparación archivo-por-archivo con el original de goose es **por nombre de archivo**, no por diff.
- No se ejecutó `cargo build`, `clippy` ni tests: todas las afirmaciones salen de lectura de código y
  de los tests ya presentes en los archivos.
- No se inspeccionó `ui/aegis-acp-client` ni `ui/desktop`: el extremo cliente se describe sólo por lo
  que exige el servidor y por lo que hace `web/server.mjs`.
- No se verificó qué `protocolVersion` envían los clientes reales (el servidor responde `LATEST` = 1).
- No existe `--no-session` en `aegis-serve`: si existe en otro binario del workspace, no se buscó acá.

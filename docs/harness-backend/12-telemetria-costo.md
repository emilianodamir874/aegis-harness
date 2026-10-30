# 12 — Telemetría, logging, costo y observabilidad

Alcance: qué se registra, dónde, con qué campos, cómo se calcula el costo, qué exporta (o no) el
tracing y qué preguntas **no** responde hoy la telemetría del harness.
Verificado el 2026-10-29 sobre el árbol vivo `C:\Aegis-Proyects\src` (rama `feat/antigravity-provider`,
HEAD `8d559d0b5`), el store `state\data\sessions\sessions.db` (46.605 filas de `usage_ledger`) y los
logs vivos `state\state\logs` (no `state\data\logs`, que está congelado).

---

## 1. Mapa de piezas

### 1.1 Subscriber de `tracing` (logs estructurados a archivo)

| archivo:línea | qué hace | quién la llama |
|---|---|---|
| `crates/aegis/src/logging.rs:52-107` | `build_logging_subscriber`: arma `Registry` con layer de archivo (texto o JSON), layer de consola opcional, layer OTLP (bajo `#[cfg(feature="otel")]`) y layer Langfuse si hay credenciales | `crates/aegis-server/src/main.rs:338-355` (`init_logging`) |
| `logging.rs:30-46` | `build_env_filter`: si `RUST_LOG` existe se usa tal cual; si no, default `mcp_client=info`, `aegis=info`, resto `WARN` | `logging.rs:65` |
| `logging.rs:56-63` | nombre de archivo `<YYYYMMDD_HHMMSS>[-name].log` con `Rotation::NEVER` (un archivo por arranque de proceso) | `build_logging_subscriber` |
| `logging.rs:116-133` | `prepare_log_directory`: `Paths::in_state_dir("logs")/<component>/<YYYY-MM-DD>` | `logging.rs:55` |
| `logging.rs:135-159` | `cleanup_old_logs`: borra **subdirectorios** con `mtime` > 14 días; **no toca archivos sueltos** | `prepare_log_directory` (`logging.rs:119`) |
| `logging.rs:97-100` | `layers.extend(otel::otlp::init_otlp_layers(...))`, compilado **sólo** con `feature = "otel"` | — |
| `logging.rs:102-104` | layer Langfuse con filtro `DEBUG`, sólo si `create_langfuse_observer()` devuelve algo | — |
| `crates/aegis-server/Cargo.toml:18-25` | features default del binario: `rustls-tls, scheduler, bundled-mcp, chat-recall, acp-http` | `core/ops/build.ps1:10` con las mismas |
| `crates/aegis/Cargo.toml:14-21,90-99` | `otel` es feature opcional; sólo la mete el paraguas `portable-default` | nadie en el build vivo |

### 1.2 Registro de requests LLM (`llm_request.*.jsonl`)

| archivo:línea | qué hace | quién la llama |
|---|---|---|
| `crates/aegis/src/providers/utils.rs:50` | `LOGS_TO_KEEP = 10` | — |
| `utils.rs:54-60` | `init_aegis_request_log`: instala el logger global una sola vez (`OnceLock`) | `aegis-server/src/main.rs:341` |
| `utils.rs:80-115` | `RequestLog::start`: crea `logs\llm_request.<uuid>.jsonl` (temporal). Si no puede abrir, **avisa y sigue sin log** | trait `RequestLogger` |
| `utils.rs:117-135` | `FileLogHandle::write`: `writeln!`; ante error desactiva el log de ese request y devuelve `Ok` | trait `RequestLogHandle` |
| `utils.rs:137-157` | `finish`: flush → `rename(llm_request.i → llm_request.i+1)` para `i = 8..0` → `rename(temp → llm_request.0.jsonl)`; si `logs_to_keep == 0` borra el temporal | `Drop` |
| `utils.rs:159-172` | `Drop`: llama `finish` salvo que el hilo esté en pánico | fin del request |
| `crates/aegis-provider-types/src/request_log.rs:66-88` | `start_log`: escribe **la primera línea** `{"model_config":…,"input":…}` | cada provider |
| `request_log.rs:90-133` | `LoggerHandleExt::write` → línea `{"data":…,"usage":…}`; `error` → `{"error":"…"}` | cada provider |
| `crates/aegis-providers/src/openai_compatible.rs:110` | `let mut log = start_log(model_config, &payload)?` | `stream_payload` |
| `openai_compatible.rs:142-145` | log del camino no-stream, con `usage` | idem |
| `openai_compatible.rs:255` y `:279` | log **por cada mensaje emitido** del stream | `stream_openai_compat` |

Providers que instrumentan el log (importan `start_log` / `LoggerHandleExt`): en `crates/aegis/src/providers/`
→ `antigravity.rs:8`, `bedrock.rs:16`, `codex.rs:25`, `cursor_agent.rs:22`, `experiential.rs:17`,
`gcpvertexai.rs:34`, `gemini_oauth.rs:13`, `githubcopilot.rs:45`, `kimicode.rs:33`, `litellm.rs:24`,
`nanogpt.rs:10`, `opencode_go.rs:10`, `open_design.rs:10`, `sagemaker_tgi.rs:21`, `tetrate.rs:18`;
en `crates/aegis-providers/src/` → `anthropic.rs:5`, `databricks.rs:30`, `databricks_v2.rs:31`,
`google.rs:11`, `ollama.rs:13`, `openai.rs:26`, `openai_compatible.rs:28`, `openrouter.rs:21`, `snowflake.rs:18`.

### 1.3 Contabilidad de uso y costo (persistencia)

| archivo:línea | qué hace | quién la llama |
|---|---|---|
| `crates/aegis/src/agents/state_machine/usage.rs:24-48` | `enrich`: por cada `RecordUsage`/`CompactConversation` calcula `(cost, cost_source)` y lo pega al último mensaje assistant | state machine |
| `usage.rs:50-68` | `record`: arma `MessageUsage` y llama `record_usage_metrics` | state machine |
| `usage.rs:70-73` | `estimate_context`: `count_context_tokens` → `Usage` **sólo para el contexto**, no entra al ledger | context mgmt |
| `crates/aegis/src/providers/canonical_cost.rs:45-56` | `resolve_usage_cost`: costo del proveedor si viene, si no estimación por catálogo | `usage.rs:33` |
| `canonical_cost.rs:60-91` | `resolve_pricing`: precedencia custom-file → bundled → catálogo canónico, con relleno de huecos (`is_price_gap`) | `estimate_model_cost` |
| `crates/aegis-provider-types/src/canonical/model.rs:91-125` | `Pricing::estimate_cost`: por tier, tarifa de `cache_read`/`cache_write` con fallback a `input`, resto = input sin cache | `estimate_model_cost` |
| `crates/aegis-provider-types/src/conversation/token_usage.rs:92-101` | `Usage { input_tokens, output_tokens, total_tokens, cache_read_input_tokens, cache_write_input_tokens }` (`input_tokens` **incluye** el cache) | todos |
| `crates/aegis-provider-types/src/conversation/message.rs:777-825` | `MessageUsage` (mismos campos + `cost`, `cost_source`, `elapsed_ms`, `generation_ms`, `time_to_first_token_ms`, `is_compaction`) | `usage.rs:56` |
| `crates/aegis/src/session/session_manager.rs:650-670` | `pub record_usage_metrics` (wrapper) | agent loops |
| `session_manager.rs:2917-3010` | `record_usage_metrics`: (a) fila `carried_forward` si `sessions.accumulated_*` supera la suma del ledger, (b) `UPDATE sessions … accumulated_*`, (c) `insert_usage_ledger_row` | `usage.rs:58`, `memory/extraction.rs:238` |
| `session_manager.rs:1170-1207` | `insert_usage_ledger_row`: `INSERT … values(?, strftime('%s','now'), …)`; mapea `CostSource` a `'provider_reported'|'estimated'` | idem |
| `session_manager.rs:1366-1386` | `CREATE TABLE usage_ledger (id, session_id, created_timestamp, model, provider, input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens, cost, cost_source, is_compaction)` | migración |
| `session_manager.rs:1413-1417` | índice `idx_usage_ledger_session` (sólo por `session_id`: **no hay índice por timestamp**) | migración |
| `session_manager.rs:3012-3050` | `get_session_usage_totals`: suma el árbol de subagentes (`parent_session_id`) | UI / ACP |

### 1.4 OTLP y Langfuse (export)

| archivo:línea | qué hace |
|---|---|
| `crates/aegis/src/otel/otlp.rs:227-259` | `signal_exporter(signal)`: `OTEL_SDK_DISABLED` apaga todo; `OTEL_{SIGNAL}_EXPORTER` (`none` apaga, `otlp`/`console`); si no, hay OTLP cuando existe `OTEL_EXPORTER_OTLP_{SIGNAL}_ENDPOINT` u `OTEL_EXPORTER_OTLP_ENDPOINT` |
| `otlp.rs:205-221` | `signal_protocol_is_http`: sólo `http/protobuf`; con `grpc` avisa una vez y desactiva |
| `otlp.rs:261-272` | `promote_config_to_env`: copia `otel_exporter_otlp_endpoint` / `otel_exporter_otlp_timeout` de `config.yaml` a env si no están |
| `otlp.rs:300+` | `init_otlp_layers` (traces/metrics/logs); cada exporter corre en un runtime tokio propio (`otlp.rs:48-68`) |
| `otlp.rs:462`, `:581-620` | `is_otlp_initialized`, `shutdown_otlp` (timeout `otel_shutdown_timeout_ms`) |
| `crates/aegis/src/tracing/langfuse_layer.rs:155-175` | `create_langfuse_observer`: exige `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` (o `LANGFUSE_INIT_PROJECT_*`); URL de `LANGFUSE_URL`/`LANGFUSE_BASE_URL`/`LANGFUSE_HOST`, default `http://localhost:3000` (`:13`); batch de 5 s (`:58-59`) |
| `crates/aegis/src/tracing/observation_layer.rs:15-23,65-95` | `SpanData`, `SpanTracker` (span u64 → observation UUID) para mapear spans de `tracing` a observaciones Langfuse |
| `crates/aegis/src/instance_id.rs:9-13` | `instance_id` persistido en `<state>/instance_id` (UUID v4, estable entre reinicios) |

### 1.5 Spans instrumentados

| punto | nombre / campos |
|---|---|
| `crates/aegis/src/agents/agent.rs:1069-1090` | `#[instrument]` con `gen_ai.operation.name = "invoke_agent"`, `session.id`, `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.usage.input_tokens`, `trace_input`/`trace_output`; el stream se envuelve en `reply_span` (`agent.rs:1050`, `:1104`) |
| `crates/aegis/src/agents/reply_parts.rs:240-252` | span con `gen_ai.operation.name = "chat"`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.request.stream`, `gen_ai.conversation.id` |
| `crates/aegis/src/hooks/mod.rs:488-495` | span `execute_hook` con `gen_ai.operation.name = "execute_hook"`, `aegis.hook.event`, `aegis.hook.plugin`, `error.type` |
| `crates/aegis/src/agents/gen_ai_telemetry.rs` | helpers que rellenan atributos `gen_ai.*`; el contenido de mensajes/argumentos sólo se registra con `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` (`gen_ai_telemetry.rs:11-16`) |

### 1.6 Herramientas de análisis (fuera del binario)

| archivo | qué hace |
|---|---|
| `web/tools/audit-costs.py` | auditoría read-only del `usage_ledger`; ventana por `created_timestamp`; `prices.json` se carga **sólo** para recordar que no sustituye el costo registrado (`audit-costs.py:18-24`); atribuye proveedor por `messages.metadata_json` cuando el ledger viejo no lo trae (`:26-40`) |
| `web/tools/test_audit_costs.py` | tests del anterior |
| `web/tools/analyze-sessions.py`, `analyze-speed.py`, `tps-usage.mjs`, `load-cost.mjs`, `gasto-check.mjs` | análisis puntuales sobre el store (sesiones, velocidad, TPS, gasto) |
| `web/tools/_llmreq.ps1`, `_recent_logs.ps1`, `_glogs.ps1`, `_timeline.ps1` | sondas de los `.jsonl` vivos |
| `core/ops/audit-cuadre.ps1`, `audit-detalle.ps1` | cruce ledger vs acumulados de sesión |
| `core/ops/prune-logs.ps1:11-13` | retención 14 días / 200 MB por carpeta; raíces `core\logs`, `web\logs` y `%APPDATA%\Aegis\aegis\data\logs` (**no** `state\state\logs`) |
| `core/ops/measure-harness-latency.ps1`, `measure-latency.ps1`, `medicion-turno.yaml` | medición de latencia externa (por reloj, no por span) |
| `web/prices.json` | tarifas **derivadas** de una muestra de 2026-10-14, con `inputEffective`, `basedOn.calls`, `fitReliable`; el propio archivo aclara que no es precio contractual y que `null` es "no informado", no gratis |

---

## 2. Flujos paso a paso, con campos exactos

### 2.1 Un request LLM → una línea de cabecera + N líneas de stream

1. El provider entra a `stream_payload` y llama `start_log(model_config, &payload)`
   (`openai_compatible.rs:110`). `start_log` pide un handle al logger global
   (`request_log.rs:74-80`) y escribe la **línea 0**:

   ```json
   {"model_config":{"model_name":"deepseek-v4.1-flash","temperature":null,"max_tokens":384000,
    "toolshim":false,"toolshim_model":null,"request_params":{"thinking_effort":"max"},
    "reasoning":true,"supports_vision":false},
    "input":{"model":"deepseek-v4.1-flash","messages":[...],"tools":[...]}}
   ```

   Es el cuerpo HTTP completo: system prompt, historial, esquemas de tools.

2. Cada mensaje que el stream emite se escribe como una línea propia
   (`openai_compatible.rs:255`, `:279`):

   ```json
   {"data":{"id":"gw-…","role":"assistant","created":1793288776,
    "content":[{"type":"thinking","thinking":"…","signature":""}],
    "metadata":{"userVisible":true,"agentVisible":true}},
    "usage":null}
   ```

   Las líneas intermedias llevan `"usage": null`; la última trae el uso real:

   ```json
   {"data":{…},"usage":{"input_tokens":49058,"output_tokens":256,"total_tokens":49314,
    "cache_read_input_tokens":45312,"cache_write_input_tokens":null}}
   ```

3. Si el request falla: `log.error(e)` → línea `{"error":"…"}` (`openai_compatible.rs:126`).

4. Al soltarse el handle, `finish` (`utils.rs:137-157`) flushea y rota:
   `llm_request.8→9 … 0→1`, `temp→llm_request.0.jsonl`. Es **rotación por cantidad de requests
   terminados**, no por tamaño ni por tiempo: quedan 10 archivos.

Medición real (2026-10-29 12:46):
`state\state\logs` = 29 archivos, 8,9 MB: 10 numerados (`llm_request.0..9.jsonl`, 134 KB – 312 KB
cada uno, 11–32 líneas) + 19 con nombre UUID (14 vacíos; 5 con datos de 78 KB a 2,4 MB, el más viejo
del 20/10).

### 2.2 De `ProviderUsage` a una fila del ledger

1. El provider parsea `usage` del JSON y lo envuelve en `ProviderUsage` (`token_usage.rs:7-24`).
   Para Anthropic/Bedrock usa `Usage::from_cache_exclusive_input` (`token_usage.rs:178-194`) para
   plegar cache dentro de `input_tokens`.
2. `state_machine/usage.rs:33` → `resolve_usage_cost(provider, &usage)`:
   - si `usage.cost` viene del proveedor → `(Some(cost), ProviderReported)`;
   - si no → `estimate_model_cost(provider, model, usage)` → `(Some(cost), Estimated)`;
   - si no hay tarifa → `(None, None)`.
3. `usage.rs:56` → `MessageUsage::from_provider_usage` copia tokens, `cost`, `cost_source`,
   `elapsed_ms`, `time_to_first_token_ms` y `generation_ms` (este último desde
   `additional_data["generation_ms"]`, `message.rs:816-820`).
4. `record_usage_metrics` (`session_manager.rs:2917`) en una transacción `BEGIN IMMEDIATE`:
   - fila `cost_source = 'carried_forward'` con la diferencia entre `sessions.accumulated_*` y la
     suma del ledger (`:2931-2968`) — red de seguridad para sesiones escritas antes de que existiera
     el ledger;
   - `UPDATE sessions SET total_tokens=…, accumulated_cost = accumulated_cost + ?` (`:2970-3004`);
   - `INSERT INTO usage_ledger` (`:3006`).

La columna `cost` que se suma en cualquier informe es **la que quedó escrita en ese momento**; no se
recalcula si cambia el catálogo de precios.

### 2.3 Cálculo del precio

`Pricing::estimate_cost` (`canonical/model.rs:91-125`), tarifas en USD por millón:

```
costo = (input_sin_cache × P_input
       + cache_read × P_cache_read
       + cache_write × P_cache_write
       + output × P_output) / 1_000_000
```

- `input_sin_cache = max(input_tokens − cache_read − cache_write, 0)` (`:115-116`).
- Si el modelo declara tiers y `input_tokens > above_input_tokens`, el tier reemplaza **toda** la
  tarifa (`:96-110`).
- `cache_read`/`cache_write` sin tarifa propia caen a `P_input`.
- Falta `input_tokens` o `output_tokens` → `None` (no se inventa el número, `:94-102`).
- Un precio 0 o ausente cuenta como hueco y se rellena desde el bundled (`canonical_cost.rs:71-83`).

Precedencia completa (`canonical_cost.rs:1-22` y `:60-91`):
1. costo reportado por el proveedor (fuera de este módulo);
2. tarifas del archivo de proveedor custom del usuario (lectura viva, sin reinicio);
3. registro canónico empaquetado (`canonical/data/canonical_models.json`, 5,6 MB);
4. definiciones declarativas empaquetadas, sólo para rellenar huecos.
Moneda no USD sin tipo de cambio → no se estima (`canonical_cost.rs:62-68`).

### 2.4 Estado observado del ledger (2026-10-29)

| métrica | valor |
|---|---|
| filas | 46.605 |
| rango | 2026-10-10 16:15 → 2026-10-29 15:48 UTC |
| `cost_source='estimated'` | 44.176 filas, USD 2.242,19 |
| `cost_source='provider_reported'` | 2.022 filas, USD 1,53 |
| `cost_source IS NULL` (sin tarifa) | 406 filas |
| `cost_source='carried_forward'` | 1 fila |
| `cost IS NULL` | 407 |
| `provider IS NULL` | 20 |
| `is_compaction=1` | 60 |

Lectura: el 94,8 % del gasto registrado es **estimación**, no cifra del proveedor. Los 407 requests
sin costo son el agujero conocido: hubs/gateways que no reportan `usage` y modelos sin tarifa en el
catálogo.

---

## 3. Invariantes y trampas

1. **`llm_request` no se poda.** `cleanup_old_logs` sólo borra directorios (`logging.rs:151`), y
   `prune-logs.ps1` no incluye `state\state\logs` (`prune-logs.ps1:11-13`). La única cota son los
   10 archivos numerados; los temporales UUID quedan para siempre (19 hoy, hasta 2,4 MB).
2. **Un temporal huérfano = un request que no rotó.** Si el hilo paniquea, `Drop` no llama `finish`
   (`utils.rs:160-163`) y el `.uuid.jsonl` se queda con datos.
3. **La rotación no tiene lock.** Varios procesos (serve + subagentes) renombran
   `llm_request.i → i+1` a la vez; dos `finish` concurrentes pueden pisarse. La prueba de concurrencia
   son los 19 temporales simultáneos, no un test.
4. **El log de request jamás rompe un turno.** Abrir o escribir falla → `tracing::warn!` y el request
   sigue (`utils.rs:88-107`, `:117-134`). Hay test: `utils.rs:178-200`.
5. **No hay redacción de secretos.** Cero coincidencias de `redact|secret|api_key|mask` en
   `request_log.rs`, `providers/utils.rs` y `openai_compatible.rs`. Las credenciales van en headers
   (`api_client.model_headers`, `openai_compatible.rs:117`), no en el body, así que no aterrizan en el
   `.jsonl`; **pero sí todo el contenido de la conversación, el system prompt y los esquemas de tools**.
   Los `.jsonl` son material sensible a mano.
6. **`input_tokens` incluye cache** (`token_usage.rs:88-95`). Sumar `input + cache_read` duplica.
7. **Costo grabado, no recalculado.** Cambiar tarifas no reescribe filas viejas. `prices.json` **no**
   participa del cálculo del harness: es un derivado de muestra con `inputEffective`, y el propio
   audit lo dice (`audit-costs.py:18-24`).
8. **`usage` del stream puede ser `null` en todas las líneas menos la última**; parsear sólo la línea 0
   o las primeras da cero tokens.
9. **`carried_forward` infla a propósito**: existe para sesiones cuyo acumulado en `sessions` no
   cuadra con el ledger. Filtrar por `cost_source != 'carried_forward'` cuando se audita por modelo:
   esas filas no tienen `model` ni `provider` (`session_manager.rs:5701-5712`).
10. **El ledger no tiene columna de duración** (`session_manager.rs:1368-1382`): `elapsed_ms` y
    `time_to_first_token_ms` existen en `MessageUsage` (`message.rs:795-799`) pero
    `insert_usage_ledger_row` no los escribe.

---

## 4. Niveles de log y destino

| aspecto | valor | evidencia |
|---|---|---|
| variable de filtro | `RUST_LOG` manda; hoy **no está definida** en el entorno del usuario | `logging.rs:31-33`; `[Environment]::GetEnvironmentVariable('RUST_LOG','User')` = vacío |
| default sin `RUST_LOG` | `mcp_client=info`, `aegis=info`, global `WARN` + `aegis_server=info` del caller | `logging.rs:35-45`; `aegis-server/src/main.rs:345` |
| destino archivo (serve) | `<state>\logs\serve\<YYYY-MM-DD>\<YYYYMMDD_HHMMSS>.log`, **JSON** (`json: true`) | `main.rs:342-350` |
| consola | sólo con `AEGIS_LOG_CONSOLE` definida (necesario para `--stdio`) | `main.rs:346-348` |
| rotación | `Rotation::NEVER`: un archivo por arranque de proceso | `logging.rs:62-63` |
| retención | dirs con más de 14 días, borrados **al iniciar** un componente | `logging.rs:135-159` |
| volumen actual | `logs\serve`: 80 archivos, **83,28 MB**, días 2026-10-20…28 | medición directa |
| `.jsonl` de requests | 10 fijos + huérfanos, 8,9 MB | medición directa |
| OTLP | **apagado en el build vivo**: la feature `otel` no está en `build.ps1:10` | ver §5 |
| Langfuse | **apagado**: exige `LANGFUSE_PUBLIC_KEY`+`SECRET_KEY`; no están en el entorno | `langfuse_layer.rs:155-175` |

Cómo se evita inundar el disco: sólo por dos vías, (a) 14 días de directorios de `tracing` y (b) tope de
10 archivos de request. No hay tope de tamaño por archivo, ni por proceso, ni cuota global; y la
retención de `logs\serve` depende de que el proceso rearranque para ejecutar `cleanup_old_logs`.

---

## 5. OTLP: qué existe y por qué no exporta nada hoy

- Código completo y probado (`otel/otlp.rs`, 46 KB, con `test_case` para `OTEL_SDK_DISABLED`,
  `*_EXPORTER`, endpoints por señal, protocolo, etc.: `otlp.rs:725-760`).
- **No se compila en el binario desplegado.** `logging.rs:97-100` está bajo
  `#[cfg(feature = "otel")]`; la feature `otel` existe en `aegis/Cargo.toml:14-21` pero
  `build.ps1:10` construye con `--no-default-features --features
  rustls-tls,scheduler,bundled-mcp,chat-recall,acp-http`, y el `default` de `aegis-server/Cargo.toml:19-25`
  tampoco la incluye. Sólo llega por `portable-default` (`aegis/Cargo.toml:90-99`).
- Consecuencia: `is_otlp_initialized()` nunca se llama, no hay export de trazas/métricas/logs, ni
  propagación de contexto, ni los atributos `gen_ai.*` salen del proceso.

Para activarlo (no ejecutado, fuera de alcance de esta auditoría):
1. añadir `otel` a la lista de `-Features` de `build.ps1` (o a `aegis-server/Cargo.toml`),
2. exportar `OTEL_EXPORTER_OTLP_ENDPOINT=http://host:4318` (transporte `http/protobuf`; con `grpc`
   el código desactiva las señales y avisa: `otlp.rs:29-46`),
3. opcional `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` sólo si se quiere contenido,
4. `OTEL_SERVICE_NAME` para el nombre del recurso (`otlp.rs:288-296`).
Equivalente por config: `otel_exporter_otlp_endpoint` y `otel_exporter_otlp_timeout` en `config.yaml`
(`otlp.rs:261-272`).

---

## 6. Qué responde hoy la telemetría y qué no

### Responde (con la consulta concreta)

| pregunta | cómo |
|---|---|
| costo por request / modelo / proveedor | `SELECT model, provider, cost, cost_source FROM usage_ledger` |
| costo por sesión, con subagentes | `get_session_usage_totals` suma el árbol `parent_session_id` (`session_manager.rs:3032-3046`) |
| gasto en una ventana | `SUM(cost) WHERE created_timestamp >= strftime('%s','now') - N*86400` |
| tokens y cache por request | columnas `input/output/total/cache_read/cache_write` |
| cuántas llamadas y cuántas son compactación | `COUNT(*)`, `is_compaction` |
| qué se envió exactamente en el último request | `llm_request.0.jsonl`, línea 0 |
| requests fallidos | líneas `{"error":…}` en el `.jsonl` |
| TPS / velocidad aproximada | `web/tools/analyze-speed.py`, `tps-usage.mjs` sobre mensajes y ledger |

### No responde (con la evidencia del hueco)

| hueco | evidencia |
|---|---|
| **latencia por etapa** (armado de contexto → request → primer token → streaming) | el ledger no tiene columnas de tiempo salvo `created_timestamp` (`session_manager.rs:1368-1382`); `elapsed_ms`/`time_to_first_token_ms` existen en `MessageUsage` pero no se persisten en el ledger (`:1184-1204`). Lo que hay es medición externa por reloj (`core/ops/measure-harness-latency.ps1`) |
| **tokens o costo por herramienta** | no hay tabla; el ledger es por request y el `.jsonl` registra `toolRequest` sin duración ni resultado correlacionado |
| **costo por proyecto/workspace como dato propio** | `usage_ledger` no tiene `project_id`; sale sólo por `JOIN sessions` (`:3012-3050` hace ese join para una sesión, no agregado por proyecto). Ninguna tool del harness lo expone |
| **costo real vs facturado** | 44.176 de 46.605 filas son `estimated`; 407 sin costo; no hay conciliación con el panel del proveedor |
| **trazas distribuidas / métricas OTLP** | feature `otel` fuera del build (§5) |
| **redacción de secretos o PII en los `.jsonl`** | cero coincidencias de `redact|secret|api_key|mask` en la ruta de logging |
| **retención de los `.jsonl`** | `cleanup_old_logs` ignora archivos (`logging.rs:151`); `prune-logs.ps1` no cubre `state\state\logs` |
| **por qué un request no reportó uso** | el ledger guarda `NULL`, sin motivo; distinguir "el gateway no manda usage" de "no hay tarifa" exige ir al `.jsonl` a mano |

---

## 7. Local vs GitHub

`gh api repos/block/goose/contents/crates --jq '.[].name'` (29/10) devuelve 15 crates; entre ellas
`goose` (equivalente a `aegis`). Dentro de `crates/goose/src` existen `logging.rs`, `instance_id.rs`,
`otel/` y `tracing/`.

| pieza | upstream `block/goose` | fork local | estado |
|---|---|---|---|
| `crates/*/src/logging.rs` | sí | sí | renames; mismas funciones (`build_logging_subscriber`, `prepare_log_directory`, `cleanup_old_logs`) |
| `src/otel/mod.rs` | sí (`mod.rs`) | sí, 15 bytes: `pub mod otlp;` | recortado |
| `src/otel/otlp.rs` | sí | sí (46 KB) | renames de env/marca |
| `src/otel/trace_context.rs` | **sí** | **no existe** | falta propagación de contexto de traza |
| `src/tracing/{mod,langfuse_layer,observation_layer}.rs` | sí | sí | renames |
| `src/agents/gen_ai_telemetry.rs`, spans `gen_ai.*` | presente en el árbol upstream | presente | instrumentación gen_ai |
| `crates/aegis-cli` | upstream tiene `goose-cli` | **borrado** el 2026-10-20; el harness es `aegis-server` | divergencia de layout |
| `providers/canonical_cost.rs` | base upstream | modificado local | último commit que lo toca: `a99f766a3 fix(costos): preservar provenance de tarifas y uso por proveedor` |
| `providers/utils.rs` (`llm_request`) | base upstream | local sin cambios de fondo | commits que lo tocan: `7bc1e9b51` (imports), `7f394c468` (rebrand) |

`git log --oneline -3 -- crates/aegis/src/otel crates/aegis/src/tracing crates/aegis/src/logging.rs
crates/aegis/src/providers/utils.rs crates/aegis/src/providers/canonical_cost.rs` →
`a99f766a3`, `7bc1e9b51`, `7f394c468`. Conclusión: la capa de tracing/otel **es de goose**; lo único
sustantivo propio en este dominio es la procedencia de tarifas en `canonical_cost.rs` y la
contabilidad `usage_ledger`/`carried_forward`, y la ausencia de `trace_context.rs`.

---

## 8. Referencias

- OpenTelemetry — Rust: <https://opentelemetry.io/docs/languages/rust/> (verificado por fetch 29/10).
- Contenido de `crates/goose/src/otel` (upstream):
  <https://api.github.com/repos/block/goose/contents/crates/goose/src/otel> (consultado con `gh api`,
  devuelve `mod.rs`, `otlp.rs`, `trace_context.rs`).
- Contenido de `crates/goose/src/tracing`:
  <https://api.github.com/repos/block/goose/contents/crates/goose/src/tracing> (`langfuse_layer.rs`,
  `mod.rs`, `observation_layer.rs`).
- Listado de crates upstream: <https://api.github.com/repos/block/goose/contents/crates>.

---

## 9. No verificado / preguntas abiertas

1. **No** ejecuté `build.ps1` ni compilé con `otel`; la conclusión "OTLP está fuera del binario" sale de
   leer `build.ps1:10` + `logging.rs:97` + los `Cargo.toml`, no de inspeccionar el binario desplegado.
   Comprobación pendiente: `strings` o `--version` con la feature, o buscar `opentelemetry` en el exe.
2. **No** verifiqué si `get_instance_id()` se usa como atributo de recurso OTLP en `otlp.rs:274-298`
   (sólo leí el bloque de `OTEL_SERVICE_NAME`).
3. **No** medí cuántos `.jsonl` huérfanos se acumulan por día; hay 19 ahora y el más viejo es del 20/10,
   lo que sugiere pocos por sesión, pero no lo conté por día.
4. **No** confirmé si dos `finish` concurrentes realmente pisan archivos: la hipótesis se apoya en que
   `utils.rs:149-153` no usa lock, y en la convivencia de 19 temporales.
5. **No** verifiqué cómo pobla `sessions.project_id` ni la tabla `workspaces` para poder agregar costo
   por proyecto; el `usage_ledger` no la tiene y no encontré consulta que lo haga.
6. **No** revisé `core/ops/audit-cuadre.ps1` / `audit-detalle.ps1` línea por línea; su descripción en el
   mapa sale del nombre y del encabezado.
7. **No** sé si `prices.json` lo consume alguna otra herramienta además de `audit-costs.py`; en el
   harness Rust no aparece citado.

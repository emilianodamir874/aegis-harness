# 03 — Providers, modelos y streaming (contratos de API)

Estado: 2026-10-29. Rama `feat/antigravity-provider`, HEAD `8d559d0b5`.
Alcance leído: `crates/aegis-providers/src/**`, `crates/aegis-provider-types/src/**`,
`crates/aegis/src/providers/**`, `crates/aegis/src/{model_catalog.rs,model_config.rs,oauth/}`,
`state/config/config.yaml`, `web/prices.json`. Sin secretos: las claves se nombran, nunca se imprimen.

---

## 1. Mapa de piezas

| ruta:linea | qué hace | quién la llama |
|---|---|---|
| `crates/aegis-provider-types/src/base.rs:537` | `trait Provider`: contrato único de todo proveedor | `aegis-agent`, `acp/provider.rs`, todos los `*_def.rs` |
| `base.rs:550` | `async fn stream(&self, &ModelConfig, system, &[Message], &[Tool]) -> Result<MessageStream>` — el único método obligatorio | runtime del agente |
| `base.rs:558` | `complete()` por defecto: `stream()` + `collect_stream` | compactación, títulos, tool-pair summarizer |
| `base.rs:342` | `type MessageStream = Pin<Box<dyn Stream<Item=Result<(Option<Message>, Option<ProviderUsage>), ProviderError>>>>` | todos |
| `base.rs:334` | `trait ProviderDescriptor { fn metadata() -> ProviderMetadata }` | catálogo de proveedores / UI |
| `base.rs:356-417` | `model_info_for_provider_model`, `find_declared_model`, `merge_configured_model_info`, `known_models_from_registry` — ModelInfo desde registro canónico | inventario |
| `base.rs:420` | `collect_stream`: concatena deltas; el *thinking* sólo se coalesce si el chunk trae **un** bloque (`is_single_block_delta`) y la firma es compatible | `complete`, tests |
| `base.rs:512/521` | `stream_from_single_message`, `stream_with_leading_notice` | providers no-streaming, avisos (p.ej. adjuntos descartados) |
| `base.rs:574` | `get_context_limit(model, override)` → `ContextLimitResolver` | agente, UI |
| `base.rs:704-714` | `manages_own_context` / `uses_local_session_naming` / `supports_builtin_tools` | harness ACP (Claude Code, Gemini CLI) |
| `base.rs:727/733/739` | `configure_oauth`, `refresh_credentials`, `update_mode` | ACP, UI de conexión |
| `base.rs:746-775` | `thinking_effort_support`, `subscribe_thinking_effort_support`, `set_thinking_effort`, `apply_model_selection` | `acp/provider.rs`, `acp/response_builder.rs` |
| `crates/aegis/src/providers/base.rs:31` | `trait ProviderDef`: `type Provider`, `SESSION_BOUND`, `RUNS_OWN_TOOL_LOOP`, `from_env*` | `provider_registry.rs` |
| `crates/aegis/src/providers/base.rs:20` | `enum ProviderType { Preferred, Builtin, Declarative, Custom }` | registro / UI |
| `crates/aegis/src/providers/provider_registry.rs:29,118-230` | `ProviderEntry`, `ProviderRegistry::{register, register_with_inventory, register_with_name}` | `init.rs` |
| `crates/aegis/src/providers/init.rs:68-194` | registro efectivo de ~40 proveedores; `open_design` en `:172`, `opencode_go` en `:176`, `chatgpt_codex` en `:90`, `antigravity` en `:72` | `create_provider_registry()` al arrancar |
| `aegis-providers/src/openai_compatible.rs:237` | `stream_openai_compat(response, log)` — adapta un `Response` HTTP a `MessageStream` (SSE Chat Completions) | `open_design`, `opencode_go`, `openai_compatible`, `experiential` |
| `openai_compatible.rs:261` | `stream_responses_compat` — idem para Responses API | proveedores Responses |
| `aegis-provider-types/src/formats/openai.rs:1372` | `response_to_streaming_message`: máquina de estados del SSE de Chat Completions | `stream_openai_compat` |
| `formats/openai.rs:1222/1323/1283` | `strip_data_prefix`, `parse_streaming_chunk`, `classify_choiceless_frame` | parser SSE |
| `formats/openai_responses.rs:288-330` | `is_known_responses_stream_event_type` y descarte de eventos desconocidos | parser Responses |
| `formats/openai_responses.rs:1140-1277` | match de eventos (`OutputTextDelta`, `OutputItemDone`, `ResponseCompleted/Incomplete/Failed`, `FunctionCallArgumentsDelta`, `Refusal*`, `Error`, `_ =>`) | `chatgpt_codex` |
| `aegis-providers/src/http_status.rs:244` | `map_http_error_to_provider_error(status, payload, url)` | todos los providers |
| `http_status.rs:397/321/337` | `handle_status`, `send_bounded` (deadline duro + extensión al body), `read_response_body_with_limit` | todos |
| `http_status.rs:47-133` | `extract_retry_after` (body `metadata.retry_after_seconds` > header RFC 7231), `is_context_length_exceeded*` | 429/400 |
| `aegis-provider-types/src/retry.rs:114-164` | `should_retry`, `retry_operation`, backoff con jitter 0,8–1,2 | `ProviderRetry::with_retry` |
| `aegis-provider-types/src/thinking.rs:307-367` | `ThinkingEffort`, `ThinkingEffortCapability`, `ThinkingEffortSupport` | modelo y ACP |
| `aegis/src/acp/response_builder.rs:472-499` | **las 4 listas reales** de esfuerzo por modelo | menú `session/new` y `session/load` |
| `aegis/src/acp/provider.rs:2309` | `resolve_effort_value`: pick de sesión → default global → vocabulario del agente | `apply_effort_if_changed` (`:594`) |
| `aegis/src/model_catalog.rs:5-32` | refresco del catálogo `https://models.dev/api.json` a `data/model_catalog` | arranque |
| `aegis/src/model_config.rs:13-88` | `model_config_from_user_config*`, `materialize_model_config`, `with_default_thinking_effort` | sesión |

---

## 2. Cómo se declara un provider nuevo (pasos exactos)

1. **Archivo del proveedor**: `crates/aegis/src/providers/<nombre>.rs`
   - `struct XProvider { client: ApiClient }`
   - `impl ProviderDescriptor for XProvider { fn metadata() -> ProviderMetadata }` con
     `ProviderMetadata::with_models(name, display, description, default_model, models, docs_url, vec![ConfigKey::new("X_API_KEY", required, secret, None, …)])`
     (ejemplo canónico: `open_design.rs:59-99`).
   - `impl ProviderDef for XProvider { type Provider = Self; fn from_env(ext, tls) -> BoxFuture<…> }`
     (`open_design.rs:119-142`): lee la clave con `Config::global().get_secret("X_API_KEY")` y construye el `ApiClient`.
   - `impl Provider for XProvider`: `get_name`, `stream` obligatorio; opcionales `get_context_limit`,
     `fetch_supported_models`, `configure_oauth`, `refresh_credentials`, `thinking_effort_support`,
     `set_thinking_effort`, `permission_routing`.
   - Si `RUNS_OWN_TOOL_LOOP = true` el harness no levanta los MCP servers (proveedores ACP).
2. **Export**: `crates/aegis/src/providers/mod.rs` (`pub mod <nombre>;` + `pub use`).
3. **Registro**: `crates/aegis/src/providers/init.rs` — `registry.register_with_inventory::<XProvider>(preferred, Some(inventory), has_builtin_skills)`; `register::<XProvider>(preferred)` si no hay inventario (ver `init.rs:68-194`).
4. **Metadatos de setup UI** (opcional): `ProviderSetupMetadata::new(category, method, group).with_docs_url(...).with_field(...)` dentro de `metadata()` (`open_design.rs:85-98`).
5. **Credencial**: fila en `state/config/secrets.yaml` (`X_API_KEY`) o flujo OAuth (`configure_oauth`).
6. **Visibilidad**: `providers.<nombre>.enabled: true` en `config.yaml` y, si aplica, `AEGIS_VISIBLE_PROVIDERS` (hoy `open_design,opencode_go,experiential,chatgpt_codex,antigravity`).
7. **Tests**: unitarios con `wiremock` en el mismo archivo (`open_design.rs:358-395`), y la suite compartida `crates/aegis/tests/providers.rs`.
8. **Alternativa sin Rust**: proveedor *declarativo* — JSON en
   `crates/aegis-providers/src/declarative/definitions/<id>.json` (48 definiciones, idénticas al upstream);
   lo carga `declarative.rs` y `register_declarative_providers` (`init.rs:53`). Formatos soportados:
   openai / openai_responses / anthropic / google / ollama / databricks / snowflake (`aegis-provider-types/src/formats/`).

---

## 3. Proveedores activos: wire exacto

### 3.1 `open_design` (activo: `config.yaml` → `active_provider: open_design`)

| aspecto | valor | código |
|---|---|---|
| endpoint | `POST https://amr-link.open-design.ai/v1/chat/completions` | `open_design.rs:28`, `:252` |
| formato | OpenAI Chat Completions + extensiones DeepSeek (`thinking`, `reasoning_effort`) | `build_payload` `:169-223` |
| auth | `Authorization: Bearer <OPEN_DESIGN_API_KEY>` | `:110-116`, `ConfigKey` `:77-83` |
| headers extra | `agent-session-id` (`SESSION_ID_HEADER`, `aegis/src/session_context.rs:5`) | `:116` |
| modelos anunciados | `deepseek-v4.1-flash` (1 048 576 ctx) y `glm-5.3-flash` (200 000 ctx) | `:41`, `:46-52` |
| alias de esfuerzo | `-none/-low/-medium/-high/-max` se aceptan pero **se reescriben** al id base en el wire | `legacy_suffix_effort` `:148`, `wire_model` `:161` |
| thinking | `Off → {"thinking":{"type":"disabled"}}` y sin `reasoning_effort`; `Low → enabled+low`; `Medium/High → enabled+high`; `Max → enabled+max`; `None →` se omite (default del gateway) | `:203-221` |
| visión | fuerza `supports_vision = true` y `ImageFormat::OpenAi` | `:186`, `:192` |
| streaming | `stream: true` + `stream_options.include_usage` (viene de `formats/openai.rs:1933-1934`), parseo SSE genérico | `:264` |
| timeout | idle de 300 s (reqwest `read_timeout`, no total) | `STREAM_IDLE_TIMEOUT_SECS` `:40` |
| razón del 300 | se midió un TTFT legítimo de 147,6 s y un cuelgue de 606,9 s con el default de 600 s | comentario `:34-39` |

Trampa verificada en tests: un `thinking_effort: off` **manda sobre** un alias `-max` (`:346-356`); si no,
las llamadas one-shot (compactación, títulos) facturaban razonamiento dentro del presupuesto de salida y
abortaban con «filled the configured budget» (`:178-183`).

### 3.2 `opencode_go`

| aspecto | valor | código |
|---|---|---|
| endpoint | `POST https://opencode.ai/inference/go/openai/v1/chat/completions` | `opencode_go.rs:31`, `:360` |
| formato | OpenAI Chat Completions **sin** `reasoning_effort` (se elimina del payload) | `:350-354` |
| auth 1 | `OPENCODE_GO_API_KEY` → `Bearer` si existe | `:283-285` |
| auth 2 | si no hay clave: OAuth de la CLI de OpenCode en `~/.local/share/opencode/auth.json` (`XDG_DATA_HOME` manda), campo `opencode.{access,refresh,expires}` | `cli_auth_path` `:140-169` |
| refresh | `POST https://opencode.ai/console/auth/device/token` con `{grant_type: refresh_token, refresh_token, client_id: "opencode-cli"}`; skew 120 s; reescribe el archivo con `write_private_file` y aborta si el refresh rotó en paralelo | `:34`, `:188`, `:200-240` |
| headers | `User-Agent: aegis/1.0` + `x-opencode-session` (override del header de sesión) | `:263-268` |
| timeout | 300 s | `:270` |
| modelos | 18 ids de Chat Completions en `CHAT_MODELS`; cualquier otro id se rechaza en `stream` con `ProviderFailed` | `:56-75`, `:331-336` |
| contexto | `deepseek-v4.1-flash` → 1 000 000; resto → 200 000 | `:49-55` |
| visión | `VISION_MODELS = []` **a propósito**: el gateway respondió 422 «Upstream request failed» con `image_url` (verificado 2026-10-20) | `:37-47` |
| thinking | no se envía ningún campo: el razonamiento depende del modelo del gateway; el esfuerzo del chip no viaja | `:350-354` |

### 3.3 `chatgpt_codex` (suscripción ChatGPT vía OAuth, formato **Responses**)

| aspecto | valor | código |
|---|---|---|
| endpoint | `POST https://chatgpt.com/backend-api/codex/responses` | `chatgpt_codex.rs:39`, `:957` |
| modelo por defecto | `gpt-5.5`; catálogo real por `GET /backend-api/codex/models?client_version=26.930.61225` | `:49`, `:55`, `:1003-1039` |
| auth | OAuth PKCE contra `https://auth.openai.com` (`client_id app_EMoamEEZ73f0CkXaXp7hrann`, scopes `openid profile email offline_access`, callback `127.0.0.1:1455`, timeout 300 s) | `:37-46`, `:530-554`, `:747` |
| tokens | caché en `<config>/chatgpt_codex/tokens.json` (escritura privada), refresh cuando faltan <60 s | `:350`, `:854-890` |
| headers | `Authorization: Bearer`, `Content-Type: application/json`, `chatgpt-account-id` (claim del JWT), `agent-session-id` | `:940-966` |
| payload | `{model, input[], store:false, instructions: system, tools[{type:function,name,description,parameters}], tool_choice:"auto", parallel_tool_calls:true, reasoning:{effort}, stream:true}` | `create_codex_request` `:288-334`, `:1099` |
| mapeo de mensajes | `input_text` / `output_text` / `input_image` (data URL base64) / `function_call` / `function_call_output` (los errores de tool van como `output: "Error: …"`) | `build_input_items` `:144-237` |
| thinking | `reasoning.effort` **siempre** presente (fallback a `CHATGPT_CODEX_REASONING_EFFORT`, default `medium`) | `:239-286` |
| streaming | SSE de Responses con `LinesCodec` + `responses_api_to_streaming_message` | `:1090-1124` |
| reintentos | `with_retry` alrededor de `post_streaming` (sólo cubre el handshake HTTP) | `:1101-1106` |

### 3.4 `antigravity` (Google internals, formato Gemini)

| aspecto | valor | código |
|---|---|---|
| endpoints (fallback en orden) | `daily-cloudcode-pa.googleapis.com` → `daily-cloudcode-pa.sandbox.googleapis.com` → `cloudcode-pa.googleapis.com` | `antigravity.rs:38-42` |
| ruta | `POST {endpoint}/v1internal:streamGenerateContent?alt=sse` y `v1internal:loadCodeAssist` para el project id | `:328`, `:231` |
| auth | refresh token de Google en `https://oauth2.googleapis.com/token` | `:26`, `:206-220` |
| UA | `antigravity/cli/1.2.4 (aidev_client; os_type=windows; arch=amd64; cl=982146307; auth_method=consumer)` | `:43` |
| formato | Gemini (`contents`, `tools.functionDeclarations`, `generationConfig`) vía `providers/formats/google` | `:5`, `:650` |
| modelos | un id por familia; `gemini-3.8-flash` + `thinking_effort` se traduce a `-high`/`-medium` en `runtime_model` | `:52-86` |
| thinking | no hay campo de esfuerzo en el wire: **es el id** (`gemini-3.8-flash-high`), y `claude-opus-4-6 → -thinking` | `:75-86` |
| salida | tope por modelo (`model_output_cap`: claude 64k, gpt-oss, gemini-3.8) aplicado como `max_tokens` | `:88-95`, `:645-649` |
| stream | `unwrap_sse` + reintento de **stream vacío** (hasta 3 pasadas) porque el gateway cerraba en borde de línea y el turno quedaba `[]` | `:659-730` |
| errores | un 404 *a nivel modelo* sobrevive al walk de endpoints; un 429 posterior no lo enmascara | `:319-356`, `:384-412` |

### 3.5 `experiential` (gateway OpenAI-compatible)

`https://api.experientiallabs.ai/v1`, `Authorization: Bearer xpl_<40 hex>`, default
`deepseek-v4.1-flash-uncensored`, catálogo real por `GET /v1/models` (318 slugs), `tools` verificado
(`providers/experiential.rs:24-40`). Es el único proveedor con un modelo "abliterated" declarado por el operador.

### 3.6 `local` (Ollama / inferencia local)

- `crates/aegis-providers/src/ollama.rs` + `aegis/src/providers/ollama_def.rs`: API nativa Ollama
  (`/api/chat`, NDJSON, no SSE), formato en `aegis-provider-types/src/formats/ollama.rs`.
- `crates/aegis-providers/src/local_inference.rs` + `aegis-local-inference`: llama.cpp embebido.
- `ollama_cloud.rs` (508 líneas): variante cloud con clave.
- Registrados como *Builtin* no preferidos (`init.rs:89`, `:164`).

---

## 4. Streaming: qué hace exactamente el parser

### 4.1 Cadena SSE de Chat Completions

```
reqwest bytes_stream  →  StreamReader  →  FramedRead/LinesCodec   (una línea = un frame)
   openai_compatible.rs:241-246
→ strip_data_prefix  ("data: " | "data:", trim)                   openai.rs:1222
→ "[DONE]"  ⇒ break 'outer                                       openai.rs:1402
→ línea vacía / sin prefijo ⇒ continue                            openai.rs:1406
→ parse_streaming_chunk                                           openai.rs:1323
     · {"error":…} / {"object":"error"} ⇒ ProviderError::ServerError
     · objeto SIN "choices" ⇒ metadata-only: classify_choiceless_frame
         - señal de error (status/statusCode/code ≥400, type=="error", detail≠null) ⇒ ServerError
         - si no ⇒ Ok(None) y se descarta el frame
     · "choices": [] ⇒ NO es metadata: es el chunk de usage
```

Separación de deltas (`response_to_streaming_message`, `openai.rs:1372-1760`):

| señal | origen en el delta | destino |
|---|---|---|
| texto | `delta.content` (string o array de partes `{type:"text", text, thoughtSignature}`) | `MessageContentBlock::Text`, tras `ThinkFilter` |
| razonamiento estructurado | `delta.reasoning_content` (DeepSeek/OpenRouter) o `delta.reasoning` (vLLM); gana el primero no vacío | `MessageContentBlock::Thinking(text, signature)` |
| razonamiento con detalles | `delta.reasoning_details[]` | se acumula y viaja como metadata `ProviderMetadata["reasoning_details"]` |
| thinking inline | `<think>…</think>` dentro de `content` | `ThinkFilter`/`pending_inline_thinking`; **sólo se emite si nunca llegó razonamiento estructurado** |
| firma | `thoughtSignature` (Gemini) | `last_signature`, se pega a los tool calls (clave `GEMINI_THOUGHT_SIGNATURE_KEY`) |
| tool calls | `delta.tool_calls[{index,id,function:{name,arguments},…extra}]` | acumulación por `index` en `tool_call_data` hasta `finish_reason` (`openai.rs:1452-1553`); los argumentos se concatenan; se emiten **una sola vez**, completos, ordenados por índice (`:1607-1677`) |
| usage | `usage` del chunk (normalmente `choices: []`) | `ProviderUsage`; se emite **una vez** (`usage_emitted`) |
| corte por longitud | `finish_reason == "length"` | `MessageContentBlock::tool_request(... Err(output_token_limit_tool_error))` + `metadata.output_token_limit_reached` |

Invariantes del parser:

1. **Un frame anómalo no mata el turno si es benigno, y no se descarta si es un error.** Es la razón de
   `classify_choiceless_frame` (`openai.rs:1272-1308`): Portkey/Azure APIM intercalan objetos de
   guardrail (`{"hook_results":…}`) y un gateway que rate-limita en HTTP 200 con `{"statusCode":429}`
   debe fallar, no producir un turno vacío «exitoso».
2. **Durante la acumulación de tool calls, un frame metadata-only hace `continue`, no cierra la
   acumulación** (`openai.rs:1479-1484`); si cayera al branch de `choices` vacías truncaría los argumentos.
3. **Argumentos no-objeto** ⇒ `Err(ErrorData INVALID_PARAMS)` con el raw en el mensaje, en lugar de
   romper el run (`:1649-1672`), porque `rmcp::object()` hace debug-assert sobre no-objetos.
4. **Reasoning duplicado**: si llega inline y después estructurado, se descarta el inline
   (`pending_inline_thinking.clear()`, `:1429-1431`).

### 4.2 Responses API (`chatgpt_codex`)

`responses_api_to_streaming_message` (`formats/openai_responses.rs`): eventos tipados por `type`;
`is_known_responses_stream_event_type` (`:288-302`) lista los que se consumen y **todo evento
desconocido se ignora** (`:319-330`, `_ =>` en `:1277`), que es lo que permite que OpenAI agregue
eventos nuevos sin romper el turno. `ResponseIncomplete` se traduce a error con
`incomplete_details` (`:1194-1219`).

### 4.3 Backpressure, timeouts, reintentos

| mecanismo | dónde | efecto real |
|---|---|---|
| backpressure | `FramedRead` sobre `bytes_stream` dentro de `try_stream!` | el socket se lee al ritmo del consumidor; no hay buffer ilimitado ni cola propia |
| deadline del handshake | `send_bounded` (`http_status.rs:321-335`) | `timeout_at` sobre `send()` y **deadline heredado** al body (`ResponseDeadline`) |
| deadline del body no-stream | `read_response_body_with_limit` (`:337-373`) | corta también la lectura del body; tope de bytes (`MAX_PROVIDER_JSON_RESPONSE_BYTES`) |
| idle de stream | `ApiClient::with_timeout_and_tls` (300 s open_design/opencode_go; 600 s default `api_client.rs:19`) | es *read timeout*, no tiempo total: sólo dispara si el endpoint calla |
| reintentos | `ProviderRetry::with_retry` + `retry_operation` (`retry.rs:125-164`) | 3 intentos, 1 s × 2ⁿ, techo 30 s, jitter 0,8–1,2; `RateLimitExceeded` respeta `retry_delay` |
| qué se reintenta | `should_retry` (`retry.rs:114`) | `RateLimitExceeded`, `ServerError`, `NetworkError` siempre; `RequestFailed` salvo `transient_only` o marcador permanente (`:101-112`) |
| reintento de stream vacío | `antigravity.rs:659-730` | 3 pasadas; **sólo cuenta como contenido un mensaje con partes** (el evento de usage no cuenta) |
| rate limit | `http_status.rs:415-419` | `retry_delay` se toma del body (`error.metadata.retry_after_seconds`) y si no del header RFC 7231; se clampea por `duration_from_finite_secs` |

---

## 5. `thinking_effort`

### 5.1 Declaración

- Enum: `ThinkingEffort::{Off,Low,Medium,High,Max}` (`aegis-provider-types/src/thinking.rs:307`).
- `FromStr` (`:317-325`): `off|disabled|none` → Off, `low`, `medium|med`, `high`, `max|xhigh` → Max.
- Vive como **parámetro de request** del modelo, no como campo: `request_params["thinking_effort"]`
  (`aegis-provider-types/src/model.rs:235-242`), se lee con `thinking_effort()` (`:407-410`).
- Default global: `AEGIS_THINKING_EFFORT` (hoy `max` en `config.yaml`) aplicado en
  `model_config_from_user_config*` (`aegis/src/model_config.rs:32,70`) vía `with_default_thinking_effort`
  (`model.rs:244-252`), que **no pisa** un valor persistido aunque no sea parseable (`"default"`).

### 5.2 Las cuatro listas reales (menú de sesión)

`aegis/src/acp/response_builder.rs:472-499`:

| condición | opciones ofrecidas |
|---|---|
| `!is_reasoning_model()` | `[off]` |
| GLM 5.3 (`is_glm_5_3_reasoning_model`) | `[off, low, high, max]` — **sin medium**, con off |
| Kimi K3 | `[low, high, max]` — **sin off** |
| cualquier otro modelo de razonamiento | `[off, low, medium, high, max]` |

`build_thinking_effort_choices` (`:424-457`): si el provider es ACP con capacidad propia
(`ThinkingEffortSupport::Options`) se refleja **su** lista, no ésta; si es `Unsupported`, sólo `[off]`.

### 5.3 Clamp / mapeo al vocabulario del wire

| proveedor | Off | Low | Medium | High | Max | código |
|---|---|---|---|---|---|---|
| open_design / DeepSeek | `thinking.disabled`, sin `reasoning_effort` | `enabled` + `low` | `enabled` + **`high`** | `enabled` + `high` | `enabled` + `max` | `open_design.rs:203-221` |
| opencode_go | — (no envía nada) | — | — | — | — | `opencode_go.rs:352-354` |
| chatgpt_codex | `none` (si existe) si no `low` | `low→medium→high→xhigh` | `medium→high→low→xhigh` | `high→medium→xhigh→low` | `xhigh→high→medium→low` | `chatgpt_codex.rs:259-286` |
| antigravity | tier `-medium` es el mínimo | tier por id | `-medium` | `-high` | `-high` | `antigravity.rs:75-86` |
| chatgpt_codex, config inválida | — | — | — | — | — | `get_reasoning_effort` cae a `medium` y emite `tracing::warn!` (`:239-257`) |

**Qué pasa si el modelo no soporta el nivel:** no hay error. El clamp es silencioso y ocurre en tres
lugares distintos: (a) el menú no ofrece el nivel, (b) `resolve_effort_value` (`acp/provider.rs:2309-2321`)
mapea al primer nivel válido del agente y deja el pick persistido intacto para cuando el usuario vuelva,
(c) el provider reescribe al valor más cercano (`reasoning_effort_for_config`). El pick inválido queda
en el store; al cambiar de modelo puede volver a ser honorable.

---

## 6. Errores y cuotas

`ProviderError` (`aegis-provider-types/src/errors.rs:8-62`): `NotConfigured`, `Authentication`,
`ContextLengthExceeded`, `RateLimitExceeded{details,retry_delay}`, `ServerError`, `NetworkError`,
`RequestFailed`, `InvalidValue`, `ExecutionError`, `UsageError`, `NotImplemented`, `EndpointNotFound`,
`CreditsExhausted{details,top_up_url}`, `Refusal`.

| HTTP | error interno | se reintenta | código |
|---|---|---|---|
| 401 / 403 | `Authentication` | no | `http_status.rs:264` |
| 402 | `CreditsExhausted` (con `top_up_url: None`) | no | `:273` |
| 400 | `ContextLengthExceeded` si el payload/mensaje suena a contexto; si no `RequestFailed` | `RequestFailed` sí (salvo marcadores) | `:278-285`, `:114-133` |
| 404 | `RequestFailed` «Resource not found» | según config | `:269` |
| 413 | `ContextLengthExceeded` | no | `:277` |
| 429 | `RateLimitExceeded` + `retry_delay` | sí, con el delay del server | `:286`, `:415` |
| 5xx | `ServerError` | sí | `:290` |
| otro 4xx | `RequestFailed` con status y URL saneada | según config | `:295` |

Detección de contexto excedido: `is_context_length_exceeded` mira payload (`error.code`,
`"context_length_exceeded"`, `"maximum context length"`, `"too many tokens"`, `"many-image"`) y si no, el
texto (`:114-242`). La URL se sanea (`sanitize_url`, `:24`) antes de entrar al mensaje, así una key en
query no se filtra al log. `tracing::warn!` con payload completo en `:302-309` (ver §8).

---

## 7. Local vs GitHub

`gh api repos/block/goose/contents/crates` (2026-10-29) lista **los mismos 15 crates** que `origin/main`,
con prefijo `goose-`: `goose-providers`, `goose-provider-types`, `goose-agent`, …, `goose-test-support`.
`origin/main` de `aegis-harness` está en `3bd852002 agent-loop: changed yield_to_customer to next enum (#12789)`.
El fork **renombró todos los crates** `goose-* → aegis-*`: por eso `git diff origin/main -- crates/aegis-*`
reporta 202 archivos y +375 304 líneas «nuevas» aunque el 95 % sea upstream movido de sitio.

| archivo | situación | evidencia |
|---|---|---|
| `aegis-providers/src/{openai_compatible,declarative}.rs` | upstream, renombrado + 2 líneas | `git diff --numstat` → `2/2` |
| `aegis-providers/src/http_status.rs` | **idéntico** al upstream | `git diff --numstat` vacío |
| `aegis-provider-types/src/formats/openai.rs` | upstream + **226/17** (fork añadió SSE, reasoning, tool-call accumulation) | numstat |
| `aegis-provider-types/src/formats/openai_responses.rs` | upstream + 7/7 | numstat |
| `aegis/src/providers/chatgpt_codex.rs` | upstream + **107/14** (catálogo remoto de modelos, effort por sesión) | numstat |
| `aegis/src/providers/init.rs` | upstream + 47/14 (4 proveedores nuevos) | numstat |
| `aegis/src/providers/{base,mod,openai_def,provider_registry}.rs` | upstream con retoques menores (6/6, 15/11, 11/11, 1/1) | numstat |
| `declarative/definitions/*.json` | 48 = 48, **0 locales, 0 upstream-only** (incluye `opencode_go.json`, `deepseek.json`) | `git ls-tree` comparado |
| **`aegis/src/providers/open_design.rs`** | **solo local** (407 líneas) | no existe en `origin/main` ni en block/goose |
| **`aegis/src/providers/opencode_go.rs`** | **solo local** (562) | idem |
| **`aegis/src/providers/antigravity.rs`** | **solo local** (1215) | idem |
| **`aegis/src/providers/experiential.rs`** | **solo local** | idem |
| `aegis/src/model_catalog.rs` | presente en ambos (32 líneas) | `git ls-tree origin/main` |
| `crates/aegis-*` (nombres) | **solo local**: upstream/publicaciones usan `goose-*` | `gh api` |

Proveedores upstream que el fork **no** añadió: `avian`, `gondola`, `kimicode`, `litellm`, `nanogpt`,
`tetrate`, `xai*`, `chatgpt_codex`, `muse_code` vienen de block/goose. Invención local verificada:
**open_design, opencode_go, antigravity, experiential**.

---

## 8. Huecos, riesgos y deuda técnica

1. **El registro de proveedores no está en `config.yaml`.** `config.yaml` sólo declara `openai` y
   `open_design`; `chatgpt_codex`, `opencode_go`, `antigravity` y `experiential` existen por
   `init.rs` + `AEGIS_VISIBLE_PROVIDERS` + credenciales fuera del YAML (OAuth en
   `<config>/chatgpt_codex/tokens.json`, CLI de OpenCode, `secrets.yaml`). Un lector del YAML no puede
   saber qué proveedores hay.
2. **`opencode_go` no transporta `thinking_effort`** (`opencode_go.rs:350-354`): el chip de la barra
   cambia el valor persistido y no tiene ningún efecto en el wire. Contradice la expectativa de F-0214
   («el motor recalcula thinking_effort por modelo») sin avisar al usuario.
3. **`open_design` colapsa `medium` en `high`** (`:212-215`): el nivel `medium` del menú viaja como
   `high`, así que la lista de 5 niveles es efectivamente de 4 en ese proveedor.
4. **`get_reasoning_effort` de chatgpt_codex** depende de `CHATGPT_CODEX_REASONING_EFFORT` y hace
   fallback a `medium` con sólo un `warn` (`chatgpt_codex.rs:239-257`); no consulta la lista del modelo
   del backend, sólo la tabla estática (`CHATGPT_CODEX_KNOWN_MODELS`, `:63-104`), que el propio
   comentario `:51-55` reconoce como desactualizable. Un modelo nuevo cae en `DEFAULT_REASONING_LEVELS =
   ["medium","high"]` (`:108`).
5. **`tracing::warn!` con el payload HTTP completo** en `map_http_error_to_provider_error`
   (`http_status.rs:302-309`): en un 400 de contenido el body puede llevar fragmentos del prompt.
6. **Doble timeout en chatgpt_codex**: `reqwest` con `read_timeout = 600 s` **y** `send_bounded(600 s)`
   (`chatgpt_codex.rs:949-972`); el segundo no acorta el stream, sólo el handshake. Un stream muerto
   puede colgar hasta 600 s, el mismo caso que `open_design` ya resolvió bajando a 300 s (`:34-40`).
7. **`antigravity` no tiene conversión de esfuerzo declarada en `thinking_effort_support`**: el mapeo
   vive en `runtime_model` (`:75-86`) y depende del *nombre* del modelo, así que un alias de esfuerzo en
   el id (que el comentario `:61` dice que se conserva por compatibilidad) puede quedar pisado por
   `model_config.thinking_effort()` sin traza.
8. **`fetch_supported_models` de open_design/opencode_go es una lista fija** (`KNOWN_MODELS`,
   `CHAT_MODELS`); no hay `GET /v1/models`. Un modelo nuevo en el gateway hay que compilarlo.
9. **`prices.json` no es tarifa**: sus propios campos lo dicen (`_comentario`: «NO tarifas verificadas ni
   factura… `null` = costo no informado, NO gratis»). Varias entradas tienen `inputEffective` sin
   `input/output` (`open_design/deepseek-v4.1-flash-max`: 0,014249 USD/1M entrada efectiva, 3 684
   llamadas, 6,349 USD). La UI no debe presentarlo como precio por token.
10. **El catálogo de modelos depende de un tercero**: `model_catalog.rs:5` refresca `models.dev/api.json`
    en `tokio::spawn` al arrancar y sólo loguea un `warn` si falla; el `context_limit` de un modelo puede
    cambiar sin tocar el repo.

### No verificado

- No ejecuté builds ni tests: todo lo anterior sale de leer el código y de `git diff/numstat`.
- La documentación pública de OpenAI Responses (streaming events) se localizó pero el texto extraído fue
  navegación; **no pude confirmar en la página** los nombres exactos de evento que consume
  `openai_responses.rs`.
- No hay documentación pública verificable de los endpoints `*cloudcode-pa.googleapis.com/v1internal:*`
  que usa `antigravity` (superficie interna de Google); el contrato está inferido del código y de los
  logs citados en los comentarios.
- No verifiqué el contenido de `secrets.yaml` (sólo los nombres de clave que cita el código).

---

## 9. Referencias web (consultadas 2026-10-29)

| fuente | URL | qué confirma |
|---|---|---|
| DeepSeek API Docs — Quick Start / Your First API Call | `https://api-docs.deepseek.com/guides/reasoning_model` | `base_url (OpenAI) https://api.deepseek.com`; `model deepseek-flash` servido por **DeepSeek-V4.1-Flash-1017**; ejemplo con `"thinking": {"type": "enabled"}` y `"reasoning_effort": "high"`; compatibilidad OpenAI/Anthropic |
| DeepSeek — Models & Pricing (vía portada) | `https://www.deepseek.com/en/platform/` | DeepSeek-V4-Flash / V4-Pro, caché automática, contexto hasta 1M (© 2026) |
| OpenAI — Responses streaming events | `https://platform.openai.com/docs/api-reference/responses-streaming` | la página existe y expone «Streaming events» bajo Responses API (contenido extraído = navegación) |
| Anthropic — Extended thinking (legacy) | `https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking` | «Configure manual extended thinking with a fixed `budget_tokens` … migrate to adaptive thinking»; status **Legacy** en la Messages API |
| Anthropic — Thinking / Effort / Task budgets | `https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking` (nav: «Sleering and cost control», «Effort», «Task budgets (beta)») | el control de esfuerzo se movió a páginas propias; el preset de esfuerzo no es `budget_tokens` |
| Ollama | `https://ollama.com/` | portal oficial; la doc de `/api/chat` no se pudo extraer en esta sesión (`https://github.com/ollama/ollama` listado como código) |

Nota de contrato: el repo usa en el wire el id `deepseek-v4.1-flash` contra **gateways** (Open Design,
OpenCode Go, Experiential), no contra `api.deepseek.com`, donde el id documentado es `deepseek-flash`.
Son dos superficies distintas y no son intercambiables.

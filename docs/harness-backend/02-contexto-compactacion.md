# 02 — Contexto, compactación y conteo de tokens

Lectura read-only del árbol vivo (`src` en `feat/antigravity-provider`, HEAD `660d9ff2c`),
del store (`state\config\config.yaml`) y de `crates/aegis-context-management`. Todas las
citas son `ruta:linea` del árbol local salvo que digan `origin/main` / `upstream/main`.

**Corrección de premisa:** el techo de contexto **no es 350k**. Vale `500000` desde el
commit `933bc945e` (2026-10-28): `state\config\config.yaml:3-4`
(`AEGIS_AUTO_COMPACT_TOKEN_LIMIT: 500000`, comentario «26/10: 350k -> 28/10: 500k a pedido;
antes 839k»). 350k fue el valor del 26/10 al 28/10.

---

## 1. Mapa de piezas

### 1.1 Conteo de tokens (`crates/aegis/src/token_counter.rs`)

| ruta:linea | qué hace | quién la llama |
|---|---|---|
| `token_counter.rs:10` | `static TOKENIZER: OnceCell<Arc<CoreBPE>>` — un solo BPE por proceso | `get_tokenizer` |
| `token_counter.rs:218-226` | `tiktoken_rs::o200k_base()` — **tokenizer de OpenAI o200k**, no el del modelo | `TokenCounter::new` |
| `token_counter.rs:14` | `MAX_TOKEN_CACHE_SIZE = 8_192` entradas LRU (antes 1024) | `TokenCounter::new` |
| `token_counter.rs:30-43` | clave del cache = `(len, blake3(text))` | `count_tokens` |
| `token_counter.rs:60-80` | `count_tokens`: cache → `encode_with_special_tokens` → cache | `count_chat_tokens`, `count_tokens_for_tools` |
| `token_counter.rs:17-22` | constantes de tool schema: `FUNC_INIT 7`, `PROP_INIT 3`, `PROP_KEY 3`, `ENUM_INIT -3`, `ENUM_ITEM 3`, `FUNC_END 12` | `count_tokens_for_tools` |
| `token_counter.rs:82-134` | `count_tokens_for_tools`: aproxima el schema por nombre+descripción de tool y por propiedad | `count_chat_tokens` |
| `token_counter.rs:136-184` | `count_chat_tokens`: **4 tok por mensaje**, system prompt, texto/tool req/tool resp/thinking | `context_mgmt`, `recent`, `acp/server` |
| `token_counter.rs:150-152` | `if !message.metadata.agent_visible { continue }` — **el historial oculto no cuenta** | ídem |
| `token_counter.rs:167-173` | cuenta `thinking.thinking`; `RedactedThinking` = `REDACTED_THINKING_TOKENS = 32` (`:47`) | ídem |
| `token_counter.rs:181` | `+3` por «Reply primer» | ídem |
| `token_counter.rs:186-201` | `count_everything` = chat + resources | sin llamadores en producción |
| `token_counter.rs:228-237` | `shared_token_counter()`: contador de proceso (cache sobrevive entre turnos) | `context_mgmt`, `acp/server` |
| `token_counter.rs:239-241` | `create_token_counter()`: instancia nueva, cache vacío | solo tests (`token_counter.rs:258-366`); el camino de contexto usa `shared_token_counter` |

### 1.2 Contexto y compactación (`crates/aegis/src/context_mgmt/`)

| ruta:linea | qué hace | quién la llama |
|---|---|---|
| `context_mgmt/mod.rs:49-64` | `auto_compact_threshold(context_limit)`: umbral efectivo | `agents/agent.rs:658`, `acp/server.rs:1003` |
| `context_mgmt/mod.rs:66-70` | `tool_pair_summarization_enabled()` (`AEGIS_TOOL_PAIR_SUMMARIZATION`, default **false**) | `agent.rs:677`, `mod.rs:798` |
| `context_mgmt/mod.rs:27` | `TOOLCALL_SUMMARIZATION_BATCH_SIZE = 10` | `tool_ids_to_summarize`, op de pares |
| `context_mgmt/mod.rs:28-29` | `COMPACTION_INPUT_RESERVE_PERCENT = 10`, `MAX_SINGLE_MESSAGE_OVERAGE = 64_000` | `compaction_input_budgets` |
| `context_mgmt/mod.rs:31-45` | `compaction_input_budgets(limit, output)` → `(input_budget, single_message_input_budget)` | `do_compact` |
| `context_mgmt/mod.rs:112-267` | `compact_messages`: **la compactación completa** (resumen + visibilidad + continuación + cola reciente) | `ops_compaction.rs:253,411` |
| `context_mgmt/mod.rs:271-281` | `count_context_tokens`: suma por mensaje **agent-visible** | `ops_compaction.rs:65,170`, `mod.rs:254` |
| `context_mgmt/mod.rs:284-334` | `check_if_compaction_needed`: **código muerto** (ver §6) | nadie fuera de doc-comments |
| `context_mgmt/mod.rs:336-363` | `AegisCompactionModel::complete` → `model_config::complete_one_shot` con `with_max_tokens(output_budget)` | `do_compact` |
| `context_mgmt/mod.rs:365-378` | `AegisTokenEstimator` (envuelve `TokenCounter`) | `do_compact` |
| `context_mgmt/mod.rs:380-385` | `compaction_templates()`: overrides desde `prompt_template::template_source` | `do_compact` |
| `context_mgmt/mod.rs:387-430` | `do_compact`: filtra turn-context, calcula budgets, llama `summarize_in_chunks_with_single_message_budget` | `compact_messages` |
| `context_mgmt/mod.rs:434-442` | `compute_tool_call_cutoff`: `(3 * limit*threshold / 20_000).clamp(10,500)` | `agent.rs:662` |
| `context_mgmt/mod.rs:459-491` | `tool_ids_to_summarize_limited`: qué tool calls son elegibles | op de pares, `tool_ids_to_summarize` |
| `context_mgmt/mod.rs:493-526` | `agent_visible_tool_pair`: extrae el par req/resp de un tool id | `summarize_tool_call`, `maybe_summarize_tool_pairs` |
| `context_mgmt/mod.rs:543-589` | `summarize_tool_pair`: 1 llamada one-shot, prompt «summarize a tool call & response pair» | `summarize_tool_call`, op de pares |
| `context_mgmt/mod.rs:601-671` | `summarize_tool_call_groups`: N pares en **una** llamada, respuesta numerada 1..N | op de pares |
| `context_mgmt/mod.rs:680-727` | `parse_numbered_summaries`: parser estricto del reply numerado | `summarize_tool_call_groups` |
| `context_mgmt/mod.rs:790-887` | `maybe_summarize_tool_pairs`: ruta vieja con `tokio::spawn` | **solo tests** (`mod.rs:1579`) |
| `context_mgmt/recent.rs:5-43` | `recent_start`: cuánta cola queda literal tras compactar | `compact_messages` (`mod.rs:176`) |
| `context_limit.rs:7-10` | `get_context_limit(provider, model)` + `AEGIS_CONTEXT_LIMIT` override | `compact_messages`, `do_compact` |
| `context_limit.rs:12-41` | `get_local_context_limit` (bedrock/local/declarative, sin discovery) | providers locales |

### 1.3 Crate reutilizable (`crates/aegis-context-management/src/`)

| ruta:linea | qué hace | quién la llama |
|---|---|---|
| `lib.rs:34` | `DEFAULT_COMPACTION_THRESHOLD = 0.8` | `aegis::context_mgmt` (re-export `mod.rs:25`) |
| `lib.rs:37-49` | traits `CompactionInput` / `CompactionOutput` | API para SDK (`aegis-sdk`, uniffi) |
| `lib.rs:51-66` | `compact()` de alto nivel | sin llamadores en el harness |
| `model.rs:13-26` | traits `CompactionModel` / `TokenEstimator` | `summarize`, `chunked` |
| `model.rs:28-52` | `ProviderModel` (provider + ModelConfig) | `CompactingProvider` |
| `provider.rs:18-110` | `CompactingProvider`: reintenta ante `ContextLengthExceeded` con historial compactado | **sin llamadores en producción** (ver §6) |
| `summarize.rs:14` | `REMOVAL_PERCENTAGES = [0,10,20,50,100]` | `summarize_with_retry_policy` |
| `summarize.rs:16-17` | `SUMMARIZE_REQUEST_TEXT` = «Please summarize the conversation history provided in the system prompt.» | ídem |
| `summarize.rs:39-76` | `filter_tool_responses`: tira tool responses **del medio hacia afuera** | ídem |
| `summarize.rs:81-99` | `apply_structured_summary` → devuelve `structured: bool` | `summarize_with_retry_policy` |
| `summarize.rs:101-125` | `ensure_usage_tokens`: estima input/output si el provider no los reporta | ídem |
| `summarize.rs:130-209` | `summarize` / `summarize_with_retry_policy` (política `allow_tool_drop`) | `chunked`, `provider.rs` |
| `chunked.rs:12-13` | `MAX_STAGES = 8`, `MAX_REQUESTS = 128` | `summarize_in_chunks*` |
| `chunked.rs:50-87` | `validate()`: vacío / truncado / budget lleno / «implausibly short» | ídem |
| `chunked.rs:115-286` | `summarize_in_chunks_with_single_message_budget`: pipeline multi-etapa | `do_compact` |
| `format.rs:4-83` | `format_message_for_compacting`: texto plano `[role]: …` (thinking y redacted-thinking **se omiten** `:64-65`) | `summarize`, `chunked`, ops de pares |
| `templates.rs:5-8,49-59` | prompts embebidos (`include_dir!`) y `render` minijinja con filtro `code_fence` | `Templates`, `compact_messages` |
| `structured.rs` | `StructuredSummary::parse` / `render_with` (contrato JSON del resumen) | `summarize.rs:82-85` |
| `prompts/compaction.md` | prompt del resumidor: contrato JSON (`user_intent`, `pending_tasks`, `current_work`, `next_step`, `problem_solving`, `errors_and_fixes`, `files`, `technical_concepts`, `user_messages`) | `Templates::default` |
| `prompts/compaction_summary.md` | plantilla del resumen renderizado (secciones en inglés) | `apply_structured_summary` |

### 1.4 Decisión y ejecución (`crates/aegis/src/agents/…`, `acp/…`)

| ruta:linea | qué hace | quién la llama |
|---|---|---|
| `agents/agent.rs:658` | `let compaction_threshold = context_mgmt::auto_compact_threshold(context_limit)` | `build_state_machine` (o equivalente) |
| `agents/agent.rs:659-663` | `AEGIS_TOOL_CALL_CUTOFF` o `compute_tool_call_cutoff(...)` | ídem |
| `agents/agent.rs:667-672` | `AEGIS_TOOL_PAIR_COMPACT_MIN_RATIO` (default 0.5, clamp 0..1) × umbral → `pair_compaction_min_tokens` | ídem |
| `agents/agent.rs:683-693` | registra `CompactionOperation` solo si `!manages_own_context` | ídem |
| `agents/agent.rs:695-702` | registra `ToolPairCompactionOperation` | ídem |
| `state_machine/ops_compaction.rs:27` | `MAX_CONTEXT_ERROR_COMPACTIONS = 2` | `run` |
| `state_machine/ops_compaction.rs:29-52` | `compaction_part`: bloque `<compaction>…</compaction>` para el modelo (avisa desde 25% del techo) | `moim_parts` |
| `state_machine/ops_compaction.rs:56-66` | `unreported_tool_tokens`: tokens de tool results posteriores a la última inferencia | `context_tokens` |
| `state_machine/ops_compaction.rs:103-107` | `compact_requested` (marca de la tool `compact_context`) | `run` |
| `state_machine/ops_compaction.rs:111-140` | `record_compaction` → `CompactionLogState` en `session.extension_data` | `run`, `run_command` |
| `state_machine/ops_compaction.rs:169-177` | `context_tokens = max(reportado + no reportado, contado)` | `run`, `moim_parts` |
| `state_machine/ops_compaction.rs:234-297` | `/compact` manual (`manual_compact = true`) | slash command |
| `state_machine/ops_compaction.rs:316-462` | `run`: decide auto/manual/tool y ejecuta | state machine |
| `state_machine/ops_tool_pair_compaction.rs:43-115` | `summarize_detached`: batchea de a 10, fallback 1×par | `run` |
| `state_machine/ops_tool_pair_compaction.rs:181-238` | `apply_summaries`: oculta el par (`agent_visible:false`) y **emite el resumen como mensaje nuevo** | `run` |
| `acp/server.rs:971-1037` | `build_usage_updates`: `used`, `context_limit`, `auto_compact_at/pct`, bitácora | notificación `UsageUpdate` |
| `acp/server.rs:1068-1073` | `estimate_message_tokens`: proxy barato = `chars/4` del JSON del contenido | `build_usage_updates`, `context_breakdown` |
| `acp/server.rs:1145-1244` | `context_breakdown`: filas del desglose, incluida `oculto por compactacion` | `build_usage_updates` |
| `acp/server.rs:904-921` | `compaction_usage`: costo de los one-shot de pares (marcados `is_compaction`) | `build_usage_updates` |
| `acp/server/config.rs:279-282` | preferencia editable `AutoCompactThreshold` ↔ `AEGIS_AUTO_COMPACT_THRESHOLD` (0 < x ≤ 1) | cliente ACP |
| `session_context.rs` | **no es contexto de tokens**: propaga `agent-session-id` por header/task-local | providers HTTP |

---

## 2. Flujos concretos

### 2.1 Cómo se calcula el contexto usado

Hay **tres números distintos** y solo uno decide compactar.

**(a) Conteo exacto-por-tokenizer (no exacto por modelo)** — `TokenCounter::count_chat_tokens`
(`token_counter.rs:136-184`):

```
num = 0
if system != "":            num += count_tokens(system) + 4
para cada mensaje:
    si !metadata.agent_visible → se salta entero          (:150-152)
    num += 4                                              (:153)
    + count_tokens(texto)                                 (:155-156)
    + count_tokens("{id}:{name}:{args:?}") si es ToolRequest (:157-164)
    + count_tokens(texto del toolResult) si es ToolResponse  (:165-166)
    + count_tokens(thinking.thinking) si es Thinking       (:167-170)
    + 32 si es RedactedThinking                            (:171-172)
si hay tools: num += count_tokens_for_tools(tools)         (:177-179)
num += 3                                                   (:181)
```

- Tokenizer: **`o200k_base` de OpenAI** para *todos* los modelos (`:221`). Para
  `deepseek-v4.1-flash` (el modelo vivo de `open_design`) y para cualquier Anthropic es
  **heurística**, no el tokenizer real. Con texto español/código la desviación típica es de
  pocos por ciento; con tablas markdown y base64 puede ser mucho mayor.
- Tool schemas: aproximación por constantes fijas (`:17-22`), no se serializa el JSON schema.
- **Qué NO entra:** mensajes `agent_visible == false` (historial ya compactado), imágenes y
  documentos (no hay rama para `Image`/`Document`: solo se suman los 4 tokens del mensaje),
  `SystemNotification`, `Error`, `ActionRequired`, recursos MCP, y el texto del *prefijo*
  cacheado por el provider. El system prompt **sí** entra, pero solo cuando el llamador lo pasa:
  `count_context_tokens` (`mod.rs:271-281`) lo llama con `""`, así que el uso que decide el
  umbral **no** incluye el system prompt ni los tools.
- Cache: LRU de 8192 entradas con clave `blake3`, compartido a nivel proceso
  (`token_counter.rs:228-237`). El cache se indexa por texto exacto, así que un solo turno
  nuevo invalida solo su propia entrada.

**(b) Lo que reporta el provider** — `session.usage.total_tokens`, que es el `usage` de la
**última inferencia** (`ops_compaction.rs:163-168`). No incluye lo que llegó después de esa
inferencia (tool results, mensajes del usuario en cola).

**(c) El número que usa la UI** — `build_usage_updates` (`acp/server.rs:971-1037`):

```
reportado = session.usage.total_tokens            (:980)
estimado  = Σ estimate_message_tokens(m) sobre agent_visible   (:981-992)  // chars/4
used      = max(reportado, estimado)              (:993)
```

`estimate_message_tokens` = `len(JSON del content) / 4` (`:1068-1073`): **no** es tiktoken, es
un proxy de caracteres, y no cuenta el system prompt.

### 2.2 Quién decide compactar

`CompactionOperation::run` (`ops_compaction.rs:316-462`), en este orden exacto:

1. `manages_own_context` → `not_applicable` (`:322-325`).
2. `requested_by_tool` = marca de `CompactRequestState` (`:329`, `:103-107`).
3. `reactive_context_error` = el último mensaje es un error `ContextLengthExceeded`
   (`:331-334`). Si hay más de `MAX_CONTEXT_ERROR_COMPACTIONS = 2` errores de contexto ya
   ocultos, abandona (`:344-346`).
4. Si **no** hay error reactivo:
   - no compacta si la cola efectiva es `Assistant`, si se esperan tool responses, o si hay un
     `FinalOutputTool` exitoso (`:351-361`) — salvo pedido explícito del modelo.
   - `tokens = context_tokens(session, conversation)` (`:362`) y
     `over_threshold(tokens)` = `tokens / context_limit > threshold` (`:156-161`);
     `tokens <= 0` también aborta (`:370`).
5. Emite aviso inline (`:389-399`) + «aegis is compacting the conversation...».
6. `compact_messages(..., manual_compact = false)` (`:411-419`).

Umbral efectivo (`mod.rs:49-64`):

```
threshold = AEGIS_AUTO_COMPACT_THRESHOLD   || DEFAULT_COMPACTION_THRESHOLD (0.8)
si 0 < threshold < 1 y context_limit > 0:
    threshold = min(threshold, AEGIS_AUTO_COMPACT_TOKEN_LIMIT / context_limit)
```

Con el store vivo: `context_limit = 1_048_576` (open_design), `AEGIS_AUTO_COMPACT_TOKEN_LIMIT = 500000`
→ **threshold = 0.476837…** y `auto_compact_at = 500000` tokens. Disabled si el umbral queda
`<= 0` o `>= 1` (`:328-332`, `:317-320`).

### 2.3 Qué se resume y con qué modelo

`compact_messages` (`mod.rs:112-267`):

1. `recent_start = recent::recent_start(messages, context_limit)` (`:176`). Presupuesto de cola
   literal = `(context_limit / 8).min(128_000)` (`recent.rs:11`) recorriendo **de atrás hacia
   adelante**, cortando en un mensaje `user` de texto que no sea tool req/resp y que no sea
   turn-context (`recent.rs:20-41`). El `start` solo se acepta si hay historial visible antes
   (`:42`).
2. `older_messages = messages[..recent_start]` (o todo si no hay cola) (`:177-179`).
3. `do_compact` (`:387-430`):
   - filtra `is_turn_context` y se queda con agent-visible (`:394-400`);
   - `context_limit = get_context_limit(provider, model_name)` (`:402-403`);
   - `output_budget = (context_limit / 16).clamp(4_096, 32_768)` → **32768** con 1M (`:406`);
   - `compaction_input_budgets` (`:31-45`):
     `safe = limit - output - limit/10`;
     `input_budget = min(limit*3/5, 64_000, safe)` → **64000**;
     `single_message_input_budget = input_budget + min(safe - input_budget, 64_000)` → **128000**;
 - resumidor = **el mismo provider y modelo de la sesión**, vía
   `model_config::complete_one_shot(..., model_config.with_max_tokens(output_budget), ...)`
   (`mod.rs:344-362`). No hay modelo de compactación separado.
4. `summarize_in_chunks_with_single_message_budget` (`chunked.rs:115-286`):
   - etapa 1..=8 (`MAX_STAGES`), máximo 128 requests (`MAX_REQUESTS`);
   - por etapa arma lotes por presupuesto: primero corta por caracteres
     (`input_budget * 3`, `chunked.rs:142`), después mide tokens reales y encoge mientras
     `end > cursor+1` (`:148-153`); un solo mensaje puede usar hasta
     `single_message_input_budget` (`:154-158`);
   - cada lote se resume con `summarize_with_retry_policy(..., allow_tool_drop = false)`
     (`:184-190`), o sea **sin** tirar tool responses: si el lote no entra, se parte;
   - `validate()` (`:50-87`) rechaza vacío, `finish_reasons` con `max_token|length|truncat`,
     `output_tokens >= output_budget - 32`, y texto < 100 chars con input > 2000;
   - lote que llena el budget → **parte el lote** (`:215-229`), no aborta;
   - guard final: si `next.len() >= working.len()` y el texto no encogió → error
     `Compaction did not reduce…` (`:273-282`).
5. Prompt del resumidor: `prompts/compaction.md` (contrato JSON de 9 claves, «most recent user
   correction» tiene prioridad). La respuesta se re-renderiza con `compaction_summary.md`
   (`summarize.rs:81-99`); si el modelo ignora el JSON, se conserva el texto crudo y
   `structured = false` (`chunked.rs:203-211` avisa con warn).
6. Reintentos si el resumidor se pasa de ventana (`summarize.rs:146-204`): `0%, 10%, 20%, 50%,
   100%` de tool responses eliminados desde el medio hacia afuera (`filter_tool_responses`,
   `:39-76`). Errores finales literales:
   - sin tool responses: «Failed to compact: the base prompt (system prompt, tool schemas, and
     conversation) exceeds the model's effective context window…» (`:190-194`);
   - agotada la escalera: «Failed to compact: context limit exceeded even after removing all
     tool responses» (`:197-201`).

### 2.4 Post-proceso del historial (`mod.rs:184-253`)

Invariantes de visibilidad, en orden:

1. **Todos** los mensajes originales pasan a `agent_visible = false` (`:190-194`) —
   `with_agent_invisible()`; siguen `user_visible` (el usuario los ve, el modelo no).
2. El resumen se marca `MessageMetadata::agent_only()` (`:196`) → `user_visible=false`,
   `agent_visible=true`.
3. Se agrega un mensaje `assistant` de continuación, también agent-only, con uno de tres
   textos: `MANUAL_COMPACT_CONTINUATION_TEXT` (manual), `CONVERSATION_CONTINUATION_TEXT`
   (la cola era el último turno), `TOOL_LOOP_CONTINUATION_TEXT` (loop de tools)
   (`:200-212`). Los tres dicen «Do not mention that you read a summary» y mandan a
   `chatrecall current_session=true` para recuperar originales.
4. `merge_consecutive_messages` fusiona resumen + continuación en un solo mensaje
   (`:214-215`) para no romper la alternancia de roles.
5. La cola literal se **re-emite** como copias con `id = None`, `created = continuation.created`
   (`:216-225`) — se reinsertan al final, no en su posición original.
6. Si había un mensaje de usuario preservado y no cae dentro de la cola reciente, se agrega al
   final (`:227-232`).
7. Se arrastra el turn-context del turno en curso (`:236-251`), con `created` bumpeado al
   máximo para que el orden de recarga del store lo deje al final.
8. `retained_context_tokens = count_context_tokens(conversation)`; si falla, cae a
   `usage.output_tokens` del resumen (`:254-260`).

### 2.5 Tool-pair summarization

Regla de elegibilidad (`mod.rs:459-491`):

```
tool_call_ids = todos los ToolRequest de mensajes agent_visible
eligible = len(ids) - protect_last_n              (protect_last_n = tool calls del turno actual)
si eligible <= cutoff + TOOLCALL_SUMMARIZATION_BATCH_SIZE (10) → no hace nada
toma los primeros min(limit, eligible - cutoff) ids  (de los más viejos)
```

`cutoff = (3 * context_limit * threshold / 20_000).clamp(10, 500)` (`mod.rs:434-442`) → **74**
con 1M×0.4768.

Gate perezoso (`ops_tool_pair_compaction.rs:300-307`): no compacta pares hasta que
`session.usage.total_tokens >= context_limit * threshold * AEGIS_TOOL_PAIR_COMPACT_MIN_RATIO`
(0.65 en el store → ~325k). Nota: acá se usa el **reportado**, no `context_tokens`.

Cómo se evita romper roles (`ops_tool_pair_compaction.rs:336-400`):

- solo pares `len == 2` (un ToolRequest + un ToolResponse) y con `id` persistido;
- `request_ids == response_ids` — un mensaje puede traer varios tool calls paralelos; si los
  hermanos se contestan en otro mensaje, se saltea (`:379-393`);
- un mensaje ya reservado en este lote no se vuelve a agrupar (`hidden_messages`, `:371-378`);
- nada del turno actual (`:351-356`).

Cómo se aplica (`:181-238`): se ocultan los dos mensajes del par
(`SetMessageVisibility{agent_visible:false}`) y **se emite el resumen como mensaje nuevo**, con
`role = User` (`mod.rs:581`, `:658`), `metadata = agent_only` y
`metadata.usage = Some(… from_provider_usage(&usage, is_compaction = true))`
(`mod.rs:586`, `:664-667`) — así el costo de compactar deja de ser invisible. Punto de inserción:
el efecto `ConversationEffect::Message` lo agrega al final del historial (append), no en el lugar
del par; el orden temporal se preserva con `created = matching_messages.last().created`
(`mod.rs:582`).

El trabajo corre **detached** (`:407-435`): el mensaje del usuario llega al modelo mientras los
resúmenes se generan; se aplican en un pase posterior (`:280-299`). Si nunca se recogen, el par
queda intacto y elegible la próxima vez (`:26-29`).

Fallback: se intenta **una llamada por lote de 10 pares** (`summarize_tool_call_groups`,
`mod.rs:601-671`, parser `parse_numbered_summaries` `:680-713`); si el reply no rinde
exactamente N líneas numeradas 1..N, se descarta todo el batch y se hace **una llamada por par**
(`ops_tool_pair_compaction.rs:43-115`).

### 2.6 El techo y el budget de salida

| parámetro | dónde vive | valor vivo | efecto |
|---|---|---|---|
| `AEGIS_AUTO_COMPACT_TOKEN_LIMIT` | `state\config\config.yaml:4` | `500000` | cap absoluto: `threshold = min(0.8, 500000/limit)` → **0.4768** con 1M |
| `AEGIS_AUTO_COMPACT_THRESHOLD` | config/env, UI (`acp/server/config.rs:279-282`) | ausente → `0.8` | se clampea contra el cap |
| `AEGIS_CONTEXT_LIMIT` | env (`config/base.rs:1331-1338`) | ausente | override duro de la ventana |
| ventana por modelo | `ContextLimitResolver` (`aegis-provider-types/src/context_limit.rs:44-86`) | `DEFAULT_CONTEXT_LIMIT = 128_000` (`model.rs:11`) | precedencia: override → declarativo → discovery → canónico → 128k |
| `output_budget` compactación | `mod.rs:406` | `(limit/16).clamp(4096, 32768)` → 32768 | `max_tokens` del resumidor |
| `input_budget` | `mod.rs:35-39` | 64000 | lote multi-mensaje |
| budget de un mensaje indivisible | `mod.rs:40-43` | 128000 | único mensaje |
| cola literal post-compactación | `recent.rs:11` | `(limit/8).min(128000)` | 128k de historial verbatim |
| batch de pares | `mod.rs:27` | 10 | por llamada/concurrencia 4 (`ops_tool_pair_compaction.rs:317-320`) |

**Si el provider reporta más tokens que el techo:** no se recorta nada en el camino de lectura;
el exceso dispara compactación en el próximo `run` (`over_threshold`) o, si el provider devuelve
`ContextLengthExceeded`, la ruta reactiva (`ops_compaction.rs:331-346`) oculta el mensaje de error
y compacta, con tope de 2 intentos y después «Please try again or create a new session»
(`:449-459`). El techo de 500k es **solo** un umbral de compactación: la ventana real que se
declara al cliente sigue siendo la del modelo (1.048.576), y `used` puede superar
`auto_compact_at` sin que nada lo impida por código.

### 2.7 Bitácora de compactaciones

- Estado: `CompactionLogState` en `session.extension_data`, entrada
  `{at, before_tokens, after_tokens, trigger, note}` (`ops_compaction.rs:125-133`).
  `trigger` ∈ `"manual"` (`:274`), `"auto"` (`:433`), `"tool"` (`:431`, con `note` del modelo).
- `before_tokens = context_tokens(...)` (máximo entre reportado y contado, `:422-426`);
  `after_tokens = result.retained_context_tokens` (`:426`).
- Salida al cliente: `compaction_log_rows` → `SessionUsageUpdate.compaction_log`
  (`acp/server.rs:1009`, `:1121-1143`).
- Costo: cada resumen de par/compaction lleva `metadata.usage` con `is_compaction = true`
  (`mod.rs:584-586`); `compaction_usage` (`acp/server.rs:904-921`) los suma a
  `compaction_calls / compaction_input_tokens / compaction_output_tokens`.
  **La compactación completa (`/compact`, auto) NO escribe `usage_ledger`**: solo el mensaje de
  resumen con su marca. Es deuda, ver §6.

---

## 3. Invariantes y trampas

1. **`agent_visible` es la única fuente de verdad del contexto.** Todo conteo que decide
   (auto-compact, `count_context_tokens`, `build_usage_updates`) filtra por
   `message.is_agent_visible()`. La auditoría del 17/10 midió que sin ese filtro la UI mostraba
   1.29M con techo de 500k (`660d9ff2c`); el fix está vivo en `acp/server.rs:988`.
2. **El historial oculto no se borra**: se marca `agent_visible = false` y sigue en el store.
   Eso es lo que hace que `sessions.db` crezca (93k mensajes, 513 ocultos en una sola sesión
   según `docs/auditoria-contexto-20261017.md:12-18`).
3. **`session.usage` describe el pasado.** Es el usage de la última inferencia; el código lo
   trata como piso y siempre lo compara con el conteo (`ops_compaction.rs:169-177`). La
   excepción es el gate de pares, que usa solo el reportado (`ops_tool_pair_compaction.rs:303`).
4. **`role` de los resúmenes es `User`**, no `Assistant` (`mod.rs:581`, `:658`; y
   `summarize.rs:167`). Cualquier refactor que lo cambie rompe la alternancia y el
   `merge_consecutive_messages` de la continuación.
5. **`format_message_for_compacting` omite thinking** (`format.rs:64-65`), pero
   `count_chat_tokens` **sí cuenta thinking** (`token_counter.rs:167-170`). Los lotes se miden
   con el estimador pero el prompt que ve el resumidor no incluye el thinking: hay un
   desbalance estructural de hasta el tamaño del thinking por mensaje.
6. **El tokenizer es o200k para todos.** `deepseek-v4.1-flash` no usa o200k; el conteo es
   aproximado, y el `chars/4` de la UI es una tercera aproximación. Nunca coincide con el
   `usage` del provider y no debe usarse para comparar costos.
7. **La ruta de compactación no puede «perder» mensajes**: si un lote falla, `do_compact`
   devuelve `Err` y `CompactionOperation` deja el historial intacto (`:449-459`,
   `chunked.rs:249-263`). El único camino que descarta datos es el que oculta el mensaje de
   error de contexto (`ops_compaction.rs:375-386`) — y ese mensaje es del propio harness.
8. **Los tool results gigantes no se truncan en el camino de contexto**: se resumen por par
   (si el ratio lo permite) o se cuentan enteros. La poda por tamaño es un script externo
   (`core\ops\truncate-tool-results.mjs`), que conserva encabezado y cola, tira base64 de
   imágenes y marca `metadata_json` con `truncated`/`truncatedOriginalBytes`/`truncatedBlocks`.
9. **`/compact` no dice «threshold»**: el manual comparte el motor pero cambia los textos
   (`mod.rs:200-206`) y no preserva el mensaje de usuario (`:169-171`).
10. **El aviso `<compaction>` se publica desde el 25% del techo** (`ops_compaction.rs:40-44`),
    no desde el 50% que documentaba la auditoría vieja (`docs/auditoria-contexto-20261017.md:22`).

---

## 4. Comparación local vs GitHub

### 4.1 Estado de remotos (verificado con `git`)

| ref | commit | qué tiene |
|---|---|---|
| local `feat/antigravity-provider` | `660d9ff2c` | árbol completo con `aegis-*` (rename hecho) |
| `origin` = `aegis-harness` `main` | `3bd852002` | **rename a medias**: sigue teniendo `crates/goose-context-management/**` y `crates/goose/src/context_mgmt/**`; no tiene `chunked.rs` |
| `upstream` = `block/goose` `main` | `0df818175` | `crates/goose-context-management/**` sin `chunked.rs` |

`git diff --stat origin/main...HEAD` sobre los paths de contexto da **20 archivos, 9849
inserciones, 0 borrados**, porque todas las rutas cambiaron de `goose-*` a `aegis-*`. Comparado
path-contra-path (renombrando a mano) el delta real es:

| archivo local | vs `origin/main` (goose) | vs `upstream/main` (goose) | delta |
|---|---|---|---|
| `aegis-context-management/src/summarize.rs` | 38+/11- | 38+/11- | `Summary.structured`, `apply_structured_summary -> bool`, `summarize_with_policy(allow_tool_drop)` |
| `aegis-context-management/src/lib.rs` | 5+/3- | ídem | re-export `chunked`, `DEFAULT_COMPACTION_THRESHOLD` |
| `aegis-context-management/src/chunked.rs` | **existe solo acá** (564 líneas) | **no existe** | pipeline multi-etapa completo |
| `aegis/src/context_mgmt/mod.rs` | 413+/79- | 573+/78- | `compaction_input_budgets`, `recent_start`, `summarize_tool_call_groups`, `unreported_tool_tokens` en op, budgets escalados |
| `aegis/src/context_mgmt/recent.rs` | **solo local** | **no existe** | cola literal proporcional a la ventana |
| `aegis/src/token_counter.rs` | solo local (368 líneas) | existe en upstream, distinto | `shared_token_counter`, LRU 8192, thinking/redacted |
| `aegis/src/context_limit.rs` | solo local | existe | `get_local_context_limit` |
| `prompts/compaction.md` | 24+/32- | ídem | reescrito: contrato JSON más corto, prioridad a la corrección más reciente |

### 4.2 Tabla de propiedad

| pieza | existe solo local | atrasado en `origin/main` | goose puro (upstream) |
|---|---|---|---|
| `chunked.rs` (lotes, `MAX_STAGES=8`, `MAX_REQUESTS=128`, `validate`) | ✅ | ✅ ausente | ✅ ausente |
| `recent.rs` (cola literal `limit/8`) | ✅ | ✅ ausente | ✅ ausente |
| `summarize_tool_call_groups` + `parse_numbered_summaries` | ✅ | ✅ ausente | ✅ ausente |
| `ToolPairCompactionOperation` (detached, `AEGIS_TOOL_PAIR_COMPACT_MIN_RATIO`) | ✅ (`ops_tool_pair_compaction.rs`) | ✅ | ✅ |
| `CompactionLogState` (bitácora) + `compact_requested` (tool `compact_context`) | ✅ | ✅ | ✅ |
| `unreported_tool_tokens` / `context_tokens = max(...)` | ✅ | ✅ | ✅ |
| `build_usage_updates` con `used = max(reportado, estimado)` + desglose | ✅ | parcial (el desglose existe; el `max` es local `32c2fc582`) | ✅ |
| `AEGIS_AUTO_COMPACT_TOKEN_LIMIT` como cap absoluto | ✅ (`mod.rs:49-64`) | ✅ | ✅ |
| `CompactingProvider` (retry ante `ContextLengthExceeded`) | heredado | heredado | heredado, **sin uso** |
| `maybe_summarize_tool_pairs` | heredado | heredado | heredado, **solo tests** |
| `check_if_compaction_needed` | heredado | heredado | heredado, **muerto** |
| `session_context.rs` | heredado | heredado | heredado (headers de sesión, no tokens) |

### 4.3 Commits propios relevantes (`git log --grep=contexto`)

| commit | título | qué dejó |
|---|---|---|
| `660d9ff2c` | el usado de la UI no cuenta el historial oculto | filtro `is_agent_visible` en `build_usage_updates` — **vivo** (`acp/server.rs:988`) |
| `960bdc5e5` | bitácora de compactaciones en el estado y en `usage_update` | `CompactionLog*` |
| `32c2fc582` | el uso que ve el modelo y el usuario no subestima el contexto | `max(reportado, estimado)`, `unreported_tool_tokens` |
| `7751dbe25` | el pedido de compactación del modelo compacta por debajo del techo | tests del budget |
| `933bc945e` | el modelo puede pedir su propia compactación y el techo sube a 500k | tool `compact_context`, 350k→500k |
| `1cab47e66` | cuenta thinking en el estimador | `token_counter.rs:167-173` |
| `8fc9096d9` | la ventana reciente post-compactación escala con la ventana | `recent.rs` |
| `f42cd8e31` | un resumen completo sin JSON ya no aborta | `structured: bool` |
| `830d69cec` | compactación por pares sin bloquear el turno | op de pares detached |

---

## 5. Referencias web

- tiktoken (BPE de OpenAI, `o200k_base`): `https://github.com/openai/tiktoken` — encodings en
  `https://github.com/openai/tiktoken/blob/main/README.md` («`o200k_base`», `encoding_for_model`).
- Contabilidad de tokens y unidades de cobro en DeepSeek:
  `https://api-docs.deepseek.com/quick_start/token_usage`.
- Nombres de modelo vivos de DeepSeek (confirma que `deepseek-v4.1-flash` se sirve como
  `deepseek-flash`): `https://api-docs.deepseek.com/quick_start/pricing`.
- Repos upstream: `https://github.com/block/goose` (crate `goose-context-management`),
  `https://github.com/emilianodamir874/aegis-harness` (fork, main atrasado).

No encontré una spec pública de *summarization de conversación* con contrato JSON; el contrato
de `prompts/compaction.md` es propio de este fork.

---

## 6. Huecos, riesgos y deuda técnica (con evidencia)

| # | hallazgo | evidencia | impacto |
|---|---|---|---|
| 1 | `check_if_compaction_needed` es **código muerto**: solo aparece en su definición y en dos doc-comments | `context_mgmt/mod.rs:104,270,284`; grep en `crates/**` no encuentra llamadores | doble fuente de verdad del umbral (su lógica es *distinta* de `CompactionOperation::over_threshold`: no suma tool results no reportados) |
| 2 | `maybe_summarize_tool_pairs` (ruta vieja, `tokio::spawn`, sin batching numerado) queda vivo y solo se usa en tests | `context_mgmt/mod.rs:790-887`, llamada en `mod.rs:1579` (dentro de `#[cfg(test)]`) | código duplicado del camino real (`ToolPairCompactionOperation`) |
| 3 | `CompactingProvider` no se instancia en producción | `aegis-context-management/src/provider.rs:18`; grep en `crates/**` solo encuentra test propio `:138` | la capa «retry por `ContextLengthExceeded`» existe pero nadie la envuelve: el harness usa la ruta reactiva de la op |
| 4 | El conteo que decide el umbral **no incluye system prompt ni tool schemas** | `count_context_tokens` llama `count_chat_tokens("", …)` (`mod.rs:278`) y `token_counter.rs:177-179` solo suma tools si se pasan | con muchos tools/hints el `used` real puede estar decenas de miles arriba del que dispara la compactación; el residual aparece en la fila `sistema + herramientas (est.)` de la UI |
| 5 | Tokenizador único o200k para todos los modelos | `token_counter.rs:221` | sesgo sistemático con deepseek/gemini/claude |
| 6 | `estimate_message_tokens` es `chars/4` mientras el desglose se calibra contra `used` | `acp/server.rs:1068-1073`, `:1190-1194` | la UI es consistente consigo misma pero no con el conteo del motor; dos aproximaciones distintas en la misma pantalla |
| 7 | La compactación **completa** no escribe `usage_ledger`; solo los pares dejan marca | `ops_compaction.rs:278,439` (`record_chat_usage` al span); `summarize.rs` no toca ledger; `acp/server.rs:904-921` solo lee mensajes marcados | el costo de `/compact` y del auto-compact sigue siendo parcialmente invisible (la auditoría del 17/10 ya lo señalaba, `docs/auditoria-contexto-20261017.md:28-29,85-87`) |
| 8 | El gate de pares usa el usage reportado, no `context_tokens` | `ops_tool_pair_compaction.rs:302-306` vs `ops_compaction.rs:169-177` | en un loop de tools los pares pueden compactarse tarde (el reportado va por detrás) |
| 9 | Los budgets y el techo están en YAML de operador, sin validación de coherencia | `state\config\config.yaml:4` vs `mod.rs:49-64` | si `AEGIS_AUTO_COMPACT_TOKEN_LIMIT > limit`, el `min` lo absorbe; si es 0, `auto_compact_threshold` lo ignora silenciosamente (`filter(|limit| *limit > 0)`) |
| 10 | `_ctx_probe.py` apunta a `%APPDATA%\Aegis\aegis\data\sessions\sessions.db` (ruta inexistente hoy) | `web\tools\_ctx_probe.py:3` vs `_ctx-db-*.py:3` (que sí usan `C:\Aegis-Proyects\state\…`) | sonda de diagnóstico rota; el resto de `_ctx-*` está bien |
| 11 | `output_budget` del resumidor ignora el peso del thinking del propio resumidor | `mod.rs:406` + `done_compact` no fija `ThinkingEffort::Off` explícito; el fix del 17/10 vive en el provider | si el alias `-max` vuelve a ganar (`docs/auditoria-contexto-20261017.md:39-47`), el split recursivo reaparece: es una regresión latente que solo cubre un test de provider |
| 12 | `compact_messages` conserva el turn-context **bumpeando `created`** al máximo | `mod.rs:242-250` | depende del orden de recarga por `created_timestamp`; si un mensaje futuro trae un `created` mayor, el turn-context queda intercalado |

---

## 7. No verificado

- No ejecuté `cargo test` ni ningún binario: todo lo anterior es lectura de código y de config.
- No medí el `used` real de la sesión viva en `llm_request.*.jsonl` ni contrasté `used` de la UI
  contra `usage` del provider; la afirmación de que `used >= real` es lectura de
  `ops_compaction.rs:169-177`, no medición.
- No leí `crates/aegis-context-management/src/structured.rs` línea por línea (494 líneas): solo
  su contrato por los llamadores (`parse` / `render_with`). El detalle de tolerancias del parser
  JSON queda sin auditar.
- No verifiqué qué provider concreto responde `ContextLengthExceeded` para `open_design`
  (depende del mapeo HTTP→`ProviderError`, fuera de mi alcance).
- No comparé el `token_counter.rs` local contra el de `upstream/main` línea por línea (solo sé
  que ambos existen y que el local agrega `shared_token_counter` y el conteo de thinking).
- El valor 350k del enunciado corresponde al estado del 26–28/10; no hay ningún 350000 en el
  árbol ni en el store a la fecha de este informe.

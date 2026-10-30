# 01 — El turno del agente (agent loop / reply execution)

Dominio: `crates/aegis-agent/src/**`, `crates/aegis/src/agents/**` (incl. `state_machine/`), `crates/aegis/src/conversation/`, `crates/aegis/src/execution/`, más los módulos sueltos `tool_monitor.rs`, `tool_inspection.rs`, `action_required_manager.rs`, `elicitation.rs`, `builtin_extension.rs`, `tool_call_labels.rs`, `subprocess.rs`, y `lib.rs`.

Hallazgo estructural que ordena todo lo demás: **el turno ya no es un loop escrito a mano**. Es una `StateMachine` declarativa que recorre una lista ordenada de `Step`s por pasada y se re-ejecuta mientras el estado persistido diga `Continuing`. Cada paso es un *handler* que mira la conversación persistida, decide si le toca (`NotApplicable`) o aplica un `Effect`. El modelo no "llama herramientas": el turno se **reconstruye** desde el log de mensajes en cada iteración.

Rutas absolutas base: `C:\Aegis-Proyects\src\crates\...`. Abajo, `A/` = `aegis-agent/src/`, `AG/` = `aegis/src/agents/`.

---

## 1. Mapa de piezas

### 1.1 Runtime genérico (`crates/aegis-agent`, 6 archivos, ~1.563 líneas)

| ruta:linea | qué hace | quién la llama |
|---|---|---|
| `A/lib.rs:1-5` | declara los 5 módulos: `events`, `inference`, `machine`, `operation`, `tool` | es el crate raíz |
| `A/operation.rs:80-138` | `trait Operation<S,E>`: `name`, `set_message_meta`, `finalize_cancellation`, `run_command`, `inference_tools`, `prompt_parts`, `moim_parts`, `run` | `StateMachine::step` |
| `A/operation.rs:149-165` | `trait Inference: Operation` añade `applies`, `prepare_session`, `infer` | `StateMachine::step` (rama `Step::Inference`) |
| `A/operation.rs:167-183` | `RunStatus {Continuing, Yielded, Cancelled}`, `StepResult`, `OperationResult {NotApplicable, Applied}` | todo el loop |
| `A/operation.rs:213-229` | `ConversationEffect {AppendMessage, ReplaceConversation, PatchToolRequestMeta, SetMessageVisibility}` — **el único lenguaje de mutación del turno** | `StateMachine::apply` → `SessionManager` |
| `A/operation.rs:260-287` | `Emitter`: `mpsc::UnboundedSender<AgentEvent>` + `CancellationToken`; `emit()`, `message()` (genera id y emite) | todas las operaciones |
| `A/operation.rs:25-36` | `messages_since_kickoff`: recorta la conversación desde el último mensaje `role=User`, user-visible y no-tool-response → **frontera del turno** | casi todas las operaciones |
| `A/operation.rs:49-76` | `assistant_turn_count`, `ends_turn` (assistant sin error y sin `ToolRequest`/`ActionRequired`) | `ops_maxturns.rs:60`, `ops_steer.rs:68` |
| `A/machine.rs:55-59` | `StateMachine { steps, cancel, interrupted_step }` | `AG/agent.rs:771` |
| `A/machine.rs:121-190` | `step()`: recorre pasos, `tokio::select!{ biased; execution, cancel }`, devuelve el primer `Applied` | `machine.rs:217` (`run`) |
| `A/machine.rs:211-226` | `run()`: `loop { load(session) → step → apply → Continuing? }` — **el loop real del turno** | `AG/state_machine/session.rs:337` |
| `A/machine.rs:228-263` | `finalize()`: al cancelar, responde tool calls huérfanas (`interrupted_response`, l.69-92) y llama `finalize_cancellation` de cada paso | `machine.rs:225` |
| `A/inference.rs:211-217` | `InferenceRunner { provider, model_config, request_preparer, output: Mutex<InferenceOutput> }` | `AG/agent.rs:757-760` |
| `A/inference.rs:204-209` | `InferenceOutput { accumulator: Conversation, additional_messages, usage }` — **acumulador de reply** (no existe `ReplyParts`) | `InferenceRunner` |
| `A/inference.rs:424-632` | `infer()`: prepara request, `provider.stream()`, consume chunks, emite, cuenta vacíos, reintenta | `machine.rs:155` |
| `A/inference.rs:221-249` | `messages_for_provider`: proyección agent-visible + descarte de tool requests sin respuesta de turnos previos | `infer`/`should_infer` |
| `A/inference.rs:273-282` | `should_infer`: solo si el último mensaje proyectado es `User`/`Tool` | `applies`, `infer` |
| `A/inference.rs:345-383` | `wait_to_retry`: backoff cancelable (`AEGIS_PROVIDER_SKIP_BACKOFF`) | `infer` |
| `A/inference.rs:75-89` | `EMPTY_RESPONSE_MESSAGE` + marcador `inference/empty_response` | `ops_empty_response.rs:31` |
| `A/tool.rs:125-135` | `trait ToolProvider<S>`: `tools(session)`, `call(session, request_id, call, emit)` | `ToolOperation` |
| `A/tool.rs:193-197` | `ToolOperation { registered, providers, response: Mutex<Option<Message>> }` | (variante simple del harness; el server usa `ops_toolcalling`) |
| `A/tool.rs:328-396` | `ToolOperation::run`: junta requests pendientes, ejecuta **secuencial**, arma un único `Message::user()` con todas las respuestas | — |
| `A/events.rs:9-18` | `AgentEvent { Message, Usage, MessageUsage{message_id,usage}, McpNotification((String,ServerNotification)), HistoryReplaced(Conversation) }` | `Emitter` → `aegis-server`/ACP |

### 1.2 Integración Aegis (`crates/aegis/src/agents`)

| ruta:linea | qué hace | quién la llama |
|---|---|---|
| `AG/agent.rs:171-184` | `struct Agent { config, extension_manager, tool_confirmation_coordinator, tool_inspection_manager, hook_manager, steer_queues, tool_pair_compactions }` | `AgentManager::get_or_create_agent` |
| `AG/agent.rs:104-...` | `AgentConfig` (session_manager, permission_manager, scheduler, providers…) | `Agent::with_config` |
| `AG/agent.rs:1084-1106` | `reply()`: entra con `session_context`, sale con `user_event` filter — **única frontera de eventos live** | `acp/server.rs:2904` |
| `AG/agent.rs:1108-1166` | `reply_impl`: asigna id al user message, corta por `ElicitationResponse` (devuelve stream vacío), delega | `reply` |
| `AG/agent.rs:774-790` | `reply_with_state_machine` | `reply_impl` |
| `AG/agent.rs:792-850` | `reply_with_state_machine_inner`: `try_start_turn()` (1 turno por sesión), persiste el user message, lanza naming async, `stream_state_machine_session` | — |
| `AG/agent.rs:993-1052` | `stream_state_machine_session`: crea `Agent`, `mpsc::unbounded_channel`, `Emitter`, corre `run_aegis` y drena con `select!{biased; rx.recv, run}` | `stream_state_machine_turn` |
| `AG/agent.rs:943-991` | `stream_state_machine_turn`: si el stream dejó tool confirmations, **espera respuestas** y re-lanza el turno | `reply_with_state_machine_inner`, `resume_state_machine_turn` |
| `AG/agent.rs:852-921` | `resume_state_machine_turn` (+inner): reanuda turno con confirmaciones pendientes | `acp/server/load_session.rs:345` |
| `AG/agent.rs:624-772` | `create_state_machine`: lee límites de config y **arma el orden de los Steps** (ver §2.2) | `stream_state_machine_session` |
| `AG/agent.rs:186-198` | `user_event`: proyecta a user-visible; descarta mensajes sin contenido | `reply`, `reply_live_delegation` |
| `AG/state_machine/session.rs:23-37` | `impl MachineSession for Session` + `SessionLoader for SessionManager` (recarga desde SQLite en cada paso) | `machine.rs` |
| `AG/state_machine/session.rs:40-154` | `impl EffectHandler`: traduce `AegisEffect` a escrituras de `SessionManager` y a `AgentEvent` | `machine.apply` |
| `AG/state_machine/session.rs:156-187` | `TurnRuntime`: envuelve `SessionManager` y acumula `Usage` del turno | `session.rs:333` |
| `AG/state_machine/session.rs:303-362` | `run_aegis`: hooks de arranque de turno, span, corre la máquina, telemetría | `agent.rs:1026` |
| `AG/state_machine/mod.rs:43-55` | `awaits_tool_responses` | `inference_preparation` |
| `AG/state_machine/inference_preparation.rs:41-59` | `prepare_session`: snapshot de extensiones + renovación de `ExtensionLease` si no hay tool pendiente | `machine.rs:135` |
| `AG/state_machine/inference_preparation.rs:61-107` | `prepare`: filtra tools `never_allow`, ordena, **construye el system prompt**, agrega `turn_context` | `A/inference.rs:448` |
| `AG/state_machine/ops_llm.rs:131-203` | `Provider` wrapper: enriquece errores de tool desconocida, `toolshim`, nota `advertised_tools` | `A/inference.rs:489` |
| `AG/state_machine/ops_toolcalling.rs:982-1179` | `ToolExecutionOperation::run`: pending → lease → segmentación → ejecución → 1 mensaje de respuestas | `machine.step` |
| `AG/state_machine/ops_toolpair_compaction.rs` (416 l.) | compactación perezosa de pares tool-call/result | idem |
| `AG/state_machine/ops_steer.rs:60-97` | `SteerOperation`: inyecta mensajes del operador entre turnos | idem |
| `AG/state_machine/ops_maxturns.rs:53-67` | `MaxTurnsOperation`: corta a `AEGIS_MAX_TURNS` assistant-turns | idem |
| `AG/state_machine/ops_turn_ceiling.rs:120-...` | `TurnCeilingOperation`: techo de tool calls y wall-clock | idem |
| `AG/state_machine/ops_empty_response.rs:23-54` | revela el fallback de respuesta vacía si nadie lo tomó | idem |
| `AG/tool_confirmation_coordinator.rs:17-193` | estado por sesión: `turn_lock`, `confirmations`, `extension_lease`, `Notify` | `agent.rs` |
| `AG/tool_execution.rs:95-149` | `ToolCallResult` (future + notification stream + action_required stream), `tool_stream` (merge con `select!`) | `ops_toolcalling.rs:1131` |
| `AG/tool_inspection.rs:34-53` | `trait ToolInspector` + `InspectionAction`; manager que aplica resultados a permisos | `inference_preparation.rs:69` |
| `AG/tool_monitor.rs:34-99` | `RepetitionInspector`: corta tool calls repetidas | `ToolInspectionManager` |
| `AG/action_required_manager.rs:49-232` | declaraciones de elicitation: `request_and_wait`, `claim_response`, streams por sesión | `extension_manager`, `elicitation` |
| `AG/elicitation.rs:38-64` | cierra una elicitation desde el mensaje del cliente | `agent.rs:1147` |
| `execution/manager.rs:88-146`, `277-311` | `AgentManager`: agentes por sesión, registro de cancel tokens, `cancel_session`, `is_session_busy` | `aegis-server` |
| `execution/active_run.rs:144-...` | `ActiveRunRegistry`: dedupe de prompts por `promptId`, cancel token por run, `touch_progress`, `mark_stalled` | `acp/server.rs` |
| `conversation/rewind.rs:27-210` | `Turn`, `collect_turns`, `hide_tail_from` (rewind por batches) | `acp/server/rewind.rs` |

`crates/aegis-server/src` contiene **solo** `main.rs` y `recipe_runner.rs`: el servidor ACP vive en `crates/aegis/src/acp/` (48 archivos). Es decir, `aegis-server` es un *bootstrap*, no el harness.

---

## 2. Flujos concretos

### 2.1 Secuencia de un turno (texto)

```
Cliente ACP ──session/prompt──► acp/server.rs:2904
   Agent::reply(user_message, SessionConfig, Some(cancel))          agent.rs:1084
     ├ session_context::with_session_id
     ├ reply_impl                                                    agent.rs:1108
     │    ├ user_message.with_generated_id_if_missing()
     │    ├ ¿ActionRequired/ElicitationResponse? → complete_elicitation → stream vacío
     │    └ reply_with_state_machine                                 agent.rs:774
     ├ reply_with_state_machine_inner                                agent.rs:792
     │    ├ turn_guard = coordinator.session(id).try_start_turn()     ← 1 turno por sesión
     │    ├ state.start_new_turn()                                    ← limpia confirmations + lease
     │    ├ session_manager.add_message(user_message)                 ← PERSISTE ANTES DE PENSAR
     │    ├ tokio::spawn(maybe_update_name)                           ← fire and forget
     │    └ stream_state_machine_turn(initial_stream = stream_state_machine_session())
     └ stream_state_machine_session                                 agent.rs:993
          ├ provider = self.provider(id) ; model_config = effective_model_config
          ├ context_limit = get_context_limit(...)
          ├ machine = create_state_machine(...)          ← arma Steps (agente.rs:624-772)
          └ (tx,rx) = mpsc::unbounded_channel::<AgentEvent>()
             Emitter::new(tx, cancel)
             loop tokio::select!{ biased;
                 Some(e) = rx.recv() => yield e,          ← streaming al cliente
                 r = run_aegis(&machine, ...) => break r }
```

Dentro de `run_aegis` (`state_machine/session.rs:303`):

```
load(session) → run_turn_start_hooks(SessionStart/UserPromptSubmit)
StateMachine::run(session_id)                                    machine.rs:211
  loop {
    session = SessionManager.get_session(id, include_hidden=true)   ← RECARGA de SQLite
    result  = StateMachine::step(&session, &emit)                   machine.rs:121
    apply(runtime, &session, result.effects, &emit)                 machine.rs:192
    match result.status { Continuing => repetir, Yielded|Cancelled => break }
  }
  finalize(...)                                                     machine.rs:228
```

`StateMachine::step` recorre los pasos en orden y **devuelve al primero que aplica**:

```
para cada step (índice i):
  si cancel.is_cancelled() → RunStatus::Cancelled
  tokio::select!{ biased; exec = step(...), _ = cancel.cancelled() }
  OperationResult::NotApplicable → siguiente step
  OperationResult::Applied(StepResult{effects, applied_step, status}) → return
si ninguno aplicó → RunStatus::Yielded
```

Un paso `Inference` hace además (`machine.rs:134-156`): `prepare_session` → `applies(conversation)` → junta `inference_tools()` + `prompt_parts()` + `moim_parts()` de **todos** los steps → `infer(...)`.

### 2.2 Orden exacto de los Steps (`agent.rs:679-771`)

| # | Step | Tipo | Aplica cuando |
|---|---|---|---|
| 0 | `SlashCommandOperation` | Op | el mensaje es un `/comando` (envuelve a todos los demás handlers) |
| 1 | `SteerOperation` | Op | hay mensajes en `SteerQueue` y el turno está cerrado o en rol `Tool` |
| 2 | `BangShellOperation` | Op | `!cmd` |
| 3 | `CompactionOperation` (**solo si** `!provider.manages_own_context()`) | Op | umbral `auto_compact_threshold` |
| 4 | `ToolPairCompactionOperation` | Op | pares viejos sobre `pair_compaction_min_tokens` |
| 5 | `ToolApprovalOperation` | Op | hay `ActionRequired::ToolConfirmation` sin responder |
| 6 | `DoctorOperation` | Op | `/doctor` |
| 7 | `ProjectOperation` | Op | cambio de workspace pedido |
| 8 | `SkillOperation` | Op | skill cargada/`load_skill` |
| 9 | `ForegroundSubagentOperation` | Op | hay subagentes foreground pendientes (antes de `RecipeOperation`, comentario en `agent.rs:710-712`) |
| 10 | `RecipeOperation` | Op | sesión con recipe |
| 11 | `ToolExecutionOperation` | Op | hay `ToolRequest` sin `ToolResponse` y con tool disponible |
| 12 | `UnknownToolOperation` | Op | tool request de nombre inexistente |
| 13 | `RetryOperation` | Op | recipe retry/failure |
| 14 | `EmptyResponseOperation` | Op | último mensaje es el marcador de respuesta vacía |
| 15 | `StopHookOperation` | Op | hook `Stop` decide bloquear el cierre |
| 16 | `ExitOnErrorOperation` | Op | hubo error de turno |
| 17 | `TurnCeilingOperation` | Op | `tool_call_count >= AEGIS_TURN_TOOL_CALL_LIMIT` o deadline |
| 18 | `MaxTurnsOperation` | Op | `assistant_turn_count >= AEGIS_MAX_TURNS` |
| 19 | **`InferenceRunner`** | **Inf** | último mensaje proyectado es `User`/`Tool` y no hay error trailing |

Consecuencia de diseño: **la inferencia es el último step**. Cualquier operación que quiera "cerrar el turno" (max turns, ceiling, empty response, stop hook) tiene prioridad sobre volver a llamar al modelo.

### 2.3 Construcción del prompt (`inference_preparation.rs:61-107`)

1. `AegisMode::SmartApprove` → `tool_inspection_manager.apply_tool_annotations(&tools)`.
2. `filter_denied_tools` — quita tools en `never_allow` de la sesión (comentario en `l.26-28`: si solo se bloquea, el modelo gasta el turno intentando escribir).
3. `prepare_inference_tools` (`reply_parts.rs:218-226`): filtra por `_meta.ui.visibility`, **ordena por nombre** (estable para prompt caching multi-sesión).
4. `PromptManager::build_system_prompt(session, prompt_parts, mode)` — `prompt_parts` viene de cada Operation (`ToolExecution::prompt_parts` agrega instructions de extensiones + hints de subdirectorio, `ops_toolcalling.rs:933-980`).
5. `additional_messages = moim::turn_context_event(working_dir, context_limit, moim_parts, turn_start)` — bloque dinámico `<turn-context>`, deduplicado contra el último `turn_context` de la conversación (`l.99`).

### 2.4 Streaming y "acumulación de ReplyParts"

No hay struct `ReplyParts` en ningún lado del workspace (`Select-String ReplyParts` sobre `crates/**/*.rs` → 0 resultados; tampoco en `block/goose` main: `reply_parts.rs` solo expone `is_tool_visible_to_app`/`_model`). Lo que hacía de acumulador es, en este fork:

- `InferenceOutput.accumulator: Conversation` (`A/inference.rs:204-209`), bajo `Mutex`, con tres cosas: `additional_messages`, `usage: Vec<ProviderUsage>` y los mensajes emitidos.
- `ConversationEffect` como lenguaje de efecto (`A/operation.rs:217-229`).

Ciclo de chunk (`A/inference.rs:531-579`), por cada `(Option<Message>, Option<ProviderUsage>)` del `MessageStream`:

| paso | código | efecto |
|---|---|---|
| usage | `l.555-560` | `output.usage.truncate(attempt_start); push(usage)` — un solo usage por intento |
| metadata de inferencia | `l.562-564` | `chunk.with_inference_if_assistant(InferenceMetadata{provider, requested_model, resolved_model, provider_session_id})` |
| dedupe de tool-call ids | `l.565-570` | `tool_request_ids: HashSet`; id repetido → se descarta el chunk |
| thinking repetido | `l.571` + `l.98-115` | `drop_repeated_tool_call_thinking`: borra `Thinking` ya visto en el acumulador cuando el chunk trae `ToolRequest` |
| vacío | `l.572-577` | chunk sin contenido y sin `output_token_limit_reached` → **solo al acumulador, no se emite**; si no, `emit_message` (acumula + `AgentEvent::Message`) |

El agrupado de chunks contiguos en un mismo mensaje (id compartido) ocurre antes, en `reply_parts.rs:459-491`: `is_mergeable_assistant_chunk` + `active_mergeable_assistant_id`, y al final se emite `(None, Some(usage))` (`l.492-496`) — por eso el uso llega como evento separado.

### 2.5 Detección y ejecución de tool calls

Detección: no hay "parseo" — el chunk del provider ya trae `MessageContent::ToolRequest(ToolRequest)` (`aegis-provider-types/src/conversation/message.rs:133`). Se **persiste** como mensaje assistant (`ConversationEffect::AppendMessage`), y la *siguiente* pasada de la máquina lo ve pendiente.

`ToolExecutionOperation::run` (`ops_toolcalling.rs:982-1179`):

```
messages = messages_since_kickoff(conversation)
pending  = pending_advertised_tool_requests(messages)   → (ToolRequest, ToolDisposition)
   ToolDisposition: Execute | Decline | ParseError(String)
lease = coordinator.extension_lease()
  · None y todos los pending fueron generados por una operación y sin historial de aprobación
      → resolve_lease(session)
  · None en otro caso → responde error EXPIRED_APPROVAL_RESPONSE a cada uno   (l.1016-1044)
tools = lease.tools_excluding("skills")
pending.retain(tool conocida) ; dedupe por request.id
if session.aegis_mode == Chat → responde CHAT_MODE_TOOL_SKIPPED_RESPONSE      (l.1061-1082)
segments = plan_tool_segments(&pending, &tools, &hook_manager)                (l.31-48)
para cada segmento:
   · barrera (write/shell/decline/parse error) → se resuelve sin ejecutar
   · lecturas paralelas → run_bounded_ordered(…, buffer_unordered(4))         (l.50-65)
       por request: dispatch_tool_call → ToolCallResult → tool_stream()
         ToolStreamItem::Result  → batch.record(...) (+ McpNotification si platform_notification)
         ToolStreamItem::Message → AgentEvent::McpNotification
         ToolStreamItem::ActionRequired → batch.actions.push + emit.message
response = batch.take()  (un único Message::user con TODAS las ToolResponse)
emit.emit(AgentEvent::Message(response.user_visible_content()))
applied(actions ++ [response])
```

Sólo `read_file`/`grep`/`tree` del dueño `developer` corren en paralelo, y sólo si no hay hooks `PreToolUse`/`PreToolUseResult`/`BeforeReadFile` (`safe_parallel_read`, `l.7-29`). Tope: 4 arranques simultáneos. **Reinyección**: el `Message::user()` con las respuestas se persiste; en la siguiente pasada `should_infer` ve rol `Tool` y vuelve a llamar al modelo.

### 2.6 Confirmaciones de herramienta (pausa/reanudación)

1. `ToolApprovalOperation` emite `ActionRequired::ToolConfirmation{id}`.
2. `stream_state_machine_turn` (`agent.rs:950-991`) ve el evento, llama `register_request(id)` y marca `has_confirmations`.
3. Al agotarse el stream **sin** nuevas confirmaciones → `clear_confirmations()` + `spawn_post_turn_memory_extraction` + `return`. Si hubo: `wait_for_all_confirmation_answers(&cancel)`.
4. El cliente responde por `submit_tool_confirmation` (`agent.rs:537-604`): intenta `try_route_tool_confirmation_to_provider` (provider con `PermissionRouting::ActionRequired`), si no `persist_tool_confirmation_decision(...)` + `record_answer(StateMachine(perm))`.
5. Si hay respuesta de tipo `StateMachine` → se **re-lanza** `stream_state_machine_session` (mismo `turn_guard`), y `resume_state_machine_turn` cubre el caso de reapertura de sesión (`load_session.rs:345`).

---

## 3. Concurrencia, cancelación y steering

| pieza | mecanismo | ruta:linea |
|---|---|---|
| Eventos agente→cliente | `tokio::sync::mpsc::unbounded_channel::<AgentEvent>`; `select!{biased; rx.recv(), run}` | `AG/agent.rs:1021-1041` |
| Notificaciones MCP durante tools | `mpsc::Sender<ServerNotification>` con `try_send` (best-effort, no frena la tool) | `AG/tool_execution.rs:16-29` |
| Action required / elicitation | stream por sesión registrado en `ActionRequiredManager`, `Notify`/canal por request | `AG/action_required_manager.rs:62-232` |
| Cancelación | un único `CancellationToken` por turno: `select!` en cada step (`machine.rs:159-163`), cancelable en backoff (`inference.rs:379-382`), `finalize()` cierra tool calls huérfanas y llama `finalize_cancellation` de cada operación | `A/machine.rs:228-263` |
| Cancel desde fuera | `AgentManager::try_register_cancel_token` / `cancel_session` / `is_session_busy`; `ActiveRunRegistry::agent_cancel_token`, `cancel_agent_run`, `mark_client_cancelled` | `execution/manager.rs:277-311`, `execution/active_run.rs:311-457` |
| 1 turno por sesión | `try_start_turn()` toma `OwnedMutexGuard` no bloqueante → error `"session already has an active turn"` | `tool_confirmation_coordinator.rs:40-50` |
| Steering a mitad de turno | **no interrumpe**: `Agent::steer()` empuja a `SteerQueue` (`agent.rs:331-337`); `SteerOperation` drena sólo cuando `ends_turn(messages)` o el rol efectivo es `Tool` (`ops_steer.rs:66-79`) | idem |
| Paralelismo de tools | `buffer_unordered(4)` para lecturas, orden de resultados restaurado por índice | `ops_toolcalling.rs:50-65` |
| Procesos `spawn_blocking` | tools `SyncTool` se mandan a `spawn_blocking` (en wasm no, y ahí no son cancelables) | `A/tool.rs:89-117` |
| Dedupe de prompts | `ActiveRunRegistry::claim_prompt(session, prompt_id, digest)` → `Waiting(subscriber)` / `Completed` / error si el `promptId` se reusó con otro contenido | `execution/active_run.rs:151-208` |

**Invariante central de cancelación**: el turno nunca "se corta a mitad de escritura". Cancelar significa: `step` → `RunStatus::Cancelled` → `finalize()` → se persiste una `ToolResponse` de error por cada request sin responder (`interrupted_response`, `A/machine.rs:69-92`).

---

## 4. Límites, timeouts, reintentos y errores

| límite | valor por defecto | config | ruta |
|---|---|---|---|
| Turnos assistant por turno | 1000 (`DEFAULT_MAX_TURNS`, `agent.rs:59`) | `AEGIS_MAX_TURNS`, `SessionConfig.max_turns` | `agent.rs:633-637`, `ops_maxturns.rs:53-67` |
| Tool calls por turno | 120 (`DEFAULT_TOOL_CALL_LIMIT`; 0 = off) | `AEGIS_TURN_TOOL_CALL_LIMIT` | `ops_turn_ceiling.rs:36,52-56` |
| Wall clock por turno | 0 = off | `AEGIS_TURN_DEADLINE_SECONDS` (medido desde `created` del kickoff, sobrevive reinicio) | `ops_turn_ceiling.rs:41,58-62,144-151` |
| Aviso al modelo del techo | `used*2 >= limit` | — | `ops_turn_ceiling.rs:45,98-118` |
| Reintentos de provider (pre-primer-item) | `provider.retry_config().transient_only()`, `max_retries` del provider | env `AEGIS_PROVIDER_SKIP_BACKOFF` | `A/inference.rs:483-512`, `reply_parts.rs:337-394` |
| Reintentos mid-stream | sólo si `!emitted_output` (si ya se mostró, reintentar duplicaría) | — | `A/inference.rs:534-552` |
| Providers que gestionan su contexto | **cero reintento** (`manages_own_context()`) | — | `A/inference.rs:500`, `reply_parts.rs:337` |
| Respuestas vacías | 3 reintentos (`MAX_EMPTY_RESPONSE_RETRIES=3`); luego marcador oculto | — | `A/inference.rs:77,589-609` |
| Empty + último tool response OK | no reintenta: emite mensaje vacío `user_visible=false` para que el turno cierre | — | `A/inference.rs:612-627` |
| Retry/failure de recipe | `AEGIS_RECIPE_RETRY_TIMEOUT_SECONDS`, `AEGIS_RECIPE_ON_FAILURE_TIMEOUT_SECONDS` | idem | `agent.rs:642-647`, `ops_retry.rs` |
| Stop hook blocks | `AEGIS_STOP_HOOK_BLOCK_CAP` | idem | `agent.rs:648-657` |
| Compactación | `auto_compact_threshold(context_limit)`; par-compaction lazy a `AEGIS_TOOL_PAIR_COMPACT_MIN_RATIO` (0.5) | `AEGIS_TOOL_CALL_CUTOFF` | `agent.rs:658-677` |

**Error de tool vs error de turno.**
- Tool: se persiste como `ToolResponse` con `CallToolResult::is_error` → el modelo lo ve y corrige. Nunca rompe el stream. Casos: `DECLINED_RESPONSE`, `EXPIRED_APPROVAL_RESPONSE`, parse error, `UNCLAIMED_TOOL_ERROR` + lista de tools disponibles (`ops_llm.rs:39-73`).
- Turno: `ProviderError` → `Message::from_provider_error(err)` emitido como mensaje (`A/inference.rs:385-390`) → el mensaje queda con `MessageErrorKind` → `trailing_error(conversation)` corta `should_infer` (`l.417`) y dispara `ExitOnErrorOperation`; en ACP, `prompt_error_from_message_content` devuelve error al cliente (`acp/server.rs:2672-2674`).

---

## 5. Eventos hacia el frontend

`AgentEvent` (`A/events.rs:9-18`) es el contrato interno. Se traduce en `acp/server.rs:2652-2753`:

| `AgentEvent` | destino ACP | ruta |
|---|---|---|
| `Message` | por cada `MessageContent`: `handle_message_content` → `session/update` (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`…) | `acp/server.rs:2660-2708` |
| `McpNotification((request_id, notif))` | `tool_notifications::tool_notification_update` → `ToolCallNotifier::send_update` (`tool_call_update`) | `acp/server.rs:2709-2716` |
| `MessageUsage` | `AegisSessionUpdate::MessageUsage(message_usage_update(...))`, sólo si el cliente soporta notificaciones custom | `acp/server.rs:2717-2729` |
| `Usage` | `send_session_usage_updates(...)` → `usage_update` (contexto + coste); un fallo aquí no aborta el turno | `acp/server.rs:2730-2746` |
| `HistoryReplaced` | reemplazo de historial en cliente (compactación/`/clear`), con lo que el mismo batch agregue después (`session.rs:192-212`) | emitido en `session.rs:139-147` |
| `OutputTokenLimitReached` (meta del mensaje) | `populate_output_token_limit_content` | `acp/server.rs:2661,2670` |
| progreso/stall | `active_runs.touch_progress(session_id)` en cada evento | `acp/server.rs:2653` |

Canal físico: el `bus` de notificaciones ACP (`AegisSessionNotification`), más JSON-RPC por HTTP/WS o stdio. `stream_state_machine_session` sólo reenvía **eventos de agente**; la persistencia ocurre en `apply_effects` **antes** de emitir los eventos derivados (`session.rs:119-151`, dos pasadas: primero escribe, después emite).

---

## 6. Invariantes y trampas conocidas

1. **Nada se decide en memoria.** `StateMachine::run` recarga la sesión de SQLite en cada iteración (`A/machine.rs:216`). Un efecto no aplicado no existe; por eso `Operation::set_message_meta`/`message_meta` graba *notas de acción pasada* en la metadata para que un pipeline reconstruido llegue a la misma conclusión (`A/operation.rs:83-93`).
2. **`messages_since_kickoff` es la frontera.** Todo se mide desde el último `User` user-visible no-tool. Un mensaje de steering cuenta como kickoff nuevo para las operaciones siguientes.
3. **El `Message::user()` de herramientas es uno solo por batch** (`ops_toolcalling.rs:1175-1178`); un batch sin respuesta es `anyhow!("tool batch produced no responses")`.
4. **`AppendMessage` con id generado**: `ensure_message_ids` (`A/operation.rs:231-246`) asigna `msg_<uuid>` antes de aplicar. Los ids son la clave de `SetMessageVisibility` y de `PatchToolRequestMeta`.
5. **Un solo turno por sesión**; el segundo intento falla con error, no bloquea (`tool_confirmation_coordinator.rs:40-50`).
6. **`start_new_turn()` limpia el `ExtensionLease`**: una aprobación contestada después de que expiró el lease devuelve `EXPIRED_APPROVAL_RESPONSE` en vez de ejecutar con un lease nuevo (`ops_toolcalling.rs:92-93`, `inference_preparation.rs:46-57`).
7. **`turn_lock` se libera al `drop` del `ActiveTurnGuard`**, y sólo limpia el lease si no quedan confirmaciones pendientes (`tool_confirmation_coordinator.rs:166-172`).
8. **Thinking duplicado se borra** a propósito cuando el chunk trae tool calls (`A/inference.rs:98-115`); es la única deduplicación de contenido, y compara por igualdad exacta.
9. **Reintento seguro sólo antes del primer contenido**: `emitted_output` es la guarda anti-duplicado (`A/inference.rs:530,538`).
10. **Providers que manejan su propio contexto** (`manages_own_context()`): sin retry, sin compactación de turno, sin tool-pair compaction (`agent.rs:675-677,683`). `provider.resume(provider_session_id)` sólo se toma del **último** `InferenceMetadata` y sólo si es del mismo provider (`A/inference.rs:251-262`).
11. **La máquina no puede registrar la misma tool dos veces**: `add_tools_to_inference_input` falla con `"multiple operations registered tool '<x>'"` (`A/machine.rs:94-106`), y `available_tools` con `"multiple tool providers registered '<x>'"` (`A/tool.rs:263-283`).
12. **`toolshim` acumula todo el stream antes de emitir** (`reply_parts.rs:397-457`): ahí no hay streaming visible y cada chunk intermedio se emite como `(None, None)` "para chequear cancelación".
13. **`HistoryReplaced` incluye lo que se agregó después en el mismo batch**; si no, un `/clear` dejaría la UI vacía (`session.rs:189-212`).
14. **`user_event` descarta mensajes sin contenido user-visible** (`agent.rs:186-198`): regla de negocio del cliente, no del loop.
15. **`spawn_post_turn_memory_extraction` corre desprendido** en cada cierre de turno sin confirmaciones (`agent.rs:403-…`, llamado en `agent.rs:966,978`).

---

## 7. Comparación local vs GitHub

`gh api repos/block/goose/contents/crates --jq '.[].name'` (2026-10-29):

| crate upstream (`block/goose`) | local (`C:\Aegis-Proyects\src`) | estado |
|---|---|---|
| `goose-agent` | `aegis-agent` | **existe sólo local con ese nombre**: el rebrand `7f394c468 feat(rebrand): renombra el fork de goose a Aegis` + `7bc1e9b51 style: reordena imports` son los **dos únicos** commits del directorio |
| `goose-cli` | — | **borrado en el fork** (no hay TUI ni binario `aegis`) |
| — | `aegis-server` | **existe sólo local** (sólo `main.rs` + `recipe_runner.rs`) |
| `goose` | `aegis` | renombrado; `agents/` diverge fuerte (ver abajo) |
| `goose-context-management`, `-download-manager`, `-local-inference`, `-mcp`, `-provider-types`, `-providers`, `-roaming`, `-sdk`, `-sdk-types`, `-test`, `-test-support`, `-acp-macros` | idem con prefijo `aegis-` | renombrado 1:1 |

Contenido de `goose-agent/src` upstream: `events.rs`, `inference.rs`, `lib.rs`, `machine.rs`, `operation.rs`, `skills/`, `subagent.rs`, `tool.rs`.
Contenido de `aegis-agent/src` local: `events.rs`, `inference.rs`, `lib.rs`, `machine.rs`, `operation.rs`, `tool.rs` → **faltan `skills/` y `subagent.rs`** (movidos/eliminados en el fork).

`origin/main` de `emilianodamir874/aegis-harness` (verificado con `git ls-tree origin/main crates/`): todavía tiene **`crates/goose-agent`**, no `aegis-agent`. Es decir: **el rebrand es sólo local**; `origin/main` está atrasado respecto de la rama `feat/antigravity-provider`.

| pieza | existe sólo local | atrasado en `origin/main` | upstream `goose` puro |
|---|---|---|---|
| `crates/aegis-agent/**` (6+4 archivos, 1.563 l.) | ✅ (renombre + recorte de `skills`/`subagent`) | `origin/main` aún dice `goose-agent` | ✅ como `goose-agent` |
| `crates/aegis-server/**` | ✅ (nuevo; reemplaza `goose-cli`) | ausente | ✅ `goose-cli` en su lugar |
| `crates/aegis/src/agents/state_machine/**` (33 archivos, ~9.4k l.) | parcial: existe `state_machine/` upstream, pero la variante local tiene `ops_turn_ceiling.rs`, `ops_steer.rs`, `ops_empty_response.rs`, `ops_foreground_subagent.rs`, `ops_tool_pair_compaction.rs`, `ops_skills.rs`, `ops_doctor.rs`, `ops_project.rs`, `ops_status.rs`, `ops_bang_shell.rs`, `ops_slash_command.rs`, `ops_unknown_tool.rs`, `ops_stop_hook.rs`, `ops_exit_on_error.rs` | — | `goose/src/agents/state_machine*` (sin verificar archivo por archivo) |
| `agents/active_run.rs` (local) | — | — | upstream lo tiene en `goose/src/agents/active_run.rs`; local lo movió a `aegis/src/execution/active_run.rs` y `agents/` ya no lo lista |
| `agents/services.rs`, `agents/session_runtime.rs`, `agents/state_machine_builder.rs`, `agents/snapshots/` (upstream) | — | — | **no existen en local** (verificado por listado de `crates/aegis/src/agents` y de `crates/aegis/src/execution`) |
| `agents/tool_confirmation_coordinator.rs` | — | — | presente en ambos |
| `ReplyParts` | ❌ en ambos: 0 resultados en el workspace local y ausente en `block/goose` `main` (`reply_parts.rs` sólo tiene `is_tool_visible_to_app/_model`) | — | ya no existe |

No aparecen PRs/commits de upstream en el historial local: `git log --follow -- crates/aegis-agent/src` devuelve exactamente `7bc1e9b51` y `7f394c468`. La rama está en `8d559d0b5 feat(acp): autonomía como único modo Aegis`.

---

## 8. Referencias web externas

| tema | URL |
|---|---|
| ACP — schema (v1), métodos `session/prompt`, `session/update` | https://agentclientprotocol.com/protocol/schema |
| ACP — Prompt Turn: ciclo `prompt` → `session/update` → final; variantes `sessionUpdate` (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update`) | https://agentclientprotocol.com/protocol/prompt-turn |
| ACP — Tool Calls (`tool_call`/`tool_call_update`, estados) | https://agentclientprotocol.com/protocol/tool-calls |
| ACP — Cancellation (`session/cancel` y el turno debe terminar limpio) | https://agentclientprotocol.com/protocol/cancellation |
| ACP — Elicitation | https://agentclientprotocol.com/protocol/elicitation |
| ACP — índice completo (llms.txt) | https://agentclientprotocol.com/llms.txt |
| goose docs (raíz; `/docs/goose-architecture/` devuelve 404 desde este host) | https://block.github.io/goose/ |
| goose docs alternativo (espejo citado por el buscador) | https://goose-docs.ai/ |

**Traducción ACP ↔ Aegis confirmada por código**: `session/update` se produce en `crates/aegis/src/acp/server.rs:2660-2746`; el cancel del protocolo aterriza en el `CancellationToken` que viaja en `Emitter` y en `ActiveRunRegistry` (`acp/server.rs:2649`, `execution/active_run.rs:311-457`).

---

## 9. Huecos, riesgos y deuda técnica

| # | hallazgo | evidencia |
|---|---|---|
| 1 | **Recarga de la sesión completa desde SQLite en cada paso** del loop: con store de ~534 MB y conversaciones de miles de mensajes, el costo por iteración es O(historial). | `A/machine.rs:216` (`runtime.load(session_id)` dentro del `loop`), `session.rs:33-37` (`get_session(id, true)`) |
| 2 | `ToolOperation` (`A/tool.rs:193-396`) es una **segunda implementación** del despacho de tools, secuencial y sin aprobaciones, conviviendo con `ToolExecutionOperation`. Riesgo de deriva entre ambas. | `A/tool.rs:328-396` vs `ops_toolcalling.rs:982-1179` |
| 3 | `expect()` en rutas de producción: `"pending requests were filtered by available tools"`, `"tool responses retained"`, `"extension lease unavailable"`, `"state-machine session loaded without conversation"`. Un invariante roto es panic, no error. | `A/tool.rs:368,393`; `ops_toolcalling.rs:997`; `machine.rs:124` |
| 4 | El turno se cierra si el stream no dejó confirmaciones (`!has_confirmations → return`), aunque el último mensaje no sea un cierre semántico: cualquier operación que emita y no reentre deja el turno "terminado" sin respuesta final. | `agent.rs:964-969` |
| 5 | `UserPromptSubmit` se dispara **dos veces** en un turno con steering: una en `run_turn_start_hooks` (`session.rs:290-299`) y otra por cada mensaje drenado (`ops_steer.rs:89-95`). | idem |
| 6 | El `ExtensionLease` se renueva sólo si `!awaits_tool_responses` (`inference_preparation.rs:48-57`): un turno con tools pendientes de un lease viejo queda con lease viejo hasta que se resuelvan (deliberado, pero el mensaje `EXPIRED_APPROVAL_RESPONSE` puede sorprender al operador). | idem + `ops_toolcalling.rs:92-93` |
| 7 | `plan_tool_segments` sólo paraleliza `read_file`/`grep`/`tree` del dueño `developer` (`ops_toolcalling.rs:14-21`): lecturas de otras extensiones son secuenciales de hecho. | idem |
| 8 | `TurnCeilingOperation`: el deadline por defecto es 0 (=off) y el comentario reconoce que el reloj de pared no distingue espera de loop (`ops_turn_ceiling.rs:38-41`). El comentario de cabecera afirma que las evals C13/C21 "burned 900-1200 s each and were ended by the eval timeout" — ese dato no está verificable desde el código. | `ops_turn_ceiling.rs:1-18` |
| 9 | `EMPTY_RESPONSE_MESSAGE` invita al usuario a reenviar el mensaje; con 3 reintentos automáticos ya hechos, el costo de un provider que devuelve vacío se multiplica por 4 sin backoff propio. | `A/inference.rs:75-77,589-599` |
| 10 | `origin/main` atrasado (aún `goose-*`): no hay remoto con el rebrand; backup y upstream divergen. Cualquier `git pull`/merge arrastra renombres masivos. | `git ls-tree origin/main crates/` |
| 11 | `aegis-server` no contiene el servidor: `main.rs` + `recipe_runner.rs` (2 archivos). La documentación de "el harness es aegis-server" induce a buscar en el crate equivocado; el ACP real está en `crates/aegis/src/acp/` (48 archivos). | listado de `crates/aegis-server/src` |
| 12 | `toolshim` rompe el streaming visible (acumula todo) y emite `(None, None)` por chunk sólo para chequear cancelación. | `reply_parts.rs:397-437` |
| 13 | Comentarios con datos medidos pero sin fuente reproducible dentro del repo (evals C9/C13/C21, "~30 tool calls", "2 minutos de tiempo de modelo"). | `ops_turn_ceiling.rs:4-6,33-35` |
| 14 | `planner_splits_at_every_barrier_and_rejects_impersonated_reads` y `parallel_reads_start_at_most_four...` son los únicos tests del planificador; no hay test de `dispatch_tool_call` con approval denegado end-to-end a nivel de operación. | `ops_toolcalling.rs:1213-1310` |

---

## 10. No verificado

- **Contenido del `state_machine/` de upstream `block/goose`** archivo por archivo: sólo verifiqué el listado de `crates/goose/src/agents/` (incluye `state_machine/` y `state_machine_builder.rs`), no el delta de cada `ops_*.rs`.
- **`AgentEvent::OutputTokenLimitReached`**: vi la meta `message.metadata.output_token_limit_reached` y `update_output_token_limit_reached` en `acp/server.rs:2661`, pero no abrí la definición del enum en `aegis-provider-types`.
- **`ops_tool_approval.rs` (256 l.) y `ops_compaction.rs` (463 l.)**: leí su interfaz por las referencias de `agent.rs`, no su lógica interna.
- **`tool_call_labels.rs` (754 l.)**: no lo abrí; por el nombre etiqueta tool calls para la UI, sin confirmar el punto de llamada.
- **`builtin_extension.rs` / `subprocess.rs`**: revisé sólo la superficie pública (`register_builtin_extension`, `spawn_long_lived_mcp_subprocess`, `set_no_window`); no su uso en el turno.
- **`PromptManager::build_system_prompt`** (`prompt_manager.rs`, 457 l.): no verifiqué cómo ordena/ensambla `prompt_parts`.
- **Tests de `aegis-agent`** (`tests/cancellation.rs`, `network_retry.rs`, `tool_operation.rs`, `wasm.rs`, ~1.3k l.): listados, no leídos; no afirmo qué cubren.
- **Cifras de costo/tokens del turno**: no medí el store; cualquier número de latencia o tamaño es del código, no de ejecución.
- **Documentación de goose**: `https://block.github.io/goose/docs/goose-architecture/` devuelve 404 desde este host; no encontré una página de arquitectura del loop para citar con URL literal.

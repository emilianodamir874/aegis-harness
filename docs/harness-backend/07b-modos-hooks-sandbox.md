# 07b — Modos de sesión, hooks y sandbox de escritura

Estado verificado sobre el árbol de trabajo el 2026-10-29 12:58 (-03). HEAD `8d559d0b5`
(`feat(acp): autonomía como único modo Aegis`), rama `feat/antigravity-provider`, 40 archivos
modificados sin commitear (WIP de formato/compaction, ninguno funcional en este dominio).

Nota de método: todo lo que sigue sale de leer código en disco. No se corrió nada: no hay build,
no hay test ejecutado, no hay request contra el serve vivo (3284). Lo no comprobado está en
"No verificado".

---

## 0. Resumen ejecutivo en cinco líneas

| Pregunta | Respuesta corta |
|---|---|
| ¿Existen tres modos? | Sí, en la extensión `mode` (plan/revisar/ejecutar). Viven **solo en memoria del proceso**, por sesión. No hay columna, no hay archivo, no hay migración. |
| ¿Quién los elige? | El agente, con la tool `mode__request_mode`. La UI ya **no dibuja chip** (`web/src/session-mode.ts:143-149`). |
| ¿Persisten? | No, por sesión: `PermissionManager.session_overrides` es un `RwLock<HashMap>` (`config/permission.rs:42`). Se pierden al reiniciar el serve. |
| ¿Hooks? | 12 eventos en el enum, 9 realmente emitidos, `SessionEnd` sin emisor. Config: `<plugin>/hooks/hooks.json`, cero plugins en el store. |
| ¿Sandbox de escritura? | Existe de verdad (`security/workspace_sandbox.rs`, 405 líneas, inspector registrado en `agent.rs:380-386`) pero **está apagado** por `AEGIS_WORKSPACE_SANDBOX: false` en `state/config/config.yaml:20`. `core/ops/verify-sandbox.ps1` **no lo prueba**: prueba el arranque de un binario con store aislado. |

---

## 1. Los tres modos

### 1.1 Dónde se define cada uno

| Concepto | Ruta:línea | Qué hace |
|---|---|---|
| Enum `SessionMode { Plan, Revisar, Ejecutar }` | `crates/aegis/src/agents/platform_extensions/mode.rs:55-60` | Los tres modos. `Copy`, privado del módulo: no viaja por el protocolo. |
| `SessionMode::parse` | `mode.rs:63-70` | Acepta `plan`; `revisar`\|`review`; `ejecutar`\|`execute`\|`auto`. Case-insensitive, trim. |
| `SessionMode::name` | `mode.rs:72-78` | Devuelve el id canónico (`"plan"`, `"revisar"`, `"ejecutar"`). |
| `SessionMode::entries` | `mode.rs:80-101` | Traduce modo → lista `(tool, PermissionLevel)`. **Es todo el mecanismo.** |
| `WRITE_TOOLS` | `mode.rs:32` | `["shell","edit","write"]` |
| `READ_ONLY_TOOLS` | `mode.rs:33-44` | 10 tools de lectura que se fuerzan a `AlwaysAllow` en plan/revisar. |
| `PermissionLevel { AlwaysAllow, AskBefore, NeverAllow }` | `crates/aegis/src/config/permission.rs:19-25` | Los tres niveles reales del motor. |
| Espejo en la web (muerto) | `web/src/session-mode.ts:49-61` | Copia exacta de las dos listas, del lado TS. |
| Modo ACP (`AegisMode`) | `crates/aegis/src/config/base.rs` (enum reexportado por `config`), usado en `acp/server.rs:3165-3184` | Otra cosa: `auto`/`approve`/`smart_approve`/`chat`. Hoy la superficie ACP expone **solo** `auto`. |

### 1.2 Qué cambia exactamente por modo

`SessionMode::entries` (`mode.rs:80-101`) produce:

| Modo | `shell`,`edit`,`write` | Las 10 de `READ_ONLY_TOOLS` | Resto de tools |
|---|---|---|---|
| `plan` | `never_allow` | `always_allow` | Sin override: manda `permission.yaml` |
| `revisar` | `ask_before` | `always_allow` | Sin override |
| `ejecutar` | — | — | `entries()` devuelve `Vec::new()` → **borra** los overrides de la sesión (`config/permission.rs:252-263`) |

Efectos encadenados, uno por consumidor:

1. **Tools ocultas al modelo.** `crates/aegis/src/agents/state_machine/inference_preparation.rs:73-77`
   filtra el set de tools con `filter_denied_tools(...)` (definido en `:29-37`) usando
   `session_permission_for_tool(...) == Some(NeverAllow)`. En `plan`, `developer__shell`,
   `developer__edit` y `developer__write` **no llegan al request**: el modelo ni las intenta.
   El comentario de `:26-28` lo dice explícito.
2. **Bloqueo duro en ejecución.** `crates/aegis/src/permission/permission_inspector.rs:163-169`
   (rama `AegisMode::Auto`): override `NeverAllow` → `InspectionAction::Deny`;
   `AskBefore` → `RequireApproval(None)`; el resto → `Allow`. Con `AegisMode::Chat` el inspector
   hace `continue` (`:160`) y no opina: todo lo resuelve `acp/provider.rs:909` (`reject_all_tools`).
3. **Tarjeta de permiso.** `RequireApproval` termina en `ops_tool_approval.rs:107-140`, que emite un
   `ActionRequired::ToolConfirmation` con `tool_name`, `arguments` y `prompt` opcional.
4. **Visibilidad en la UI.** `acp/server/tools.rs:22-30` (`on_get_tools`) pinta `permission` por tool
   con el mismo `session_permission_for_tool(...)`, así el panel de tools muestra el nivel real.

Invariante importante: el override de sesión **gana sobre `permission.yaml` y sobre el modo ACP**
(`config/permission.rs:221-223`) y **también niega en `AegisMode::Auto`** — hay test para eso:
`permission_inspector.rs:336-374` (`session_override_denies_in_auto_mode_without_touching_other_sessions`).

### 1.3 Cómo se cambia

Mensaje exacto: llamada MCP a la extensión `mode`, tool `request_mode`,
`{"mode": "<plan|revisar|ejecutar>", "reason": "<texto>"}`
(constantes `EXTENSION_NAME`/`REQUEST_MODE_TOOL_NAME` en `mode.rs:29-30`, schema en
`RequestModeParams` `mode.rs:46-53`, implementación en `call_tool` `mode.rs:236-260`).

Registro de la extensión: `crates/aegis/src/agents/platform_extensions/mod.rs:195-204`
(`mode::EXTENSION_NAME`, display `"Session mode"`, `mode::ModeClient::new`).

Respuestas textuales de la tool (`mode.rs:193-217`):
- modo desconocido: `Modo desconocido: <x>. Usá plan, revisar o ejecutar.`
- sin cambios: `Ya estás en modo \`<m>\`.`
- aplicado: `Modo \`<m>\` activo (motivo: <reason>). <efecto>`
- error: `No pude cambiar el modo: <error>` (sólo si el `PermissionManager` global no está instalado).

Camino alternativo, todavía vivo, sin tool: RPC `_aegis/unstable/tools/permissions/set` con
`sessionId` (`acp/server/tools.rs:142-164`, `on_set_tool_permissions`). Es lo que usaba el chip y lo
que usa el "modo debate". Con `sessionId`, escribe `set_session_permissions` y **no toca
`permission.yaml`**; sin `sessionId`, escribe `update_user_permission` (persistente).

Camino humano que sí existe hoy: la **palette** (`web/src/palette.ts:105-117`), tres entradas
`mode-plan` / `mode-revisar` / `mode-ejecutar` que llaman `window.__aegisSessionMode.set(...)`
(`session-mode.ts:151-155`) → mismo RPC con `sessionId` (`session-mode.ts:105-120`). Es el único
punto de la UI que fija un modo; el chip se eliminó a propósito (`session-mode.ts:143-149`).

### 1.4 Cómo se persiste por sesión

| Capa | Ruta | Persistencia |
|---|---|---|
| `session_overrides` (lo que implementa plan/revisar/ejecutar) | `config/permission.rs:42`, escritura en `:252-263` | **Memoria del proceso.** Muere con `aegis-serve`. |
| `PermissionManager` global del proceso | `config/permission.rs:52-68` (`install_global_permission_manager`, `global_permission_manager`) | Singleton por proceso; si no está instalado, `ModeClient::current` asume `Ejecutar` (`mode.rs:134-139`). |
| `sessions.aegis_mode` (el modo ACP, no estos tres) | `session/session_manager.rs:1335` (schema, `TEXT NOT NULL DEFAULT 'auto'`), `:1772` (ALTER de migración), `:1108-1111` (lectura) | Disco, por sesión. `ALTER TABLE sessions RENAME COLUMN goose_mode TO aegis_mode` en `:2017`. |
| Migración a `Auto` al activar sesión | `acp/server.rs:1657-1660` (`prepare_session_for_activation`) | Cualquier sesión con otro modo persistido se reescribe a `Auto` en load/fork/resume. |
| Preferencia de UI | `web/src/session-mode.ts:34` (`aegis.sessionMode` en `localStorage`) | Sólo navegador, y **no se aplica al abrir** (`:161-162`: "Cambiar de sesion no reaplica nada"). |

Consecuencia directa: **un `swap.ps1 -Restart` devuelve la sesión a `ejecutar` sin avisar**. No hay
ni columna ni renglón en el store que guarde "esta sesión estaba en plan". El único rastro es el
mensaje de la tool en el transcript.

---

## 2. El pedido de aprobación al operador

### 2.1 Protocolo exacto

| Paso | Ruta:línea | Qué pasa |
|---|---|---|
| 1. El inspector pide aprobación | `permission/permission_inspector.rs:167` o `:180` | `InspectionAction::RequireApproval(prompt: Option<String>)` |
| 2. Se crea el mensaje | `agents/state_machine/ops_tool_approval.rs:119-127` | `Message::assistant().with_action_required(request.id, tool_name, arguments, security_message).user_only()` — el mensaje es **user_only**: el modelo no lo ve |
| 3. Se marca no ejecutable | `ops_tool_approval.rs:109` + `:283-289` | `PatchToolRequestMeta { "aegis.executable": false }` |
| 4. El ACP lo traduce a request | `acp/server.rs:1905-1923` → `:2067-2132` | `handle_tool_permission_request` construye `ToolCallUpdate` (`acp/server/tool_calls/conversion.rs:136-156`) y manda **`session/request_permission`** |
| 5. Opciones ofrecidas | `acp/server.rs:2092-2097` | Exactamente cuatro, con id == nombre == serde del kind: `allow_always`, `allow_once`, `reject_once`, `reject_always` |
| 6. Respuesta del cliente | `acp/server.rs:2103-2129` | `outcome_to_confirmation(&response.outcome).permission` → `agent.submit_tool_confirmation(session_id, request_id, permission)` |
| 7. Se persiste como mensaje | `agents/state_machine/tool_confirmation.rs:75-117` | `ToolConfirmationResponse` con `visibility(false,false)` (ni usuario ni modelo) |
| 8. Se relee y se marca | `ops_tool_approval.rs:57-76` | `AllowOnce|AlwaysAllow` → `executable=true`; el resto `false`. `AlwaysAllow` además `update_permission_manager(AlwaysAllow)`; `AlwaysDeny` → `NeverAllow` |

Mensaje ACP literal: `session/request_permission` con `RequestPermissionRequest::new(session_id,
tool_call_update, options)` (`acp/server.rs:2099-2100`). El tipo viene del SDK ACP
(`agent_client_protocol`, importado en `acp/server.rs:58`).

El texto que ve el operador en la tarjeta: el título sale de `default_tool_title(tool_name,
Some(args))`; el cuerpo es `prompt` **sólo si existe** (`conversion.rs:149-153`). `prompt` se llena
únicamente en dos casos: extension management (`permission_inspector.rs:189-192`, texto
`"Extension management requires approval for security"`) y sandbox
(`security/workspace_sandbox.rs:243-256`, `:263-265`). Si no, `RequireApproval(None)` y la tarjeta va
sin texto explicativo.

### 2.2 Si el operador no contesta

- **Nada expira.** No hay timeout de confirmación en el motor. `wait_for_all_confirmation_answers`
  (`agents/tool_confirmation_coordinator.rs:90-121`) espera con `tokio::select!` sobre
  `Notify` y el `CancellationToken` del turno: sólo sale cuando **todas** las confirmaciones del
  lote tienen respuesta, o cuando el turno se cancela.
- Mientras espera, la sesión está **tomada**: `try_start_turn` usa `try_lock_owned`
  (`tool_confirmation_coordinator.rs:40-50`) y el segundo turno falla con
  `session already has an active turn`.
- Si el cliente ACP devuelve error a la request, se asume `Permission::Cancel`
  (`acp/server.rs:2107-2110`) y, si `submit_tool_confirmation` falla, se **cancela el turno**
  (`:2113-2127`).

### 2.3 Si la sesión se corta o el serve se reinicia

| Situación | Qué queda | Evidencia |
|---|---|---|
| Se cierra la pestaña / se corta el transporte | `session/request_permission` nunca responde. El turno queda colgado hasta cancelación. | `coordinator.rs:116-119` (sólo `cancel.cancelled()` lo despierta) |
| El serve muere en medio | El estado en memoria se va. En el store queda `ToolConfirmation` **sin** `ToolConfirmationResponse`: **estado colgado permanente**. | `session/pending_confirmations.rs:1-11` (doc del módulo, dice literalmente "el turno queda huerfano y la sesion aparece como trabada para siempre") |
| Se recarga la sesión con turno muerto | La tarjeta **no se reemite** (a propósito): `pending_confirmations.rs:8-10`. Sólo se reemiten si se reanuda el turno: `acp/server/load_session.rs:286-314` (`resend_pending_tool_permissions`) desde `start_resumed_state_machine_turn` (`:316+`). | `load_session.rs:286-314` |
| Existe barrido | **Manual, no automático**: `aegis-serve --sweep-pending` → `sweep_pending(&manager, true)`, que escribe `ToolConfirmationResponse { permission: Cancel }`. | CLI en `crates/aegis-server/src/main.rs:123` (flag), `:383-395` (handler); función en `session/pending_confirmations.rs:32-89` |
| Idempotencia | Sí: una confirmación ya respondida no se toca. | `pending_confirmations.rs:29-31` |

Conclusión operativa: **sí queda estado colgado**, y el único remedio es correr el binario con
`--sweep-pending`. No hay barrido en el arranque del serve ni en `session/load`. Verificado por
grep: `sweep_pending` sólo aparece en `session/pending_confirmations.rs:32` y en
`crates/aegis-server/src/main.rs:383,385`.

---

## 3. Hooks

### 3.1 Implementación

Un solo archivo: `crates/aegis/src/hooks/mod.rs` (2312 líneas, 79.862 bytes). Es una copia extendida
del `crates/goose/src/hooks/mod.rs` de upstream (ver §5).

### 3.2 Eventos soportados

Enum `HookEvent` en `hooks/mod.rs:54-68`, nombres canónicos en `:71-86`, parse en `:88-104`:

| Evento | ¿Emitido hoy? | Emisor (ruta:línea) |
|---|---|---|
| `PreToolUse` | Sí, **blocking** | `agents/state_machine/ops_toolcalling.rs:188-194` |
| `PreToolUseResult` | Sí (telemetría del veredicto) | `ops_toolcalling.rs:162-166` |
| `PostToolUse` | Sí | `ops_toolcalling.rs:288` (éxito) |
| `PostToolUseFailure` | Sí | `ops_toolcalling.rs:289` (error) |
| `SessionStart` | Sí | `agents/agent.rs:313` y `agents/state_machine/session.rs:279-280` |
| `SessionEnd` | **NO** | Sólo definido (`mod.rs:78`, `:95`). Grep en todo `crates/` no encuentra ningún `HookEvent::SessionEnd` fuera de esas dos líneas. |
| `UserPromptSubmit` | Sí | `agents/state_machine/session.rs:293-294` y `ops_steer.rs:90-93` |
| `BeforeReadFile` | Sí | `ops_toolcalling.rs:250-254` |
| `AfterFileEdit` | Sí | `ops_toolcalling.rs:399-408` |
| `BeforeShellExecution` | Sí | `ops_toolcalling.rs:250-254` |
| `AfterShellExecution` | Sí | `ops_toolcalling.rs:399-402` |
| `Stop` | Sí, **blocking** | `agents/state_machine/ops_stop_hook.rs:92-97` |

### 3.3 Contrato (stdin/stdout/exit code)

| Canal | Contrato | Ruta |
|---|---|---|
| **stdin** | JSON del `HookContext` (`hooks/mod.rs:225-259`): `event`, `session_id`, `matcher_context`, y opcionales `tool_call_id`, `tool_name`, `tool_input`, `tool_output`, `message`, `last_assistant_message`, `working_dir`, `decision`, `policy_evaluated`, `blocked_by`, `reason`. | `:262-317` (builders), serialización en `:525`/`:633`/`:717` |
| **exit 0 + stdout vacío** | `Allow` | `classify_output` `:953-957` |
| **exit 0 + `{"decision":"allow"}`** | `Allow` | `:954` |
| **exit 0 + `{"decision":"block","reason":"..."}`** | `PolicyDeny{reason}` | `:948-952` |
| **exit 2 + stderr** | `PolicyDeny{reason = stderr}` (default `"denied by plugin hook"`) | `:920-925` |
| **exit 0 + stdout no vacío sin `decision`** | `HookFailure` ("exited 0 without an allow or block decision") | `:959-965` |
| **cualquier otro exit / señal** | `HookFailure` | `:961-963` |
| **stdin no entregado** | `HookFailure` (salvo PolicyDeny) | `classify_run` `:906-914` |
| **stdout con `{"banner":"..."}`** | Sólo por `emit_collecting_banners` (`:624-698`, `extract_banner` `:892-904`) | No se usa en el flujo de tools de hoy |
| **timeout** | 30 s por defecto (`DEFAULT_HOOK_TIMEOUT_SECS` `:44`), override por regla (`timeout` en `RawCommandAction` `:131`) | `run_command_hook` `:1050-1059` |
| **`on_failure`** | Sólo se honra en `PreToolUse`: `block` convierte un `HookFailure` en `Deny`; default `allow` (fail-open). En el resto de eventos siempre `Allow`. | `:1018-1026`, `apply_verdict` `:872-890` |
| **matcher** | Regex contra `matcher_context` (nombre de tool, o el mensaje para `UserPromptSubmit`/`Stop`). Regex inválida → regla descartada con warning. | `:998-1012`, `:805-819` |

Los errores de un hook **nunca propagan** en modo `emit`: se loguean y se sigue (`:518-520`,
`:605-613`). En `emit_blocking` un hook que no puede ejecutarse se convierte en `HookFailure`
(`:744-759`) y sólo bloquea si `on_failure: block`.

### 3.4 Dónde se pueden colgar

- Archivo: `<plugin-root>/hooks/hooks.json` (`hooks/mod.rs:4-20` documenta el schema; carga en
  `:435-472` → `load_hooks_file` `:968-1048`).
- Descubrimiento de plugins: `crates/aegis/src/plugins/discovery.rs:52-77`, con dos raíces:
  - usuario: `plugin_install_dir()` (`discovery.rs:61`),
  - proyecto: `<project_root>/.agents/plugins` (`discovery.rs:181-183`).
- Placeholder `"${PLUGIN_ROOT}"` en el comando (`expand_plugin_root` `:1189+`), y `$PATH` del login
  shell opcional (`:1137-1187`).
- Sólo se soporta `type: "command"`; acciones de otro tipo se ignoran (`select_action` `:142-176`).

### 3.5 Cuáles hay configurados hoy

**Ninguno.** Evidencia:

```
Get-ChildItem -Recurse -Filter hooks.json -Path state   → 0 resultados
Test-Path state\config\plugins        → no
Test-Path state\.agents\plugins       → no
Test-Path $env:USERPROFILE\.agents\plugins → no
Test-Path C:\Aegis-Proyects\.aegis\plugins → no
Test-Path C:\Aegis-Proyects\src\.aegis\plugins → no
```

O sea: `HookManager::from_plugins` recibe lista vacía, `has_hooks(e)` es `false` para todos los
eventos, y todas las llamadas `emit*` retornan en la primera línea (`:522-524`, `:569-571`).
Los hooks están **implementados y muertos** por falta de plugin. El único consumidor real son los
tests (`agents/state_machine/tests/hooks_lifecycle.rs`, 61.747 bytes).

---

## 4. Sandbox de escritura: estado real

### 4.1 Existe, y no es un prompt

`crates/aegis/src/security/workspace_sandbox.rs` (405 líneas). No es texto de `delegate`: es un
`ToolInspector` del motor, igual que el de permisos.

| Pieza | Ruta:línea | Qué hace |
|---|---|---|
| Doc del módulo | `workspace_sandbox.rs:1-14` | Dos reglas, cero modelo de por medio ("costo 0 en tokens"). El `RequireApproval` del sandbox gana sobre un `always_allow`. |
| `WRITE_TOOLS = ["write","edit"]` | `:26` | Tools cuyo `path` se valida |
| `SHELL_TOOLS = ["shell","bash"]` | `:28` | Tools cuyo `command` se inspecciona |
| `PROTECTED_FRAGMENTS` | `:31-41` | `\state\config\`, `\.ssh\`, `\.git\config`, `secrets.yaml/yml`, `auth.json`: piden permiso **aunque estén dentro del root** |
| `DESTRUCTIVE_PATTERNS` (25 pares) | `:45-74` | `rm -rf /`, `del /f /s /q`, `rd /s /q`, `format c:`, `diskpart`, `mkfs.`, `dd if=`, `shutdown /s`, `git reset --hard`, `git clean -fdx`, `git push --force`, `drop table`, `remove-item -recurse -force`, `sdkmanager --uninstall`, `docker system prune`, … |
| `path_inside` | `:109-119` | Compara componentes normalizados, case-insensitive (Windows). No sigue symlinks. |
| `resolve_target` | `:134-150` | `canonicalize` del padre + nombre; si no existe el padre, normalización léxica de `..`/`.` |
| `check_write` | `:184-215` | Fragmentos protegidos primero; después dentro/fuera del root |
| `destructive_reason` | `:218-224` | Match por substring en minúsculas sobre el comando completo |
| `WorkspaceSandboxInspector::verdict` | `:235-271` | Sin root resoluble → pide permiso; `write`/`edit` fuera del root → pide permiso; `shell` destructivo → pide permiso |
| `impl ToolInspector` | `:275-323` | `name() == "workspace_sandbox"`, `finding_id: "sandbox:<request.id>"`, confianza 0.9 |
| Registro en la cadena | `agents/agent.rs:353-399`, bloque `:370-386` | Se añade **antes** del `PermissionInspector` (que entra en `:389-393`) para que su `RequireApproval` gane |
| Flag de apagado | `agent.rs:377-386` | `AEGIS_WORKSPACE_SANDBOX` (`bool`, default `true`); `false` = no se registra |
| Montaje del resultado | `permission/permission_inspector.rs:116-128` | Los resultados de inspectores no-permiso se aplican como overrides (`apply_inspection_results_to_permissions`) |

Diseño hecho, no a medias: hay 8+ tests unitarios (`:325-405`, `inside_the_root_is_allowed`,
`relative_escape_is_caught`, `sibling_project_is_outside`, …).

### 4.2 Estado REAL hoy: apagado

```
state/config/config.yaml:1   AEGIS_MODE: auto
state/config/config.yaml:20  AEGIS_WORKSPACE_SANDBOX: false
```

Con `false`, el branch `agent.rs:380` no se toma: **el inspector no existe en la cadena**. Es una
decisión del operador documentada en el propio comentario (`agent.rs:374-376`): "no quiere que el
harness pida permiso para nada", 2026-10-27.

Efecto combinado con el modo: como `AEGIS_MODE: auto` y los modos plan/revisar no están puestos, el
camino normal hoy es `Allow` sin tarjeta. `permission.yaml` sigue mandando para lo que tenga escrito
(el mapa `user:`), pero nada pide permiso por ruta ni por comando destructivo.

### 4.3 `core/ops/verify-sandbox.ps1`: qué prueba de verdad

**No prueba el sandbox de escritura.** Es un smoke de arranque del binario con store aislado
("sandbox" = *store temporal*, no *WorkspaceSandboxInspector*):

| Línea | Qué hace |
|---|---|
| `:9-10` | Exige `core\bin\aegis-<Tag>.exe` |
| `:11-14` | Crea `%TEMP%\sandbox-<Tag>\config` y copia `state\config\config.yaml` |
| `:16-17` | `AEGIS_PATH_ROOT` al temp, `AEGIS_SERVER__SECRET_KEY=sandbox` |
| `:18-23` | `Start-Process --host 127.0.0.1 --port 3298`, polling `/health` hasta 45 s |
| `:26` | `Stop-Process -Force` (mata el proceso de prueba, no el serve vivo) |
| `:30-36` | Verifica que exista `data\sessions\sessions.db`, la vista `v_visible_messages` y `schema_version` |
| `:37-40` | Filtra `err.log` por `code_execution|code-mode|ERROR|panic|v_visible` |

Lo que sí está en el código: la creación del store, la vista `v_visible_messages` y
`schema_version`. Lo que **no** está: ninguna aserción sobre `workspace_sandbox`, ni sobre
`AEGIS_WORKSPACE_SANDBOX`, ni sobre tarjetas de permiso. Cero intersección con §4.1.

---

## 5. Local vs GitHub (block/goose)

Verificado con `gh api repos/block/goose/contents/crates --jq '.[].name'` (2026-10-29): el árbol
upstream tiene `goose`, `goose-agent`, `goose-cli`, `goose-context-management`, `goose-download-manager`,
`goose-local-inference`, `goose-mcp`, `goose-provider-types`, `goose-providers`, `goose-roaming`,
`goose-sdk`, `goose-sdk-types`, `goose-test`, `goose-test-support`, `goose-acp-macros`.
`gh api repos/block/goose/contents/crates/goose/src/hooks --jq '.[].name'` → `mod.rs`.

| Pieza | Local (Aegis) | Upstream (goose) | Veredicto |
|---|---|---|---|
| Hooks | `crates/aegis/src/hooks/mod.rs` (2312 líneas) | `crates/goose/src/hooks/mod.rs` (existe) | **Origen común.** Aegis lo extendió: `PreToolUseResult` + `policy_evaluated`/`blocked_by`/`cause` (`:246-258`, `:341-347`, `:355-368`) y el `on_failure: block` con `HookChainOutcome` (`:370-409`, `:872-890`) son añadidos sobre el spec de Open Plugins. |
| Extensión `mode` (plan/revisar/ejecutar) | `crates/aegis/src/agents/platform_extensions/mode.rs` | No consta en upstream (la carpeta `platform_extensions` no aparece listada y `goose` upstream no tiene esta extensión por nombre) | **Propio.** Sin equivalente. |
| `session_overrides` por sesión | `config/permission.rs:40-43`, `:221-273` | Upstream sólo tiene `permission.yaml` + `smart_approve` | **Propio.** |
| Sandbox por workspace | `crates/aegis/src/security/workspace_sandbox.rs` | No existe con ese nombre (upstream tiene `SecurityInspector`/`EgressInspector`/`AdversaryInspector`, que Aegis también tiene en `security/`) | **Propio.** |
| Modo ACP único `auto` | `acp/response_builder.rs:308-317`, `acp/server.rs:3170-3173` | Upstream expone los 4 (`Auto`/`Approve`/`SmartApprove`/`Chat`) con `mode_mapping` por proveedor (`acp/provider.rs:4368+` conserva ese mapeo para proveedores externos) | **Divergencia deliberada** (commit `8d559d0b5`). Ojo: el mapeo a CLIs externos sigue vivo. |
| `sweep_pending` | `session/pending_confirmations.rs` + `aegis-serve --sweep-pending` | No consta | **Propio.** |
| `checks/` | `crates/aegis/src/checks/mod.rs` (922 líneas): `.agents/checks/*.md` + `**/.agents/REVIEW.md`, consumido por `aegis review` y por `sources.rs:1000-1006` | No es de este dominio: **no es un sistema de checks de seguridad**, es el catálogo de revisiones (frontmatter YAML: `name`, `model`, `turn-limit`, `tools`, `severity-default`) | Aclaración: pedido fuera de los tres temas; no toca permisos ni modos. |

---

## 6. Invariantes y trampas

1. **El modo no sobrevive al proceso.** `session_overrides` es memoria pura (`config/permission.rs:42`).
   Un `swap.ps1 -Restart` en medio de un `plan` lo borra en silencio. Si se quiere durabilidad, el
   lugar es una columna nueva o `extension_data`, no el `PermissionManager`.
2. **`mode` sin manager global degrada a `ejecutar`.** `ModeClient::current` → `Ejecutar` si
   `global_permission_manager()` es `None` (`mode.rs:134-139`). En ese estado la tool responde
   `Ya estás en modo ejecutar` y no hay override posible.
3. **`ejecutar` borra, no "pisa con allow".** `entries()` vacío → `overrides.remove(session_id)`
   (`config/permission.rs:258-260`). Si alguien había puesto un `NeverAllow` por RPC (modo debate),
   pasar a `ejecutar` lo elimina.
4. **El match tolera el prefijo de extensión** (`session_permission_for_tool`, `config/permission.rs:235-248`):
   `"write"` en el override aplica a `developer__write`. El bug histórico (override mudo) está
   documentado en `:232-234`.
5. **`plan` no es sólo "bloquear": es no anunciar.** El filtro `filter_denied_tools`
   (`inference_preparation.rs:73-77`) va en el request, así que el modelo no ve las tools. Un modo
   que sólo rechazara en ejecución haría que el modelo gastara el turno intentando (comentario
   `:26-28`).
6. **La tarjeta se pide una vez.** `pending_requests()` excluye lo que ya tiene
   `ToolConfirmation` (`ops_tool_approval.rs:228-244`). Si el turno muere, no se reemite: hay que
   usar `--sweep-pending` o reanudar el turno.
7. **`user_only` en los dos lados.** El pedido (`ops_tool_approval.rs:126`) y la respuesta
   (`tool_confirmation.rs:108`) van con visibilidad `(false,false)`: el modelo nunca ve el pedido de
   permiso ni la decisión. Si algo "no aparece" en el contexto del modelo, es a propósito.
8. **Un turno por sesión, exclusivo.** `try_start_turn` (`coordinator.rs:40-50`): mientras hay
   confirmaciones pendientes, cualquier turno nuevo rebota con `session already has an active turn`.
9. **Los hooks no pueden tumbar la tool** en modo `emit` (`hooks/mod.rs:518-520`), pero en
   `PreToolUse` con `on_failure: block` un fallo **sí** niega, y el mensaje al modelo es explícito:
   `"That hook is configured to block on failure."` (`:394-397`).
10. **`SessionEnd` no existe en la práctica.** Configurar un hook ahí es configurar un no-op.
11. **El sandbox está apagado por flag.** Cualquier razonamiento sobre "el sandbox protege" hoy es
    falso: `AEGIS_WORKSPACE_SANDBOX: false` (`config.yaml:20`).
12. **`AEGIS_MODE: auto` es un parámetro de config, no del enum de tres modos.** Son dos sistemas
    paralelos con nombres que se solapan: `AegisMode` (ACP, 4 variantes, una expuesta) y
    `SessionMode` (extensión `mode`, 3 variantes, en memoria). No confundirlos al leer `session.aegis_mode`.

---

## 7. Referencias web

| URL | Qué aportó |
|---|---|
| https://open-plugins.com/agent-builders/components/hooks | Spec que cita el módulo (`hooks/mod.rs:1-2`). Devuelve la portada de **Agent Plugins Specification v1.0.0**; el fragmento descargado no incluye la sección de hooks, así que el contrato exacto de eventos no se pudo confirmar contra la spec: el contrato real es el del código (`hooks/mod.rs:916-966`). |
| https://goose-docs.ai/docs/guides/security/ | Página "Staying Safe with goose" (200 OK). Índice de seguridad de goose: Adversary Mode, Prompt Injection Detection, Classification API. **No hay** sección de hooks ni de modos de sesión. |
| https://goose-docs.ai/ | Portada: confirma que goose es de AAIF, 70+ extensiones, "sandbox mode" mencionado como feature de seguridad, sin detalle de permisos por sesión. |
| https://github.com/aaif-goose/goose | Repo público de goose (resultado de búsqueda). Para el código se usó la API (`repos/block/goose/contents/...`), que es la que alimenta el fork local. |

No se encontró documentación pública de goose sobre **hooks** ni sobre **modos de sesión** con las
URLs probadas. No se declara 404 porque las dos páginas existen; lo que no existe es el contenido.

---

## 8. Huecos y deuda (con evidencia)

| # | Hueco | Evidencia |
|---|---|---|
| 1 | El modo plan/revisar/ejecutar **no se persiste**. Reinicio = `ejecutar`. | `config/permission.rs:42` (memoria), ausencia de cualquier escritura a disco en `set_session_permissions` (`:252-263`) |
| 2 | La UI **no tiene chip** y no reaplica al cambiar de sesión. El único camino es la tool o la palette. | `web/src/session-mode.ts:143-149` (`renderChip` vacía el chip a propósito), `:161-162` |
| 3 | `web/src/session-mode.ts` mantiene **una copia** de `WRITE_TOOLS`/`READ_ONLY_TOOLS` (`:49-61`) que puede divergir de `mode.rs:32-44` sin que nada falle. | duplicación literal de las listas |
| 4 | `session-mode.ts:166-174` escucha un evento `aegis:mode-hint` que **ningún código emite**: el puente motor→UI está muerto. Verificado por grep en `web/src`, `web/app` y `web/dist-ts`: las únicas apariciones son el `addEventListener` (`session-mode.ts:166`, compilado en `app/session-mode.js:7` y `dist-ts/app/session-mode.js:7`); no hay `dispatchEvent('aegis:mode-hint')` en ningún lado. El único camino vivo es la palette (`src/palette.ts:105-117`). | grep anterior |
| 5 | `SessionEnd` no se emite nunca. | grep `HookEvent::SessionEnd` → sólo `hooks/mod.rs:78,95` |
| 6 | No hay `hooks.json` en ningún plugin: todo el sistema de hooks está inerte. | §3.5 |
| 7 | `--sweep-pending` es manual; no hay barrido en arranque ni en `session/load`. | `crates/aegis-server/src/main.rs:383`; ausencia de llamada en `acp/server.rs`/`load_session.rs` |
| 8 | La confirmación **no tiene timeout**: una sesión con tarjeta abierta bloquea todo turno nuevo indefinidamente. | `coordinator.rs:90-121`, `:40-50` |
| 9 | El sandbox de escritura está **implementado y apagado**. | `config.yaml:20` + `agent.rs:377-386` |
| 10 | `verify-sandbox.ps1` no verifica el sandbox: nombre engañoso. No hay ningún test de integración del `WorkspaceSandboxInspector` fuera de sus unit tests. | `core/ops/verify-sandbox.ps1:1-40` vs `workspace_sandbox.rs:325-405` |
| 11 | `DESTRUCTIVE_PATTERNS` es substring sobre el comando completo: `rm -rf ./build` no matchea (`"rm -rf /"` no aparece), y `echo "drop table"` sí matchea (falso positivo). | `workspace_sandbox.rs:45-74`, `:218-224` |
| 12 | El `prompt` de la tarjeta sólo lo llena el sandbox o extension management; para cualquier otra tool el operador ve una tarjeta sin razón escrita. | `permission_inspector.rs:167,180` (`RequireApproval(None)`) |

---

## No verificado

- No se ejecutó ningún build, test ni binario. Las afirmaciones sobre comportamiento en runtime
  (p. ej. que `request_permission` llega de verdad al cliente web y cómo lo dibuja `app.js`) salen
  de leer el código, no de observarlo.
- No se inspeccionó `sessions.db` para contar cuántas sesiones tienen hoy `ToolConfirmation` sin
  respuesta (el dato sería el tamaño real del problema #7). Requeriría `sqlite3` sobre el store vivo.
- No se revisó el lado cliente de `session/request_permission` en `web/` (cómo se renderiza la
  tarjeta y si respeta las cuatro opciones). Fuera del alcance asignado.
- No se confirmó contra la spec de Open Plugins si `PreToolUseResult` es una extensión propia o un
  evento del spec: el fragmento web descargado no llega a esa sección.
- El contenido exacto de `crates/goose/src/hooks/mod.rs` en upstream no se leyó (sólo se confirmó su
  existencia vía API); la comparación de §5 se basa en el árbol local y en esa existencia.

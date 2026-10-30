# 07 — Permisos, seguridad, hooks y sandbox de escritura

Alcance: `crates/aegis/src/{permission,security,hooks,checks}`, `config/permission.rs`, `acp/server*.rs` en lo que toca aprobaciones, `core/ops/verify-sandbox.ps1`, config viva (`state/config/{permission,config}.yaml`) y el modo `plan|revisar|ejecutar`.
Base: árbol de trabajo local al 2026-10-29, HEAD `8d559d0b5`, WIP sin commitear en `mode.rs`/`config/permission.rs` (sólo formato). Todo lo citado es `ruta:línea` del repo local.

## 0. Estado real en una línea

| capa | prendida hoy | evidencia |
|---|---|---|
| modo de sesión (`AEGIS_MODE`) | `auto` → toda tool se aprueba salvo override de sesión | `state/config/config.yaml:1`, `permission/permission_inspector.rs:163-169` |
| `permission.yaml` | irrelevante en `auto`; `always_allow` incluye `shell`, `edit`, `write`, `execute_typescript`; `ask_before` y `never_allow` vacíos | `state/config/permission.yaml:2-30` |
| seguridad por patrones | **apagada** (`SECURITY_PROMPT_ENABLED: false`) | `state/config/config.yaml:17`, `security/mod.rs:59-74` |
| sandbox de escritura | **apagado** (`AEGIS_WORKSPACE_SANDBOX: false`) | `state/config/config.yaml:20`, `agents/agent.rs:377-386` |
| hooks | cero `hooks.json` en el árbol | `Get-ChildItem -Recurse -Filter hooks.json` → sin resultados |
| plan/revisar | sólo si el operador o el agente lo piden con `mode__request_mode` (o `set_tool_permissions` con `sessionId`); es RAM, no disco | `config/permission.rs:42`, `agents/platform_extensions/mode.rs:141-165` |

Conclusión operativa: hoy el gate del harness es **el modo de sesión**, y su default es "todo permitido". Las otras tres capas (patrones, sandbox, hooks) existen en código y están desactivadas por config.

## 1. Mapa de piezas

| ruta:línea | qué hace | quién la llama |
|---|---|---|
| `crates/aegis/src/permission/mod.rs:1-10` | re-exporta el motor y los tipos de `aegis_providers::permission` | `lib.rs` |
| `config/permission.rs:19-25` | enum `PermissionLevel { AlwaysAllow, AskBefore, NeverAllow }` (serde snake_case) | todo el resto |
| `config/permission.rs:29-33` | `PermissionConfig { always_allow, ask_before, never_allow }` = esquema de `permission.yaml` | `load_permission_map` |
| `config/permission.rs:37-43` | `PermissionManager`: mapa persistido + `session_overrides` en RAM | `agent.rs`, `acp/server.rs` |
| `config/permission.rs:52-68` | instancia global del proceso (`install_global_permission_manager` / `global_permission_manager`) | `agents/agent.rs:2504`, `acp/server.rs:1437` |
| `config/permission.rs:159-182` | `get_permission`: orden **never_allow → always_allow → ask_before** dentro de la categoría | `get_user_permission`, `get_smart_approve_permission` |
| `config/permission.rs:224-248` | overrides por sesión; `session_permission_for_tool` tolera el prefijo `ext__tool` | `permission_inspector`, `mode.rs`, `inference_preparation.rs`, `acp/server/tools.rs` |
| `config/permission.rs:275-357` | persistencia: lock `fs2` sobre `permission.yaml.lock`, relectura, escritura atómica (`NamedTempFile::persist`), pánico si el YAML está corrupto | `update_permission`, `clear_permissions`, `remove_extension` |
| `permission/permission_inspector.rs:144-284` | inspector `permission`: convierte nivel → `Allow|RequireApproval|Deny` | `ToolInspectionManager::inspect_tools` |
| `permission/permission_inspector.rs:73-131` | `process_inspection_results`: base = resultado del inspector `permission`; el resto de inspectores lo **sobreescriben** | `tool_inspection.rs:151-159` |
| `permission/permission_judge.rs:145-185` | juez LLM de "read-only" (`platform__tool_by_tool_permission`), sólo SmartApprove | `permission_inspector.rs:246-257` |
| `permission/permission_store.rs:36-143` | almacén `config/permissions/tool_permissions.json` con hash blake3 de argumentos y expiración | ver §9 (no verificado) |
| `tool_inspection.rs:57-119` | corre inspectores **en orden de registro**; si uno falla, se loguea y se sigue | `ops_tool_approval.rs:80-88` |
| `tool_inspection.rs:170-261` | mezcla final: `Deny` gana, `RequireApproval` degrada `approved`→`needs_approval`, `Allow` **nunca** revierte | `permission_inspector.rs:124-127` |
| `agents/agent.rs:352-399` | orden de registro: `security`, `egress`, `adversary`, `workspace_sandbox` (condicional), `permission`, `repetition` | `Agent::new` |
| `agents/state_machine/inference_preparation.rs:73-78` | **oculta** al modelo las tools con override de sesión `NeverAllow` | pipeline de inferencia |
| `agents/state_machine/ops_tool_approval.rs:78-141` | pide inspección de los requests pendientes y emite `ActionRequired::ToolConfirmation` (`user_only`) | state machine |
| `agents/state_machine/ops_tool_approval.rs:57-76` | aplica la respuesta: `AlwaysAllow`/`AlwaysDeny` **se persisten** en `permission.yaml` | state machine |
| `acp/server.rs:1905-1922` | traduce `ActionRequired::ToolConfirmation` a `PendingToolPermission` | `handle_message` |
| `acp/server.rs:2067-2132` | emite el `RequestPermissionRequest` ACP y espera la respuesta; error → `Permission::Cancel` | `handle_tool_permission_request` |
| `acp/server/tool_calls/conversion.rs:136-156` | arma el `ToolCallUpdate` de la aprobación (título, `rawInput`, `content` = prompt si hay) | `acp/server.rs:2077` |
| `agents/tool_confirmation_coordinator.rs:17-153` | estado en RAM de las confirmaciones pendientes: una sola respuesta, inmutable | `agent.rs:548` |
| `agents/agent.rs:537-604` | `submit_tool_confirmation`: dedupe, `Cancel`→`DenyOnce`, persiste la decisión como mensaje | `acp/server.rs:2113-2116` |
| `security/mod.rs:96-243` | `SecurityManager::analyze_tool_requests` (sólo empuja hallazgos sobre umbral) | `security_inspector.rs:73-76` |
| `security/scanner.rs:132-201` | análisis de un tool call: **sólo si la tool se llama exactamente `shell`** | `SecurityManager` |
| `security/patterns.rs:48-320` | ~25 patrones regex de comandos peligrosos | `PatternMatcher::scan_for_patterns` |
| `security/workspace_sandbox.rs:226-322` | inspector `workspace_sandbox` (escritura fuera del root / comando destructivo) | `agent.rs:381-385` |
| `hooks/mod.rs:418-475` | `HookManager::load` escanea plugins por `hooks/hooks.json` | `Agent` |
| `hooks/mod.rs:703-707` | `emit_blocking` / `emit_blocking_with_outcome` | `ops_toolcalling.rs:188-194`, `ops_stop_hook.rs:97` |
| `checks/mod.rs:1-40` | *review checks* (`.agents/checks/*.md`, `REVIEW.md`) para `aegis review` | CLI `review` — **no** valida cambios en el camino de escritura |
| `core/ops/verify-sandbox.ps1:1-50` | verifica un binario nuevo en un store temporal; **no** es un sandbox de escritura | operador / ops |

## 2. Modelo de decisión

### 2.1 Quién evalúa

`ToolInspectionManager` (registro de `ToolInspector`, `tool_inspection.rs:57-119`) recibe los `ToolRequest` pendientes y devuelve `Vec<InspectionResult>`. Cada inspector decide por `tool_request_id`. Después `PermissionInspector::process_inspection_results` (`permission/permission_inspector.rs:73-131`) arma el `PermissionCheckResult { approved, needs_approval, denied }`:

1. Línea 88-114: la decisión del inspector `permission` es la **base**. Si un request no tiene resultado del inspector de permisos → `needs_approval` (fail-closed, línea 110-113).
2. Línea 117-128: los demás inspectores (`security`, `egress`, `adversary`, `workspace_sandbox`, `repetition`) se aplican como **override** vía `apply_inspection_results_to_permissions` (`tool_inspection.rs:170-261`).

### 2.2 Precedencia exacta

| situación | resultado | código |
|---|---|---|
| un inspector dice `Deny` | saca el request de `approved` y `needs_approval`, lo mete en `denied` | `tool_inspection.rs:213-232` |
| un inspector dice `RequireApproval` | saca de `approved` y lo mete en `needs_approval` | `tool_inspection.rs:233-252` |
| un inspector dice `Allow` | no toca nada: **no puede revertir** un `Deny` ni un `RequireApproval` de otro inspector | `tool_inspection.rs:253-256` |

O sea: **deny > ask > allow**, y "ask" de cualquier inspector (sandbox, seguridad) gana sobre un `always_allow` de `permission.yaml`. Es exactamente lo que el comentario de `agent.rs:370-372` dice buscar.

### 2.3 Orden interno del inspector `permission`

`permission_inspector.rs:159-207`, por modo (`AegisMode`, definido en `crates/aegis-provider-types/src/aegis_mode.rs:22`):

| modo | regla |
|---|---|
| `Chat` | `continue` — no produce decisión (línea 160) |
| `Auto` | **sólo** mira el override de sesión: `NeverAllow`→Deny, `AskBefore`→Ask, resto→**Allow** (163-169). `permission.yaml` no se consulta |
| `Approve` / `SmartApprove` | 1) override de sesión **o** `user` de `permission.yaml` (172-182) → 2) anotación `read_only_hint == true` en SmartApprove (184-187) → 3) `manage_extensions` siempre pide (189-192) → 4) juez LLM en SmartApprove si no hay caché o la caché dice `AlwaysAllow` (194-201) → 5) default: pedir (203-205) |

### 2.4 Granularidad

| granularidad | existe | evidencia |
|---|---|---|
| tool completa (nombre) | sí, es la única realmente usada | claves de `permission.yaml` son nombres de tool |
| argumentos | sólo en `ToolPermissionStore` (hash blake3 de `arguments`), que no está en el camino de decisión citado | `permission_store.rs:117-127` |
| path | sólo en `workspace_sandbox` (destino de `write`/`edit` contra el `working_dir`) | `security/workspace_sandbox.rs:239-257` |
| comando | sólo por patrones de substring del `command` de `shell` | `security/workspace_sandbox.rs:259-268`, `security/scanner.rs:403-411` |

Las claves de `permission.yaml` aceptan nombre corto o `ext__tool`: `session_permission_for_tool` prueba el nombre completo y después el sufijo tras el último `__` (`config/permission.rs:235-248`), pero `get_user_permission` (línea 102) **no** hace ese fallback — asimetría real.

### 2.5 Flujo paso a paso (un turno con `revisar`)

1. El modelo emite `ToolRequest` (`call_tool` name + `arguments`).
2. `inference_preparation.rs:73-78` ya filtró las tools con override `NeverAllow` en la request de inferencia → en `plan` el modelo no ve `shell/edit/write`.
3. `ToolApprovalOperation::run` (`ops_tool_approval.rs:43-148`) corre `inspect_tools` sobre los requests pendientes.
4. Cada inspector devuelve `InspectionResult`; `process_inspection_results` mezcla (§2.2).
5. `denied` → `mark_executable(false)` (línea 103-105): la tool no se ejecuta.
6. `needs_approval` → `mark_executable(false)` + mensaje `ActionRequired::ToolConfirmation{id, tool_name, arguments, prompt}` marcado `user_only` (líneas 107-127). `prompt` es `Some` sólo si algún inspector devolvió `RequireApproval(Some(texto))` (111-117).
7. `acp/server.rs:1905-1922` → `handle_tool_permission_request` → `build_permission_tool_call_update` (`conversion.rs:136-156`) → `RequestPermissionRequest::new(session_id, tool_call_update, options)` con **cuatro** opciones (2092-2097): `AllowAlways`, `AllowOnce`, `RejectOnce`, `RejectAlways`; el `optionId` es la serialización serde del kind (2084-2090).
8. Respuesta → `outcome_to_confirmation` (`server.rs:2151-2156`) → `Agent::submit_tool_confirmation` (`agent.rs:537-604`). `Permission::Cancel` se normaliza a `DenyOnce` (550-554); una segunda respuesta con otro valor devuelve error (566-568).
9. Al turno siguiente, `ApprovalState::responses` (`ops_tool_approval.rs:205-226`) aplica: `AllowAlways` → `update_user_permission(tool, AlwaysAllow)` **persistido**; `AlwaysDeny` → `NeverAllow` persistido (60-70); luego `mark_executable`.

## 3. Modos `plan` / `revisar` / `ejecutar`

### 3.1 Dónde se definen

No hay enum persistido: el "modo" es **la forma del override de sesión** (`agents/platform_extensions/mode.rs`).

| pieza | línea | contenido |
|---|---|---|
| `WRITE_TOOLS` | 32 | `["shell", "edit", "write"]` |
| `READ_ONLY_TOOLS` | 33-44 | 10 tools (`read_file`, `grep`, `tree`, `read_image`, `web*`, `load_skill`, `load`, `chatrecall`, `extensionmanager__search_available_extensions`) |
| `SessionMode::entries` | 80-100 | `plan`: escritura `NeverAllow` + lectura `AlwaysAllow`; `revisar`: escritura `AskBefore` + lectura `AlwaysAllow`; `ejecutar`: lista vacía (borra overrides) |
| `SessionMode::parse` | 63-70 | acepta `plan`, `revisar|review`, `ejecutar|execute|auto` (case/trim-insensitive) |
| `current_with` | 150-156 | el modo se **deduce** del override de la tool `write`: `NeverAllow`→plan, `AskBefore`→revisar, resto→ejecutar |
| `apply_with` | 158-165 | `manager.set_session_permissions(session_id, entries)` |
| tool `request_mode` | 167-191 | schema `{mode, reason}`, anotada `read_only=false, destructive=true` |
| respuesta al modelo | 193-217 | texto con el motivo y el efecto del modo |

### 3.2 Qué tools se ocultan

`inference_preparation.rs:73-78`: `filter_denied_tools` elimina de la lista enviada al modelo toda tool cuyo **override de sesión** sea `NeverAllow`. Sólo overrides de sesión: un `never_allow` en `permission.yaml` **no oculta** la tool, sólo la niega en la ejecución.

En `plan` quedan visibles `read_file`, `grep`, `tree`, `read_image`, `websearch__*`, `load_skill`, `load`, `chatrecall`, `extensionmanager__search_available_extensions`, `memory__*`, `scheduler__*`, `delegate`, `execute_typescript`, `mode__request_mode`… (todo lo que no sea exactamente `shell|edit|write`).

### 3.3 Cómo se pide la aprobación

Mensaje ACP exacto (`acp/server.rs:2099-2100`): `RequestPermissionRequest { sessionId, toolCall: ToolCallUpdate { toolCallId = request_id, title = default_tool_title(tool, args), kind = default, status = Pending, rawInput = arguments, content? = [text(prompt)] }, options: [allow_always, allow_once, reject_once, reject_always] }` (`conversion.rs:143-155`).

Trampa: **no hay diff**. `build_permission_tool_call_update` sólo agrega `content` si hay `prompt`, y en `revisar` el `RequireApproval` es `None` (`permission_inspector.rs:180`). El texto de la tool `request_mode` promete "cada escritura pide permiso al operador, con su diff" (`mode.rs:175`) y el mensaje de commit del modo lo repite: **el diff no existe en el código**.

Los únicos prompts con texto son: alerta de seguridad (`security_inspector.rs:34-40`, prefijo `🔒 Security Alert` + `Finding ID`), escritura fuera del workspace / ruta protegida (`workspace_sandbox.rs:242-256`) y comando destructivo (`workspace_sandbox.rs:263-266`).

### 3.4 Si la sesión se corta

| escenario | qué queda | evidencia |
|---|---|---|
| turno interrumpido con confirmaciones pendientes | el estado en RAM **no se limpia** al soltar el turno; se limpia al arrancar el turno siguiente (`start_new_turn`) | `tool_confirmation_coordinator.rs:166-172`, test `236-251` |
| respuesta después del corte dentro del mismo proceso | `answer()` sigue devolviendo la decisión previa; una segunda respuesta distinta da error | `agent.rs:556-569` |
| reinicio del proceso | se pierde `confirmations` (RAM) **y** `session_overrides` (RAM) → la sesión vuelve a `AEGIS_MODE`/`permission.yaml`, es decir, sale de `plan`/`revisar` sin aviso | `config/permission.rs:42`, `tool_confirmation_coordinator.rs:23` |
| el cliente ACP corta la request de permiso | el `on_receiving_result` mapea el error a `Permission::Cancel` → `DenyOnce` | `acp/server.rs:2105-2111`, `agent.rs:550-554` |
| la decisión sobrevive en el transcript | sí: `ActionRequired::ToolConfirmationResponse` queda como mensaje y `ApprovalState::from_messages` la relee | `ops_tool_approval.rs:183-189` |

## 4. Seguridad por patrones

### 4.1 Qué corre y cuándo

`SecurityManager::analyze_tool_requests` (`security/mod.rs:96-243`) sale temprano si `SECURITY_PROMPT_ENABLED` es falso (101-107; default `false`, línea 73). El default de umbral es `0.8` (`security/scanner.rs:126-130`). Sólo se empuja un `SecurityResult` si `confidence > threshold` (177-215); los hallazgos bajo umbral sólo se loguean como `action = "LOG"` (184, 199-205).

### 4.2 Punto exacto de inspección

`scanner.rs:132-144`: si `!is_shell_tool_name(tool_call.name)` devuelve `scanned: false` con explicación `"Tool call skipped: only shell commands are scanned"`. `is_shell_tool_name` es `matches!(name, "shell")` (`scanner.rs:424-426`).

El texto inspeccionado es el **argumento crudo** del modelo: `arguments["command"]` tal cual (`scanner.rs:403-411`). No hay normalización, de-ofuscación, ni resolución de alias antes del match: se comparan regex contra el string que el modelo escribió, **antes** de que el shell lo parsee o expanda (`$VAR`, backticks, `cmd /c`, `$(...)` siguen intactos). El sandbox usa el mismo criterio pero con `to_lowercase()` + `contains` (`workspace_sandbox.rs:218-224`).

### 4.3 Reglas

`security/patterns.rs:48-320`, `THREAT_PATTERNS`, cada una `(name, regex, description, risk_level, category)`; confianza por nivel (`patterns.rs:37-45`: Critical > High 0.75 > Medium 0.60 > Low 0.45). Muestra representativa:

| name | bloquea / detecta | línea |
|---|---|---|
| `rm_rf_root_bare` | `rm -rf /` con flags combinados y comillas | 49-55 |
| `rm_rf_home_or_root` | `rm -r ~`, `$HOME`, `/home`, `/root` | 56-62 |
| `dd_destruction` | `dd if=/dev/zero of=/dev/sdX` | 63-69 |
| `format_drive` | `format`/`mkfs.extX` sobre `/dev/sdX` | 70-76 |
| `curl_bash_execution` | `curl … \| bash/sh/zsh…` (con ruta y `.exe`) | 78-84 |
| `bash_process_substitution` | `bash <(curl …)` | 85-91 |
| `python_remote_exec` | `python -c … urllib` / `requests … exec` | 92-98 |
| `powershell_download_exec` | `DownloadString` + `Invoke-Expression` | 99-105 |
| `ssh_key_exfiltration` | `curl -d … .ssh/id_rsa` | 107-113 |
| `password_file_access` | leer `/etc/shadow`, `.password` | 114-120 |
| `history_exfiltration` | exfiltrar `.*_history` | 121-127 |
| `crontab_modification` / `systemd_service_creation` / `hosts_file_modification` | persistencia | 129-149 |
| `netcat_listener` / `reverse_shell` / `ssh_tunnel` | red | 151-171 |
| `kill_security_process` | matar AV/firewall/defender | 173-179 |

Todas son POSIX/Linux-céntricas. No hay patrones para `del`, `rd`, `format c:`, `diskpart`, `Remove-Item`, `icacls`, `reg add`, `schtasks`, PowerShell `-enc`/`-e`, ni para `powershell -Command "..."` genérico.

`security/workspace_sandbox.rs:45-74` es la única lista con forma Windows: `del /f /s /q`, `del /s /q`, `rd /s /q`, `rmdir /s /q`, `format c:`, `format d:`, `diskpart`, `mkfs.`, `dd if=`, `shutdown /s`, `shutdown -h`, `git reset --hard`, `git clean -fdx`, `git push --force`, `drop table|database`, `truncate table`, `remove-item -recurse -force`, `sdkmanager --uninstall`, `docker system prune|volume rm`, `rm -rf /|/*|~`, `rm -fr /`.

### 4.4 Cómo se evita el bypass trivial

| vector | mitigación | veredicto |
|---|---|---|
| pipe a shell desde red | `curl_bash_execution` (patrón 78-84) | cubierto si la tool se llama `shell` y el patrón matchea el literal |
| subshell `bash <(curl)` | patrón 85-91 | cubierto literal |
| ruta absoluta al intérprete | regex permite prefijo de ruta y `.exe` (80) | cubierto literal |
| ofuscación / expansión (`$IFS`, comillas embebidas, `cmd /c`, base64) | **ninguna**: se matchea el string crudo | **no cubierto** (§9) |
| tool con otro nombre (`bash`, `developer__shell`, `execute_typescript`) | el escáner exige `name == "shell"` (424-426) | **no cubierto** |
| escritura fuera del workspace con `write`/`edit` | `workspace_sandbox::check_write` canonicaliza y compara componentes case-insensitive (109-215) | cubierto… si el inspector está prendido |
| escritura vía `shell` (`echo > archivo`) | no se evalúa como escritura; sólo pasa por los patrones de comando | **no cubierto** |

## 5. Hooks

Contrato (`hooks/mod.rs:1-24`): archivo `<plugin-root>/hooks/hooks.json` de cada plugin descubierto por `plugins::discovery::discover_enabled_plugins`; sólo acciones `type: "command"`; el script recibe el contexto JSON por stdin y debe salir 0. Timeout por defecto 30 s (`hooks/mod.rs:44`).

| evento | línea | dónde se emite |
|---|---|---|
| `PreToolUse` | 56 | `ops_toolcalling.rs:188-194` (bloqueante: puede denegar la tool) |
| `PreToolUseResult` | 57 | `ops_toolcalling.rs:162-165` |
| `PostToolUse`, `PostToolUseFailure` | 58-59 | post-ejecución |
| `SessionStart`, `SessionEnd`, `UserPromptSubmit` | 60-62 | ciclo de sesión |
| `BeforeReadFile`, `AfterFileEdit` | 63-64 | lectura/edición |
| `BeforeShellExecution`, `AfterShellExecution` | 65-66 | `ops_toolcalling.rs:250` |
| `Stop` | 67 | `ops_stop_hook.rs:97` (bloqueante) |

Decisiones: `HookDecision { Allow, Deny { reason, plugin } }` (`hooks/mod.rs:350-353`). Un fallo del hook puede bloquear según configuración del plugin: `HookChainOutcome` distingue `PolicyDenial` de `HookFailure` y arma el mensaje "Tool call blocked because policy hook `X` could not complete… That hook is configured to block on failure" (`hooks/mod.rs:370-409`). El matcher es regex sobre el nombre de tool, ej. `"developer__shell|developer__text_editor"` (`hooks/mod.rs:12`).

Configurados hoy: **ninguno**. No existe `hooks.json` bajo `C:\Aegis-Proyects` (búsqueda recursiva a profundidad 3 y en `state\config`). El sistema está inerte.

Nota de seguridad: un hook es código arbitrario que corre con los privilegios del harness, sin sandbox, y `PreToolUse`/`Stop` pueden **bloquear**; el modelo no los ve ni los aprueba.

## 6. Sandbox de escritura

Existe, es real, es un **inspector** (no un aislamiento de proceso ni FS), y está **apagado por config** en este store.

| pieza | línea | detalle |
|---|---|---|
| registro | `agents/agent.rs:377-386` | `AEGIS_WORKSPACE_SANDBOX` default `true`, **false** en `config.yaml:20` → no se agrega el inspector |
| tools que vigila | `security/workspace_sandbox.rs:26-28` | `write`, `edit` (valor de ruta) y `shell`, `bash` (valor de comando) |
| raíz | 291-298 | `session.working_dir`; si no se resuelve → `RequireApproval` con "No pude resolver el workspace" |
| rutas protegidas | 31-41 | `\state\config\`, `/.ssh/`, `\.ssh\`, `/.git/config`, `secrets.yaml|yml`, `auth.json` — substring sobre la ruta resuelta, case-insensitive (188-198) |
| resolución | 134-150 | `canonicalize()` del destino; si no existe, canonicaliza el padre; si tampoco, normaliza `..`/`.` léxicamente; quita prefijo `\\?\` |
| comparación | 109-130 | por componentes (`Prefix`/`RootDir`/`Normal`), minúsculas; **no** sigue symlinks |
| veredicto | 184-215 | protegida → deny; dentro del root → allow; fuera → deny con motivo |
| destructivos | 218-224 | `to_lowercase().contains(patrón)` sobre el comando completo |
| salida | 300-321 | `RequireApproval(Some(motivo))` o `Allow` |

Es determinista y sin modelo (0 tokens), pero **no encierra el proceso**: no hay chroot, ni usuario distinto, ni restricción de syscalls, ni filtro de FS a nivel kernel. El único límite físico es "el inspector decide pedir permiso"; si el sandbox está apagado o el modo es `auto`, no hay límite.

`core/ops/verify-sandbox.ps1` **no** es esto: es un arnés de verificación de un binario nuevo (store temporal en `%TEMP%\sandbox-<Tag>`, puerto propio, espera `/health`, inspecciona el `sessions.db` creado). Comparte la palabra "sandbox", no la función.

## 7. Invariantes y trampas

1. **`auto` ignora `permission.yaml`.** En `Auto` el inspector sólo consulta overrides de sesión (`permission_inspector.rs:163-169`). Con `AEGIS_MODE: auto` (config viva), `ask_before`/`never_allow` del YAML no se evalúan.
2. **Deny > Ask > Allow.** `Allow` de un inspector nunca revierte (`tool_inspection.rs:253-256`); por eso el sandbox se registra *antes* que permisos (`agent.rs:370-372`).
3. **Fail-closed en el default.** Sin resultado del inspector `permission` → `needs_approval` (`permission_inspector.rs:110-113`). Sin provider para el juez LLM → conjunto vacío → `RequireApproval` (`permission_inspector.rs:246-257` + `permission_judge.rs:161-184`).
4. **`Allow always` escribe en disco, incluso en `revisar`.** `AlwaysAllow` → `update_user_permission` persistido en `permission.yaml` (`ops_tool_approval.rs:60-70`). En `revisar` el override de sesión sigue ganando (`permission_inspector.rs:172-182`), pero al volver a `ejecutar` la tool queda permitida para todo el store.
5. **`plan`/`revisar` son RAM.** Reiniciar el serve devuelve la sesión al modo global sin aviso (`config/permission.rs:40-42`).
6. **`plan` oculta 3 nombres, nada más.** `shell|edit|write` (`mode.rs:32`). Cualquier otra tool que escriba (`execute_typescript`, `delegate`, `scheduler__*`, `memory__write`) sigue visible y permitida.
7. **El modelo puede cambiar su propio modo.** `request_mode` está en `always_allow` (`permission.yaml:24`) y no tiene guardas: `ModeClient` sólo exige que exista el manager global (`mode.rs:141-146`). El comentario de cabecera lo asume explícitamente ("el operador eligió quedar a merced del modelo", `mode.rs:7-12`).
8. **El escáner de seguridad sólo conoce el nombre exacto `shell`** (`scanner.rs:424-426`), mientras el sandbox normaliza prefijo con `tool_suffix` (`workspace_sandbox.rs:77-79`). Cualquier tool con otro nombre (`bash`, `developer__shell`, `execute_typescript`) es invisible para los patrones.
9. **La seguridad nunca deniega.** `SecurityInspector` sólo produce `RequireApproval` (`security_inspector.rs:34-43`); el operador puede aprobar una inyección detectada con un click y dejarla `always_allow`.
10. **`permission.yaml` corrupto = pánico.** `load_permission_map` hace `panic!` a propósito (`config/permission.rs:303-317`); una edición manual mal formada impide arrancar el harness.
11. **Asimetría corto/largo.** `session_permission_for_tool` tolera `ext__tool`; `get_user_permission` no (`config/permission.rs:102` vs `235-248`).
12. **`Chat` no pasa por aprobación.** `ToolApprovalOperation::run` devuelve `not_applicable()` si el modo es `Chat` (`ops_tool_approval.rs:50-52`) mientras el inspector hace `continue` (`permission_inspector.rs:160`): en `Chat` no se ejerce ninguna de las dos capas.
13. **Hooks sin sandbox.** `PreToolUse` y `Stop` corren comandos del plugin con privilegios del harness y pueden bloquear (`hooks/mod.rs:44,703-707`).
14. **La aprobación trae argumentos crudos, no diff.** `rawInput` + opcional `prompt` (`conversion.rs:143-155`); el texto que promete diff (`mode.rs:175`) no tiene respaldo en código.

## 8. Local vs GitHub (`block/goose`)

`gh api repos/block/goose/contents/crates/goose/src` confirma que upstream ya tiene `permission/` y `security/`, además de `hooks/` y `tool_inspection.rs`.

| pieza local | upstream | invención local |
|---|---|---|
| `permission/{mod,permission_inspector,permission_judge,permission_store}.rs` | existen con los mismos nombres | **no** (base heredada) |
| `security/{adversary_inspector,classification_client,egress_inspector,mod,patterns,scanner,security_inspector}.rs` | existen con los mismos nombres | **no** |
| `security/workspace_sandbox.rs` | no está en la lista upstream de `src/security` | **sí, local** |
| `agents/platform_extensions/mode.rs` | upstream no tiene `mode.rs` (lista: `analyze, apps, chatrecall, code_execution, developer, ext_manager, javascript, mod, scheduler, summarize, summon, todo, tom`) | **sí, local** |
| `session_overrides` + `session_permission_for_tool` en `config/permission.rs` | no hay razón para que exista upstream; los tests y comentarios citan "modo debate" | **sí, local** |
| rama `AegisMode::Auto` con override de sesión (`permission_inspector.rs:163-169`) | upstream en `Auto` no consultaba nada (comentario 161-162) | **sí, local** |
| ocultamiento de tools por override (`inference_preparation.rs:73-78`) | no verificado en upstream | **probablemente local** |
| `AEGIS_WORKSPACE_SANDBOX` como flag de config | no existe upstream | **sí, local** |
| `hooks/` con `HookEvent`/`HookManager` | existe en la lista upstream (`hooks`) | **no** |
| `checks/` | existe en la lista upstream (`checks`) | **no** |
| `core/ops/verify-sandbox.ps1` | no es del repo upstream (ops propias) | **sí, local** |

Commits locales que tocan este dominio: `8d559d0b5 feat(acp): autonomía como único modo Aegis` (toca `acp/server.rs`, `response_builder.rs`, `server/new_session.rs`, `server/tools.rs`). WIP sin commitear en `mode.rs` y `config/permission.rs` es sólo `cargo fmt`.

## 9. Huecos y bypasses plausibles (con evidencia)

| # | hueco | evidencia | efecto |
|---|---|---|---|
| B1 | el escáner sólo matchea `name == "shell"` | `scanner.rs:424-426`, temprano-return en 137-144 | una tool que ejecute comandos con otro nombre (`bash`, `developer__shell`, `execute_typescript`, MCP de terceros) no se analiza nunca |
| B2 | los patrones comparan el string crudo del modelo, sin expansión | `scanner.rs:403-411`, `workspace_sandbox.rs:218-224` | `r""m -rf /`, `rm$'\x20'-rf`, `$IFS`, `cmd /c "del /f /s /q x"`, `powershell -enc <base64>`, `Remove-Item -Recurse -Fo`, `git reset --har""d`: ninguno matchea |
| B3 | lista de destructivos es substring corta y literal | `workspace_sandbox.rs:45-74` | abreviaturas de PowerShell (`-Recurse -Fo`), parámetros reordenados, `rmdir /s /q` vs `rd /S /Q` con otro espaciado, rutas con `^` de escape de cmd |
| B4 | `workspace_sandbox` sólo mira `write`/`edit`; el shell no se evalúa como escritura | `workspace_sandbox.rs:239-268` | `shell` con `echo … > C:\...\state\config\permission.yaml` o `Set-Content` no pasa por `check_write` ni por rutas protegidas |
| B5 | `write_target` sólo lee `path|file_path|filePath` | `workspace_sandbox.rs:82-95` + `235-240` (`?` devuelve `None`) | una tool de escritura con otra clave (`destination`, `target`) devuelve `None` → `Allow` "dentro del workspace" (300-321) sin chequear nada |
| B6 | `plan` sólo enumera 3 tools | `mode.rs:32` | `memory__write`, `scheduler__*`, `delegate`, `execute_typescript` siguen visibles y permitidos en `plan` |
| B7 | el agente puede salir de `plan`/`revisar` | `request_mode` en `always_allow` (`permission.yaml:24`), `mode.rs:141-165` | auto-escalada: no hay gate humano en el cambio de modo |
| B8 | las aprobaciones `AlwaysAllow` se persisten aun con `revisar` | `ops_tool_approval.rs:60-70` | un click en `revisar` deja la tool abierta para siempre en `ejecutar`/`auto` |
| B9 | seguridad apagada por default | `security/mod.rs:73` (`unwrap_or(false)`) y `config.yaml:17` | todo §4 está inerte salvo que se prenda a mano |
| B10 | sandbox apagado en la config viva | `config.yaml:20` | escrituras fuera del root no piden nada, con independencia del modo |
| B11 | `auto` no consulta `permission.yaml` | `permission_inspector.rs:163-169` | `never_allow` global es letra muerta en el modo default |
| B12 | los hooks son código sin sandbox y pueden bloquear | `hooks/mod.rs:44`, `12`, `703-707` | cualquier plugin instalado puede ejecutar y denegar; hoy no hay ninguno cargado |
| B13 | `Chat` no ejerce ninguna capa | `ops_tool_approval.rs:50-52`, `permission_inspector.rs:160` | en `Chat` la política es sólo lo que haga la ejecución concreta de la tool |
| B14 | `Deny` no oculta la tool al modelo | `filter_denied_tools` sólo mira overrides (`inference_preparation.rs:73-78`) | el modelo reintenta en bucle una tool `never_allow` y consume turnos |

## 10. Referencias web (URL literal)

- https://goose-docs.ai/ — home de la documentación oficial de goose (explica ACP, extensiones y "Security: prompt injection detection, tool permission controls, sandbox mode, and an adversary reviewer").
- https://github.com/aaif-goose/goose — repo upstream (redirige desde `block/goose`), usado vía `gh api repos/block/goose/contents/...` para el diff estructural de §8.
- https://open-plugins.com/agent-builders/components/hooks — spec de hooks que cita `hooks/mod.rs:1-2`; define el `hooks.json`, los eventos y el contrato stdin/exit 0.
- https://owasp.org/www-community/attacks/Command_Injection — argumento de por qué matchear el string crudo antes de la expansión no alcanza (quoting, concatenación de comandos, indirección por variables); **no verificado por fetch** en esta sesión, citado por conocimiento estándar.
- https://attack.mitre.org/techniques/T1059/ — T1059 *Command and Scripting Interpreter*: por qué `powershell -enc` y `cmd /c` son el mismo vector que `curl|bash` y no están en `THREAT_PATTERNS`.

## 11. No verificado

- Los `optionId` literales del `RequestPermissionRequest` (`allow_always`, `allow_once`, `reject_once`, `reject_always`): son la serialización serde de `PermissionOptionKind` (`acp/server.rs:2084-2090`); no abrí el schema del crate `aegis-acp` para confirmar el `rename_all`.
- Llamadores de `ToolPermissionStore` (`permission/permission_store.rs`): no encontré referencias desde el camino de decisión; no verifiqué si está muerto o lo usa el CLI/`sources`.
- Comportamiento de ejecución de tools en `Chat`: qué capa decide la ejecución cuando `ToolApprovalOperation` no corre.
- Si upstream (`block/goose`) oculta tools por permiso en la preparación de inferencia; sólo comparé listados de directorios, no el contenido de `inference_preparation` upstream.
- No ejecuté ningún binario, test ni build: todo el documento es lectura de código y config.

# 07a — Motor de decisiones de permisos (Aegis)

Dominio acotado: motor de permisos + inspección por patrones. Fuentes leídas completas:
`crates/aegis/src/permission/*.rs` (4), `crates/aegis/src/security/*.rs` (8), `config/permission.rs`,
`tool_inspection.rs`, `agents/state_machine/ops_tool_approval.rs`, `acp/server/tools.rs`, y la config
viva `state/config/permission.yaml`. Verificación de contraste contra upstream `block/goose` vía
`gh api` + `raw.githubusercontent.com`. Fecha de lectura: 2026-10-29.

---

## 1. Orden de evaluación exacto

### 1.1 Precedencia dentro de una misma categoría (regla dura)

`config/permission.rs:159-182` `get_permission()` evalúa en este orden y **corta en el primero que
matchea**:

| # | Chequeo | Línea | Devuelve |
|---|---|---|---|
| 1 | `never_allow.contains(name)` | 163-168 | `NeverAllow` |
| 2 | `always_allow.contains(name)` | 169-173 | `AlwaysAllow` |
| 3 | `ask_before.contains(name)` | 174-179 | `AskBefore` |
| 4 | nada | 181 | `None` |

Gana **deny**. Un tool listado a la vez en `always_allow` y `never_allow` queda denegado; el test que
lo fija es `test_persisted_never_allow_takes_precedence_over_other_levels`
(`config/permission.rs:483-526`). El "default" no es una regla: es la ausencia de match (`None`), y lo
que hace el llamador con `None` depende del modo (§2).

### 1.2 Precedencia entre capas (evaluación completa de una tool call)

| Orden | Capa | Ubicación | Qué aporta | Puede subir severidad sobre `always_allow` |
|---|---|---|---|---|
| 0 | Modo de sesión `Chat` | `ops_tool_approval.rs:50-52`, `permission_inspector.rs:160` | se salta todo el step | n/a (no hay tools) |
| 1 | Override de sesión (memoria) | `config/permission.rs:224-248`, consultado en `permission_inspector.rs:163-174` | `NeverAllow` / `AskBefore` / `AlwaysAllow` | **sí**, y gana sobre el modo y sobre el YAML |
| 2 | `permission.yaml` categoría `user` | `permission_inspector.rs:174` → `get_user_permission` | nivel persistido | no: en `Auto` no se consulta |
| 3 | Anotación MCP `read_only_hint=true` | `permission_inspector.rs:184-187`, `apply_tool_annotations` 52-64 | `Allow` solo en `SmartApprove` | no |
| 4 | Nombre especial `extensionmanager__manage_extensions` (completo) | `permission_inspector.rs:189-192` | `RequireApproval` forzado | **sí** |
| 5 | Caché `smart_approve` (persistida en el YAML) | `permission_inspector.rs:194-201` | `None`/`AlwaysAllow` ⇒ difiere al LLM judge | — |
| 6 | LLM judge "read-only" | `permission_judge.rs:145-185` | `Allow` o `RequireApproval` | sí, tras el juicio |
| 7 | Default del modo | `permission_inspector.rs:203-205` | `RequireApproval(None)` para tools desconocidas | ≤ allow |
| 8 | Inspectores de seguridad (override) | `permission_inspector.rs:116-128` + `tool_inspection.rs:170-261` | `Deny`/`RequireApproval` pisan el resultado de permisos | **sí** |

Regla de mezcla exacta (`tool_inspection.rs:213-257`): `Deny` saca la request de `approved` y
`needs_approval` y la mete en `denied`; `RequireApproval` la saca de `approved` y la mete en
`needs_approval` salvo que ya esté en `denied`; `Allow` de otro inspector **no** overridea nada
(comentario literal en 254-255: "don't override other inspectors' decisions").

### 1.3 Granularidad: nombre de tool, exacto, sin comodines

- El tipo de la regla es **`Vec<String>` por categoría**, no un patrón:
  `PermissionConfig { always_allow: Vec<String>, ask_before: Vec<String>, never_allow: Vec<String> }`
  (`config/permission.rs:29-33`), serializado con `serde(rename_all="snake_case")` para
  `PermissionLevel` (19-25).
- La comparación es `contains(&principal_name.to_string())` sobre `Vec<String>`: **igualdad exacta de
  string**, case-sensitive, sin glob, sin regex, sin prefijo.
- No hay evaluación por argumentos, por path ni por comando **en el motor de permisos**. Los
  argumentos solo aparecen en dos lugares: (a) el hash del caché legado
  `ToolPermissionStore` (`permission_store.rs:117-127`, blake3 del JSON de argumentos) — código
  **muerto**: `ToolPermissionStore` se exporta en `permission/mod.rs:10` y no tiene ningún llamador en
  el crate; (b) el judge LLM, que recibe `tool_name` + `arguments` (`permission_judge.rs:97-101`).
  La granularidad por path/comando existe, pero **en el sandbox**, no en el motor (§3.4).
- El único "tolerancia de prefijo" del sistema es para overrides de sesión:
  `session_permission_for_tool` (`config/permission.rs:235-248`) prueba el nombre completo y, si no
  matchea, `rsplit("__").next()` — o sea `developer__write` → `write`. Comentario 232-234 explica que
  sin eso el bloqueo por sesión no aplicaba a ninguna tool de extensión.
- Por qué el YAML puede listar `shell`, `edit`, `write` sin prefijo: esas tools viven en la extensión
  `developer`, declarada `unprefixed_tools: true`
  (`agents/platform_extensions/mod.rs:170-179`), y el prefijo solo se aplica cuando es `false`
  (`agents/extension_manager/mod.rs:321-323`).

---

## 2. Punto de intercepción en el flujo

### 2.1 Dónde se consulta (una sola puerta real)

La state machine se arma en `agents/agent.rs:679-771`; el step de permisos es
`Arc::new(ToolApprovalOperation::new(&self.tool_inspection_manager))` en **`agents/agent.rs:703`**,
dentro de `remaining_operations` (694-745), que se encadenan después de `SlashCommandOperation`
(764-767). Nombre del step: `"tool_approval"` (`ops_tool_approval.rs:39-41`).

Dentro del step (`ops_tool_approval.rs:43-148`):

1. `let state = ApprovalState::from_messages(messages_since_kickoff(conversation)?)` (54): reconstruye
   el estado desde los mensajes, sin estado en RAM.
2. Aplica las respuestas humanas ya presentes (57-76): `Permission::AlwaysAllow` ⇒
   `update_permission_manager(tool, AlwaysAllow)` (escribe `permission.yaml`); `AlwaysDeny` ⇒
   `NeverAllow`.
3. `pending_requests()` (228-244) filtra lo que ya no hay que evaluar (§2.2).
4. `tool_inspection_manager.inspect_tools(session_id, &pending_requests, messages, aegis_mode)`
   (`ops_tool_approval.rs:80-88`) → corre todos los inspectores en orden de registro.
5. `process_inspection_results_with_permission_inspector` (89-101) → `PermissionInspector::
   process_inspection_results` (`permission_inspector.rs:73-131`), que arma
   `PermissionCheckResult { approved, needs_approval, denied }` (`permission_judge.rs:188-193`).
6. Efectos: `denied` ⇒ `aegis.executable=false` (103-105); `needs_approval` ⇒
   `aegis.executable=false` + un mensaje `ActionRequired` `ToolConfirmation` con el motivo de
   seguridad si lo hay (107-140).

El flag que gobierna la ejecución es la metadata `aegis.executable` (`TOOL_EXECUTABLE_KEY`,
`ops_tool_approval.rs:23`), leída por `request_executable` (271-277) y exigida por
`ToolExecutionOperation` (agent.rs:724). `permission_allows()` (279-281) solo acepta `AllowOnce` y
`AlwaysAllow`; `Cancel`, `DenyOnce`, `AlwaysDeny` ⇒ no ejecutable.

### 2.2 Excepciones (lista cerrada, con línea)

| Excepción | Línea | Efecto |
|---|---|---|
| Modo `Chat` | `ops_tool_approval.rs:50-52` (`not_applicable`) y `permission_inspector.rs:160` (`continue`) | el step no corre; no hay tools |
| Modo `Auto` | `permission_inspector.rs:163-169` | `Allow` salvo override de sesión `NeverAllow`/`AskBefore`. **No consulta `permission.yaml`** |
| Ya respondida (`ToolResponse`) | `ops_tool_approval.rs:232` | sale de `pending_requests` |
| Ya tiene pedido de confirmación pendiente | 233 | idem |
| Ya tiene respuesta de confirmación | 234 | la procesa el bloque 57-76 |
| `was_executed_externally()` | 235; definido en `aegis-provider-types/src/conversation/tool_request.rs:58-62` (`TOOL_META_EXTERNAL_DISPATCH_KEY`) | el provider ya la ejecutó: no se evalúa ni se redispatchea |
| `aegis.executable == Some(false)` | 236 | no se reevalúa |
| `tool_call.is_err()` | 237 | request roto, se ignora |
| API de apps ACP (`on_call_tool`) | `acp/server/tools.rs:52-140` | **bypass total**: llama `call_for_app` directo (105-118) sin pasar por la state machine; exige `session.aegis_mode == AegisMode::Auto` (99-102) |
| Subagentes | `agent.rs:713-719` (`ForegroundSubagentOperation`) | el subagente corre su propio agente/state machine; hereda el `PermissionManager` global del proceso (§2.3), no un evalúo del padre |
| `!` shell (bang) | `agent.rs:681` (`BangShellOperation`), ejecutado antes del step de approvals | no pasa por `tool_approval` |
| Inspector deshabilitado | `security_inspector.rs:91-95` (`SECURITY_PROMPT_ENABLED`) y `agent.rs:377-386` (`AEGIS_WORKSPACE_SANDBOX`, default `true`) | el inspector no corre; el resto del step sí |

### 2.3 Instancia única del gestor

`install_global_permission_manager` / `global_permission_manager`
(`config/permission.rs:52-68`); se instala en `acp/server.rs:1436-1439` y `agents/agent.rs:2503-2506`.
El motivo está escrito en 49-51: que el chip de la web, el inspector y la extension `mode`
(`agents/platform_extensions/mode.rs:130-132`) vean los mismos overrides de sesión.

---

## 3. Seguridad por patrones

### 3.1 Contrato del inspector

`SecurityInspector` (`security_inspector.rs:56-95`) nombre `"security"`, es el **primero** en
registrarse (`agent.rs:360-361`, con el comentario "highest priority - runs first"). Solo corre si
`is_prompt_injection_detection_enabled()`: `SECURITY_PROMPT_ENABLED` en config, `false` por defecto
(`security/mod.rs:59-74`), override por env `SECURITY_PROMPT_ENABLED_OVERRIDE`.
Un `is_malicious && should_ask_user` se traduce a `RequireApproval("🔒 Security Alert\n\n{explanation}
\n\nFinding ID: {id}")` (`security_inspector.rs:29-53`); nunca a `Deny` — el bloqueo duro lo produce
la mezcla de `tool_inspection.rs` solo si un inspector devuelve `Deny`.

### 3.2 Reglas literales (patrones regex, `security/patterns.rs:48-308`)

37 patrones, compilados una vez con flag `(?i)` (`310-318`). Enumerados con nombre, riesgo y qué
bloquean:

| Categoría | Patrones (nombre) | Riesgo |
|---|---|---|
| FileSystemDestruction | `rm_rf_root_bare` (`rm -rf /` y variantes `/*`, `/./*`), `rm_rf_home_or_root` (`~`, `$HOME`, `${HOME}`, `/home`, `/root` + `*`), `dd_destruction` (`dd if=/dev/{zero,random,urandom} of=/dev/[sh]d*`), `format_drive` (`format\|mkfs.* /dev/[sh]d*`) | Critical |
| RemoteCodeExecution | `curl_bash_execution` (`curl\|wget … \| bash\|sh\|zsh\|fish\|csh\|tcsh[.exe]`, acepta rutas absolutas y `C:\…`), `bash_process_substitution` (`bash < (curl\|wget`), `python_remote_exec` (`python -c …urllib`, `requests…exec`), `powershell_download_exec` (`DownloadString…Invoke-Expression`) | Critical / High |
| DataExfiltration | `ssh_key_exfiltration` (`curl\|wget -d …/.ssh/id_rsa…`), `password_file_access` (`cat\|grep\|awk\|sed … /etc/shadow\|.password`), `history_exfiltration`, `memory_dump` (`gcore`, `gdb…dump`, `/proc/<pid>/mem`), `steganography_tools` (`steghide`, `outguess`, …) | High / Medium |
| SystemModification | `crontab_modification`, `systemd_service_creation`, `hosts_file_modification`, `kernel_module_manipulation` (`insmod\|rmmod\|modprobe *.ko`, Critical), `log_manipulation`, `file_timestamp_manipulation` | High / Medium / Low |
| NetworkAccess | `netcat_listener` (`nc -l\|-p N`), `reverse_shell` (`(nc\|netcat\|bash\|sh) … -e bash…`, Critical), `ssh_tunnel` (`ssh … -L\|-R\|-D N:`), `network_scanning` (`nmap\|masscan\|zmap\|unicornscan … -s`) | High / Medium |
| ProcessManipulation | `kill_security_process` (`kill… antivirus\|firewall\|defender\|security\|monitor`), `process_injection` (`gdb … attach`, `ptrace PTRACE_POKETEXT`) | High |
| PrivilegeEscalation | `sudo_without_password` (`echo…NOPASSWD…>…sudoers`, Critical), `suid_binary_creation` (`chmod [47]xxx`, `chmod +s`), `docker_privileged_exec` (`docker run\|exec … --privileged`), `container_escape` (`chroot\|unshare\|nsenter … --mount\|--pid\|--net`), `password_cracking_tools` (`john --x`, `hashcat`, `hydra`, `medusa`, `brutespray`) | Critical / High |
| CommandInjection | `encoded_commands` (`base64\|hex\|url … decode \| bash\|sh`), `base64_encoded_shell`, `hex_encoded_commands`, `eval_with_variables`, `indirect_command_execution` (sustitución anidada, Low), `unicode_obfuscation` (3+ escapes consecutivos, Medium) | High / Medium / Low |

Score: `RiskLevel::confidence_score()` = Critical 0.95, High 0.75, Medium 0.60, Low 0.45
(`patterns.rs:36-45`). Decisión: `is_malicious = final_confidence >= threshold`, con
`SECURITY_PROMPT_THRESHOLD` o default **0.8** (`scanner.rs:126-130`, `195-200`). Consecuencia práctica:
Medium y Low **nunca** disparan bloqueo por sí solos (0.60 y 0.45 < 0.8), solo High/Critical;
`indirect_command_execution` es ruido decorativo salvo que el clasificador ML lo levante.
Fusión: `final = combine(tool, context).max(pattern_confidence)` (`scanner.rs:170-172`);
`combine_confidences` (267-288) ignora el contexto si el comando < 0.3, lo pondera 80/20, y con ambos
> 0.8 aplica `max*1.05` topado en 1.0. Fail-open: si un clasificador falla, devuelve `None` y **no
baja** el score del otro (test `failed_prompt_scan_does_not_lower_command_confidence`,
`scanner.rs:734-753`).

### 3.3 Punto exacto de inspección: sobre texto crudo, sin expandir

- `analyze_tool_call_with_context` (`scanner.rs:132-201`) corta antes de todo si el nombre no es
  exactamente `"shell"`: `fn is_shell_tool_name(name) -> bool { matches!(name, "shell") }`
  (`scanner.rs:424-426`). Traducción: **solo `shell` sin prefijo**. Un `${ext}__shell`, `bash`,
  `powershell`, `execute_typescript`, `edit` o `write` no se escanean nunca. `SHELL_TOOLS` del sandbox
  sí incluye `"bash"` (`workspace_sandbox.rs:28`), el scanner no.
- El texto inspeccionado es `arguments["command"]` tal cual (`extract_tool_content`, 403-421); si no
  hay `command`, el JSON completo de argumentos.
- **No hay expansión de variables, ni resolución de rutas, ni parseo de shell, ni normalización de
  quoting.** Los patrones y el sandbox matchean substrings sobre el string literal del comando:
  `destructive_reason` hace `command.to_lowercase().contains(pattern)`
  (`workspace_sandbox.rs:218-224`). Consecuencias verificables:
  - `rm -rf $HOME/x` no matchea `rm_rf_home_or_root` (el patrón exige `$HOME` seguido de fin o `/*`);
  - `rm  -rf   /` (doble espacio) sí matchea (regex con `\s+`), pero `rm -r -f /` casa por
    `(-[rRfF]+\s+)*` y `\x0a`/`&&`/`;` están cubiertos por el grupo final `(\s|[;&|]|$)` (test
    `rm_rf_root_bare_matches_known_variants`, `patterns.rs:396-406`);
  - un comando construido en variables (`c=/; rm -rf "$c"`) **pasa** toda la seguridad por patrones.
- El contexto conversacional (últimos 10 mensajes de usuario, `USER_SCAN_LIMIT`, `scanner.rs:10`,
  `378-401`) entra como señal ML (`SECURITY_PROMPT_CLASSIFIER_ENABLED`), no como patrón.

### 3.4 Los otros tres inspectores (mismo punto de intercepción)

| Inspector | Archivo | Dispara con | Acción |
|---|---|---|---|
| `egress_inspector` | `security/egress_inspector.rs:49-170+` | extrae destinos de un comando shell: URLs `https?\|ftp`, `git@host:path`, `s3://`, `gs://`, `scp`/`rsync`, `ssh`, `docker push\|login`, `npm publish`, y comando de red genérico (`fetch\|nc\|ncat\|netcat\|ftp\|sftp\|socat\|httpie\|xh` + dominio) | resultado de inspección (RequireApproval) |
| `adversary_inspector` | `security/adversary_inspector.rs:14-50` | LLM reviewer, **desactivado si no existe** `<config>/adversary.md` (84-94); por defecto revisa solo `DEFAULT_TOOLS = ["shell"]` (14); **fail-open** si la review falla (comentario 50) | `RequireApproval`/`Allow` según las reglas del `.md` |
| `workspace_sandbox` | `security/workspace_sandbox.rs:226-323` | (a) `write`/`edit` con path fuera del `working_dir` de la sesión; (b) cualquier path que caiga en `PROTECTED_FRAGMENTS` (31-41: `\state\config\`, `\.ssh\`, `\.git\config`, `secrets.yaml`, `secrets.yml`, `auth.json`); (c) `shell`/`bash` cuyo comando contiene una de las 23 formas de `DESTRUCTIVE_PATTERNS` (45-74: `rm -rf /`, `del /f /s /q`, `rd /s /q`, `format c:`, `diskpart`, `mkfs.`, `dd if=`, `shutdown /s`, `git reset --hard`, `git clean -fdx`, `git push --force`, `drop table`, `drop database`, `truncate table`, `remove-item -recurse -force`, `sdkmanager --uninstall`, `docker system prune`, `docker volume rm`) | `RequireApproval` con motivo en castellano |

El sandbox es **local** (no existe en upstream, §5) y su orden importa: se registra **antes** del de
permisos (`agent.rs:370-386`, comentario 370-372: "para que su RequireApproval gane sobre un Allow"),
y se apaga con `AEGIS_WORKSPACE_SANDBOX=false` (377-379).

Resolución de rutas del sandbox (`workspace_sandbox.rs:134-175`): `canonicalize()` del destino, si no
existe canonicaliza el padre y le pega el nombre, y si tampoco, normalización léxica de `..`/`.`;
`strip_verbatim` quita `\\?\`. La comparación es por componentes en minúsculas (`109-130`), así que
`C:\Aegis-Proyects-otro` no pasa como hijo de `C:\Aegis-Proyects` (test 355-364). No sigue symlinks:
el comentario 107-108 dice que `canonicalize` se hizo antes "sobre lo que existe", o sea que un symlink
creado después apunta fuera sin que el sandbox lo vea.

---

## 4. `permission.yaml` real vs. lo que aplica el código

Config viva `C:\Aegis-Proyects\state\config\permission.yaml` (28 líneas, leída 2026-10-29):

| Sección | Reglas | Contenido |
|---|---|---|
| `user.always_allow` | **24** | `delegate`, `scheduler__manage_schedule`, `extensionmanager__manage_extensions`, `extensionmanager__search_available_extensions`, `read_file`, `grep`, `tree`, `read_image`, `websearch__web_fetch`, `websearch__web_search`, `load_skill`, `load`, `chatrecall__chatrecall`, `memory__memory_write`, `memory__memory_search`, `memory__memory_list`, `memory__memory_confirm`, `memory__memory_forget`, `memory__memory_consolidate`, `mode__request_mode`, `shell`, `edit`, `execute_typescript`, `write` |
| `user.ask_before` | 0 | `[]` |
| `user.never_allow` | 0 | `[]` |
| `smart_approve` | **ausente** | la escribe el runtime cuando cachea decisiones de anotación/LLM (`update_smart_approve_permission`, `bulk_update_smart_approve_permissions` en `config/permission.rs:134-156`) |

### ¿Coincide con lo que el código aplica?

| Afirmación del YAML | Qué hace el código | Veredicto |
|---|---|---|
| 24 tools en `always_allow` | `get_permission` devuelve `AlwaysAllow` por igualdad exacta de nombre | **coincide** |
| `shell`, `edit`, `write` sin prefijo | la extensión `developer` es `unprefixed_tools: true` (`platform_extensions/mod.rs:175`); el nombre real del request es `shell`, etc. | **coincide** |
| `read_file`, `grep`, `tree`, `read_image` | mismas tools del developer, también sin prefijo | **coincide** |
| `memory__*`, `websearch__*`, `chatrecall__*`, `mode__request_mode`, `extensionmanager__*`, `scheduler__*` con prefijo | esas extensiones son `unprefixed_tools: false` (mod.rs:104,120,134,189,201,219) | **coincide** |
| `always_allow` implica "no se pregunta nunca" | **falso en tres casos**: (1) `WorkspaceSandboxInspector` mete `RequireApproval` sobre `write`/`edit`/`shell` → gana por `tool_inspection.rs:233-251`; (2) `extensionmanager__manage_extensions` está en `always_allow` **y** el código lo fuerza a `RequireApproval` (`permission_inspector.rs:189-192`) — la entrada del YAML es inoperante; (3) el inspector `security`/`egress`/`adversary` puede subir a `RequireApproval` |
| `never_allow: []` | no hay deny persistido | **coincide** |
| `ask_before: []` | cualquier tool fuera de la lista de 24 cae a `None` ⇒ `RequireApproval` en `Approve`/`SmartApprove`, y `Tool requires user approval` | **coincide** |
| `subjectMode Auto` (implícito del store) | en `Auto` no se lee `user`; todo se permite salvo override de sesión | la lista de 24 es **decorativa en Auto** |
| `execute_typescript` | no está en `tools` de ningún inspector y el scanner solo mira `"shell"`: en `SmartApprove` va al LLM judge como candidato read-only | coherente, pero **sin ningún control determinista** |
| `delegate` | no es tool de una extensión de plataforma listada; no hay regla de código que la trate | sin efecto verificable |

Trampa de persistencia: cualquier escritura (`SetToolPermissions` sin `session_id`,
`acp/server/tools.rs:166-173`; o una respuesta `AlwaysAllow`/`AlwaysDeny` en el step de approvals,
`ops_tool_approval.rs:60-70`) reescribe el archivo entero con `serde_yaml` desde un
`HashMap<String, PermissionConfig>` (`write_permission_map`, `config/permission.rs:339-357`). Se
conservan las claves que deserialicen a `PermissionConfig`; **cualquier clave o comentario que no
matchee el esquema se pierde silenciosamente**. Y `load_permission_map` (303-317) **paniquea** el
proceso si el YAML está corrupto, con el mensaje "Refusing to start with corrupted permission config.".

---

## 5. Local vs GitHub

Comando ejecutado: `gh api repos/block/goose/contents/crates --jq '.[].name'` →
`goose-acp-macros, goose-agent, goose-cli, goose-context-management, goose-download-manager,
goose-local-inference, goose-mcp, goose-provider-types, goose-providers, goose-roaming, goose-sdk-types,
goose-sdk, goose-test-support, goose-test, goose`.
No existe `goose-server`: el binario HTTP/ACP `aegis-server` y el crate `aegis-acp`/`aegis-server` son
estructura local (el `aegis-server` reemplaza al `aegis-cli` borrado el 2026-10-20 según el hint del
workspace).

Diff por archivo contra `raw.githubusercontent.com/block/goose/main` (`Compare-Object` línea a línea):

| Archivo | Upstream | Local | Líneas cambiadas | Solo local | Solo upstream | Veredicto |
|---|---|---|---|---|---|---|
| `permission/mod.rs` | 10 | 10 | 4 | — | — | espejo + rename |
| `permission/permission_inspector.rs` | 398 | 452 | 100 | 69 | 23 | **divergencia real** |
| `permission/permission_judge.rs` | 271 | 271 | 6 | — | — | rename `goose`→`aegis` |
| `permission/permission_store.rs` | 144 | 144 | 0 | 0 | 0 | **idéntico** (y muerto en ambos) |
| `security/mod.rs` | 247 | 266 | 35 | 26 | 8 | `workspace_sandbox` + hook de test |
| `security/patterns.rs` | 588 | 588 | 4 | — | — | idéntico salvo rename |
| `security/scanner.rs` | 792 | 792 | 2 | — | — | idéntico |
| `security/security_inspector.rs` | 147 | 154 | 13 | 9 | 3 | hook de test `enabled()` |
| `security/egress_inspector.rs` | 555 | 555 | 4 | — | — | idéntico |
| `security/adversary_inspector.rs` | 721 | 721 | 10 | — | — | rename |
| `security/classification_client.rs` | 251 | 251 | 0 | 0 | 0 | **idéntico** |
| `config/permission.rs` | 590 | 695 | 105 | **79** | **0** | **todo lo local, nada de upstream** |
| `tool_inspection.rs` | 313 | 313 | 8 | — | — | rename |
| `agents/state_machine/ops_tool_approval.rs` | 289 | 289 | 20 | 10 | 10 | rename (`GooseEffect`→`AegisEffect`, `goose.executable`→`aegis.executable`) |

### Qué es local (no está en goose)

| Pieza local | Evidencia | Qué agrega |
|---|---|---|
| `security/workspace_sandbox.rs` (405 líneas) | no existe en `crates/goose/src/security` de upstream (listado: `adversary_inspector, classification_client, egress_inspector, mod, patterns, scanner, security_inspector`) | sandbox de escritura por workspace + 23 patrones destructivos |
| Overrides de sesión | `config/permission.rs:40-42, 221-273` — 79 líneas local-only, 0 upstream-only | `set/clear/session_permission_for_tool`, solo memoria |
| `PermissionManager` global del proceso | `config/permission.rs:49-68` | instancia única compartida |
| `Auto` deja de ser "allow ciego" | upstream: `GooseMode::Auto => InspectionAction::Allow`; local: `permission_inspector.rs:163-169` consulta `session_permission_for_tool` y puede `Deny`/`RequireApproval` | bloqueo del modo debate sin tocar el YAML ni otras sesiones |
| `readonly_annotated` de `Approve` | local `permission_inspector.rs:184` (`&& aegis_mode == SmartApprove`), upstream sin ese gate en la cadena | idéntico comportamiento efectivo, forma distinta |
| `aegis-a52`/`aegis-server`/`acp` app path | `acp/server/tools.rs` completo | endpoint que ejecuta tools saltando el approval (§2.2) |
| Counters `monotonic_counter.aegis.*` | `security/mod.rs` (8 líneas upstream `goose.*`) | rename únicamente |

Nada de `permission/` ni de `security/` (salvo `workspace_sandbox`) es diseño propio: el motor es
upstream con rename. La deuda conceptual (granularidad nombre-only, sin expandir variables) **también
es upstream**.

---

## 6. Referencias web

| URL literal | Estado | Qué aporta |
|---|---|---|
| `https://block.github.io/goose/docs/guides/permissions` | **404** | no existe la página; el sitio de docs de block ya no sirve contenido (dominio migrado a AAIF) |
| `https://block.github.io/goose/docs/guides/managing-tools/permissions` | **404** | idem |
| `https://block.github.io/goose/docs/guides/security` | **404** | idem |
| `https://goose-docs.ai/docs/guides/goose-permissions` | 200 | existe la ruta, pero el modelo **no está documentado ahí**: la page devuelve 0 caracteres útiles (render JS) y el árbol de docs de `block/goose` solo tiene `documentation/docs/guides/security/{index.mdx, adversary-mode.md, prompt-injection-detection.md, classification-api-spec.md}`. **No hay documentación pública del esquema `permission.yaml`** |
| `https://goose-docs.ai/docs/guides/security` | 200 | sección de seguridad del sitio vivo (sin esquema de permisos) |
| `https://goose-docs.ai/docs/guides/managing-tools/permissions` | **404** | |
| `https://goose-docs.ai/docs/troubleshooting/permissions` | **404** | |
| `https://raw.githubusercontent.com/block/goose/main/documentation/docs/guides/security/index.mdx` | 200, 51 líneas, 0 menciones de "permission"/"approval" | índice de la categoría seguridad: confirma que el modelo de approvals no se documenta en el repo |
| `https://raw.githubusercontent.com/block/goose/main/crates/goose/src/config/permission.rs` | 200 | upstream: 590 líneas, sin overrides de sesión |

Conclusión de la fuente web: **el modelo de permisos de goose no está documentado públicamente**; la
única especificación es el código. Cualquier documento que cite un esquema `always_allow/ask_before/
never_allow` como "documentado" está inventando.

---

## 7. Invariantes y trampas

1. **deny gana, siempre, dentro de la categoría** (`config/permission.rs:163-168`). No hay forma de
   permitir algo listado en `never_allow`.
2. **Un `RequireApproval` de cualquier inspector gana sobre un `AlwaysAllow`** (`tool_inspection.rs:233-251`).
   El YAML es un techo, no un suelo.
3. **En `Auto` el YAML `user` no se lee** (`permission_inspector.rs:163-169`). Con el store actual en
   `Auto`, las 24 reglas no hacen nada; lo único que puede frenar es un override de sesión o un
   inspector de seguridad/sandbox.
4. **Ninguna regla matchea por prefijo ni por glob.** Un `always_allow: ["shell"]` no cubre
   `developer__shell` en el motor de permisos (solo el override de sesión tolera el prefijo).
   Hoy eso no rompe nada porque `developer` viaja sin prefijo; una extensión con
   `unprefixed_tools: false` llamada `shell` requeriría entrada `ext__shell`.
5. **`ToolPermissionStore` (caché por hash de argumentos, `permission_store.rs`) está exportado y sin
   llamadores**: no participa de las decisiones. No confundirlo con el caché `smart_approve` del YAML.
6. **El YAML se reescribe entero** en cada cambio: comentarios y claves desconocidas se pierden;
   un YAML corrupto **paniquea el arranque** (`config/permission.rs:303-317`).
7. **Lock por archivo + relectura antes de mutar** (`mutate_permission_map`, 275-301, con
   `permission.yaml.lock` y resolución de symlink 319-337): dos procesos no se pisan, pero el proceso
   que ya tenía el mapa en memoria **no ve** cambios hechos por otro hasta que vuelve a mutar (test
   `permission_persistence.rs`).
8. **La seguridad por patrones es textual**: no expande variables, no resuelve rutas, no parte el
   comando. Un comando ofuscado (`c=/; rm -rf "$c"`, `eval`, variables de entorno) pasa entero.
9. **Threshold 0.8 contra scores fijos**: Medium (0.60) y Low (0.45) jamás bloquean por patrón solo;
   High (0.75) **tampoco** (0.75 < 0.8) salvo que el ML lo levante o el operador baje
   `SECURITY_PROMPT_THRESHOLD`. Solo los patrones `Critical` (0.95) disparan solos; los `High` (0.75)
   - `crontab_modification`, `systemd_service_creation`, `netcat_listener`, `suid_binary_creation`,
   `ssh_key_exfiltration`, `password_file_access`, `history_exfiltration`, `memory_dump`,
   `docker_privileged_exec`, `container_escape`, `password_cracking_tools`, `python_remote_exec`,
   `powershell_download_exec`, `kill_security_process`, `process_injection`, `base64_encoded_shell`,
   `hex_encoded_commands`, `eval_with_variables` - **no bloquean sin el clasificador ML** aunque el
   patrón matchee, salvo que el operador baje el threshold a ≤ 0.75.
10. **El scanner solo ve `"shell"`** (`scanner.rs:424-426`): `bash`, `powershell`, `execute_typescript`
    y cualquier tool con prefijo no pasan por detección de inyección.
11. **En `SmartApprove` el `AlwaysAllow` legacy del caché se re-juicio** (test
    `smart_approve_ignores_legacy_cached_allow`, `permission_inspector.rs:378`; y
    `smart_approve_rejudges_legacy_cached_allow`, 415-427): un allow cacheado ya no autoriza, se
    reemplaza por `AskBefore` si el LLM judge dice no read-only (`cache_non_readonly_decision`, 22-34).
12. **El judge LLM trata nombre y argumentos como datos**: prompt de sistema separado, datos en un
    mensaje `UNTRUSTED TOOL REQUEST DATA (JSON)` (`permission_judge.rs:109-117`), con test anti-inyección
    (227-250). Si falla la resolución de modelo o la respuesta, devuelve `vec![]` ⇒ todo cae a
    `RequireApproval`.
13. **Fallback por ausencia de resultado**: si un request no tiene `InspectionResult` del inspector de
    permisos, va a `needs_approval` (`permission_inspector.rs:110-113`). Nunca a `approved`.
14. **`Chat` corta el step entero** pero `Agent`/`Auto` está por default (`AegisMode::Auto` es
    `#[default]`, `aegis-provider-types/src/aegis_mode.rs:23-25`).

---

## 8. Huecos y deuda (con evidencia)

| # | Hueco | Evidencia | Impacto |
|---|---|---|---|
| 1 | Sin granularidad por argumento/path/comando en el motor de permisos | `config/permission.rs:29-33, 159-182` | imposible "permitir `bash` pero no `bash rm`"; el único freno es el sandbox, que es heurístico |
| 2 | `permission.yaml` inoperante en `Auto` | `permission_inspector.rs:163-169` | la config viva sugiere control que no existe en el modo por defecto |
| 3 | `extensionmanager__manage_extensions` en `always_allow` contradicho por el código | `permission.yaml:5` vs `permission_inspector.rs:189-192` | el operador no puede habilitar esa tool sin prompt; el YAML miente |
| 4 | Scanner limitado a `"shell"` | `scanner.rs:424-426` | `execute_typescript`, `bash`, `powershell` sin detección de inyección |
| 5 | Análisis textual sin expandir variables ni resolver rutas | `workspace_sandbox.rs:218-224`, `patterns.rs:310-318` | evasión trivial (`c=/; rm -rf "$c"`) |
| 6 | `ToolPermissionStore` muerto pero exportado | `permission/mod.rs:10`, sin llamadores en el crate (grep de 5 hits, todos dentro del propio archivo + el re-export) | deuda de superficie pública |
| 7 | Bypass de aprobación en el path de apps ACP | `acp/server/tools.rs:52-140`, gate `aegis_mode == Auto` en 99-102 | cualquier cliente de apps ejecuta tools sin evaluación si la sesión está en Auto |
| 8 | El YAML es un `HashMap<String, PermissionConfig>` sin esquema versionado | `config/permission.rs:303-317` | claves nuevas se descartan al reescribir; corrupción = panic |
| 9 | Medium/Low del patrón nunca bloquean (0.60/0.45 < 0.8) | `patterns.rs:36-45`, `scanner.rs:126-130` | 20+ patrones son solo telemetría |
| 10 | `adversary.md` desactivado por ausencia y fail-open | `adversary_inspector.rs:48-50, 84-94` | no hay segunda opinión LLM en el store actual (no existe `state\config\adversary.md`) |
| 11 | Los overrides de sesión son solo memoria | `config/permission.rs:40-42, 250-263` | un reinicio del serve borra el bloqueo del modo debate |
| 12 | `RateLimit`/`AskBefore` no persiste motivo de sesión | `permission_inspector.rs:107` (`RequireApproval(None)`) vs `ops_tool_approval.rs:111-117` | la UI recibe `security_message = None` en el caso normal |

---

## No verificado

- No ejecuté `cargo test`: el diff contra upstream es estático y los tests citados son los que el
  código declara; no comprobé que pasen en este árbol (regla read-only del encargo).
- No inspeccioné el `sessionsDB` de esta sesión para confirmar el `aegis_mode` efectivo con el que
  corre el serve vivo: la conclusión "en `Auto` el YAML no se lee" es del código, no del estado.
- El diff de `adversary_inspector.rs`, `egress_inspector.rs`, `patterns.rs` y `scanner.rs` da 2-10
  líneas de diferencia que atribuyo al rename `goose`→`aegis`; no revisé línea por línea cada una
  (los conteos de `solo_local`/`solo_upstream` de esos archivos no se imprimieron en el segundo
  script, solo los de los seis archivos de la tabla).
- `permission_judge.rs` upstream y local son 271/271 con 6 líneas de diferencia: asumo rename, no
  verifiqué una por una.
- No medí el costo por turno de los inspectores LLM (`adversary`, judge de read-only) cuando están
  activos.
- No verifiqué si el `binding` del `EgressInspector` produce `Deny` en algún caso: leí solo las
  primeras 170 de 555 líneas (extracción de destinos); la política de decisión del resto no está en
  esta entrega.
- `https://goose-docs.ai/docs/guides/goose-permissions` devolvió 200 con 0 caracteres extraídos
  (render JS): no pude confirmar si esa página documenta el modelo; lo que sí verifiqué es que el
  repo de docs no tiene ningún archivo de permisos.

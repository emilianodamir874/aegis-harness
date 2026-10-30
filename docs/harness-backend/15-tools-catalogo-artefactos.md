# 15 — Catálogo de tools del agente y supervivencia de artefactos

Estado: verificado leyendo código en el árbol de trabajo de `C:\Aegis-Proyects\src` (commit `8d559d0b5a19ea8d3917463d7f1cff155e59ec70`, 2026-10-29 12:29, rama `feat/antigravity-provider`, con WIP sin commitear en `mode.rs`, `permission.rs` y `context_mgmt`). No se ejecutó el serve ni se dispararon requests: todo lo que sigue sale de leer fuente y de `gh api`.

Rutas relativas a `C:\Aegis-Proyects\src` salvo que se diga otra cosa.

---

## 1. Mapa de piezas

| pieza | archivo | qué hace |
|---|---|---|
| Registro de extensiones in-process | `crates/aegis/src/agents/platform_extensions/mod.rs:33-254` | `PLATFORM_EXTENSIONS: Lazy<HashMap<&str, PlatformExtensionDef>>`; cada entrada lleva `default_enabled`, `unprefixed_tools`, `hidden` y un `client_factory` |
| Definición del tipo | `crates/aegis/src/agents/platform_extensions/mod.rs:341-351` | `PlatformExtensionDef { name, display_name, description, default_enabled, unprefixed_tools, hidden, client_factory }` |
| Extensión `developer` (shell/read/write/edit/tree/read_image/grep) | `.../developer/mod.rs:116-217` (definición), `:236-301` (dispatch por nombre) | 7 tools planas, sin prefijo (`unprefixed_tools: true`, `mod.rs:175`) |
| `grep` + `read_file` | `.../developer/read.rs` | límites duros de lectura y búsqueda |
| `write`/`edit` | `.../developer/edit.rs` | escritura completa y reemplazo único de texto |
| `shell` | `.../developer/shell.rs` (1400 líneas) | proceso hijo con timeout, cancelación, truncado a archivo temporal |
| `tree` | `.../developer/tree.rs` | árbol con conteo de líneas, respeta gitignore |
| `read_image` | `.../developer/image.rs` | base64 de imagen, `MAX_IMAGE_BYTES = 20 MiB` (`image.rs:14`) |
| `web_search` / `web_fetch` | `.../websearch.rs:96-111`, dispatch `:800`,`:826` | cadena Tavily → SearXNG → Mojeek → Bing → DDG lite, cache 1 h |
| `chatrecall` | `.../chatrecall.rs:333-350` | búsqueda en store + recuperación de mensajes de la sesión actual |
| `memory_*` (6 tools) | `.../memory.rs:23-24`, `:140-215` | hechos durables del operador |
| `compact_context` | `.../compact.rs:28`, `:105-130` | el modelo compacta su propio contexto |
| `request_mode` | `.../mode.rs:30`, `:167-191` | cambia el modo de sesión (plan/revisar/ejecutar) |
| `load` + `delegate` | `.../summon.rs:436-...`, `:499-...`, dispatch `:1415-1430` | carga conocimiento / delega a subagente |
| `manage_extensions` / `search_available_extensions` / `list_resources` / `read_resource` | `.../ext_manager.rs:66-69`, `:241-340` | CRUD de extensiones y recursos |
| `todo_write` | `.../todo.rs:94-120` | plan persistente (extensión `todo`, `default_enabled: false`) |
| `load_skill` | `crates/aegis/src/skills/client.rs:84-108` | carga una skill del store |
| Agregador / dispatch | `crates/aegis/src/agents/extension_manager/mod.rs` (`fetch_public_tools:300-342`, `recover_mangled_tool_name:443-483`), `extension_manager/lease.rs` (`resolve_tool:573-635`, `call:637-647`, `call_resolved:664+`) | prefija nombres, normaliza schema, resuelve nombre y despacha |
| Filtro final antes del provider | `crates/aegis/src/agents/state_machine/inference_preparation.rs:29-37`, `:73-78`; `crates/aegis/src/agents/reply_parts.rs:218-239` | saca tools `never_allow`, saca tools no visibles al modelo, ordena alfabético, elige toolshim |
| Serialización al provider | `crates/aegis-provider-types/src/formats/openai.rs:804-823` (y `anthropic.rs:558`, `google.rs:279`, `databricks.rs:343`, `snowflake.rs:112`; Bedrock en `crates/aegis/src/providers/formats/bedrock.rs:367-390`) | `{"type":"function","function":{name,description,parameters:input_schema,"strict":false}}` |
| Inspectores de tools | `crates/aegis/src/tool_inspection.rs`, `tool_monitor.rs` | permisos y repetición; producen `Allow/Deny/RequireApproval` |
| Elicitación "action required" | `crates/aegis/src/action_required_manager.rs:49-118` | pide datos al operador a mitad de una tool call, con timeout |
| API de tools al cliente | `crates/aegis/src/acp/server/tools.rs:9-50` (`_aegis/unstable/tools/list`), `:52-140` (`tools/call`), `:142-175` (`tools/permissions/set`); nombres de método en `crates/aegis-sdk-types/src/custom_requests.rs:96`, `:144`, `:2459` | lo que devuelve hoy `web/tools/_list-tools.mjs` |
| Normalizador de schema | `crates/aegis/src/agents/tool_schema_normalize.rs:6`, `:26` | colapsa `oneOf` de consts a `enum` e inlinea `$defs` triviales |

### 1.1 Qué devuelve hoy `web/tools/_list-tools.mjs`

`C:\Aegis-Proyects\web\tools\_list-tools.mjs:19-24`: abre WS a `ws://<publicHost>:<servePort>/acp?token=<secretKey>` (de `web/config.json`), hace `initialize`, `session/new`, `_aegis/unstable/tools/list` y **solo imprime los nombres ordenados** (`tools.map(t => t.name || t.id).sort()`), después archiva la sesión (`:25`) y sale. O sea: no expone schemas, ni permisos, ni descripciones — el contrato real (con `input_schema`, `output_schema` y `permission`) es `crates/aegis/src/acp/server/tools.rs:31-45`. Ese script es la fuente del "perfil de solo lectura" (lista blanca de nombres), no un catálogo.

---

## 2. Tabla maestra de tools builtin

Notación de `ToolAnnotations::from_raw` (orden real del constructor rmcp): `title, read_only_hint, destructive_hint, idempotent_hint, open_world_hint`. El "permiso" es el nivel de `permission.yaml` que se consulta antes de ejecutar; el default no está escrito en cada tool: lo decide `PermissionManager` (`crates/aegis/src/config/permission.rs:21-25`, `permission/permission_inspector.rs:166-178`).

| nombre | se define en | parámetros (schema) | anotaciones | implementación | cómo reporta error |
|---|---|---|---|---|---|
| `shell` | `developer/mod.rs:142-167` | `command: String`, `timeout_secs?: u64` (`shell.rs:179-186`) | destructivo, open-world (`:161-167`) | `shell.rs:380-523` (`shell_with_cwd_and_emitter`), `run_command` `:557-668` | `CallToolResult::error` + bloque de texto con `Command exited with code N` / `Command timed out after N seconds` (`:480-513`); `structured_content` con `ShellOutput` |
| `write` | `developer/mod.rs:118-129` | `path`, `content` (`edit.rs:21-25`) | destructivo | `edit.rs:70-105` (`fs::write`, crea padres) | `error` con `Failed to write …` (`:100-104`) |
| `edit` | `developer/mod.rs:130-141` | `path`, `before`, `after` (`edit.rs:27-32`) | destructivo | `edit.rs:111-148` + `string_replace:157-196` | 0 matches → error con "Did you mean" + preview de 20 líneas (`:161-170`); N matches → error con las 2 primeras ubicaciones (`:172-195`) |
| `read_file` | `developer/mod.rs:192-203` | `path`, `offset?`, `limit?` (`read.rs:27-37`) | read-only | `read.rs:72-164` | error si no existe / es dir / binario (NUL en primeros 8 KiB, `:95-100`) / offset fuera de rango (`:146-151`) |
| `grep` | `developer/mod.rs:204-215` | `pattern`, `path?`, `glob?`, `ignore_case?`, `max_results?`, `context?` (`read.rs:39-57`) | read-only | `read.rs:166-274` | regex inválido → error (`:177-183`); sin matches → **success** con "No matches …" (`:260-266`) |
| `tree` | `developer/mod.rs:168-179` | `path`, `depth = 2` (`tree.rs:11-20`) | read-only | `tree.rs:34-79` | error si no existe / no es dir (`:49-61`) |
| `read_image` | `developer/mod.rs:180-191` | ver `image.rs` (`ImageReadParams`) | read-only=false, open-world=true (test `mod.rs:336-346`) | `image.rs` (archivo local o http, base64) | error de tamaño/límite; `MAX_IMAGE_BYTES` 20 MiB (`image.rs:14`) |
| `web_search` | `websearch.rs:99-102` | `WebSearchParams` (schemars) | — | `websearch.rs:800-825` | texto de error de la cadena de motores |
| `web_fetch` | `websearch.rs:104-108` | `WebFetchParams` (`url`, `max_chars`) | — | `websearch.rs:826+` | idem |
| `chatrecall` | `chatrecall.rs:333-350` | `query?`, `session_id?`, `limit?`(10/50), `after_date?`, `before_date?`, `current_session?: bool`, `message_id?`, `offset?`, `max_chars?` (`chatrecall.rs` struct `ChatRecallParams`) | read-only, open-world | `chatrecall.rs:379`, `:413` | `Err(String)` → `CallToolResult::error` |
| `memory_write` | `memory.rs:140-155` | `text`, `kind?`, `tags?`, `confidence?`, `pinned?` (`MemoryWriteParams`) | destructivo | `memory.rs` | texto |
| `memory_search` | `memory.rs:156-162` | `query`, `limit?` | read-only | — | texto |
| `memory_list` | `memory.rs:163-168` | `kind?`, `status?`, `limit?` | read-only | — | texto |
| `memory_forget` | `memory.rs:169-180` | `id` | destructivo | — | texto |
| `memory_confirm` | `memory.rs:181-190` | `id` | destructivo | — | texto |
| `memory_consolidate` | `memory.rs:191-205` | `report?` | destructivo | — | texto |
| `compact_context` | `compact.rs:105-130` | `note?` (`compact.rs:30-36`) | ninguna (todo false) | `compact.rs` | texto |
| `request_mode` | `mode.rs:167-191` | `mode: String`, `reason: String` (`:46-53`) | destructivo | `mode.rs:193-217` | **success** con mensaje de error (`:194-216`); JSON inválido → error (`:252-256`) |
| `load` | `summon.rs:436-450` | `source?` | — | `summon.rs:1415-1421` | texto |
| `delegate` | `summon.rs:454-...` | `instructions?`, `source?`, `parameters?`, `extensions?`, `provider?`, `model?`, `temperature?`, `max_turns?`, `context?`, `working_dir?` (`summon.rs:455-499`) | — | `summon.rs:1422+` | resultado del subagente |
| `manage_extensions` | `ext_manager.rs:69`, `:241+` | ver `manage_extensions` | destructivo | `ext_manager.rs` | texto |
| `search_available_extensions` | `ext_manager.rs:68`, `:267+` | — | read-only | `ext_manager.rs` | texto |
| `list_resources` / `read_resource` | `ext_manager.rs:67`, `:66`, `:293+`, `:319+` | `extension_name` / `uri` | read-only | `lease.rs:463-533` | texto |
| `todo_write` | `todo.rs:94-120` | `TodoWriteParams` | destructivo | `todo.rs` | texto |
| `load_skill` | `skills/client.rs:84-108` | `name`, `args?` (schema JSON escrito a mano, `:66-82`) | — | `skills/client.rs:112+` | `CallToolResult::error("Unknown tool: …")` (`:112-117`) |

**Prefijos.** Solo las extensiones con `unprefixed_tools: true` publican el nombre pelado: `developer`, `summon`, `skills`, `compact` y `analyze` (`platform_extensions/mod.rs:46,60,149,175,246`). El resto se publica como `<clave>__<tool>` (`extension_manager/mod.rs:321-323`): de ahí `websearch__web_search`, `chatrecall__chatrecall`, `memory__memory_write`, `extensionmanager__search_available_extensions`, `mode__request_mode`. `scheduler` es además `hidden: true` (`mod.rs:135`).

**Quién decide qué ve el modelo** (4 filtros en cadena, todos en el camino de inferencia):

1. Extensiones habilitadas en la sesión (`ExtensionSet` del registro de la sesión) → `fetch_public_tools` (`extension_manager/mod.rs:300-342`), que además filtra por `config.is_tool_available(&tool.name)` (`:318`).
2. `never_allow` de la sesión → `filter_denied_tools` (`inference_preparation.rs:29-37`, aplicado en `:73-77`). El modo `plan` usa esto: no "bloquea al ejecutar", **saca la tool del set**.
3. Visibilidad MCP Apps (`_meta.ui.visibility` sin `"model"` → tool solo de app) y orden alfabético estable → `prepare_inference_tools` (`reply_parts.rs:218-226`, predicado `is_tool_visible_to_model:531-…`).
4. `toolshim` del modelo: si está activo, las tools no van al provider sino al system prompt (`reply_parts.rs:228-239`).

---

## 3. Contrato de schema

### 3.1 Generación

- Todas las tools nativas generan el JSON Schema desde Rust con `schemars`: `schema_for!(T)` → `serde_json::Value` → `JsonObject` (`developer/mod.rs:99-105`, `mode.rs:122-128`, `memory.rs:120-124`, `compact.rs:97-100`). Las que no pueden (skills, `delegate`, `load`) escriben el schema a mano (`skills/client.rs:66-82`, `summon.rs:455-499`).
- Los comentarios `///` de los structs de params **son** la documentación que ve el modelo: terminan como `description` de cada propiedad (ej. `read.rs:28-56`).
- Post-proceso obligatorio en el camino in-process: `normalize_input_schema` (`extension_manager/mod.rs:330-333`) → `collapse_const_unions` + `inline_trivial_defs` (`tool_schema_normalize.rs:6,26,204`). Motivo declarado en el comentario: schemars emite enums unitarios como `$ref → $defs → oneOf` de consts, ~9× más grande, y los validadores estrictos (Moonshot) lo rechazan (`tool_schema_normalize.rs:19-25`). Lo que no es demostrablemente equivalente se deja intacto.
- Dialecto: los schemas generados no declaran `$schema` (schemars no lo emite por defecto en `schema_for!`), y el normalizador **asume semántica post-draft-04**: se niega a colapsar si detecta un dialecto anterior a `const` (`tool_schema_normalize.rs:37-47`).
- MCP externo: los servers reales sí mandan `"$schema": "http://json-schema.org/draft-07/schema#"` (visible en los replays `crates/aegis/tests/mcp_replays/…server-everything…`), y `bedrock.rs:370-374` inyecta `"type":"object"` cuando falta porque Bedrock lo exige.

### 3.2 Consumo

`{"type":"function","function":{"name","description","parameters": <input_schema tal cual>, "strict": false}}` (`aegis-provider-types/src/formats/openai.rs:813-821`). Cada formato tiene su `format_tools`: `anthropic.rs:558` (dedupe por nombre), `google.rs:279`, `databricks.rs:343`, `snowflake.rs:112`, Bedrock `bedrock.rs:367-390`. Duplicado de nombre = error duro en OpenAI (`:807-809`).

Aparte del provider, el mismo schema se sirve al cliente por `_aegis/unstable/tools/list` como `inputSchema` entero + `parameters` (solo nombres de propiedades) + `outputSchema` opcional (`acp/server/tools.rs:31-45`); `get_parameter_names` en `extension_manager/mod.rs:414-423`.

### 3.3 Si el schema es inválido o el modelo inventa un parámetro

| caso | qué pasa | evidencia |
|---|---|---|
| schema malformado de un server MCP | el normalizador es best-effort: si no puede probar equivalencia, no toca nada (`tool_schema_normalize.rs:19-25`); no hay validación de schema contra meta-schema en el camino | no hay llamada a un validador de meta-schema en `tool_schema_normalize.rs` |
| Bedrock sin `type` | se agrega `object` | `bedrock.rs:370-374` |
| argumentos que no deserializan | cada tool devuelve `CallToolResult::error` con `Failed to parse arguments: {e}` (`developer/mod.rs:107-114`, usado en `:256, 260-299`) | el turno sigue, el modelo ve el error y puede reintentar |
| parámetro inventado (extra) | **no se rechaza**: `serde` por defecto ignora campos desconocidos en estos structs (no hay `deny_unknown_fields` en `read.rs`, `edit.rs`, `shell.rs`, `mode.rs`) → la tool corre y el parámetro se pierde en silencio | grep `deny_unknown_fields` en `platform_extensions/`: sin coincidencias |
| tool inexistente | `lease.rs:604-620`: `RESOURCE_NOT_FOUND` con la lista de tools disponibles; en el cliente in-process, `"Error: Unknown tool: {name}"` (`developer/mod.rs:297-299`) | |
| nombre "mangled" por el modelo (`developer.shell`, `functions.shell`) | se recupera con `recover_mangled_tool_name` (`extension_manager/mod.rs:443-483`): solo si el candidato es **único**; si hay colisión devuelve `None` y falla | `:476-481` |

---

## 4. Límites duros (dónde se aplican, no dónde se documentan)

| límite | valor | se aplica en |
|---|---|---|
| `read_file` líneas | 2000 por llamada (`READ_MAX_LINES`) | `developer/read.rs:18`, aplicado `:106-109` (`clamp(1, 2000)`) |
| `read_file` bytes | 60 000 (`READ_MAX_BYTES`) | `read.rs:20`, aplicado `:126` y `:138-141` (corta el archivo, no la línea) |
| `read_file` binario | NUL en los primeros 8192 bytes → rechazo | `read.rs:91-100` |
| `read_file` paginación | `offset` 1-based; si sobra archivo agrega `[N de M lineas mostradas; segui con offset=K]` | `read.rs:152-159` |
| `grep` resultados | default 100, máximo 500 | `read.rs:21-22`, `:188-191` |
| `grep` contexto | máximo 5 líneas | `read.rs:23`, `:192` |
| `grep` tamaño por archivo | 4 MiB (archivos mayores se saltean) | `read.rs:25`, `:219-224` |
| `grep` archivos binarios | descarta si hay NUL en primeros 8 KiB | `read.rs:229-231` |
| `shell` líneas por stream | 2000 (`OUTPUT_LIMIT_LINES`) | `shell.rs:158`, `:891` |
| `shell` bytes por stream | 50 000 (`OUTPUT_LIMIT_BYTES`) | `shell.rs:159`, `:892` |
| `shell` preview al truncar | últimas 50 líneas y ≤10 000 bytes (`OUTPUT_PREVIEW_LINES/BYTES`), con snap a char boundary | `shell.rs:160-161`, `:903-937` |
| `shell` volcado completo | se guarda en un `tempfile::TempDir` del `ShellTool`, 8 slots rotativos (`OUTPUT_SLOTS`) | `shell.rs:163`, `:326,337,351,427-450`; `save_full_output:939-947` |
| `shell` timeout | `timeout_secs` explícito, o `aegis_default_extension_timeout`, o `DEFAULT_EXTENSION_TIMEOUT` | `shell.rs:549-555`; si el valor es 0, no hay timeout (`:597` filtro `> 0`) |
| `shell` cancelación | `tokio::select!` con `cancellation_token.cancelled()` → `child.start_kill()` + `wait` | `shell.rs:610-614`, `:621-626` |
| `shell` drenaje post-exit | 500 ms; si no termina, aborta la tarea de lectura y marca `output_truncated` | `shell.rs:629-653` |
| `shell` salida vacía | `(no output)` | `shell.rs:873-878` |
| `read_image` | 20 MiB | `image.rs:14` |
| `chatrecall` | `limit` default 10, máximo 50; `max_chars` máximo 12000 (default 4000) | descripción del schema en `chatrecall.rs` struct |
| extensions: timeout por extensión | `resolve_timeout` en el manager | `extension_manager/mod.rs:122` |
| elicitación | timeout por pedido | `action_required_manager.rs:62-118` (`timeout_duration` como parámetro) |
| repetición de tool | inspector `repetition` niega cuando se supera `max_repetitions` (`REP-001`) | `tool_monitor.rs:51-134` |
| tools/call desde apps | exige `session.aegis_mode == Auto` | `acp/server/tools.rs:99-102` |

Nota: el truncado **no** es un error. `shell` conserva `is_error=false` si el comando salió 0 aunque haya truncado; el aviso viaja como bloque de contenido separado "para que el modelo lo lea como instrucción y no como dato" (`shell.rs:468-478`, `:516-519`).

---

## 5. `/dl/<name>` y el outbox

### 5.1 Implementación

- Raíz: `OUTBOX = join(DIR, "outbox")`, con `DIR` = carpeta de `web/server.mjs` (`web/server.mjs:191-193`). Hoy `C:\Aegis-Proyects\web\outbox` existe y tiene decenas de artefactos (auditorías `.md`, un ZIP de 72 MB, `_shots/`).
- Handler: `web/server.mjs:1501-1546`. GET solamente (`:1501`).

### 5.2 Validación, en orden

1. `decodeURIComponent(url.pathname.slice(4))` dentro de `try` (`:1502-1506`): un `%` inválido deja `name=""` y cae al chequeo siguiente.
2. `outboxName(name)` (`:195-197`) — la muralla real. Rechaza:
   - vacío, `.`, `..`;
   - cualquier `\`, `/`, byte de control (`\x00-\x1f`), `\x7f`, o `:` (mata `C:` y también los ADS de NTFS);
   - cualquier substring `..`;
   - terminación en `.` o espacio (truco clásico de Windows que normaliza `foo.` → `foo`);
   - nombre que empiece con `.`;
   - por regex: `auth|config|secrets|permission|tokens` `.json`, `config|secrets|permission` `.ya?ml`, `id_rsa`/`id_ed25519`, y extensiones `.pem .key .p12 .pfx .db .sqlite*`.
3. `openOutboxFile` (`:198-…`): `realpath(OUTBOX)` debe ser igual a `resolve(OUTBOX)` (anti-junction del propio root, `:200-201`); `join(OUTBOX, name)`; `lstat` exige archivo regular y no symlink (`:203-204`); `realpath(candidate)` y `dirname(actual)` debe ser el root (`:205-206`); después `open(actual,"r")` y re-chequeo de `stat` vs `lstat` vs `realpath` + comparación de `ino`/`dev` para detectar swap entre el chequeo y el open (`:207-211`). Es un TOCTOU-aware open, no un `stat` optimista.
4. Tamaño: `> 512 MiB` → 413 `file too large` (`:1522-1526`).
5. Respuesta: `content-type` por extensión desde el mapa `MIME`, fallback `application/octet-stream` (`:1527`); `content-disposition: attachment; filename="<name sin comillas/CRLF>"` (`:1531`); `cache-control: no-store`; stream con `createReadStream({start:0,end:size-1,autoClose:false})` + `pipeline` (`:1539`) y `handle.close()` en `finally` (`:1542-1544`).

### 5.3 Riesgo de path traversal si la validación fuera laxa

`join()` de Node no escapa de la raíz, y `:` está permitido por muchas validaciones ingenuas; con `:` + ADS (`outbox/x.txt:secret`) o con `..%5c` (backslash sin rechazar) se sale del directorio o se lee un flujo alterno. Acá eso está cubierto por (a) rechazo de `/`, `\`, `:` y `..` en el nombre, (b) `realpath` del root y del destino, (c) `lstat` no-symlink, (d) comparación de inodo. El eslabón más frágil es el orden: si alguien "simplifica" `openOutboxFile` a `readFile(join(OUTBOX,name))` perdiendo el `realpath` de `:205-206`, un symlink dentro de `outbox/` se convierte en lectura arbitraria. Los 512 MiB y la lista negra de nombres (`.db`, `.pem`, `secrets.yaml`) existen justamente porque el outbox es un directorio escribible por el agente.

### 5.4 Convención de entrega al operador

El par `/dl/<name>` + `/outbox.json` (`:1235-1300`) es el contrato: el índice lista `{name, bytes, mtime, ext, url:"/dl/"+encodeURIComponent(name)}` solo de archivos que pasan `outboxName` y `openOutboxFile` (`:1285-1295`); la vista previa textual usa `OUTBOX_PREVIEW_MAX = 2e6` (`:194`). La convención operativa (copiar el artefacto a `web\outbox\` y cerrar con `[descargar <nombre>](/dl/<nombre>)`) no está en el código: es disciplina de prompt.

---

## 6. Encoding: decode/encode de archivos

| punto | comportamiento | evidencia |
|---|---|---|
| `read_file` | lee **bytes** con `read_until(b'\n')` y renderiza con `String::from_utf8_lossy` → UTF-8 inválido se vuelve `U+FFFD` (`�`), nunca error ni pánico; el test lo fija (`read.rs:382-410`) | `read.rs:137` |
| `read_file` CRLF | quita el `\n` y, si queda, el `\r` final; un `\r` suelto dentro de la línea se conserva | `read.rs:130-136`, tests `:412-442` |
| `read_file` BOM | **no se detecta ni se quita**: el BOM UTF-8 (`EF BB BF`) se decodifica como `U+FEFF` y aparece al inicio de la primera línea | no hay lógica de BOM en `read.rs` |
| `grep` | `String::from_utf8_lossy` sobre el archivo entero (`read.rs:233`); un archivo Latin-1 se busca con caracteres ya corrompidos | `read.rs:233` |
| `write` | `fs::write(path, &params.content)` — escribe la cadena Rust tal cual, en UTF-8; no agrega BOM ni cambia finales de línea | `edit.rs:91` |
| `edit` | `fs::read_to_string` — **falla** si el archivo no es UTF-8 válido (`Failed to read …`), porque `read_to_string` es estricto | `edit.rs:118-126` |
| `shell` (stdout/stderr) | se decodifica por línea con pérdida en el colector (`collect_tagged_lines`, `shell.rs:773-848`); Windows cmd entrega CP850/CP1252 y el resultado sale con `�` | `shell.rs:804-805` |
| fix aplicado en código | **no hay** decodificación Latin-1 tolerante en `read_file`/`edit`. El "fix" vive solo en scripts: `web/tools/fix-encoding.mjs` (`repair()`, `:14-49`; solo actúa si `TextDecoder('utf-8',{fatal:true})` falla, `:62-69`), y no corre solo: hay que invocarlo con `--apply <dir>`. Extensiones que toca: `.ts .tsx .css .mjs .md .json .html` (`:11`) — un `.rs` o `.py` roto no lo repara | `fix-encoding.mjs:11,62-69` |

Consecuencia práctica: el mojibake que se ve en `compact.rs` (comentarios `QuǸ va a hacer`, `Compactǭ el contexto`) ya está en el fuente; `read_file` lo muestra tal cual y `edit` lo reproduciría igual, porque ambos trabajan sobre la cadena.

---

## 7. Flujos paso a paso

### 7.1 Del registro de extensión al set de tools de un turno

1. `PLATFORM_EXTENSIONS` se construye una sola vez (`platform_extensions/mod.rs:33`).
2. La sesión arranca un `ExtensionLease` con el `ExtensionSet` de la sesión (`extension_manager/mod.rs:673-711`); cada extensión se instancia vía `client_factory`.
3. `fetch_public_tools` pide `list_tools` paginando por cursor, filtra por tools disponibles (`:305-320`), prefija salvo `unprefixed_tools` (`:321-323`), inyecta `meta.aegis_extension = <clave>` (`:324-329`) y normaliza el schema (`:330-333`).
4. `ToolCatalog::build` arma el índice nombre → (extensión, tool) por lease (`lease.rs:119`).
5. En cada inferencia: `filter_denied_tools` (deny por sesión) → `prepare_inference_tools` (visibilidad al modelo + orden) → `prepare_tools_for_provider` (toolshim o tools).
6. El provider recibe `format_tools` y el modelo elige.

### 7.2 Una tool call completa

1. El modelo emite `name` + `arguments`.
2. `ToolExecutionOperation::dispatch_tool_call` (`ops_toolcalling.rs:480-546`): abre span, overrides de working dir del lease, corre hooks `pre_tool` (`:506-521`).
3. `lease.call` → `resolve_tool` (`lease.rs:643`, `:573-635`): lookup exacto en el catálogo, si no, `recover_mangled_tool_name`; si falla, error con la lista de tools.
4. `call_resolved` (`lease.rs:664-730`): arma `ToolCallContext` (session, working dir, tool_call_id, container), streams de notificación y de "action required".
5. El cliente de la extensión hace `match name` y ejecuta (`developer/mod.rs:236-301`).
6. Hooks `post_tool` (`ops_toolcalling.rs:534-542`) y mutación aplicada (`extension_manager.applying_mutation`).
7. El resultado vuelve como `CallToolResult` (`content`, `structured_content`, `is_error`, `meta`).

### 7.3 Permisos y modo plan

1. `PermissionLevel` ∈ `AlwaysAllow | AskBefore | NeverAllow` (`config/permission.rs:21-25`), persistido en `<config>/permission.yaml` (`:13`).
2. `request_mode(plan)` → `SessionMode::Plan.entries()` → `write|edit|shell = NeverAllow` y la lista `READ_ONLY_TOOLS` = `AlwaysAllow` (`mode.rs:32-44`, `:80-100`), aplicado con `set_session_permissions` (`:158-165`) sobre el manager global del proceso (`:130-132`, `config/permission.rs:52-68`).
3. Efecto doble: la tool sale del set (`inference_preparation.rs:73-77`) **y** el inspector de permisos la negaría si igual se invoca (`permission/permission_inspector.rs:166-178`).
4. `ejecutar` borra los overrides (`mode.rs:82` → `Vec::new()`), no escribe `permission.yaml`.

### 7.4 Tools expuestas al cliente (web / apps)

`_aegis/unstable/tools/list` (método declarado en `aegis-sdk-types/src/custom_requests.rs:96`) → `on_get_tools` (`acp/server/tools.rs:9-50`) devuelve por tool: `name`, `description`, `parameters` (nombres), `permission` (sesión, con fallback a usuario, `:23-30`), `input_schema`, `output_schema`. `tools/call` (`:52-140`) valida pertenencia por `is_tool_owned_by_extension` (`:63-67`), visibilidad de app (`:69-72`), tipo de args (`:74-81`), y **solo** funciona en `AegisMode::Auto` (`:99-102`); ejecuta con `call_for_app` (aislado por extensión dueña).

### 7.5 Artefacto: de la tool al navegador

1. La tool `write`/`shell` produce el archivo en disco (cualquier ruta; no hay sandbox de escritura todavía — ver §11).
2. El agente lo copia a `C:\Aegis-Proyects\web\outbox\` (fuera del árbol del repo del motor).
3. `/outbox.json` lo lista (`server.mjs:1285-1295`), `/dl/<name>` lo sirve con `attachment` y sin cache (`:1501-1546`).
4. El nombre tiene que pasar la lista negra: un `.db` o un `secrets.yaml` copiado al outbox **no** se puede descargar (`server.mjs:196`).

---

## 8. Invariantes y trampas

1. **El nombre pelado no implica dueño.** `unprefixed_tools` deja la propiedad solo en `meta.aegis_extension` (`extension_manager/mod.rs:427-438`); por eso `tools/call` revalida con `is_tool_owned_by_extension` y hay un test que ataca la colisión de nombres planos (`mod.rs:1556` `app_dispatch_rejects_colliding_flattened_name_from_sibling_owner`).
2. **El modelo rompe el `__`.** GLM/GPT emiten `developer.shell` y `functions.shell`; la recuperación es deliberadamente conservadora (único candidato o nada, `:476-481`).
3. **`cmd.exe` trunca en el primer newline.** Hay guardia explícita que rechaza el comando entero con exit 0 engañoso (`shell.rs:392-400`) y el texto de la tool lo advierte (`developer/mod.rs:144-150`).
4. **`grep` sin matches es success**, no error (`read.rs:260-266`): un agente que mira `is_error` para decidir "no encontré nada" se equivoca.
5. **`read_file` corta por bytes además de por líneas**: un archivo de 2000 líneas larguísimas se corta a 60 KB y el aviso de paginación calcula el offset por línea, así que puede quedar un tramo que el mensaje no menciona explícitamente.
6. **`edit` exige match único**; con 2+ coincidencias no escribe nada (`edit.rs:172-195`). Un `before` que aparece dos veces es un fallo silencioso hasta que se lee el error.
7. **Los truncados de `shell` viven en un tempdir del proceso**: reiniciar el serve pierde el volcado completo y el path del aviso queda muerto. Además hay 8 slots: 9 comandos grandes en un turno pisan el slot 1 (`shell.rs:163`, `:428`).
8. **El orden de las tools importa para el cache de prompt**: se ordena alfabéticamente a propósito (`reply_parts.rs:223-224`).
9. **Modo plan es de sesión y en memoria**: no toca `permission.yaml` y muere al reiniciar el serve (`config/permission.rs:40-42`).
10. **`mode` mal escrito devuelve success con texto de error** (`mode.rs:194-199`): no rompe el turno, pero `is_error` es false.
11. El outbox es **plano**: `outboxName` prohíbe `/` y `\`, así que no hay subdirectorios (los `_shots/` que se ven en disco no se sirven por `/dl/`).
12. `read_file` **no** quita BOM y `edit` **no** acepta archivos no-UTF-8: un archivo con BOM editado por `edit` conserva el `U+FEFF` como contenido real.

---

## 9. Local vs GitHub

Verificado con `gh api repos/block/goose/contents/crates/goose/src/agents/platform_extensions`.

| pieza | upstream `block/goose` | local | marca |
|---|---|---|---|
| `developer/` (shell, read, edit, tree, image) | sí | sí, pero `read.rs` y `tree.rs` con topes y textos propios (2000 líneas/60 KB/500 hits/4 MiB) | **local** (los topes; el esqueleto es upstream) |
| `summon.rs` (`load`, `delegate`) | sí (existe el archivo) | local reescrito: 96 041 bytes, incluye `delegate` con heuristicas de cuándo delegar (`summon.rs:455-499`) y `max_turns` | **mixto**: `delegate` existe upstream; el contrato de disparadores es local |
| `chatrecall.rs` | sí | local con `current_session`, `message_id`, `offset/max_chars` | **local** (esas tres ramas) |
| `scheduler.rs` | sí | sí, `hidden: true` (`platform_extensions/mod.rs:135`) | local (feature `scheduler`) |
| `tom.rs` | sí | sí | upstream |
| `todo.rs` | sí | sí, `default_enabled: false` | upstream |
| `ext_manager.rs` | sí | sí | upstream |
| `analyze/` (tree-sitter) | sí | sí tras feature `tree-sitter` | upstream |
| `compact.rs` (`compact_context`) | **no existe** en la lista de upstream | sí, `default_enabled: true`, textos en español | **local** |
| `memory.rs` (`memory_*`, 6 tools) | **no existe en upstream** | sí | **local** |
| `mode.rs` (`request_mode`, plan/revisar/ejecutar) | **no existe en upstream** | sí; commit local `feat(modo): el agente decide sin escalera`, con WIP de rustfmt encima | **local** |
| `websearch.rs` (`web_search`/`web_fetch`) | no como plataforma (upstream usa el server MCP de Brave/Tavily externo) | in-process, cadena de 5 motores + cache 1 h | **local** |
| `code_execution.rs` / `javascript.rs` (upstream) | sí | **no** en `platform_extensions/`; la feature `code-mode` se eliminó (2026-10-22, según hints del operador) | borrado local |
| `tool_schema_normalize.rs` | no aparece en el árbol leído | sí, 39 485 bytes con tests de dialecto | **local** |
| `inference_preparation.rs` (`filter_denied_tools`) | el archivo es de Aegis (depende de `aegis_agent::inference`) | sí | **local** |
| `/dl/` + outbox | n/a (es la web de Aegis) | `web/server.mjs:1501-1546` | **local** |
| `_aegis/unstable/tools/*` | n/a | `aegis-sdk-types/src/custom_requests.rs:96,144,2459` | **local** |

Repo: la rama local es `feat/antigravity-provider`; `src` está **por delante** de `origin/main` (último push 2026-10-09 según el contexto de workspace) y este commit es de hoy. Nada de lo de la columna "local" está en GitHub.

---

## 10. Referencias web (URLs literales)

- MCP, especificación de Tools 2025-06-18 (contrato `tools/list`, `tools/call`, `Tool`/`inputSchema`, `outputSchema`, "human in the loop"): `https://modelcontextprotocol.io/specification/2025-06-18/server/tools` — leído; confirma que el `tools/list` devuelve nombre + metadata con schema y que el protocolo **no** manda interacción, la deja al cliente. El `tools/list` de Aegis replicado en `_aegis/unstable/tools/list` (`acp/server/tools.rs`) es una capa propia encima de eso.
- JSON Schema, draft 2020-12 (dialecto que asume `tool_schema_normalize.rs`): `https://json-schema.org/draft/2020-12/json-schema-core` y `https://json-schema.org/understanding-json-schema/reference/combining` (para `oneOf`/`const`).
- MCP Apps / visibilidad `_meta.ui.visibility`: la regla está citada en el código como "MCP Apps spec (2026-01-26)" (`reply_parts.rs:507-531`); no se localizó la URL canónica en esta pasada.
- Upstream de las tools: `https://github.com/block/goose/tree/main/crates/goose/src/agents/platform_extensions`.

---

## 11. Huecos, riesgos y deuda técnica (con evidencia)

| # | hallazgo | evidencia | riesgo |
|---|---|---|---|
| 1 | **No hay sandbox de escritura.** `write`/`edit` resuelven la ruta contra el working dir pero aceptan rutas absolutas y `..` sin canonizar ni verificar prefijo (`edit.rs:214-225`); `shell` corre con el usuario del proceso (`shell.rs:682-700`) | lo mismo para `read_file` (`read.rs:281-291`) | el prompt es la única frontera; el roadmap ya lo tiene como pendiente |
| 2 | `delegate` documenta "working_dir must be within the parent session's working directory" (`summon.rs:487-490`) pero la restricción es de prompt, no de código verificable en ese punto | `summon.rs:487-490` | un subagente puede escribir fuera del workspace del padre |
| 3 | Campos desconocidos se ignoran en silencio (sin `deny_unknown_fields`) | `read.rs:27-57`, `edit.rs:21-32`, `shell.rs:179-186` | el modelo "cree" que pasó un parámetro que se descartó |
| 4 | `edit` sobre archivo no-UTF-8 falla; `read_file` no quita BOM | `edit.rs:118-126`; `read.rs:130-136` | mojibake crónico en archivos tocados por PowerShell 5.1; el fix solo existe como script manual (`web/tools/fix-encoding.mjs:62-69`) y no cubre `.rs`/`.py` |
| 5 | El normalizador de schema es el único "validador"; no hay chequeo contra meta-schema ni contra la capacidad real del provider | `tool_schema_normalize.rs:19-25` | un schema raro llega al provider y el error aparece como 400 genérico, no como "tool X tiene schema inválido" |
| 6 | `shell` no tiene techo de bytes totales en memoria: acumula todas las líneas en `Vec` antes de truncar (`shell.rs:656-659`) y luego escribe el volcado completo a disco (`:939-947`) | un `cat` de un archivo de 3 GB llena RAM y el tempdir |
| 7 | Truncado por bytes en `read_file` puede saltear líneas intermedias sin decirlo con precisión (`:138-141` `bytes_used = READ_MAX_BYTES; continue;`) | lectura "incompleta" que parece completa |
| 8 | El outbox confía en una regex de nombres; agregar un formato nuevo de secreto (ej. `.env`, `*.kdbx`, `*.ovpn`) requiere tocar la lista | `server.mjs:196` | fuga de credenciales por descarga si alguien copia el archivo ahí |
| 9 | `GET /dl/` no exige autenticación propia: hereda la del server (token/`SEC`) | `server.mjs:1501` no consulta `SEC`-auth, solo agrega headers | si el server queda alcanzable en LAN/túnel, cualquiera con la URL baja el outbox |
| 10 | `_list-tools.mjs` es el único "catálogo" operativo y solo imprime nombres; no hay snapshot versionado del set de tools | `web/tools/_list-tools.mjs:22-24` | regresiones de catálogo (una tool que desaparece en modo plan por un `NeverAllow` mal puesto) no se detectan |
| 11 | `mode.rs` usa el `PermissionManager` global del proceso; los overrides de sesión son memoria y se pisan entre sesiones concurrentes por diseño | `mode.rs:130-132`, `config/permission.rs:40-42` | dos sesiones en el mismo serve comparten cambios de modo mal aplicados si se reutiliza session_id |
| 12 | `scheduler` está `hidden: true` pero `default_enabled: true` | `platform_extensions/mod.rs:133-135` | visible para el modelo, invisible en la UI: contradice "hidden = no visible al usuario ni descubrible" |

---

## 12. No verificado

- **No ejecuté** `web/tools/_list-tools.mjs` ni el serve: el set real de tools del turno vivo (y por lo tanto el prefijo exacto de `memory__*`, `mode__request_mode`, etc.) está inferido de `unprefixed_tools` + `fetch_public_tools`, no observado.
- No leí `summon.rs` completo (96 KB): los disparadores de `delegate` y el enforcement de `working_dir` en el subagente están citados por su schema/descripción, no por su ejecución.
- `websearch.rs` no se auditó en detalle (35 KB): límites de `max_chars`, tamaños de cache y timeouts HTTP no están verificados línea por línea.
- `scheduler`: no localicé los nombres de tool (`ScheduleTool` está en `agents/schedule_tool.rs`, 18 KB) — la tabla no los lista.
- No verifiqué si `AegisMode::SmartApprove` sigue existiendo tras el commit "autonomía como único modo Aegis" (`8d559d0b`): `inference_preparation.rs:67-71` todavía ramifica por `SmartApprove`.
- Dialecto exacto emitido por `schema_for!`: no lo serialicé; la afirmación "sin `$schema`" sale de leer `developer/mod.rs:99-105` (solo `to_value(schema_for!(T))`), no de imprimir el JSON.
- Ni `cargo build` ni tests corridos (READ-ONLY por consigna).

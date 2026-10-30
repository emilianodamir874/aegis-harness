# 06 — MCP, extensiones y plugins

Alcance: cómo el harness declara, arranca, mezcla, filtra y expone herramientas externas.
Fuentes: código local en `C:\Aegis-Proyects\src` (rama `feat/antigravity-provider`, HEAD `8d559d0b5`),
config viva `C:\Aegis-Proyects\state\config\config.yaml`, repo upstream `block/goose`, y la spec MCP
vigente. Fecha de relevamiento: 2026-10-29. Todo lo que dice "verificado" se leyó en disco; lo que no
se pudo comprobar está en §7.

---

## 1. Mapa de piezas

### 1.1 Declaración y modelo de datos

| ruta:linea | qué hace | quién la llama |
|---|---|---|
| `crates/aegis/src/agents/extension.rs:158` | `enum ExtensionConfig` con `#[serde(tag = "type")]`: `stdio`, `builtin`, `platform`, `streamable_http`. Es **el** tipo de declaración de extensión. | config (`extensions.rs`), recetas, ACP (`aegis_extension_to_config`), plugins (`mcp_servers.rs`) |
| `extension.rs:160-179` | `Stdio { name, description, cmd, args, envs, env_keys, timeout, cwd, bundled, available_tools }` | — |
| `extension.rs:196-208` | `Platform { name, description, display_name, bundled, available_tools }` | migración de config, `builtin_to_extension_config` |
| `extension.rs:209-256` | `StreamableHttp { name, uri, envs, env_keys, headers, timeout, socket, client_id, client_secret_key, scopes, bundled, available_tools }` | ACP/UI, config manual |
| `extension.rs:91-128` | `Envs::DISALLOWED_KEYS` (31 claves: `LD_PRELOAD`, `PATH`, `NODE_OPTIONS`, `PYTHONPATH`, `CLASSPATH`, `ComSpec`, …); se descartan con `warn!` en `Envs::new` (`:131-143`) | todo transporte que recibe env |
| `extension.rs:259-270` | `Default for ExtensionConfig` = `Builtin{ name:"developer", timeout:300, bundled:true }` | defaults |
| `extension.rs:349-380` | `key()` = `name_to_key(name)`; `is_tool_available()` (lista vacía = todo permitido) | manager, permisos, catálogo |
| `extension.rs:382-458` | `resolve(config)`: resuelve secretos (`env_keys`, `client_secret_key`) y sustituye `$VAR`/`${VAR}` en `uri`, `headers`, `socket`, `client_id`, `cwd` | `ExtensionManager::start` (`:780`) |
| `extension.rs:467-493` | `merge_environments`: valor inline gana; si no, `std::env::var(KEY.to_uppercase())`; si no, `config.get_secret::<String>(key)` | `resolve` |
| `crates/aegis/src/config/extensions.rs:15` | `ExtensionEntry { enabled: bool, #[serde(flatten)] config }` | `config.yaml` |
| `config/extensions.rs:22-32` | `name_to_key`: alfanumérico/`_`/`-` pasan, espacios se borran, el resto → `_`, luego lowercase. `"Test Client" → "testclient"`, `"client 🚀" → "client_"` | todo el mundo |
| `config/extensions.rs:9-13` | constantes: `DEFAULT_EXTENSION="developer"`, `DEFAULT_EXTENSION_TIMEOUT=300`, `EXTENSIONS_CONFIG_KEY="extensions"` | defaults |
| `config/extensions.rs:55-82` | `parse_extensions_map`: inyecta `name: <clave>` si falta (`:43`), descarta entradas que no parsean (`info!` con la clave), descarta `Platform` desconocidas (`:66` con `is_extension_available`) | lectura/escritura de config |
| `config/extensions.rs:180-197` | `set_extension_enabled(key, enabled)`: muta solo `enabled` y **preserva** hermanos, incluso los que no parsean (tests `:433`, `:547`) | ACP `on_set_config_extension_enabled` |
| `config/extensions.rs:241-273` | `get_available_extensions()` = builtins registrados + `PLATFORM_EXTENSIONS` no `hidden` (ambos como `builtin`/`platform` bundled) | `search_available_extensions`, `get_extension_by_name` |
| `config/extensions.rs:275-299` | `get_warnings()`: toda entrada `type: sse` produce warning `"SSE is unsupported, migrate to streamable_http"` | ACP `on_get_config_extensions` |
| `config/extensions.rs:301-317` | `resolve_extensions_for_new_session`: prioridad receta > override > `get_enabled_extensions()`, filtrado por `is_extension_available` | server/ACP/scheduler |
| `config/migrations.rs:32-133` | `migrate_platform_extensions`: recorre `PLATFORM_EXTENSIONS`, inserta la entrada que falta con `enabled = def.default_enabled` (`:80`), reescribe `type: platform` y conserva `enabled`/`available_tools` | arranque de config (`run_migrations`/`run_read_migrations`) |

### 1.2 Registro de plataforma (in-process) y de builtins (crate `aegis-mcp`)

| ruta:linea | qué hace |
|---|---|
| `crates/aegis/src/agents/platform_extensions/mod.rs:33-254` | `PLATFORM_EXTENSIONS: Lazy<HashMap<&'static str, PlatformExtensionDef>>`. Cada entrada: `name`, `display_name`, `description`, `default_enabled`, `unprefixed_tools`, `hidden`, `client_factory: fn(ctx) -> Option<Box<dyn McpClientTrait>>` (`:341-351`) |
| ídem `:112-124` | clave literal `"extensionmanager"`, `name: "Extension Manager"` → `name_to_key` coincide, por eso el prefijo de sus tools es `extensionmanager__` |
| ídem `:126-140` | `scheduler` es `hidden: true` (no aparece en UI ni en `search_available_extensions`) |
| ídem `:33-50` | `analyze` detrás de `feature = "tree-sitter"`; `apps` de `platform-apps`; `chatrecall` de `chat-recall` (`:5`, `:80`, `:95`) |
| `crates/aegis/src/builtin_extension.rs:7-28` | `BUILTIN_REGISTRY: RwLock<HashMap<&'static str, SpawnServerFn>>` + `register_builtin_extension(s)` / `get_builtin_extension` / `get_builtin_extension_names` |
| `crates/aegis-mcp/src/lib.rs:89-101` | `BUILTIN_EXTENSIONS` = `autovisualiser`, `computercontroller`, `memory`, `tutorial`, cada uno detrás de su feature |
| `crates/aegis-server/src/main.rs:443-444` | único punto de registro: `aegis::builtin_extension::register_builtin_extensions(aegis_mcp::BUILTIN_EXTENSIONS.clone())` (bajo `#[cfg(feature = "bundled-mcp")]`) |
| `crates/aegis-mcp/src/lib.rs:57-87` | `spawn_and_serve`: el server rmcp corre en un `tokio::spawn` sobre el par `DuplexStream` |
| `crates/aegis-mcp/src/mcp_server_runner.rs:5-45` | `McpCommand` (4 variantes) + `serve()` sobre `rmcp::transport::stdio`; es el modo "este binario ES el MCP server", usado también por el camino Docker de `builtin.rs` |

### 1.3 Ciclo de vida: slots, leases y clientes

| ruta:linea | qué hace | quién la llama |
|---|---|---|
| `crates/aegis/src/agents/extension_manager/mod.rs:370-379` | `ExtensionManager { scopes: Mutex<HashMap<scope, IndexMap<key, Arc<ExtensionSlot>>>>, enabling, context, client_name, capabilities }` | `agent.rs:253`, tests, `moim.rs` |
| `mod.rs:183-241` | `ExtensionSlot`: `config`, `placement`, `scope_id`, `Weak<ExtensionManager>`, `runtime: OnceCell<Runtime>`. `runtime()` (`:202`) arranca **una sola vez** y cachea `Running | Declined | Failed(String)` | manager |
| `mod.rs:175-181` | `enum Runtime` — `Declined` = la plataforma no puede proveer la extensión (p.ej. sin scheduler) y no se registra una extensión sin tools | — |
| `mod.rs:122-128` | `resolve_timeout`: `timeout` de la config o `AEGIS_DEFAULT_EXTENSION_TIMEOUT` o `300` s | `start` |
| `mod.rs:673-709` | `resolve(&ExtensionSet)`: reusa slot si `config == config` **y** `serves(working_dir, container)`; si no, crea slot nuevo. `enabling` evita spawns duplicados concurrentes | `session_lease`, `moim` |
| `mod.rs:747-772` | `session_lease`: selección = `EnabledExtensionsState` de la sesión; si el provider `runs_own_tool_loop()`, **excluye** `Stdio` y `StreamableHttp` | preparación de inferencia |
| `mod.rs:774-881` | `start`: dispatch por variante → `streamable_http::connect` (`:826`), `client_factory` de plataforma (`:839`, `None` ⇒ `Declined`), `builtin::connect` (`:845`/`:848`), `stdio::connect` (`:860`) inyectando `AGENT_SESSION_ID` (`:858`) | slot |
| `mod.rs:1063-1065` | `release(session_id)`: saca el scope; "los procesos mueren cuando ningún lease los sostiene" | fin de sesión / rewind |
| `extension_manager/stdio.rs:14-38` | `connect`: primero `extension_malware_check::deny_if_malicious_cmd_args(cmd,args)` (`:21`), luego `docker exec -i -e…` (`:40-53`) o `Command::new(resolve_command(cmd))` con `SearchPaths::builder().with_npm()` | manager |
| `stdio.rs:65-101` | `spawn`: setea `PATH` completo (`:66-68`), `current_dir` (`:70-81`), `spawn_long_lived_mcp_subprocess` (`crates/aegis/src/subprocess.rs:117`), drena stderr en una task para poder reportar `ProcessExit { stderr }` si el initialize falla | manager |
| `extension_manager/builtin.rs:10-41` | in-process: `get_builtin_extension(key)` o `ConfigError("Unknown extension: …")`; con contenedor, ejecuta `aegis mcp <key>` por docker; sin contenedor, `tokio::io::duplex(65536)` ×2 y llama `spawn_fn(read,write)` | manager |
| `extension_manager/streamable_http.rs:219-234` | `http_client`: headers + timeout (`tcp_user_timeout` en Linux) | `connect` |
| `streamable_http.rs:253-268` | `connect_with_legacy_retry`: si el handshake moderno falla por discover vacío, reintenta una vez fijando `ProtocolVersion::V_2025_11_25` | `connect` |
| `streamable_http.rs:29-135` | detección de 401/403 reales (`is_oauth_auth_failure`) y extracción del `WWW-Authenticate` para sembrar el descubrimiento OAuth | `connect` |
| `streamable_http.rs:165-197` | `resolve_static_oauth_client(client_id, client_secret_key, scopes, envs)` — sin `client_id`, con `client_secret_key`, es error de config | manager |
| `crates/aegis/src/agents/mcp_client.rs:507-577` | `McpClient::connect`: handshake rmcp. Con `capabilities.protocol_version` fijo usa `Discover` (si ≥ `STANDARD_HEADERS`) o `Initialize`; sin fijar usa `Auto{ [V_2026_07_28, V_2025_11_25], legacy: V_2025_11_25 }` (`:549-556`). Guarda `peer_info()` como `server_info` (capabilities + instructions) | stdio/builtin/http |
| `mcp_client.rs:583-617` | `send_request_with_context`: inyecta `session_id`/`working_dir`/`tool_call_request_id` en `_meta`, registra el tool call activo, suelta el lock antes de esperar | cada request |
| `mcp_client.rs:620-641` | `await_response`: `select!` entre respuesta, `sleep(timeout)` (→ envía `notifications/cancelled` y devuelve `ServiceError::Timeout`) y cancelación externa | cada request |
| `mcp_client.rs:699`, `:787`, `:861` | timeouts por operación en `read_resource`, `call_tool`, `get_prompt` | tools |

### 1.4 Mezcla de tools y llegada al modelo

| ruta:linea | qué hace |
|---|---|
| `extension_manager/mod.rs:272-298` | `Extension::public_tools(scope_id)`: caché `Mutex<Option<CachedTools{scope_id, version, tools}>>`; invalidada por `tools_version: AtomicU64` que el cliente incrementa en `notifications/tools/list_changed` |
| `mod.rs:300-342` | `fetch_public_tools`: pagina `tools/list` por cursor; filtra `available_tools`; **prefija** `"{key}__{tool}"` salvo `unprefixed_tools`; estampa `meta["aegis_extension"]=key`; normaliza el JSON-Schema (`tool_schema_normalize::normalize_input_schema`) |
| `extension_manager/lease.rs:119-167` | `ToolCatalog::build`: une todas las extensiones; **nombre duplicado = gana el primero**, con `warn!` (`:136-143`); guarda `server_name` sin prefijo; **omite** `list_resources`/`read_resource` de `extensionmanager` si ninguna extensión soporta recursos (`:149-157`) |
| `lease.rs:573-635` | `resolve_tool`: lookup directo y, si falla, `recover_mangled_tool_name` (el modelo convierte `developer__shell` en `developer.shell`, ver `mod.rs:443-483`); error `RESOURCE_NOT_FOUND` con la lista de tools disponibles |
| `lease.rs:637-729` | `call`: resuelve y delega; `call_resolved` limpia `meta.aegis.mcpApp` no confiable (`mod.rs:499-523`), quita `ExtensionMutation` de resultados de extensiones no-plataforma y adjunta el recurso de MCP-UI si el host lo soporta |
| `crates/aegis/src/agents/state_machine/inference_preparation.rs:73-78` | antes de mandar: saca del set toda tool con `NeverAllow` en la sesión (`filter_denied_tools`), después `reply_parts::prepare_inference_tools` |
| `inference_preparation.rs:67-71` | en modo `SmartApprove`, `tool_inspection_manager.apply_tool_annotations(&tools)` |
| `config/permission.rs:235-247` | `session_permission_for_tool`: si el nombre trae `__`, también consulta el nombre corto (permiso por tool compartido entre extensiones) |
| `agents/agent.rs:490-521` | `list_tools(session_id, extension_name)`: lease actual → `tools_for`/`tools`; con `extension_name = None` agrega el `final_output` tool |

### 1.5 La capa UI (ACP) y el "extensionmanager"

| ruta:linea | qué hace |
|---|---|
| `crates/aegis/src/agents/platform_extensions/ext_manager.rs:72-103` | `ExtensionManagerClient`: `InitializeResult` con `capabilities.tools` e **instructions** que el modelo lee (lista de las 4 tools) |
| `ext_manager.rs:240-349` | `get_tools(include_manage_extensions)`: `search_available_extensions` (sin parámetros, `readOnly`), `manage_extensions` (`schemars` de `ManageExtensionsParams{action: enable|disable, extension_name}`), `list_resources`, `read_resource` |
| `ext_manager.rs:373-392` | `list_tools`: `manage_extensions` **solo** si la sesión no es `SessionType::SubAgent` |
| `ext_manager.rs:153-159` | `manage_extensions` rechaza subagentes (`"Subagents cannot manage extensions"`) |
| `ext_manager.rs:161-179` | no puedeauto-deshabilitarse: `name_to_key(extension_name) == "extensionmanager"` ⇒ error que sugiere `aegis settings` |
| `ext_manager.rs:202-205` + `mod.rs:42-69` | el resultado viaja con `meta.aegis_extension_mutation = {action: enable|disable, name}`; `ExtensionManager::applying_mutation` (`mod.rs:1004-1027`) lo aplica **después** de devolver el resultado |
| `ext_manager.rs:457-500` | `search_available_extensions`: lista deshabilitadas (nombre + descripción, `hidden` excluido) y habilitadas deshabilitables |
| `crates/aegis/src/acp/server/extensions.rs:10-96` | handlers UI: `on_add_session_extension`, `on_remove_session_extension`, `on_get_config_extensions` (filtra `hidden`, agrega `get_warnings()`), `on_add_config_extension` (guarda secretos con `set_secret_values`), `on_remove_config_extension`, `on_set_config_extension_enabled` |
| `crates/aegis/src/acp/server/tools.rs:9-50` | `on_get_tools`: por tool, `ToolListItem{name, description, parameters, permission, input_schema, output_schema}` con permiso resuelto sesión→usuario; ordenado por nombre |
| `tools.rs:52-90` | `on_call_tool`: exige que la tool pertenezca a la extensión pedida (`is_tool_owned_by_extension`) y sea visible para apps (`is_tool_visible_to_app`) |
| `crates/aegis/src/acp/server.rs:601-651` | `initial_session_extensions`: builtins por default + explícitos + `get_enabled_extensions_with_config` + `enabled_plugin_mcp_servers(project_root)`, con `push_or_replace_extension` (dedupe por `key`) |
| `crates/aegis/src/acp/server.rs:754-766` | `builtin_to_extension_config(name)`: convierte una entrada de `PLATFORM_EXTENSIONS` en `ExtensionConfig::Platform` |

### 1.6 Plugins

| ruta:linea | qué hace |
|---|---|
| `crates/aegis/src/plugins/mod.rs:17` | `INSTALL_METADATA = ".aegis-plugin-install.json"` (marcador de instalación, con `source`, `source_type`, `auto_update`, `last_update_check`) |
| `plugins/mod.rs:20-33` | `enum PluginFormat { Gemini, OpenPlugins }` |
| `plugins/mod.rs:35-41` | `plugin_install_dir()` = `Paths::plugins_dir()`; `project_plugin_install_dir(root)` = `<root>/.agents/plugins` |
| `plugins/discovery.rs:9` | clave de config `plugins` (mapa ruta→`{enabled}`), persistida sola cuando descubre entradas nuevas (`:146`) |
| `plugins/discovery.rs:52` | `discover_enabled_plugins(project_root)` |
| `plugins/formats/open_plugins.rs` | manifiesto Open Plugins (skills + `mcpServers`) |
| `plugins/formats/gemini.rs` | formato Gemini |
| `plugins/mcp_servers.rs:12` | manifiesto MCP por defecto: `.mcp.json` (`mcpServers: { name: {command,args,env,cwd} }`) |
| `plugins/mcp_servers.rs:32-46` | `enabled_plugin_mcp_servers(root)`: por cada plugin habilitado, sus servidores; un plugin roto se saltea con `warn!` |
| `plugins/mcp_servers.rs:134-165` | `server_to_extension_config`: `ExtensionConfig::Stdio{ name: "{plugin}:{server}", env = {PLUGIN_ROOT} ∪ env, timeout: 300 }`, `cwd` y `cmd/args` con `${PLUGIN_ROOT}` expandido |
| consumidores | `acp/server.rs:648`, `gateway/handler.rs:343` y `:390`, `scheduler/full.rs:884` (solo si la receta no fija extensiones) |

---

## 2. Flujos paso a paso

### 2.1 Declaración → selección de extensiones de una sesión

1. `config.yaml › extensions:` es un mapa `clave → {enabled, type, name?, description?, …}`.
2. Al cargar, `migrations::migrate_platform_extensions` (`migrations.rs:32`) recorre `PLATFORM_EXTENSIONS`
   e **inserta** lo que falte con `enabled = def.default_enabled`; las entradas `type: platform` se
   reescriben con la descripción vigente y conservan `enabled` y `available_tools`.
3. `parse_extensions_map` (`config/extensions.rs:55`): inyecta `name` desde la clave si falta,
   intenta `serde_yaml::from_value::<ExtensionEntry>`, y descarta en silencio (con `info!` y la clave)
   lo que no parsea o es `platform` desconocida.
4. Sesión nueva: `resolve_extensions_for_new_session(recipe_extensions, override)` (`:301`) elige
   receta > override > habilitadas; ACP además suma plugins (`acp/server.rs:648`).
5. La selección se guarda en la sesión (`EnabledExtensionsState` en `extension_data`); el manager la
   lee en `session_lease` (`mod.rs:747`).

### 2.2 Arranque (spawn / handshake) y primer `tools/list`

1. `resolve(&ExtensionSet)` (`mod.rs:673`) busca un slot reutilizable (mismo `config` serializado y
   mismo `working_dir`/`container`); si no hay, `new_slot` (`:656`).
2. El slot arranca **perezosamente** y **una vez**: `runtime.get_or_init(...)` (`:202`). Un fallo queda
   cacheado como `Runtime::Failed(String)` — no hay reintento automático mientras el slot viva.
3. `start` (`:774`): `config.resolve(Config::global())` (secretos y `$VAR`), calcula `client_working_dir`,
   y despacha:
   - `streamable_http` → `streamable_http::connect` con `AegisCredentialStore::new(name)` (`:829`);
     credenciales OAuth por servidor, con fallback ante 401/403 y reintento legacy una vez.
   - `builtin|platform` **de plataforma** → `(def.client_factory)(ctx)`; `None` ⇒ `Runtime::Declined`
     (`:839-841`); el `PlatformExtensionContext` lleva `Weak<ExtensionManager>`, providers, sessions,
     scheduler y `use_login_shell_path`.
   - `builtin` no-plataforma → `builtin::connect` (duplex en proceso, o `aegis mcp <key>` por Docker).
   - `platform` no-plataforma → `ConfigError("Unknown extension")`.
   - `stdio` → chequeo antimalware de `cmd`+`args`, `envs` + `AGENT_SESSION_ID`, spawn, stderr drenado.
4. `McpClient::connect` hace el handshake rmcp (`initialize` + `tools/list_changed` subscription) con el
   timeout de conexión; guarda `server_info.capabilities` (de ahí sale `supports_resources()`).
5. Primer `tools()` del lease dispara `ToolCatalog::build` (`lease.rs:119`) → `public_tools` por
   extensión en paralelo (`join_all`) → `tools/list` paginado por cursor.

### 2.3 Llamada a una tool

1. El modelo emite `{key}__{tool}` (o el nombre desnudo si `unprefixed_tools`).
2. `ExtensionLease::call` (`lease.rs:637`) → `resolve_tool` → colisión/nombre mangled → `call_resolved`.
3. `call_resolved` arma `ToolCallContext` (session, working_dir, tool_call_id, contenedor, lease),
   engancha el stream de notificaciones del servidor y el stream de `action_required`.
4. `client.call_tool(ctx, server_name, args, cancel_token)` con `await_response(timeout)`.
5. Post-proceso: `remove_untrusted_mcp_app_meta`, `ExtensionMutation::take` (si no es plataforma),
   `McpAppCall::attach_resource`.
6. Si la tool fue `extensionmanager__manage_extensions`, el `meta` de la respuesta lleva la mutación y
   `applying_mutation` (`mod.rs:1004`) la aplica al terminar.

### 2.4 Enable / disable

- **Enable** (`mod.rs:918-971`): toma sesión, reusa slot pendiente o seleccionado si `config` coincide,
  `serves(...)` y no está `Failed`; arranca **antes** de seleccionar, para que el fallo llegue a quien
  pidió; selecciona solo si arrancó (`select` → `update_enabled_extensions`). Declined también se
  selecciona (la plataforma decidió no proveer tools).
- **Disable** (`mod.rs:973-983`): saca la config de la lista de la sesión. El proceso sigue vivo
  mientras otro lease lo sostenga; `release(scope)` lo deja caer.
- **UI/config** (`acp/server/extensions.rs:83-96`): `remove_extension` / `set_extension_enabled`
  escriben `config.yaml` preservando entradas ilegibles.

### 2.5 Config viva, leída hoy

`state\config\config.yaml` (4.010 bytes) tiene **11 extensiones, todas `type: platform`**, ninguna
`stdio` ni `streamable_http` ni `sse`:

| clave | enabled | name | nota |
|---|---|---|---|
| websearch | true | websearch | cadena Tavily/SearXNG/Mojeek/Bing/DDG |
| developer | true | developer | `unprefixed_tools` |
| memory | true | memory | descripción local ("digest por turno") |
| tom | true | tom | MOIM por env |
| extensionmanager | true | Extension Manager | clave ≠ nombre |
| todo | **false** | todo | |
| scheduler | true | scheduler | `hidden` |
| summarize | **false** | summarize | |
| chatrecall | true | chatrecall | |
| skills | true | skills | |
| summon | true | summon | |

No hay secretos en la sección `extensions` (ninguna entrada declara `envs`/`env_keys`); el resto del
archivo sólo tiene claves de tuning (`AEGIS_AUTO_COMPACT_TOKEN_LIMIT`, `OPENAI_HOST=http://127.0.0.1:61249`,
etc.). `compact`, `mode`, `analyze` y `apps` **no** figuran en el archivo aunque sí en
`PLATFORM_EXTENSIONS`: entran por la migración en cada carga y no se persisten hasta que algo escribe
la config (ver §7.1).

---

## 3. Invariantes y trampas

1. **`type` es el discriminante, y `name` puede faltar.** `ExtensionEntry` usa `#[serde(flatten)]`;
   si el YAML no trae `name`, se inyecta la clave (`config/extensions.rs:43`). Una entrada `stdio`
   sin `cmd` **no parsea** y desaparece de la vista sin borrarse del archivo.
2. **Clave ≠ nombre.** `name_to_key("Extension Manager") == "extensionmanager"`; el prefijo de tools,
   el `key` del slot, el dedupe y los permisos usan **la clave**, no el `name`.
3. **`sse` está muerto.** Ya no existe variante; una entrada `type: sse` no parsea y `get_warnings()`
   lo dice explícitamente al abrir la UI.
4. **Colisión de nombres de tools: gana el primero** del `IndexMap` de slots, con `warn!` y sin aviso
   al modelo (`lease.rs:136-143`). El orden lo fija la selección de la sesión, no la config.
5. **El modelo mangla `__` a `.`** (`developer__shell` → `developer.shell`); `recover_mangled_tool_name`
   (`mod.rs:443`) lo tolera, y si el nombre es ambiguo devuelve `None` a propósito.
6. **Un fallo de arranque es pegajoso.** `OnceCell<Runtime>` guarda `Failed`; el camino para reintentar
   es `enable` con otro slot (`mod.rs:938` excluye `Failed` de la reutilización) o recrear la sesión.
   El mensaje incluye el **stderr completo** del hijo (`extension.rs:19-37`, `stdio.rs:88-99`).
7. **Timeout**: `timeout` de la extensión > `AEGIS_DEFAULT_EXTENSION_TIMEOUT` > 300 s (`mod.rs:122`).
   Al vencer se manda `notifications/cancelled` al servidor y el error es `ServiceError::Timeout`
   (`mcp_client.rs:632-635`). No hay reintento de request; sólo el reintento legacy de handshake HTTP.
8. **Env saneado.** 31 variables peligrosas se descartan con `warn!` (`extension.rs:91`), así que
   `PATH`/`NODE_OPTIONS`/`LD_PRELOAD` declarados en `envs` **no** llegan al servidor MCP.
9. **Secretos**: `env_keys` se resuelve en este orden — valor inline, `std::env::var(KEY_MAYUSCULAS)`,
   `config.get_secret`. El secreto OAuth (`client_secret_key`) se resuelve junto con `env_keys` a
   propósito: rotarlo cambia el `config` resuelto y eso fuerza reinicio (`extension.rs:425-430`).
10. **Extensiones de plataforma corren in-process** y tienen acceso al agente (sessions, providers,
    scheduler). Las `builtin` de `aegis-mcp` corren in-process pero **como servidor MCP** sobre duplex:
    mismo protocolo, distinta confianza.
11. **El extensionmanager no se auto-deshabilita ni actúa en subagentes** (`ext_manager.rs:153`, `:163`).
12. **`manage_extensions` se aplica fuera de la respuesta**: el cliente devuelve texto + `meta`, y el
    manager aplica la mutación después (`mod.rs:1004`). Un cliente que descarte `meta` rompe la feature.
13. **`list_resources`/`read_resource` invisibles** si ninguna extensión soporta recursos
    (`lease.rs:149-157`): el modelo no ve tools que no podrían funcionar.
14. **Provider con tool loop propio ⇒ sin MCP externo.** `session_lease` excluye `Stdio` y
    `StreamableHttp` (`mod.rs:759-768`): esas tools las resuelve el proveedor, no el harness.
15. **Plugins no son extensiones de config**: viven fuera de `extensions:` (clave `plugins`), no
    aparecen en la UI de extensiones, no se pueden deshabilitar desde `manage_extensions` y se
    reconstruyen en cada sesión desde `.mcp.json`. Se saltean si la receta fija `extensions:`.

---

## 4. Flujo de una extensión externa, de punta a punta (resumen operativo)

```
config.yaml/extensions  ──parse──► ExtensionConfig ──resolve(secretos,$VAR)──► connect
   (o receta / ACP / plugin)                                    │
                                       ┌──────────────┬────────┴────────┬────────────────┐
                                    platform        builtin          stdio           streamable_http
                                 client_factory   duplex+mcp      spawn+hijos       reqwest+OAuth
                                       └──────────────┴─────────┬───────┴────────────────┘
                                                     McpClient (handshake, timeout)
                                                                │
                                    Extension.public_tools (prefijo, available_tools, meta)
                                                                │
                          ToolCatalog (dedupe por nombre) ──► filter NeverAllow ──► modelo
                                                                │
                                        lease.call ──► client.call_tool ──► resultado + meta
```

---

## 5. Local vs GitHub

### 5.1 Crate `aegis-mcp` vs `goose-mcp`

Comparado con `gh api repos/block/goose/contents/crates` y `.../crates/goose-mcp/src` el 2026-10-29:

| hecho | evidencia |
|---|---|
| Upstream tiene `goose-mcp`; local tiene `aegis-mcp` | `gh api repos/block/goose/contents/crates` lista `goose-mcp`; local `crates/aegis-mcp` |
| Mismo conjunto de fuentes en ambos: `autovisualiser/`, `computercontroller/`, `memory/`, `peekaboo/`, `tutorial/`, `lib.rs`, `mcp_server_runner.rs`, `subprocess.rs` | listado de `goose-mcp/src` == listado de `aegis-mcp/src` (8 entradas cada uno) |
| El renombre es un commit propio del fork | `git log`: `7f394c468 feat(rebrand): renombra el fork de goose a Aegis` (renames masivos `goose-* → aegis-*`) |
| Cambio de contenido dentro del crate: sólo el identificador de app | `crates/aegis-mcp/src/lib.rs:14-18` `APP_STRATEGY{ top_level_domain:"Block", author:"Block", app_name:"aegis" }` con el comentario de compatibilidad |

**Conclusión:** `aegis-mcp` es upstream sin tocar salvo el rebrand. No hay features propias agregadas
en ese crate. Lo agregado por el fork está en `crates/aegis`: extensiones de plataforma nuevas y el
modelo de slots/leases.

### 5.2 Extensiones de plataforma: existe-solo-local (por lectura directa)

| extensión | ruta local | estado frente a upstream |
|---|---|---|
| `compact` | `platform_extensions/compact.rs` | local (descripción en español, junto con `mode`) |
| `mode` | `platform_extensions/mode.rs` | local |
| `memory` | `platform_extensions/memory.rs` | local (memoria del operador con digest) |
| `tom` | `platform_extensions/tom.rs` | heredada de goose, modificada localmente |
| `skills` | `crates/aegis/src/skills` | local |
| `websearch` | `platform_extensions/websearch.rs` | local (cadena Mojeek/Bing/DDG) |
| `extensionmanager`, `developer`, `todo`, `summarize`, `analyze`, `apps`, `chatrecall`, `scheduler`, `summon` | ídem | heredadas de goose; el fork les tocó textos |

La comparación archivo por archivo contra `goose/crates/goose/src/agents/platform_extensions` **no** se
hizo en esta pasada: ver §7.2.

### 5.3 Rastros de goose que quedaron

| rastro | ruta | efecto |
|---|---|---|
| `top_level_domain/author = "Block"` | `aegis-mcp/src/lib.rs:14-18` | las rutas de datos heredan "Block" a propósito (comentario en el código) |
| `client_name: "aegis-cli"` | `extension_manager/mod.rs:619` (`with_data_dir`) | el nombre que se anuncia al server MCP en tests/herramientas |
| nombres de feature `bundled-mcp` | `aegis-server/Cargo.toml:28` | corta el registro de `BUILTIN_EXTENSIONS`; sin ella no hay `computercontroller`/`memory`/etc. |

---

## 6. Referencias web

| tema | URL | dato usado |
|---|---|---|
| Versión vigente de la spec MCP | https://modelcontextprotocol.io/specification/versioning | "La versión actual del protocolo es **2026-07-28**"; identificadores `YYYY-MM-DD`; la negociación va por `_meta["io.modelcontextprotocol/protocolVersion"]` y en Streamable HTTP también en el header `MCP-Protocol-Version` |
| Spec completa | https://modelcontextprotocol.io/specification/2026-07-28 | transports (stdio, Streamable HTTP), lifecycle, tools/resources/prompts |
| Repo de la spec | https://github.com/modelcontextprotocol/specification | fuente normativa y registro de features deprecadas |
| Upstream del crate | https://github.com/block/goose/tree/main/crates/goose-mcp | comparación de §5.1 |
| Formato Open Plugins (plugins) | https://github.com/block/goose/tree/main/crates/goose/src/plugins | base del lector local `plugins/formats/open_plugins.rs` |

Correspondencia con el código: `mcp_client.rs:549-556` prefiere `V_2026_07_28` y cae a `V_2025_11_25`
(con `legacy_version`), o sea el harness ya habla la revisión vigente y negocia hacia atrás; el
transporte HTTP del código es Streamable HTTP (`streamable_http.rs`), no el SSE antiguo, coherente con
`get_warnings()` (`config/extensions.rs:291-296`).

---

## 7. Huecos, riesgos y deuda técnica

### 7.1 La config viva no refleja el registro (evidencia)

`config.yaml` tiene 11 entradas; `PLATFORM_EXTENSIONS` (`platform_extensions/mod.rs:33-254`) define 15
(11 incondicionales + 4 detrás de feature: `analyze`, `apps`, `chatrecall`, `scheduler`). De las 4
faltantes en el archivo, `analyze` y `apps` se explican por la feature, pero `compact` y `mode` existen
siempre (`mod.rs:52-64`, `:194-209`) y no están escritas. Como `migrate_platform_extensions` inserta las faltantes en memoria (`migrations.rs:47-125`)
y sólo persiste con `needs_save`, hoy **funcionan sin estar escritas**. Riesgo: cualquier lectura que
no pase por la migración (o un `set_extension_enabled` sobre otra clave) deja el archivo
desincronizado del runtime, y quien audite `config.yaml` no ve `compact`/`mode`. No hay test que
compare "registro == archivo".

### 7.2 Comparación de contenido upstream no hecha

No se leyó `goose/src/agents/platform_extensions` ni `goose/src/agents/extension_manager` en GitHub en
esta pasada. La tabla §5.2 está basada en el código local y en la memoria de sesión, **no** en un diff.
Para cerrar el punto hay que hacer `gh api repos/block/goose/contents/crates/goose/src/agents/platform_extensions`
y comparar nombre por nombre.

### 7.3 Sin reintento de arranque ni de request

`Runtime::Failed` es permanente por slot (`mod.rs:202-221`) y no hay backoff. Un MCP que falla al
arrancar por una condición transitoria (puerto, red, OAuth vencido) obliga a recrear la sesión o a
`enable` con config distinto. Tampoco hay reintento de `call_tool`: sólo el legacy-retry de handshake
HTTP (`streamable_http.rs:253`).

### 7.4 Colisión de tools es silenciosa para el usuario

`lease.rs:136-143` loguea `warn!` y sigue. Con dos MCP que publican `search`, el segundo desaparece sin
que la UI lo muestre; `search_available_extensions` tampoco lo detecta.

### 7.5 `list_resources`/`read_resource` dependen de un cálculo global

`ToolCatalog::build` decide si mostrar esas dos tools según `supports_resources()` de **cualquier**
extensión del set (`lease.rs:120-157`). Una extensión que soporte recursos y falle al arrancar puede
hacer que las tools aparezcan y fallen después.

### 7.6 `enabled_plugin_mcp_servers` se evalúa en tres lugares distintos

`acp/server.rs:648`, `gateway/handler.rs:343`/`:390` y `scheduler/full.rs:884`. Cada uno elige un
`project_root` diferente (root de proyecto, `working_dir` de la sesión, `std::env::current_dir()`), así
que el mismo plugin puede estar activo en un camino y no en otro. `scheduler/full.rs` además sólo lo
hace si la receta no declara `extensions:`.

### 7.7 Sin tests de contrato con servidores MCP reales

Los tests del manager usan `MockClient` (`mod.rs:1142-1250`) y `McpFixtureServer`
(`aegis_test_support`). No hay un test que arranque un `npx` real y verifique prefijo, `available_tools`
y timeout. El primer contacto real suele ser la sesión del operador.

### 7.8 `extension_malware_check` en el camino crítico

`stdio.rs:21` llama `deny_if_malicious_cmd_args` **antes** de spawnear. Es el único control sobre
`cmd`+`args` arbitrarios de una entrada `stdio`, y la política del fork tiene
`SECURITY_PROMPT_ENABLED: false` en `config.yaml` (ver la sección de tuning). Con `AEGIS_WORKSPACE_SANDBOX:
false`, un `stdio` mal escrito en config no tiene segunda barrera.

---

## 8. No verificado

- Diff línea a línea de `crates/aegis-mcp` contra `goose-mcp` (sólo comparé listados de archivos y el
  `APP_STRATEGY`).
- Contenido upstream de `goose/src/agents/extension_manager` y `platform_extensions` (§7.2).
- Que `compact`/`mode` efectivamente arranquen en la sesión viva: lo deduzco de `PLATFORM_EXTENSIONS` +
  migración, no de un `tools/list` observado. En la sesión que produce este documento sí aparecen sus
  tools, lo que es evidencia indirecta pero no una medición del catálogo.
- Comportamiento de `streamable_http` contra un servidor real: leí el código, no ejecuté una conexión.
- Los paths de datos de plugins (`Paths::plugins_dir()`) resueltos en esta máquina: no ejecuté
  `aegis-serve --print-paths` para confirmarlos.

# 05 — Sesiones, persistencia y el store SQLite

Documento de referencia del subsistema de sesiones de Aegis: código Rust, esquema del store vivo,
PRAGMAs, ledger de uso, retención y deuda técnica.

Medido el **2026-10-29 12:45–12:50 (-03)** con el serve vivo (puerto 3284) y el store abierto por él.
Todo lo del store se leyó en solo-lectura (`sqlite3 -readonly`, `node:sqlite` con `mode=ro`,
`python sqlite3` con `?mode=ro`). No se escribió ni se ejecutó mantenimiento.

Comandos base usados:

```
sqlite3 -readonly state\data\sessions\sessions.db "PRAGMA journal_mode; ..."
sqlite3 -readonly ... ".schema" / "SELECT ... GROUP BY ..."
sqlite3 -readonly ... "SELECT name,SUM(pgsize)/1048576 AS mb FROM dbstat GROUP BY name ORDER BY mb DESC"
```

---

## 1. Mapa de piezas

Rutas relativas a `C:\Aegis-Proyects\`. La columna «quién la llama» es la cadena real de invocación
verificada por grep, no la intención del diseño.

### 1.1 Motor (crate `aegis`)

| ruta:línea | qué hace | quién la llama |
|---|---|---|
| `src/crates/aegis/src/session/mod.rs:1-30` | declara los submódulos y re-exporta `SessionManager`, `Session`, `SessionType`, `ExtensionData`, exportadores | `lib.rs` del crate; `aegis-server` vía `aegis::session::*` |
| `session/session_manager.rs:32` | `CURRENT_SCHEMA_VERSION = 22` | `pool()` / `run_migrations()` |
| `:38-45` | DDL de la vista `v_visible_messages` (única regla de visibilidad) | `create_schema` (:1454), migración 21 (:2037) |
| `:46-49` | `SESSIONS_FOLDER="sessions"`, `DB_NAME="sessions.db"`, umbral ms/s (1e10), batch de conteo 900 | `SessionStorage::new`, `populate_visible_message_counts` |
| `:65-74` | `SessionType` (`user`,`scheduled`,`sub_agent`,`hidden`,`terminal`,`gateway`,`acp`) | `Session.session_type`, filtros de listado |
| `:76-77` | `SESSION_STORAGE: LazyLock<Arc<SessionStorage>>` sobre `Paths::data_dir()` | `SessionManager::instance()` (:519) |
| `:80-122` | struct `Session` (espejo de la tabla + campos derivados `message_count`, `last_message_at`, `last_message_snippet`) | `sqlx::FromRow` (:1020), ACP `session/load` |
| `:124-146` | `TokenState` desde `Session.usage` | update de estado de sesión |
| `:205-244` | `SessionUpdateBuilder` (+`.apply()`) | `acp/server/*` (rename, archive, provider, model, mode) |
| `:512-535` | `SessionManager::{new,instance,storage,create_session}` | `acp/server.rs:1431` inicializa el pool eager |
| `:548-552` | `get_session(id, include_messages)` | `server.rs:1347/1372/1703`, `load_session.rs:458`, `rewind.rs:62`, etc. |
| `:571-575` | `add_message` / `replace_conversation` | `EffectHandler::apply_effects` (`agents/state_machine/session.rs:55,60`) |
| `:589-621` | `list_sessions*` | ACP `session/list`, UI web |
| `:621-625` | `delete_session` | `acp/server/manage_sessions.rs` |
| `:646-671` | `get_session_usage_totals`, `record_usage_metrics` | `agents/state_machine/usage.rs:58`, `memory/extraction.rs:238` |
| `:684-712` | `import_session`, `copy_session`, `truncate_conversation*` | ACP `_aegis/session/import`, `rewind` |
| `:734-802` | `maybe_update_name` (nombra la sesión con el modelo) | primera respuesta del turno |
| `:803-823` | `search_chat_history` | extensión `chatrecall` |
| `:824-850` | `update_message_metadata`, `update_tool_request_meta` | efecto `SetMessageVisibility`, `PatchToolRequestMeta` |
| `:851-933` | `set_extension_state/value`, `update_enabled_extensions`, `set_system_prompt_extra` | ACP extensions / hints |
| `:1139-1169` | `ensure_session_row` — recrea la fila de `sessions` si desapareció bajo un agente vivo | `add_message`, `replace_conversation_inner`, `save_compacted_conversation`, `record_usage_metrics` |
| `:1170-1207` | `insert_usage_ledger_row` | `record_usage_metrics` (:3006) |
| `:1210-1239` | `create_pool` — WAL + busy_timeout 30 s + cache 32 MB + mmap 256 MB + temp_store MEMORY + synchronous NORMAL | `SessionStorage::new` |
| `:1241-1274` | `SessionStorage::new` y `pool()` (OnceCell: migraciones una sola vez por proceso) | `SessionManager::storage()` |
| `:1276-1464` | `create_schema` — DDL completo bajo `BEGIN IMMEDIATE`, idempotente | `pool()` cuando no existe `schema_version` |
| `:1466-1585` | `import_legacy` / `import_legacy_session` — importa los `*.jsonl` viejos (tope 50 MB) de `data/sessions/` | sólo en el camino de store nuevo |
| `:1587-1631` | `run_migrations` — corre `v(n+1)..=22` en una sola transacción, luego backfill de `project_id` y su índice | `pool()` cuando existe `schema_version` |
| `:1668-2061` | `apply_migration` — las 22 migraciones (ver §4) | `run_migrations` |
| `:2419-2455` | `get_conversation` — `ORDER BY created_timestamp, id` | `get_session(..., true)` |
| `:2457-2502` | `add_message` — una transacción por mensaje, `created = max(msg.created, MAX(created_timestamp))`, `updated_at` | efectos del state machine |
| `:2504-2544` | `replace_conversation_inner` — `DELETE` + reinsertar la conversación entera | efecto `ReplaceConversation` (rewind/import) |
| `:2555-2611` | `save_compacted_conversation` — actualiza `metadata.agent_visible` por `message_id` y sólo inserta los mensajes que no estaban | efecto `CompactConversation` |
| `:2613-2755` | `list_sessions_matching` — listado paginado por cursor con subconsulta correlacionada para el último mensaje | `list_sessions_paged` (`:2802`) |
| `:2756-2790` | `populate_visible_message_counts` (batches de 900 ids) | listado sin límite |
| `:2851-2882` | `delete_session` — borra messages, usage_ledger y la fila, en ese orden | `manage_sessions` |
| `:2917-3010` | `record_usage_metrics` — fila `carried_forward` opcional + `UPDATE sessions` acumulados + fila del ledger | `usage::record` |
| `:3012-3094` | `get_session_usage_totals` — `WITH RECURSIVE` por `parent_session_id`, `max(accumulated, ledger)` | panel de uso / ACP |
| `session/workspaces.rs` (todo el archivo) | registro de raíces de trabajo: `CREATE_WORKSPACES_TABLE`, `workspace_id` (sha256 de la raíz normalizada), `register_workspace`, `touch_workspace`, `seed_from_sessions`, `list_workspaces` | `create_session` (:2135), migración 22 (:2046-2052), ACP workspaces |
| `session/last_message_snippet.rs` | snippet derivado del último mensaje visible (no es columna) | listado |
| `session/pending_confirmations.rs` | reescribe confirmaciones pendientes como mensajes | arranque de sesión |
| `session/legacy.rs` | lectura de `*.jsonl` pre-SQLite | `import_legacy` |
| `session/extension_data.rs` | `ExtensionData` tipado sobre la columna `extension_data` | `Session.extension_data` |
| `session/session_naming.rs` | nombre generado tras N mensajes | `maybe_update_name` |
| `session/diagnostics.rs`, `export_markdown.rs`, `export_html/`, `import_formats/{claude_code,codex,pi}.rs` | exportación/importación y bundle de diagnóstico | ACP / UI |

### 1.2 Fuera del crate `aegis`

| ruta:linea | qué hace | quién la llama |
|---|---|---|
| `src/crates/aegis-sdk-types/src/lib.rs:1-7` | re-exporta `custom_notifications` + `custom_requests`: **sólo tipos de cable ACP** (`_aegis/*`) | `aegis-sdk`, clientes |
| `src/crates/aegis-sdk-types/src/custom_requests.rs:19-54` | `RetryLastTurn*`, `UnrewindSession*`, recetas/programaciones; no define `Conversation` ni `ExtensionConfig` | UI / SDK |
| `src/crates/aegis-sdk/src/lib.rs:1-20` | GDK: re-export de wire types; con `--features uniffi` expone `bindings.rs` | consumidores externos |
| `src/crates/aegis-sdk/src/bindings.rs:557-870` | conversión `Usage`/mensajes a la superficie uniffi (incluye `Usage::from_provider_usage`) | uniffi (Python/Kotlin) |
| `src/crates/aegis/src/sources.rs:1-30` | CRUD de `SourceEntry` sobre **archivos** (`<config>/skills/`, `<data>/projects/<slug>.md`), no sobre el store | extensión `sources` |
| `src/crates/aegis/src/source_roots.rs:1-13` | `SourceRoot { path, writable }` — modelo de raíces de archivos | `sources.rs` |
| `src/crates/aegis-provider-types/src/conversation.rs:14` | `Conversation(Vec<Message>)` — el tipo que se serializa a `messages.content_json` | todo el motor |
| `src/crates/aegis/src/agents/state_machine/session.rs:40-117` | `EffectHandler` — traduce efectos a escrituras del store | pipeline del agente |
| `src/crates/aegis/src/agents/state_machine/usage.rs:24-68` | `enrich` (coste por efecto) y `record` (fila del ledger) | `apply_effects` |

`ExtensionConfig` **no** vive en `aegis-sdk-types`: está en `src/crates/aegis/src/config/…` (crate
`aegis`) y se persiste dentro de `sessions.extension_data` (JSON), no como columna propia.

---

## 2. Modelo de datos (store vivo)

### 2.1 Tablas y columnas

#### `sessions` (498 filas)

| columna | tipo | notas |
|---|---|---|
| `id` TEXT PK | `YYYYMMDD_<n>` | contador por día en `session_id_counters` (nunca retrocede) |
| `name` TEXT NOT NULL DEFAULT '' | nombre visible; `user_set_name=1` congela el renombrado |
| `description` TEXT NOT NULL DEFAULT '' | **vestigial** (resto de Goose): se proyecta en `FromRow` (:1052) y en los `SELECT` (:2148, :2690) pero no hay escritura; la UI usa `name` |
| `user_set_name` BOOLEAN DEFAULT FALSE | 6 filas en 1 |
| `session_type` TEXT NOT NULL DEFAULT 'user' | ver distribución §10 |
| `working_dir` TEXT NOT NULL | ruta tal cual la dio el cliente |
| `created_at`/`updated_at` TIMESTAMP | `updated_at` se toca en cada mensaje/uso |
| `extension_data` TEXT DEFAULT '{}' | estado de extensiones (`ExtensionData`) |
| `total_tokens`,`input_tokens`,`output_tokens` INTEGER | **última** llamada, no acumulado |
| `cache_read_tokens`,`cache_write_tokens` INTEGER | idem |
| `accumulated_*` (5 columnas) + `accumulated_cost` REAL | acumulado histórico; `accumulated_cost` no nulo en 424/498 |
| `schedule_id` TEXT | **0 filas** (las programadas no persisten) |
| `recipe_json`, `user_recipe_values_json` TEXT | 88 filas con receta |
| `provider_name` TEXT | 4 NULL |
| `model_config_json` TEXT | 494 filas |
| `aegis_mode` TEXT NOT NULL DEFAULT 'auto' | renombrada desde `goose_mode` (migración 19) |
| `archived_at` TIMESTAMP | 24 archivadas |
| `project_id` TEXT | **= working_dir** (ver §11, trampa 3) |
| `parent_session_id` TEXT | árbol de subagentes (`idx_sessions_parent`) |
| `system_prompt_override`, `system_prompt_extras_json` | 87 / 19 filas |
| `container_id` TEXT | **0 filas** (feature sin uso) |

Índices: `idx_sessions_updated(updated_at DESC)`, `idx_sessions_type`, `idx_sessions_parent`,
`idx_sessions_project_id`.

#### `messages` (122 934 filas)

| columna | tipo | notas |
|---|---|---|
| `id` INTEGER PK AUTOINCREMENT | orden de inserción real |
| `message_id` TEXT | `msg_<session>_<uuid>`; 4 filas NULL (legacy) |
| `session_id` TEXT NOT NULL REFERENCES sessions(id) | **sin `ON DELETE CASCADE`** → borrado manual |
| `role` TEXT NOT NULL | sólo `user`/`assistant` (los `toolResponse` van como `user`) |
| `content_json` TEXT NOT NULL | array de bloques `{type: text|toolRequest|toolResponse|thinking|image}` |
| `created_timestamp` INTEGER NOT NULL | segundos (o ms en filas legacy; umbral 1e10) |
| `timestamp` TIMESTAMP DEFAULT CURRENT_TIMESTAMP | hora de inserción, no de creación |
| `tokens` INTEGER | **NULL en el 100 % de las filas**: nunca se pobla |
| `metadata_json` TEXT | `userVisible`, `agentVisible`, `usage`, `truncated`, `turnContext`… |

Índices: `idx_messages_session`, `idx_messages_timestamp`, `idx_messages_message_id`,
`idx_messages_session_created(session_id, created_timestamp, id)`.

#### `usage_ledger` (46 172 filas)

| columna | tipo | notas |
|---|---|---|
| `id` INTEGER PK AUTOINCREMENT | |
| `session_id` TEXT NOT NULL REFERENCES sessions(id) **ON DELETE CASCADE** | el único FK con cascada |
| `created_timestamp` INTEGER NOT NULL | `strftime('%s','now')` en el servidor |
| `model` TEXT | |
| `provider` TEXT | añadida en v20; NULL sólo en 20 filas (mocks) |
| `input_tokens`,`output_tokens`,`total_tokens`,`cache_read_tokens`,`cache_write_tokens` | |
| `cost` REAL | NULL en 407 (proveedor sin tarifa), 0 en 1 407 |
| `cost_source` TEXT | `provider_reported` \| `estimated` \| `carried_forward` \| NULL |
| `is_compaction` INTEGER DEFAULT 0 | 60 filas |

Índice: `idx_usage_ledger_session`.

#### Resto

| tabla | columnas clave | contenido hoy |
|---|---|---|
| `schema_version` | `version` PK, `applied_at` | **6 filas: 17,18,19,20,21,22** (ver §4) |
| `session_id_counters` | `day` PK, `last_index` | 17 días; 20261029→27 |
| `workspaces` | `id` PK (`ws_`+16 hex sha256), `root` UNIQUE, `name`, `pinned`, `defaults` JSON, `last_used_at`, `created_at` | 10 filas, 0 fijados |
| `provider_inventory_entries` | `inventory_key` PK, `provider_id`, `provider_family`, refrescos | 3 filas |
| `provider_inventory_models` | (`inventory_key`,`ordinal`) PK, `model_id`, `name`, `context_limit`, `reasoning`, `recommended` | 303 filas |
| `messages_fts` (FTS5 `unicode61 remove_diacritics 2`) | `row_id UNINDEXED`, `text` | 122 934 filas (1:1 con `messages`) |
| `v_visible_messages` (VIEW) | `m.*` | 82 909 filas visibles |
| `sqlite_stat1`, `sqlite_sequence`, tablas internas de FTS | — | — |

Triggers: `messages_fts_ai` (INSERT), `messages_fts_ad` (DELETE), `messages_fts_au`
(UPDATE OF content_json). Extraen `group_concat(json_extract(value,'$.text'))` — **sólo bloques
`type='text'`**: resultados de herramientas y thinking no son buscables.

### 2.2 Relaciones

```
sessions 1 ──── n messages            (FK declarada, SIN cascada → delete_session borra a mano)
sessions 1 ──── n usage_ledger        (FK con ON DELETE CASCADE)
sessions 1 ──── n sessions            (parent_session_id, árbol de subagentes)
sessions n ──── 1 workspaces          (por valor: sessions.project_id/working_dir == workspaces.root)
messages 1 ──── 1 messages_fts        (row_id = messages.id)
v_visible_messages = messages ⋈ sessions  filtrando userVisible≠0 AND session_type IN (user,scheduled,acp)
```

`PRAGMA foreign_keys` **no** está persistido en el archivo (mi conexión de lectura ve `0`); lo activa
cada conexión del motor (`SqliteConnectOptions::foreign_keys(true)`, `session_manager.rs:1224`).

---

## 3. Ciclo de vida de una sesión

### 3.1 Creación

1. ACP `session/new` → `acp/server/new_session.rs:60` → `SessionManager::create_session`.
2. `create_session` (`:2063-2142`) abre `BEGIN IMMEDIATE`, crea `session_id_counters` si falta,
   siembra el contador del día con `MAX(CAST(SUBSTR(id,10) AS INTEGER))` si no existe la fila,
   lo incrementa con `UPDATE … RETURNING last_index` e inserta la fila con
   `id = '<YYYYMMDD>_<n>'`, `project_id = working_dir`, `extension_data='{}'`.
3. En la **misma** transacción llama `workspaces::touch_workspace` (alta/actualización de
   `last_used_at`); un fallo ahí se loguea y no aborta (`warn!` en `:2137`).
4. `pool()` inicializa esquema/migraciones una sola vez por proceso (`tokio::sync::OnceCell`,
   `:1246,1252-1274`).

`acp/server.rs:1431-1434` dispara `storage().pool()` en un `tokio::spawn` al arrancar, así el costo de
migrar/abrir se paga antes del primer turno.

### 3.2 Carga

- `SessionLoader::load` (`agents/state_machine/session.rs:34-36`) → `get_session(id, true)`:
  una fila de `sessions` + **todos** los mensajes de `get_conversation` (`ORDER BY created_timestamp, id`).
  Una sesión de 9 520 mensajes / 17 MB se materializa entera por turno.
- `include_messages=false` usa `COUNT(*) FILTER` + `MAX(timestamp)` (`:2181-2193`) para listados.

### 3.3 Qué se escribe y cuándo

| evento | escritura | transacción |
|---|---|---|
| cada mensaje (usuario, assistant, respuesta de herramienta) | `INSERT messages` + `UPDATE sessions.updated_at` | `BEGIN IMMEDIATE` por mensaje → **1 commit por mensaje** |
| cada respuesta del proveedor | `UPDATE sessions` (tokens de la llamada + acumulados) + `INSERT usage_ledger` (+ fila `carried_forward` si hay deriva) | `BEGIN IMMEDIATE` |
| compactación | `record_usage_metrics(is_compaction=1)` + `save_compacted_conversation` (UPDATE de `agent_visible` + INSERT de mensajes nuevos) + update de `usage` | 2 transacciones separadas |
| visibilidad / patch de tool meta | `UPDATE messages.metadata_json` | una por efecto |
| rename, archive, provider, model, modo | `UPDATE sessions …` | una por llamada |
| cierre de sesión | **no hay evento de cierre**: el estado ya está en disco | — |

No hay buffer ni flush diferido: el WAL recibe un commit por mensaje (~1–2 por tool call), que es
exactamente lo que justifica `synchronous=NORMAL` en `create_pool` (`:1234-1236`).

### 3.4 Borrado, truncado y fork

- `delete_session` (`:2851-2882`): `messages` → `usage_ledger` → `sessions`. Verifica existencia
  antes; si no existe devuelve `Session not found`.
- `truncate_conversation[_from_message]` (`:3195-3237`): borra por `created_timestamp` con
  desempate por `id` (test `:3927`).
- `copy_session` (`:3146`), `fork_session` (`acp/server/fork_session.rs`), `import_session`
  (formatos `claude_code`/`codex`/`pi`) reusan `create_session` + `replace_conversation`.

### 3.5 Concurrencia

- **Un pool por proceso**, `connect_lazy_with(options)` sin `max_connections` explícito → default de
  sqlx (10 conexiones). Todos los escrituras usan `pool.begin_with("BEGIN IMMEDIATE")`, es decir el
  lock de escritura se toma al abrir la transacción y nunca se "promueve" a mitad de camino (test
  `test_begin_immediate_prevents_lock_upgrade_deadlock`, `:4473`).
- `create_schema` y `run_migrations` van bajo `BEGIN IMMEDIATE` con DDL `IF NOT EXISTS` +
  `INSERT OR IGNORE` del bootstrap para tolerar arranques concurrentes (`:1277-1305`).
- `busy_timeout(30 s)`: el que espera por el lock reintenta 30 s antes de fallar.
- Lectores externos conviven con el serve gracias a WAL (lectores no bloquean al escritor).
  En la práctica: `web/tools/search-index.mjs` abre `file:…?mode=ro` + `readOnly:true`;
  `web/tools/analyze-sessions.py` usa `?mode=ro`; `core/ops/*.mjs` usan `node:sqlite`
  (`DatabaseSync`, sin `readOnly` → escriben si el script lo pide).
- Detalle de WAL: un proceso que abre en sólo-lectura **necesita** poder leer/escribir el
  `-shm` (o tener escritura en el directorio). Hoy `sessions.db-shm` (32 KB) y
  `sessions.db-wal` (5,9 MB) existen con el serve vivo, así que las lecturas funcionan.

---

## 4. Migraciones (estado real ≠ intención)

`run_migrations` aplica `v(n+1)..=22` en **una** transacción y registra cada versión con
`INSERT INTO schema_version`. Las 22 ramas de `apply_migration`:

| v | qué hace |
|---|---|
| 1 | crea `schema_version` |
| 2 | `sessions.user_recipe_values_json` |
| 3 | `messages.metadata_json` |
| 4 | `sessions.name`, `sessions.user_set_name` |
| 5 | `sessions.session_type` + índice |
| 6 | `sessions.provider_name`, `model_config_json` |
| 7 | `messages.message_id` + backfill `msg_<session>_<id>` + índice |
| 8 | `sessions.aegis_mode` (entonces `goose_mode`) |
| 9 | reclasifica `user`→`acp` para sesiones llamadas «ACP Session» |
| 10 | `sessions.thread_id`, tablas `threads` y `thread_messages` + índices |
| 11 | tablas de inventario de proveedores |
| 12 | `archived_at`, `project_id` |
| 13 | `accumulated_cost` |
| 14 | 4 columnas de cache |
| 15 | `parent_session_id` + índice + tabla `usage_ledger` + índice |
| 16 | `idx_messages_session_created` |
| 17 | `system_prompt_override`, `system_prompt_extras_json`, `container_id` |
| 18 | `messages_fts` + triggers + backfill del índice |
| 19 | `goose_mode` → `aegis_mode` |
| 20 | `usage_ledger.provider` |
| 21 | vista `v_visible_messages` |
| 22 | tabla `workspaces` + índice + siembra desde `project_id` |

**Hecho medido:** `SELECT version FROM schema_version` → `17,18,19,20,21,22`. Este store nació por el
camino `create_schema` cuando `CURRENT_SCHEMA_VERSION` era 17 (`:1302-1305` inserta la versión
corriente, no la 1). Consecuencias verificadas:

- Las tablas `threads` / `thread_messages` de la migración 10 **no existen** (`sqlite_master` no tiene
  ninguna coincidencia con `%thread%`), porque `create_schema` nunca las creó. Y no importa: fuera de
  esa migración **no hay una sola referencia** a `threads`/`thread_messages` en `src/crates`
  (grep: 3 coincidencias, todas dentro de `apply_migration`). Feature muerta.
- `sessions.thread_id` tampoco existe.

No hay rama `_` alcanzable con huecos: el `match` cubre 1–22; el orden de las ramas 18/17 en el
código está invertido respecto del número, lo que no afecta (se despacha por valor) pero sí engaña al
leer.

---

## 5. PRAGMAs

| pragma | valor efectivo | dónde se setea | persistente? | por qué |
|---|---|---|---|---|
| `journal_mode` | `wal` | `create_pool` `:1226` | **sí** (header del archivo) | lectores concurrentes sin bloquear al escritor; verificado `PRAGMA journal_mode` → `wal` |
| `synchronous` | `NORMAL` en el motor | `:1236` | **no** (por conexión) | en WAL, NORMAL es durable ante caída del proceso y evita un fsync por commit; hay 1 commit por mensaje |
| `cache_size` | `-32768` (32 MB) en el motor | `:1231` | no | el default de 2 MB hacía volver al disco en cada lectura de sesión larga |
| `mmap_size` | `268435456` (256 MB) | `:1232` | no | memoria mapeada respaldada por page cache del SO, compartida entre conexiones |
| `temp_store` | `MEMORY` | `:1233` | no | ORDER BY / temp de FTS en RAM |
| `busy_timeout` | 30 s | `:1225` | no | espera el lock de escritura en vez de `SQLITE_BUSY` |
| `foreign_keys` | `1` | `:1224` | no | las FK declaradas se hacen cumplir |
| `page_size` | 4096 | default de compilación; nunca se cambió | sí | cambiar `page_size` exige salir de WAL y hacer VACUUM |
| `auto_vacuum` | 0 (`none`) | — | sí | el archivo no se encoge solo: por eso `prune-sessions.ps1` difiere el VACUUM |
| `user_version` | 0 | — | sí | el versionado vive en `schema_version`, no acá |

Verificación del punto “por conexión”: mi conexión de `sqlite3 -readonly` reporta
`cache_size=-2000`, `synchronous=2 (FULL)` y `mmap_size=0` — los defaults — mientras el proceso del
serve usa los valores de la tabla. Sólo `journal_mode` (y `page_size`, `auto_vacuum`, `freelist`) son
propiedades del archivo.

`core/ops/patch-store-pragmas.py` es el parche que introdujo ese bloque: reemplaza textualmente el
tramo `.busy_timeout(...).journal_mode(Wal);` por la versión con los cuatro `.pragma(...)`,
abortando si el bloque no aparece exactamente una vez. Hoy el parche **ya está aplicado y commiteado
localmente** (`git diff origin/main` lo muestra como añadido; `git diff` de trabajo no lo lista).

---

## 6. `usage_ledger`: qué se registra y cómo se calcula el costo

### 6.1 Granularidad

Una fila por **respuesta del proveedor** (efecto `RecordUsage`) y una por **compactación**
(`CompactConversation` con usage, `is_compaction=1`). `record_usage_metrics` (`:2917-3010`):

1. Opcional: si `sessions.accumulated_*` supera la suma del ledger (deriva de builds viejos), inserta
   **una** fila `cost_source='carried_forward'` con la diferencia. Hoy hay exactamente **1**.
2. `UPDATE sessions` con los tokens de *esta* llamada (columnas sin `accumulated_`) y suma en las
   columnas `accumulated_*`; `accumulated_cost` sólo se toca si `ledger.cost IS NOT NULL`.
3. `INSERT usage_ledger` con `model`, `provider`, tokens, `cost`, `cost_source`, `is_compaction`.

### 6.2 Cálculo del costo

`agents/state_machine/usage.rs:33` → `resolve_usage_cost(provider_name, &usage)`
(`providers/canonical_cost.rs:45-56`):

1. Si el proveedor reportó `cost` → `(cost, ProviderReported)`.
2. Si no, estimación por tarifa: `estimate_model_cost(provider, model, usage)` con precedencia
   (`canonical_cost.rs:1-22,60-91`): tarifa declarada por el usuario en el archivo de proveedores
   personalizados > registro canónico incluido > tarifas declaradas en definiciones vendorizadas
   (sólo rellenan huecos). Monedas no-USD no se convierten sin tipo de cambio.
3. Si no hay tarifa → `(None, None)`: `cost` NULL en el ledger.

Distribución real (`GROUP BY cost_source`): `estimated` 44 176 filas / **2 242,19 USD**;
`provider_reported` 1 609 / **1,53 USD**; NULL 406; `carried_forward` 1 / 0.

Que el 95,7 % del dinero sea “estimated” y que `chatgpt_codex` (que reporta costo) sume 2 186 USD no
es contradictorio: el caro es `gpt-6-sol`, que reporta coste, y los que estiman son los baratos con
muchísimas llamadas.

### 6.3 `web/prices.json` — ajuste estadístico, no tarifa

`web/prices.json` declara explícitamente en `_comentario` que son **estimaciones históricas derivadas
de una muestra**, no tarifas verificadas. Contraste con el ledger medido hoy:

| provider/model | filas | input tok | cache read | costo USD | USD/1M input+output | prices.json `inputEffective` |
|---|---|---|---|---|---|---|
| chatgpt_codex/gpt-6-sol | 14 136 | 2 806 979 341 | 2 337 429 376 | 2 110,88 | 0,752 | 0,6208 (`input 2.0`, `output 10.0`, `cacheReadRatio 0.1`) |
| chatgpt_codex/gpt-6-luna | 2 732 | 788 591 528 | 492 268 672 | 61,54 | 0,078 | 0,07862 |
| open_design/deepseek-flash | 21 936 | 4 558 921 482 | 4 455 995 264 | 40,98 | 0,009 | (clave vecina `deepseek-v4.1-flash`: `null`) |
| opencode_go/deepseek-v4.1-flash | 6 516 | 1 600 847 887 | 1 536 844 672 | 14,64 | 0,009 | `null` |
| chatgpt_codex/gpt-5.6-luna | 233 | 75 124 110 | 40 400 000 | 14,03 | 0,1867 | — |
| experiential/deepseek-v4.1-flash-uncensored | 629 | 51 341 928 | 50 555 520 | 1,53 | 0,0298 | — |

Conclusión: el `cost` del ledger **no se calcula desde `prices.json`** (eso vive en el proxy web);
`prices.json` es una derivación a posteriori del mismo ledger. La tasa efectiva de `gpt-6-sol` ya está
en 0,752 USD/1M de entrada contra 0,6208 declarada, así que el archivo está desactualizado y su
`fitReliable:true` ya no se sostiene.

### 6.4 `core/ops/audit-cuadre.ps1` — no tiene relación con el costo

Es una auditoría de **disco del volumen C:**: tamaño real usado, suma por directorio de primer nivel,
pagefile/dumps, shadow copies y top 20 archivos >1 GB. No consulta el store ni el ledger. Cualquier
suposición de que “cierra el cuadre de costos” es falsa.

### 6.5 Lectura de totales

`get_session_usage_totals` (`:3012-3094`) recorre el árbol `parent_session_id` con `WITH RECURSIVE` y
suma, **por sesión**, `max(accumulated_X, SUM(ledger.X))` en lugar de sumar ambas fuentes: tolera una
sesión con ledger incompleto o con acumulados más altos que el ledger sin contar doble
(tests `:5851`, `:5884`, `:5924`).

---

## 7. Retención y poda

| pieza | qué hace | qué NO hace |
|---|---|---|
| `core/ops/prune-sessions.ps1` | informe por defecto; con `-Apply`: backup online `VACUUM INTO` a `C:\Users\Emiliano\backups\sessions` (retención `-KeepBackups 3`), borra mensajes de `sub_agent` viejos (lotes de 500, pausa 150 ms), borra sesiones `sub_agent` y sesiones vacías, llama a `truncate-tool-results.mjs`, `PRAGMA integrity_check` y **marca** `core\state\vacuum-pending` | no hace VACUUM con el serve vivo (`-VacuumNow` aborta si `Get-AegisLiveServe` responde); no toca `workspaces` |
| `core/ops/truncate-tool-results.mjs` | en mensajes `role in (user,tool,tool_result)` con `created_timestamp` > N días y `length(content_json) > --bytes` (default 32 768): conserva 4 096 B de cabeza + 1 024 B de cola de cada bloque `text`, descarta el `data` base64 de imágenes y marca `metadata.truncated = true`, `truncatedOriginalBytes`, `truncatedBytes`, `truncatedBlocks`, `truncatedAt` | nunca toca `role='assistant'` ni bloques que no sean `toolResponse`; no reescribe `messages_fts` (el trigger `…_au` sólo dispara en `UPDATE OF content_json` **sí**, así que el FTS sí se resincroniza en cada UPDATE: es costoso pero correcto) |
| `core/ops/wipe-sessions-store.ps1` | borrado total del store con backup previo | — |
| `core/ops/backfill-provider.mjs` | rellena `usage_ledger.provider` NULL usando evidencia intra-tabla (modelos con un solo proveedor atribuido), con `--apply` transaccional y SQL de vuelta atrás | deja intactos modelos sin evidencia, ambiguos o de proveedores `mock-*` |
| VACUUM | diferido: `prune-sessions.ps1` deja `core\state\vacuum-pending` y lo ejecuta el próximo swap con el serve detenido | no hay tarea programada que lo corra sola |

Estado hoy: `metadata.truncated=1` en **87** filas; `freelist_count = 0` (nada que recuperar con
VACUUM); 34 sesiones sin mensajes.

El peso no está en las sesiones vacías sino en los resultados de herramienta. Reparto de `messages`
con `role='user'` (que incluye todo `toolResponse`):

| bucket | filas | MB |
|---|---|---|
| < 32 KB | 73 930 | 152,0 |
| 32 KB – 256 KB | 945 | 78,2 |
| 256 KB – 1 MB | 234 | 141,3 |
| 1 MB – 4 MB | 15 | 20,2 |

Top absoluto: `messages.id=77631`, sesión `20261019_11`, `role=user`, **3 361 KB** en un solo mensaje.
Sesión más pesada: `20261019_11` (2 504 mensajes, 68,0 MB), seguida de `20261013_53` (6 678 / 41,05 MB)
y `20261017_57` (2 593 / 26,24 MB).

---

## 8. Estado medido del store (2026-10-29 12:47)

| métrica | valor |
|---|---|
| archivo | `sessions.db` **723 865 600 B (690,3 MB)**; `-wal` 6 188 272 B (5,9 MB); `-shm` 32 KB |
| páginas | `page_size` 4096; `page_count` 175 268 (≈684,6 MB al muestrear 12:45, antes de que la sesión en curso sumara ~6 MB); `freelist` 0 |
| sesiones | **498** (`acp` 361, `sub_agent` 87, `user` 46, `hidden` 4) |
| mensajes | **122 934** (`user` 74 583, `assistant` 48 360) |
| visibles | `v_visible_messages` = **82 909** (−40 025 ocultos por tipo o `userVisible=0`) |
| ledger | **46 172** filas, 20 días, 60 compactaciones |
| FTS | 122 934 filas (1:1) |
| workspaces | 10 |
| inventario de proveedores | 3 entradas / 303 modelos |
| `schema_version` | 17, 18, 19, 20, 21, 22 |

Ocupación por tabla/índice (`dbstat`):

| objeto | MB |
|---|---|
| `messages` | **596** |
| `messages_fts_content` | 44 |
| `messages_fts_data` | 24 |
| `idx_messages_message_id` | 6 |
| `usage_ledger` | 3 |
| `idx_messages_timestamp` | 3 |
| `idx_messages_session_created` | 3 |
| `idx_messages_session` | 2 |
| `sessions` | **1** |

Contenido: `SUM(LENGTH(content_json))` = **500,0 MB**; `metadata_json` = 30,4 MB; mensaje máximo 3 361 KB.

### Columnas vacías, mal pobladas o muertas

| dato | medición | lectura |
|---|---|---|
| `messages.tokens` | **0 filas no nulas** | columna nunca poblada; el conteo de tokens vive en `metadata_json.usage` y en el ledger |
| `sessions.schedule_id` | **0 filas** | las sesiones programadas no persisten el id |
| `sessions.description` | vestigial | resto de Goose, 0 uso |
| `sessions.container_id` | **0 filas** | feature `Container` sin uso real |
| `sessions.project_id` | 495/498 con valor, pero **es el `working_dir`**, no un id de proyecto; 2 filas con barras normales (`C:/Aegis-Proyects`), 3 vacías | agrupa por carpeta, no por proyecto lógico; `workspaces` ya lo normaliza por hash |
| `usage_ledger.provider` | **20 NULL** (todas de `mock-model`, fixture) | el backfill funcionó: el operador recordaba “provider vacío” y hoy ya no lo está |
| `sessions.provider_name` | **4 NULL** | sesiones de fixture |
| `usage_ledger.cost` | 407 NULL, 1 407 ceros | NULL = proveedor sin tarifa (no es gratis); cero = llamada sin tokens facturables o `antigravity` (304 filas, 0 USD) |
| `messages.message_id` | 4 NULL | filas legacy pre-migración 7 |
| `messages.metadata_json` | 4 NULL | idem |
| `workspaces.defaults` | 10/10 en `'{}'` y `pinned=0` | el registro existe, los defaults por workspace no se usan |
| `metadata.agentVisible=0` | 69 461 mensajes | más de la mitad del store está oculto al modelo por diseño |
| `metadata.userVisible=0` | 37 668 | lo que no ve el panel |

Ritmo de escritura (últimos 12 días, filas de ledger): 2026-10-13 → 3 440 … 2026-10-29 → 2 100.
En la ventana de 10 minutos de esta medición el archivo creció ~6 MB (717,6 → 723,9 MB), lo que da
una idea del orden de magnitud: ~35 MB/hora en una sesión de trabajo intensa con tool results.

---

## 9. Invariantes y trampas

1. **Un commit por mensaje.** `add_message` abre `BEGIN IMMEDIATE` para un solo `INSERT`. Correcto por
   durabilidad, caro en escritura: no existe batching de turno.
2. **`messages` no tiene cascada.** Borrar de `sessions` a mano deja huérfanos; sólo
   `delete_session` limpia en orden. El `prune-sessions.ps1` borra mensajes antes que sesiones por eso.
3. **`project_id` no es un id.** Es el `working_dir` (con prefijo verbatim pelado). La identidad real
   de una raíz es `workspaces.id = 'ws_' + sha256(normalize_root)[..8]`.
4. **`schema_version` no es acumulativa.** Un store creado por `create_schema` sólo registra la versión
   corriente: este store no tiene 1–16. Cualquier migración futura que “asuma” que las tablas de v10
   existen romperá.
5. **`threads`/`thread_messages` no existen en este store** y no hay código que las use: la migración
   10 es deuda pura.
6. **`get_session(id, true)` materializa la conversación entera.** Una sesión de 9 520 mensajes se lee
   completa antes de cada turno; el `mmap`+`cache_size` del pool es lo que evita que eso sea un desastre.
7. **`created_timestamp` es en segundos.** El desempate por `id` es obligatorio; `add_message` fuerza
   `created = max(msg.created, MAX(created_timestamp))` para no insertar un mensaje que ordenaría antes
   que lo ya guardado (`:2464-2473`).
8. **`ensure_session_row` es una red de seguridad, no una feature.** Si el store pierde una fila de
   `sessions` bajo un agente vivo (mantenimiento, crash), se recrea con `name='Recovered session'` y
   `working_dir = cwd del proceso`; el resto de metadatos se pierde hasta el próximo guardado.
9. **Visibilidad en dos flags.** `v_visible_messages` exige `userVisible != 0` **y** `session_type IN
   ('user','scheduled','acp')`. Los clientes que no usen la vista (el proxy Node la usa si existe,
   `search-index.mjs:55-58`) tienen que replicar la regla o muestran de más.
10. **El FTS indexa sólo texto.** `group_concat` de bloques `type='text'`: buscar dentro de un
    `toolResponse` no devuelve nada, aunque ocupe megabytes del store.
11. **Los tests dejan sesiones reales.** `--no-session` crea una sesión `Hidden` a propósito; hay 4
    sesiones `hidden` y 34 vacías, más 4 filas con `provider_name` NULL y mocks en el ledger. El store
    vivo está contaminado con fixtures.
12. **El id de sesión no se reusa.** `session_id_counters` existe porque derivar el índice de
    `MAX(SUBSTR(id,10))` reasignaba identidades de sesiones borradas el mismo día (comentario
    `:2075-2079`, test `:5996`).
13. **`record_usage_metrics` puede escribir dos filas** si detecta deriva (`carried_forward`); sumar
    `SUM(cost)` sin mirar `cost_source` infla el total en esos casos (hoy 0 USD, pero la mecánica está).
14. **`cost_source='estimated'` domina.** Cualquier cifra de gasto derivada del ledger es 95 % una
    estimación por tarifa, no una factura.

---

## 10. Local vs GitHub

Verificado con `git rev-list --left-right --count origin/main...HEAD` → **`0 139`** (0 atrás, 139
adelante). `git status` en el alcance: `session_manager.rs` y `pending_confirmations.rs` modificados
sin commitear (los cambios son tests de `canonical_working_dir`, no esquema). Comparación contra
`block/goose` (upstream real de este fork) leída con
`gh api repos/block/goose/contents/crates/goose/src/session/session_manager.rs`.

| pieza | existe sólo local | atrasado en `origin/main` (aegis-harness) | upstream `block/goose` |
|---|---|---|---|
| `session/workspaces.rs` | **sí** (archivo entero, sin equivalente) | no (ya está en los 139 commits) | **no existe** |
| migración 20 (`usage_ledger.provider`) | **sí** | no | no |
| migración 21 (`v_visible_messages`) | **sí** | no | no |
| migración 22 (`workspaces` + siembra) | **sí** | no | no |
| migración 18 (`messages_fts` + triggers) | **sí** | no | no |
| migración 19 (`goose_mode`→`aegis_mode`) | **sí** (rename del fork) | no | n/a (`goose_mode`) |
| PRAGMAs `cache_size`/`mmap_size`/`temp_store`/`synchronous` | **sí** (`:1227-1236`) | no | **no**: sólo `busy_timeout` + `journal_mode(Wal)` (líneas 1090-1091 del upstream) |
| `CURRENT_SCHEMA_VERSION` | **22** | no | **17** |
| `project_id` backfill en `run_migrations` | **sí** (`:1608-1627`) | no | no |
| migración 10 (`threads`) | igual | igual | **presente** (misma rama; dormida también allí) |
| `session_id_counters` | **sí** (se crea en `create_session`, no en el esquema) | no | no |
| `v_visible_messages`, `messages_fts`, `workspaces` en `create_schema` | **sí** | no | no |
| `aegis-sdk-types`, `aegis-sdk` | renombrados del fork | — | `goose-sdk-types`, `goose-sdk` (misma estructura: 5 archivos / 4 archivos) |
| `sources.rs`, `source_roots.rs` | idénticos en forma al fork upstream del que salieron | — | existen como `goose/src/sources.rs` |

Ninguna de las piezas de este documento está en `origin/main`: `origin/main` está 139 commits atrás
del local. Último commit local: `8d559d0b5 feat(acp): autonomía como único modo Aegis`.

---

## 11. Referencias web

| tema | URL literal |
|---|---|
| SQLite — Write-Ahead Logging (concurrencia, checkpointing, persistencia del modo WAL, “no se puede abrir una base WAL en sólo-lectura sin `-shm`”) | `https://www.sqlite.org/wal.html` |
| SQLite — `PRAGMA` (`journal_mode`, `synchronous`, `cache_size`, `mmap_size`, `temp_store`, `auto_vacuum`) | `https://www.sqlite.org/pragma.html` |
| SQLite — FTS5 (`tokenize='unicode61 remove_diacritics 2'`, `snippet`, `bm25`) | `https://www.sqlite.org/fts5.html` |
| SQLite — `VACUUM INTO` (backup online, usado por `prune-sessions.ps1`) | `https://www.sqlite.org/lang_vacuum.html` |
| better-sqlite3 — performance / WAL / `pragma()` | `https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md` |
| better-sqlite3 — API `Database` (`readonly`, `file:` URI) | `https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md` |
| Node `node:sqlite` (`DatabaseSync`, lo que usan los `.mjs` de `core/ops` y `web/tools`) | `https://nodejs.org/api/sqlite.html` |
| sqlx SQLite (`SqliteConnectOptions::pragma`, `begin_with("BEGIN IMMEDIATE")`) | `https://docs.rs/sqlx/latest/sqlx/sqlite/struct.SqliteConnectOptions.html` |

Nota: en este host **no** hay `better-sqlite3` instalado (`require.resolve` falla desde
`C:\Aegis-Proyects`); los scripts usan `node:sqlite` nativo (`DatabaseSync`), y `sqlite3.exe` viene de
scoop (`C:\Users\Emiliano\scoop\shims\sqlite3.exe`).

---

## 12. Huecos, riesgos y deuda técnica

| # | hallazgo | evidencia | impacto |
|---|---|---|---|
| 1 | `messages.tokens` nunca se escribe | `SUM(tokens IS NOT NULL) = 0` sobre 122 934 filas | cualquier consumidor que lea esa columna obtiene NULL siempre; el costo de tokens vive en `metadata.usage` y el ledger |
| 2 | `schema_version` arranca en 17 | 6 filas, 17–22 | migraciones futuras que asuman tablas de v≤16 fallan en este store (y en cualquier store nacido con `create_schema`) |
| 3 | `threads`/`thread_messages` (v10) no existen y no se usan | `sqlite_master` sin `%thread%`; 3 referencias en total, todas en `apply_migration` | código muerto en el motor; si alguien “activa” threads, no hay tablas |
| 4 | `project_id` = `working_dir` | 350 filas `C:\Aegis-Proyects`, 2 con `/`, 3 vacías | la agrupación por proyecto es en realidad por carpeta; `workspaces` es el reemplazo real pero nadie consume aún `workspaces.defaults` |
| 5 | Crecimiento sin techo: 690 MB y 596 MB son `messages` | `dbstat` | `prune-sessions.ps1` sólo borra sub_agent viejos y vacías; el volumen está en tool results de sesiones `acp` vivas. Sin VACUUM el archivo no se encoge (`auto_vacuum=0`) |
| 6 | El VACUUM es manual y diferido | `vacuum-pending` marcado por el prune, ejecutado “en el próximo swap” | si no hay swaps, el archivo nunca baja; `prune-sessions.ps1` no está en ninguna tarea programada verificada |
| 7 | `prices.json` desfasado | `gpt-6-sol` efectivo 0,752 USD/1M vs 0,6208 declarado | la UI que muestre `inputEffective` subestima el costo actual |
| 8 | 1 407 filas con `cost = 0` y 407 con `cost` NULL mezcladas con gasto real | `GROUP BY cost` | promedios y `SUM(cost)` sin filtrar por `cost_source`/`provider` engañan |
| 9 | Store contaminado con fixtures | 4 sesiones `hidden`, 20 filas de `mock-model`, `provider_name` mocks | métricas históricas incluyen ruido |
| 10 | 69 461 mensajes con `agentVisible=0` y 37 668 con `userVisible=0` | `metadata_json` | el store guarda dos historiales en la misma tabla; cualquier export/backup arrastra lo invisible |
| 11 | Tres lectores distintos del store con permisos distintos | `sqlite3` CLI (RW), `node:sqlite` sin `readOnly` en `core/ops/*.mjs`, `?mode=ro` en `analyze-sessions.py` y `search-index.mjs` | un script de mantenimiento mal invocado escribe sobre el store vivo sin gate |
| 12 | `dbstat` y `sqlite_stat1` no se regeneran solos | `sqlite_stat1` presente pero tras podas queda viejo | planes de consulta degradados tras prune sin `ANALYZE` |
| 13 | `wipe-sessions-store.ps1` (11 KB) sin revisar en detalle | fuera de tiempo | riesgo no evaluado |

---

## 13. No verificado

- El efecto real de `wipe-sessions-store.ps1` (no se leyó su cuerpo completo ni se ejecutó).
- Si existe una tarea programada que dispare `prune-sessions.ps1` o el swap con VACUUM pendiente
  (no se consultó el Programador de tareas).
- El `max_connections` efectivo del pool en runtime: se infiere el default de sqlx (10) porque
  `SqlitePoolOptions::new().connect_lazy_with(...)` no lo fija (`:1238`); no se midió con el serve vivo.
- El costo real facturado de `chatgpt_codex/gpt-6-sol`: el ledger da 2 110,88 USD, pero es
  `cost_source='provider_reported'` sobre el reporte del proveedor, no una factura contrastada.
- No se ejecutó `PRAGMA integrity_check` (bloquea el archivo varios minutos con 690 MB).
- No se comprobó si `origin/main` (139 commits atrás) compila con el esquema v22: sólo se comparó texto
  y conteos de versión.

# 08 — Recipes, Scheduler, Skills, Sources, Slash Commands y System Prompt

Alcance: `crates/aegis/src/{recipe,scheduler,skills,slash_commands,hints,prompts,config}` + `sources.rs` + `scheduler_trait.rs` + `recipe_deeplink.rs` + `agents/prompt_manager.rs` + `prompt_template.rs`.
Base local: rama `feat/antigravity-provider`, 139 commits adelante de `origin/main`, 0 atrás (`git rev-list --left-right --count origin/main...HEAD` → `0 139`). Todo lo de abajo se leyó en disco el 2026-10-29.

---

## 1. Mapa de piezas

| ruta:linea | qué hace | quién la llama |
|---|---|---|
| `recipe/mod.rs:42-87` | `struct Recipe` completa (12 campos) | todo el dominio |
| `recipe/mod.rs:323-341` | `from_content`: acepta doc plano o envuelto en `recipe:` | `from_file_path:318`, ACP, scheduler indirecto |
| `recipe/mod.rs:231-253` | `ensure_analyze_for_developer`: si hay `builtin developer` y no `analyze`, inyecta `Platform analyze` | `from_content:338` |
| `recipe/mod.rs:255-271` | `ensure_summon_for_subrecipes`: si hay `sub_recipes`, inyecta `Platform summon` | `from_content:339` |
| `recipe/mod.rs:274-290` | `check_for_security_warnings` (unicode tags en prompt/instructions/activities) | UI/ACP de import |
| `recipe/validate_recipe.rs:379` | `validate_recipe_for_scheduling` (parse + schema + JSON-Schema compilable) | `scheduler/full.rs:67` |
| `recipe/validate_recipe.rs:505,512` | `validate_recipe_template_from_content` / `validate_recipe_template` (minijinja + parámetros) | slash commands, build_recipe |
| `recipe/validate_recipe.rs:456` | `strip_unreferenced_parameters` | render de templates |
| `recipe/build_recipe/mod.rs:56-79` | `build_recipe_from_template`: valida, aplica parámetros, renderiza, resuelve sub-recipes | `scheduler/full.rs:848`, CLI/ACP |
| `recipe/build_recipe/mod.rs:81-99` | `apply_values_to_parameters` (+ variante sin expansión de `file`) | arriba |
| `recipe/local_recipes.rs:198` | escribe receta en la librería (`create_source_file`) | ACP `save_recipe` |
| `recipe/manifest.rs:21-37` | id corto = `DefaultHasher` de la ruta, 16 hex; `list_recipe_file_manifests` | UI de recetas |
| `recipe_deeplink.rs:13-17` | `encode`: JSON → base64 URL_SAFE_NO_PAD | ACP `encode_recipe` |
| `recipe_deeplink.rs:19-43` | `decode`: 3 formatos (URL-safe, base64 std, base64+urlencode) | ACP `decode_recipe` |
| `scheduler/common.rs:166-187` | `ScheduledJob` (11 campos persistidos) | scheduler + ACP |
| `scheduler/common.rs:94-105` | rutas: `<data>/schedule.json` y `<data>/scheduled_recipes/` | `Scheduler::new` |
| `scheduler/full.rs:106-133` | `Scheduler::new`: carga jobs, arranca `tokio_scheduler` | aegis-serve |
| `scheduler/full.rs:135-242` | `create_cron_task`: normaliza cron, arma el job async | add/update/load/sync |
| `scheduler/full.rs:262-337` | `add_scheduled_job_inner`: valida, copia receta, registra, persiste | ACP `create_schedule` |
| `scheduler/full.rs:404-487` | `load_jobs_from_storage` (al arrancar; limpia estado `running` huérfano) | `new` |
| `scheduler/full.rs:489-556` | `sync_from_storage` (multi-proceso: alta/baja por diff de ids) | `list_scheduled_jobs:559` |
| `scheduler/full.rs:825-1029` | `execute_job`: arma sesión + agente + receta y corre el turno | tick de cron y `run_now` |
| `scheduler_trait.rs:9-44` | contrato de 12 métodos | `Scheduler` (full.rs:1032-1108) |
| `skills/mod.rs:487-559` | `all_skill_dirs_with_config`: las 3+ raíces en orden de precedencia | `discover_skills` |
| `skills/mod.rs:728-753` | `discover_skills` con cache por `mtime+len` | `list_installed_skills:792`, `prompt_parts` |
| `skills/mod.rs:759-790` | `collect_sources`: filesystem gana sobre builtin (dedupe por nombre) | descubrimiento |
| `skills/mod.rs:241-286` | `loaded_skill_context[_with_args]`: arma el texto "# Loaded Skill" | `skills/client.rs`, slash de skill |
| `skills/client.rs:16,85-92` | extensión MCP `skills`, única tool `load_skill` | agente |
| `sources.rs:678` | `create_source` (skill/project/agent) | ACP `create_source` (`acp/server/sources.rs:9`) |
| `sources.rs:753` | `update_source_with_roots` (renombra dir si cambia el nombre, `:790-808`) | ACP `update_source` |
| `sources.rs:865-895` | `delete_source_with_roots` (`remove_dir_all` para skills) | ACP `delete_source` |
| `sources.rs:905,1029,1121` | list / export / import (colisión añade sufijo) | ACP |
| `slash_commands/slash_command.rs:22-52` | catálogo = builtin + recetas + skills, con precedencia | ACP `list_slash_commands` (`custom_dispatch.rs:779`) |
| `slash_commands/recipe_slash_command.rs:14-66` | mapping `/cmd → receta` en config (`slash_commands`) | UI + resolución |
| `slash_commands/skill_slash_command.rs:8-66` | cada skill es también `/skill` | ídem |
| `hints/load_hints.rs:373-440` | `load_hint_files`: global primero, local después, secciones separadas | `agents/prompt_manager.rs:92-102` |
| `hints/load_hints.rs:144-354` | `SubdirectoryHintTracker` (hints por subdirectorio, tope 32 KiB) | agente por turno |
| `hints/import_files.rs:9-17` | expansión de `@archivo` (`MAX_DEPTH 3`, 64 ops, 1 MiB) | `expand_hint_file` |
| `config/paths.rs:8-46` | resolución de config/data/state/agents con `AEGIS_PATH_ROOT` | todo |
| `agents/prompt_manager.rs:41-182` | `SystemPromptBuilder::build` | `build_system_prompt:201` |
| `prompt_template.rs:7-46` | plantillas embebidas + registro de 9 nombres | `render_template` |
| `prompt_template.rs:106-132` | override de usuario en `<config>/prompts/<name>` | ídem |

---

## 2. Flujos

### 2.1 Recipe — esquema y ejecución

Campos (`recipe/mod.rs:42-87`; obligatorios: `title`, `description`; `version` default `"1.0.0"` en `:28-30`):

| campo | tipo | default / nota |
|---|---|---|
| `version` | String | `"1.0.0"` (`:45`) |
| `title`, `description` | String | requeridos (serde falla si faltan) |
| `instructions`, `prompt` | Option<String> | **al menos uno** (`builder().build()` `:414-416`; el scheduler también lo exige en runtime, `full.rs:930-942`) |
| `extensions` | Option<Vec<ExtensionConfig>> | deserializer propio `recipe_extension_adapter` (`:60-65`); se le inyectan `analyze` y `summon` |
| `settings` | Option<Settings> | `aegis_provider`, `aegis_model`, `temperature: f32`, `max_turns: usize` (`:98-111`) |
| `activities` | Option<Vec<String>> | pills de UI |
| `author` | Option<{contact, metadata}> | `:89-96` |
| `parameters` | Option<Vec<RecipeParameter>> | `key`, `input_type` ∈ {string,number,boolean,date,file,select}, `requirement` ∈ {required,optional,user_prompt}, `description`, `default?`, `options?` (`:156-207`) |
| `response.json_schema` | Option<Value> | se **compila** al validar (`validate_recipe.rs:397-409`) |
| `sub_recipes` | Option<Vec<SubRecipe>> | `name`, `path`, `values` (map→string, `:131-154`), `sequential_when_repeated` (default `false`), `description?` |
| `retry` | Option<RetryConfig> | **declarativo**: el scheduler no lo usa (ver §6) |

Formatos: `yaml` y `json` (`recipe/mod.rs:26`); también acepta el documento envuelto `recipe:` de los bundles viejos (`:326-332`, test `:682-709`).

Validación en cadena (la que usa el scheduler): `read_validated_schedule_recipe` (`scheduler/full.rs:33-71`) →
`open_regular_schedule_recipe` (`common.rs:31-55`, rechaza no-fichero y en Unix abre con `O_NOFOLLOW`) →
tope `MAX_SCHEDULE_RECIPE_BYTES = 1 MiB` (`common.rs:11`) leído con `take(limite+1)` (defensa contra crecimiento entre `metadata` y `read`) →
`validate_recipe_for_scheduling` (`validate_recipe.rs:379-419`) → `SchedulerRecipeError::{GenericParse(RecipeFileFormat), InvalidSchema}` (`:37-58`).

Ejecución (`scheduler/full.rs:825-1029`), paso a paso:

1. Si `job.source` vacío, sale con `Ok` sin sesión (`:832-834`).
2. Lee la copia en `scheduled_recipes/` y resuelve el directorio con `job.recipe_base_dir` (el original), no con el de la copia (`:836-846`).
3. `build_recipe_from_template(contenido, recipe_dir, job.parameters, None)` (`:848-854`): minijinja con los parámetros del job; `file` se expande con `read_parameter_file_content`.
4. Crea `Agent::with_config(... AegisPlatform::AegisCli)` y **una sesión nueva** `SessionType::Scheduled`, `AegisMode::Auto`, nombre `"Scheduled job: <id>"` (`:871-880`).
5. Extensiones: `resolve_extensions_for_new_session(recipe.extensions)`; si la receta no declara ninguna, suma los MCP de plugins habilitados (`:882-890`).
6. Provider/modelo **de la config global** (`Config::global().get_aegis_provider()/get_aegis_model()`), no de `recipe.settings` (`:864-869`).
7. `update_aegis_mode(Auto)` (`:895-897`) → el job corre autónomo.
8. Guarda `current_session_id` en el job (`:899-903`) y luego `schedule_id` + `recipe` en la sesión (`:947-954`).
9. Prompt del turno = `recipe.prompt` si no está vacío, si no `recipe.instructions` (`:930-942`), como **un** `Message::user()`.
10. `agent.reply(msg, SessionConfig{schedule_id, max_turns: None}, Some(cancel_token))` y consume el stream (`:956-987`). Métricas OTel `aegis.session_starts`, `aegis.recipe_runs`, `aegis.session_completions` (`:913-1026`).

Interacción con el scheduler: la receta nunca se interpreta en el turno; se **copia** a `<data>/scheduled_recipes/<job_id>.<ext>` en el alta (`full.rs:298-320`) y se re-valida en ese momento. `schedule_recipe` (`:339-383`) es el atajo "esta receta está o no está programada": con `Some(cron)` actualiza (si ya existe job para esa ruta) o crea; con `None` borra el job (`remove_scheduled_job(id, false)`, sin borrar la receta).

### 2.2 Scheduler

Modelo de job = `ScheduledJob` (`common.rs:166-187`), persistido como **array JSON indentado** en `<data>/schedule.json` (`full.rs:73-85`); sin esquema ni versión.

Cron (`full.rs:142-160`): 5 campos → se antepone `0 ` y se loguea `warn` ("legacy 5-field cron"); 6 campos → tal cual; cualquier otra cuenta → `SchedulerError::CronParseError`. Es decir **6 campos = `seg min hora dom mes dow`** con segundos (el 5 campos se interpreta como "segundo 0"). Zona horaria: `Local` (`:162-164`). Dependencia: `tokio-cron-scheduler = "0.15"`, feature `scheduler` (`crates/aegis/Cargo.toml:107,173`).

Ciclo de un tick (`full.rs:164-240`): re-chequea `paused` → setea `last_run`, `currently_running`, `process_start_time` → persiste → registra `CancellationToken` en `running_tasks[job_id]` → `execute_job` → limpia estado → persiste → loguea ok/err.

Concurrencia: **no hay semáforo ni exclusión por job**. El tick no consulta `currently_running` antes de arrancar (solo `run_now:628-633` lo hace), y `running_tasks` está indexado por `job_id`, así que dos ejecuciones solapadas comparten clave y la segunda pisa el token de la primera. Una receta que tarde más que su intervalo se solapa consigo misma.

Fallo: se loguea (`tracing::error!`) y el estado se limpia; **no hay reintento** ni backoff, y el error no se persiste en el job.

Cancelación: `kill_running_job` (`:770-804`) exige `currently_running`, saca el token de `running_tasks`, `token.cancel()` y `clear_running_state`. El token llega hasta `agent.reply` (`:962-963`) y `run_now` lo reporta como `"Job '{}' was successfully cancelled"` (`:678-681`).

Operaciones bloqueadas con job corriendo: `pause_schedule` (`:696-700`) y `update_schedule` (`:732-736`); `update_schedule` con el mismo cron es no-op (`:738-740`) y si cambia, quita el `JobId` viejo y registra uno nuevo (`:748-763`).

Estado huérfano: al arrancar, cualquier `currently_running/current_session_id/process_start_time` se limpia y se re-persiste (`full.rs:435-448`, `clear_running_state` en `:87-95`). Un crash a mitad de job no deja el job "pegado en running".

Multi-proceso: `sync_from_storage` (`:489-556`) compara ids en disco contra memoria, **agrega y quita** (nunca actualiza cron de un job existente) y no toca los que están corriendo.

### 2.3 Skills

Raíces y precedencia, en este orden (`skills/mod.rs:487-559`), el primero gana (`seen`, `:759-790`):

| # | raíz | global | escribible |
|---|---|---|---|
| 1-3 | `<cwd>/.agents/skills`, `<cwd>/.aegis/skills`, `<cwd>/.claude/skills` | no | sí |
| 4 | skills de plugins de proyecto | no | **no** (read-only, `preserve_path`) |
| 5 | `~/.agents/skills` | sí | sí |
| 6 | **`Paths::config_dir()/skills`** = `...\state\config\skills` con `AEGIS_PATH_ROOT` | sí | sí |
| 7-8 | `~/.claude/skills`, `~/.config/agents/skills` | sí | sí |
| 9 | skills de plugins de usuario | sí | sí |
| 10 | built-ins embebidos (`builtin::get_all`, `:775-787`) | sí | — (`builtin://skills/<name>`) |

Frontmatter (`skills/mod.rs:147-159`): `name` (opcional), `description` (default `""`), `metadata` (map libre). Nombre válido: ≤64, solo `[a-z0-9-]`, sin guion inicial/final (`:197-223`). La descripción es lo único que el modelo ve antes de cargar; `metadata` es donde viven `arguments` y `argument-hint` (`:288-300`).

Decisión de cargar: no hay router. El system prompt lista nombre+descripción (vía slash/skills) y el modelo llama `load_skill` (`skills/client.rs:85-92`), que devuelve `loaded_skill_context` (`mod.rs:241-276`) con el cuerpo, el placeholder `{{AEGIS_DOCS_ROOT}}` resuelto solo para el builtin `aegis-doc-guide` (`:226-239`) y la lista de archivos de apoyo con ruta resuelta más `load_skill("<skill>/<archivo>")`.

Cache de descubrimiento (`mod.rs:34-145`): 8 entradas (`:42`), TTL 5 s (`:47`), clave `(working_dir, fingerprint de plugins)` (`:49-63`) y sello `mtime+len` de cada raíz, de cada `SKILL.md` y del padre de cada skill. El comentario `:107-110` documenta el motivo: en Windows editar un archivo no mueve el mtime del directorio.

CRUD — vive en `sources.rs`, no en la tool: `create_source:678`, `update_source_with_roots:753`, `delete_source_with_roots:865`, `list_sources_with_roots:905`, `export_source_with_roots:1029`, `import_sources:1121`. Bases de escritura: `global → ~/.agents/skills`, `project → <project>/.agents/skills` (`skills/mod.rs:162-195`); scope por `SourceScope::{Global, ProjectDir, ProjectId}` (`acp/server/sources.rs:86-102`). `parse_frontmatter` (`sources.rs:20-33`) parte el texto por `---` y exige ≥3 partes; el body se recompone con `parts[2..].join("---")`.

Datos vivos (2026-10-29): `state\config\skills` = **41** directorios con `SKILL.md`, **10** con archivos de apoyo. Ejemplo de frontmatter real (`aegis-infra-map`): `name`, `description`, `version: 1.0.0`, `platforms: [windows]`.

### 2.4 Hints y system prompt

Orden de armado (`agents/prompt_manager.rs:114-182`):

1. Extensiones ordenadas por nombre (comentario `:117`: estabilidad para cache de prompt multi-sesión) y sanitizadas (`:120-126`).
2. Contexto → plantilla `system.md` embebida (`:132-151`). Si la sesión trae `system_prompt_override`, se renderiza **esa** en lugar de `system.md` (`:143-148`), con fallback a la línea `"You are a general-purpose AI agent called aegis, created by Block"` (`:149-151`).
3. Extras en `IndexMap` (orden estable): `session.system_prompt_extras` (`:57-58`), luego `hints` (`:153-158`) y, en modo Chat, `chat_mode` (`:160-166`).
4. Concatenación final `"{base}\n\n# Additional Instructions:\n\n{extras}"` (`:176-180`).
5. Fecha fijada a la hora (`Utc::now().format("%Y-%m-%d %H:00 %:z")`, `:190`) para no romper el prefijo cacheado.

Qué entra como instrucción vs contexto: los hints entran como **instruction** (bloque `# Additional Instructions` del system prompt). Además hay hints por **subdirectorio** que viajan por turno: `SubdirectoryHintTracker` (`hints/load_hints.rs:144-354`) se alimenta de los argumentos de tool (`path` y tokens de `command` con separador o punto, `:166-194`), solo acepta directorios dentro del `working_dir` (`:214`), deduplica archivos ya emitidos (`loaded_files`) y corta a **32 KiB** por request (`MAX_SUBDIR_HINT_BYTES`, `:142`). El consumidor exacto de `load_new_hints` en el bucle del agente no lo abrí en esta pasada (ver §7).

Composición de los archivos de hint (`load_hints.rs:373-440`):

| orden | fuente | condición |
|---|---|---|
| 1 | `<config>/<name>` para cada `CONTEXT_FILE_NAMES` (default `.aegishints`, `AGENTS.md`, `:125-136`) | `is_file()` |
| 2 | `<agents_home>/AGENTS.md` (`:385-390`) | solo si `AGENTS.md` está en la lista |
| 3 | `<dir>/<name>` para cada directorio local desde cwd hasta el git root | `is_file()` |

Globales → `### Global Hints`, locales → `### Project Hints` (`:423-437`). Los globales se expanden con un gitignore propio y **no** se filtran por el gitignore del proyecto (test `:541`).

El "dedupe" medido (150 KB → 50 KB) es una **suma de tres presupuestos**, no un deduplicador de texto:

| mecanismo | código | cifra |
|---|---|---|
| tope de hints por subdirectorio | `load_hints.rs:138-142` | 32.768 B por request (antes: 108 KB / 27k tokens con 13 dirs, según el comentario) |
| cache de expansión `@archivo` por sello `mtime+len` | `load_hints.rs:20,35`; `import_files.rs:541-586` | 64 entradas |
| cache de git root | `load_hints.rs:96-120` | TTL 5 s, 16 entradas |
| presupuesto de expansión | `import_files.rs:14-17` | profundidad 3, 64 operaciones, 1 MiB de salida, 4 KiB por `.git` pointer |
| cache de descubrimiento de skills | `skills/mod.rs:42,47` | 8 entradas, TTL 5 s |
| dedupe real de hints repetidos | `load_hints.rs:146-152` (`loaded_dirs`, `loaded_files`) | un archivo por request |

No encontré en el código una función que "mida" 150 KB o 50 KB y lo registre; las cifras de los documentos son del comentario y de la sesión de medición, no de instrumentación permanente.

### 2.5 Slash commands

Catálogo ACP: `list_acp_commands` (`slash_commands/slash_command.rs:22-29`) = builtin + recetas + skills, fusionados por `merge_command_sources` (`:31-52`) con precedencia **builtin > recipe > skill** y dedupe por nombre normalizado (`util.rs:1-3`: quita `/` inicial y pasa a minúsculas).

| fuente | dónde se define | cómo se expande |
|---|---|---|
| builtin | `crate::agents::execute_commands::list_commands()` (`slash_command.rs:9`) | `prompts, prompt, compact, clear, skills, doctor, goal, grind, status` (test `:64-76`) |
| receta | config `slash_commands` = `[{command, recipe_path}]` (`recipe_slash_command.rs:14-20`); se setea con `set_recipe_slash_command:40-57` desde ACP `set_recipe_slash_command` | `get_recipe_for_command:59-66` → `resolve_command:149-...` valida la plantilla, parsea posicionales y `--flags`, devuelve `(Recipe, prompt)` |
| skill | una por cada skill instalada (`skill_slash_command.rs:8-10`) | `resolve_command:44-66` → `loaded_skill_context_with_args` (sustituye `$ARGUMENTS`/argumentos nombrados, `skills/arguments.rs`) |

`input_hint` se deriva de los parámetros: obligatorios como `<key>`, opcionales como `[--key <key>]` (`recipe_slash_command.rs:116-143`).

Live: `state\config\config.yaml` **no** tiene `slash_commands` ni `CONTEXT_FILE_NAMES` (grep sin coincidencias), así que hoy manda el default.

### 2.6 Config y paths

`Paths::get_dir` (`config/paths.rs:8-38`): si `AEGIS_PATH_ROOT` está seteado **y es absoluto** (`:40-46`; relativo o vacío se ignora, test `:104-119`) → `config/`, `data/`, `state/`, `.agents/plugins`, `.agents/agents`, `.agents`. Si no → estrategia `etcetera` con `Aegis/aegis` (`:22-37`).
Con el store vivo: `AEGIS_PATH_ROOT=C:\Aegis-Proyects\state` ⇒ `config_dir = state\config`, `data_dir = state\data`, `agents_home = state\.agents` (de ahí `state\.agents\AGENTS.md` como hint global). Lo que el operador ve con `aegis-serve --print-paths` es exactamente esto.

---

## 3. Invariantes y trampas

1. `title` y `description` son obligatorios, y `prompt | instructions` también, pero **en dos lugares distintos**: serde (title/description) y `RecipeBuilder::build` (`recipe/mod.rs:410-416`) / runtime del scheduler (`full.rs:930-942`). Un YAML con `title`/`description` y sin prompt parsea bien y falla recién al ejecutar o al agendar.
2. Cargar una receta **muta sus extensiones**: `analyze` si hay `developer` builtin y `summon` si hay `sub_recipes`. Comparar "extensiones de la receta" contra el YAML del disco da diferencias que no están escritas.
3. `recipe.settings.aegis_provider/model/temperature/max_turns` **se ignora** en el camino del scheduler (`full.rs:864-869` usa config global; `SessionConfig.max_turns: None` en `:959`). Solo lo consumen los caminos interactivos.
4. `recipe.retry` existe en el esquema y **no se usa** en `execute_job`.
5. Los jobs corren con `AegisMode::Auto` (`full.rs:878,896`): sin aprobación interactiva. Es el punto donde una receta copiada desde un deeplink se ejecuta sola.
6. El cron de 6 campos lleva **segundos** primero; un cron de 5 campos se convierte silenciosamente (solo `warn`), así que `*/5 * * * *` pasa a "cada 5 minutos con segundo 0", no "cada 5 segundos".
7. `currently_running` **no** impide el solapamiento de ticks; solo bloquea acciones humanas (`pause`, `update`, `run_now`, `kill`).
8. `schedule.json` corrupto o vacío ⇒ lista vacía **sin error visible** (`full.rs:419-433`): los jobs "desaparecen".
9. Alta de job copia la receta a `scheduled_recipes/` con permisos `0600` y `set_len(0)` previo (`common.rs:58-92`); si la escritura falla, borra el destino (`:86-89`). Editar la receta original **no** cambia el job; hay que re-agendar.
10. `parse_frontmatter` (`sources.rs:20-33`) es un `split("---")`: un frontmatter con `---` dentro de un valor (o un body que empieza con `---`) recompone el body pero puede romper el YAML.
11. CRUD global de skills escribe en `~/.agents/skills`, mientras que las 41 skills vivas están en `state\config\skills` (raíz #6). Crear una skill desde la UI **no** la deja donde vive el resto, y `discover_skills` la va a encontrar (raíz #5) pero el store queda partido en dos raíces.
12. El placeholder `{{AEGIS_DOCS_ROOT}}` solo se resuelve para el builtin `aegis-doc-guide` (`mod.rs:233-239`); una copia local de esa skill queda con el placeholder crudo.
13. Hints: el `AGENTS.md` global se expande sin el gitignore del proyecto (a propósito, test `:541`) ⇒ todo lo que tenga `@archivo` ahí entra en **cada** system prompt de **cada** proyecto.
14. El cache de descubrimiento de skills depende de sellos `mtime+len`; el propio código documenta que en Windows el mtime del directorio no se mueve al editar un archivo (`mod.rs:107-110`), por eso sella también `SKILL.md`.
15. Hay un **override vivo** de plantilla: `state\config\prompts\system.md` (con un `.bak-20261020-0721` al lado) pisa la `system.md` embebida en `prompt_template.rs:114-129`. El binario puede no estar usando el texto del repo.
16. `prompt_template.rs:9-46` registra `compaction.md` y `compaction_summary.md`, que no están en `src/prompts/`: salen de `aegis_context_management::templates` (`:63`). Buscarlos en `src/prompts` es un callejón.
17. La fecha del system prompt se congela a la hora (`prompt_manager.rs:190`): dentro de una hora, el prompt es idéntico byte a byte (bueno para cache, malo si algo depende del minuto).
18. Deeplink: `decode` no valida tamaño ni `version` (`recipe_deeplink.rs:19-43`); un link es una receta arbitraria.

---

## 4. Local vs GitHub

| pieza | existe solo local | atrasado en `origin/main` | upstream goose puro |
|---|---|---|---|
| `crates/aegis/src/recipe/*` (10 archivos) | — | sí: `origin/main` todavía tiene `crates/goose/src/recipe/*` (pre-rebrand) | sí, mismos 10 archivos en `crates/goose/src/recipe` |
| `scheduler/{mod,common,full}.rs` | — | sí (path viejo) | sí |
| `skills/{mod,client,arguments,supporting_files,builtin,builtins/*}` | **cache de descubrimiento** (`DISCOVERY_CACHE`, TTL, sellos, fingerprint de plugins) y raíces extra; upstream no tiene `DISCOVERY_CACHE` (grep sobre el raw de `crates/goose/src/skills/mod.rs`) | sí | sí (sin el cache) |
| `sources.rs` | — | sí (path) | **idéntico en tamaño**: 74.049 B upstream vs 74.049 B local |
| `slash_commands/*` (5 archivos) | — | sí (path) | sí |
| `hints/*` | `MAX_SUBDIR_HINT_BYTES` (32 KiB), `GIT_ROOT_CACHE_TTL`, cache de expansión; no aparecen en el raw upstream de `load_hints.rs` | sí | sí (sin esos topes) |
| `prompts/*.md` + `prompt_template.rs` | `state\config\prompts\system.md` (override fuera del repo) | sí | sí |
| `agents/prompt_manager.rs` | — | sí | sí |

Diferencias de tamaño (bytes, `gh api .../contents` vs disco) como proxy de divergencia:

| archivo | upstream `block/goose` | local |
|---|---|---|
| `scheduler/full.rs` | 64.610 | 56.098 |
| `skills/mod.rs` | 37.746 | 50.407 |
| `sources.rs` | 74.049 | 74.049 |
| `hints/load_hints.rs` | 36.137 | 45.525 |
| `slash_commands/recipe_slash_command.rs` | 21.387 | 21.846 |
| `recipe/mod.rs` | 26.506 | 27.336 |
| `agents/prompt_manager.rs` | 17.641 | 17.603 |

Lectura: el dominio **no es propio del fork** — recipes, scheduler, hints, skills, sources y slash commands existen en `block/goose` con la misma estructura de archivos. Lo propio de este fork son los topes y caches (`hints`, `skills`), el renombre de paths y los commits `f753abcc9 feat(hints,skills): caches de lo que corria en cada inferencia`, `7f394c468 feat(rebrand)`, `72c26f985 chore(rutas)`. `origin/main` (mi repo) está **139 commits atrás** y en la nomenclatura `crates/goose`, así que un `git diff origin/main -- crates/aegis/...` marca el dominio entero como "nuevo" sin decir nada útil.

Estado git del dominio (`git log -- <paths>`): los últimos toques son `f753abcc9` (caches), `47b4e76b3` (quita referencias al upstream), `06017d466` (fmt), `bc0964fc8` (elimina posthog/telemetry), `7f394c468` (rebrand).

---

## 5. Referencias web

| tema | URL | estado |
|---|---|---|
| crate del scheduler y su API (`JobScheduler`, `Job::new_async_tz`) | https://docs.rs/tokio-cron-scheduler/latest/tokio_cron_scheduler/ | verificado (versión vigente 0.15.1, depende de `croner ^3.0.0`) |
| repositorio del crate | https://github.com/mvniekerk/tokio-cron-scheduler | no abierto en esta pasada |
| upstream del harness | https://github.com/block/goose | verificado vía `gh api` (árbol `crates/goose/src`) |
| directorio del dominio en upstream | https://github.com/block/goose/tree/main/crates/goose/src | verificado vía API, no por HTML |
| spec de cron de 6 campos (segundos primero) | https://crontab.guru/ | **no verificado**: la semántica de 6 campos se dedujo del código (`full.rs:142-160` antepone `0 `) y del `docs.rs` del crate, no de una spec citada |
| docs públicas de goose sobre recipes | https://block.github.io/goose/docs/guides/recipes/session-recipes | **404** el 2026-10-29; no encontré la URL vigente en esta pasada |
| spec de frontmatter de skills que cita el código | https://agentskills.io/specification#frontmatter | citada en `skills/mod.rs:153-156`; **no abierta** |

---

## 6. Huecos, riesgos y deuda técnica (con evidencia)

| # | riesgo | evidencia | impacto |
|---|---|---|---|
| 1 | CRUD de skills y skills vivas en raíces distintas | `skills/mod.rs:162-164` (global = `~/.agents/skills`) vs 41 skills en `state\config\skills` (raíz #6, `:526-531`) | editar desde UI puede crear un duplicado que gana por precedencia, o no tocar la que el agente usa |
| 2 | Solapamiento de jobs del mismo id | `full.rs:186-204` (setea estado sin chequear) + `running_tasks` por `job_id` (`:28`) | dos turnos a la vez, `current_session_id` se pisa, `kill` cancela uno solo |
| 3 | `recipe.retry` y `settings.*` ignorados por el scheduler | `full.rs:864-869`, `:956-960` | el YAML promete comportamiento que el camino automático no cumple |
| 4 | `schedule.json` sin esquema + parse silencioso a lista vacía | `full.rs:423-433` | pérdida silenciosa de programaciones |
| 5 | `sync_from_storage` no propaga cambios de cron entre procesos | `full.rs:508-555` (solo add/remove) | dos `aegis-serve` sobre el mismo store divergen hasta el siguiente alta/baja |
| 6 | Receta copiada ≠ receta editada | `full.rs:298-320` | editar el original no cambia el job; no hay comando de "resync" |
| 7 | `AegisMode::Auto` en jobs sin gate | `full.rs:878,896` | una receta agendada ejecuta tools sin aprobación |
| 8 | `parse_frontmatter` por `split("---")` | `sources.rs:23-32` | frontmatter/body con `---` rompe o trunca metadatos |
| 9 | Override de plantilla vivo fuera del repo | `state\config\prompts\system.md` + `.bak-20261020-0721`; `prompt_template.rs:114-129` | el system prompt del binario puede no ser el del código; no hay test que cubra el override |
| 10 | Cifras de dedupe de hints sin instrumentación | comentarios `load_hints.rs:138-141`; no hay métrica OTel de tamaño de hints | "150 KB → 50 KB" no es reproducible sin volver a medir a mano |
| 11 | Consumidor por-turno de `load_new_hints` no verificado | `hints/load_hints.rs:196`; `agents/prompt_manager.rs:201-207` recibe `prompt_parts` | no puedo afirmar en qué mensaje exacto entra el hint de subdirectorio (¿system o turn-context?) |
| 12 | Deeplink sin límites ni versión | `recipe_deeplink.rs:19-43` | input no confiable de tamaño arbitrario |
| 13 | `.bak` de plantilla dentro de `state\config\prompts` | listado de disco | deuda menor, pero `list_templates` no lo lista y confunde el diff |

## 7. No verificado

- El sitio exacto donde `SubdirectoryHintTracker::load_new_hints` se inyecta en el turno (archivo/línea del agente). Leí `prompt_manager` y el tracker, no `agents/agent.rs`.
- La versión exacta de `croner` que resuelve `Cargo.lock` para `tokio-cron-scheduler 0.15` y si su parser acepta alias (`@daily`, `L`, `#`). El código solo garantiza 5 o 6 campos.
- Que los 41 skills del store pasen por `validate_skill_name`: varios tienen nombres válidos, pero no ejecuté la validación.
- El contenido de `src/.github/recipes/code-review.yaml` y `core/ops/{canary,medicion-turno}.yaml` más allá de su existencia y tamaño (1 archivo, 360 B y 191 B respectivamente).
- Nada de esto se ejecutó: no hay tests corridos, ni job agendado, ni `load_skill` invocado. Todo es lectura estática de código y de disco.

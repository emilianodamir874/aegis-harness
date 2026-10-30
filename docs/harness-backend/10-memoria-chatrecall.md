# 10 — Memoria durable y chat-recall

Dos subsistemas distintos que el operador percibe como uno:

| subsistema | que resuelve | donde vive el estado |
|---|---|---|
| **memoria del operador** (`memory`) | hechos durables entre sesiones: preferencias, decisiones, datos de entorno | `C:\Aegis-Proyects\state\data\memory\facts.jsonl` (JSONL, una linea por hecho) |
| **chat-recall** (`chatrecall`) | recuperar lo que la compactacion tapo, o buscar en sesiones viejas | `state\data\sessions\sessions.db` (tabla `messages` + indice FTS5 `messages_fts`) |

Medido hoy (2026-10-29 12:45, read-only):

| dato | valor |
|---|---|
| `facts.jsonl` | 118.319 B, 245 hechos, ultimo id `F-0246` |
| estados | 171 `candidate`, 44 `confirmed`, 30 `rejected`, **0 `stale`** |
| origen | 193 `inferred`, 52 `declared`; 15 `pinned` |
| texto total | 33.256 caracteres (media 136 por hecho) |
| categorias | fact 80, preference 79, decision 46, goal 37, style 3 |
| sesiones distintas citadas en `evidence` | 51 |
| digest real de este turno | 44 elegibles → **16 hechos, 3.759 de 4.000 chars** (`~950–1.050 tok`) |
| sessions.db | 696,3 MB; 124.390 mensajes; 498 sesiones; `messages_fts` presente con 124.390 filas |

---

## 1. Mapa de piezas

### 1.1 Motor de memoria

| ruta:linea | que hace | quien la llama |
|---|---|---|
| `src\crates\aegis\src\lib.rs:32` | `pub mod memory;` (sin feature gate: siempre compila) | — |
| `src\crates\aegis\src\memory\mod.rs:1-4` | declara `extraction` y `store` | — |
| `...\memory\store.rs:26` | `CANDIDATE_CONFIDENCE_CEILING = 0.6` | `append_candidate` |
| `...\memory\store.rs:29` | `STALE_AFTER_DAYS = 90` | `mark_stale` |
| `...\memory\store.rs:32-33` | `DIGEST_MAX_CHARS = 4_000`, `DIGEST_MAX_FACTS = 24` | `digest` |
| `...\memory\store.rs:35-54` | `enum Status { Candidate, Confirmed(default), Rejected, Stale }` | todo el store |
| `...\memory\store.rs:56-66` | `enum Source { Declared(default), Inferred, Imported }` | idem |
| `...\memory\store.rs:68-95` | struct `Fact` (esquema completo, ver §2) | idem |
| `...\memory\store.rs:103-109` | `is_digest_eligible()`: `confirmed` sí; `candidate` sólo si `confidence >= 0.85` | `digest` |
| `...\memory\store.rs:136-138` | `store_path()` = `Paths::in_data_dir("memory")\facts.jsonl` (resuelve por `AEGIS_PATH_ROOT`, `config\paths.rs:41` y `:84`) | tools, extractor, CLI, web panel |
| `...\memory\store.rs:140-142` | `report_path()` = `...\memory\memory-report.md` | `consolidate`, `write_report` |
| `...\memory\store.rs:150-181` | `normalize()`: minusculas + pliega acentos (`ñ→n`, `á→a`) + colapsa no-alfanumericos | dedupe/merge |
| `...\memory\store.rs:195-213` | `write_to()`: escribe `*.jsonl.tmp` y `rename`; ordena por id (bytes deterministas) | todas las escrituras |
| `...\memory\store.rs:215-223` | `next_id()`: `F-{max+1:04}` | altas |
| `...\memory\store.rs:226-281` | `upsert_declared()`: si existe el texto normalizado lo **actualiza y lo devuelve a `confirmed`** + segunda evidencia `"<sess>: declarado"` | tool `memory_write` |
| `...\memory\store.rs:285-339` | `append_candidate()`: cap 0.6, `+0.1` por repeticion sin pasar el techo, `rejected` se ignora, nunca pisa un confirmado | extractor |
| `...\memory\store.rs:342-352` | `reject()`: baja logica, deja la fila | tool `memory_forget` |
| `...\memory\store.rs:355-365` | `confirm()` | tool `memory_confirm`, panel web |
| `...\memory\store.rs:368-388` | `promote_candidates()`: `>= 2` sesiones distintas en `evidence` **o** `pinned` → `confirmed`, `confidence = max(0.7)` | `consolidate` |
| `...\memory\store.rs:390-418` | `mark_stale()`: sólo `confirmed` sin pin y con `confidence < 0.9`, `>= 90` dias desde `last_seen` | `consolidate` |
| `...\memory\store.rs:422-468` | `merge_duplicates()`: agrupa por `normalize(text)`, se queda el id mas bajo, une tags/evidence | `consolidate` |
| `...\memory\store.rs:472-516` | `consolidate()`: merge → promote → stale; `changed=false` si los bytes no cambian (idempotente) | tool `memory_consolidate`, `--memory-consolidate`, panel |
| `...\memory\store.rs:542-563` | `search()`: todas las palabras por substring en texto+kind+tags; excluye `rejected` | tool `memory_search` |
| `...\memory\store.rs:567-607` | `digest()`: arma `## Memoria del operador`; orden `pinned` primero, despues `last_seen` desc; corta por 24 hechos y 4.000 chars | `MemoryClient::get_moim` |
| `...\memory\store.rs:610-626` | `render_line()`: linea para listados (`(kind, conf 0.xx, estado, pinned, evidencia N)`) | `memory_list`/`memory_search` |
| `...\memory\extraction.rs:23-28` | `MIN_ASSISTANT_CHARS = 200`, `MAX_FACTS_PER_TURN = 3`, `MAX_USER_CHARS = 4_000`, `MAX_ASSISTANT_CHARS = 6_000`, `SEEN_CAPACITY = 256` | `run_turn` |
| `...\memory\extraction.rs:30-45` | `SYSTEM_PROMPT` del extractor (JSON estricto, `confidence` acotada a 0…0.6) | `run_turn` |
| `...\memory\extraction.rs:69-73` | `enabled()`: knob `AEGIS_MEMORY_EXTRACTION`, **default true** | `agent.rs:404` |
| `...\memory\extraction.rs:75-81` | `AEGIS_MEMORY_EXTRACT_MODEL` | `pick_extractor` |
| `...\memory\extraction.rs:83-95` | `already_extracted()`: dedupe por `session:message_id` en un `VecDeque` de 256, **en proceso** | `run_turn` |
| `...\memory\extraction.rs:103-148` | `last_turn_text()`: ultimo par `user`→`assistant` visible, `marker = message.id` o `len:N` | `run_turn` |
| `...\memory\extraction.rs:162-193` | `apply()`: parsea el JSON (tolera prosa alrededor), `nothing_new`, tope 3 hechos, kind default `fact` | `run_turn` |
| `...\memory\extraction.rs:196-267` | `run_turn()`: gate de 200 chars, `complete_one_shot`, **anota el costo en `usage_ledger` con el provider que respondio** | `spawn` |
| `...\memory\extraction.rs:277-299` | `extractor_choice()` + `extractor_provider()`: `AEGIS_MEMORY_EXTRACT_PROVIDER` + `_MODEL`, ambos obligatorios | `pick_extractor` |
| `...\memory\extraction.rs:329-353` | `spawn()`: `tokio::spawn`, recarga la sesion (`get_session(id, true)`) y corre `run_turn`; los errores solo se loguean | `agent.rs:413` |
| `src\crates\aegis\src\agents\agent.rs:403-414` | `spawn_post_turn_memory_extraction()` | `agent.rs:966` y `:978` (turno cerrado sin confirmaciones pendientes, o cancelado) |

### 1.2 Tools `memory_*` y extension

| ruta:linea | que hace | quien la llama |
|---|---|---|
| `src\crates\aegis\src\agents\platform_extensions\memory.rs:22-28` | nombres: `memory_write`, `memory_search`, `memory_list`, `memory_forget`, `memory_confirm`, `memory_consolidate` | — |
| `memory.rs:87-116` | `MemoryClient::new` + instrucciones que el modelo ve | `extension_manager` |
| `memory.rs:142-212` | `get_tools()` con schemas `schemars` y `ToolAnnotations` (write/forget/confirm/consolidate = `read_only=false`) | `list_tools` |
| `memory.rs:225-277` | `memory_write`: default `kind=fact`, `confidence=0.8`, `pinned=false`; responde `Guardado|Actualizado F-xxxx (N hechos en total)` | `call_tool` |
| `memory.rs:279-299` | `memory_search`: `limit` clamp 1..50, default 10 | idem |
| `memory.rs:301-334` | `memory_list`: `limit` clamp 1..100, default 20; filtra kind/status; orden `updated` desc | idem |
| `memory.rs:336-368` | `memory_forget` / `memory_confirm` por id | idem |
| `memory.rs:370-388` | `memory_consolidate` (el parametro `report` del schema **no se usa**) | idem |
| `memory.rs:438-440` | `get_moim()` → `store::digest(&store::read_from(&store::store_path()))` | `ExtensionLease::moim` |
| `src\crates\aegis\src\agents\platform_extensions\mod.rs:211-223` | registro: `default_enabled: true`, `unprefixed_tools: false` (por eso el modelo ve `memory__memory_write`), `hidden: false` | `PLATFORM_EXTENSIONS` |
| `state\config\config.yaml:38-44` | extension `memory` habilitada en el perfil vivo | motor |

### 1.3 Inyeccion al prompt (MOIM / turn-context)

| ruta:linea | que hace |
|---|---|
| `src\crates\aegis\src\agents\extension_manager\lease.rs:557-571` | `moim()`: recorre **solo extensiones de plataforma** (`is_platform`) y junta cada `get_moim()` |
| `src\crates\aegis\src\agents\moim.rs:87-91` | `parts = lease.moim()` + `compaction` + `turn-budget` |
| `moim.rs:95-110` | `turn_context_event()`: arma un **`Message::user()`** con `MessageMetadata::agent_only().with_turn_context()` — no es un bloque de system prompt |
| `moim.rs:116-137` | `compose_moim()`: `<turn-context>` → `<current-time>` → `<working-directory>` → cada parte separada por linea en blanco → `</turn-context>` |
| `moim.rs:6` y `:112-114` | `MIN_CONTEXT_FOR_MOIM = 32_000`: con ventana menor a 32k **no se inyecta nada** (ni memoria) |
| `moim.rs:8-23` | texto que el modelo ve una sola vez en el system prompt explicando que es `<turn-context>` |

### 1.4 chat-recall

| ruta:linea | que hace | quien la llama |
|---|---|---|
| `src\crates\aegis\Cargo.toml:102,106` | feature `chat-recall` (en el set default del crate) | — |
| `src\crates\aegis-server\Cargo.toml:24,31` | `chat-recall = ["aegis/chat-recall"]` en el default del binario | — |
| `platform_extensions\mod.rs:5-6` | `#[cfg(feature = "chat-recall")] pub mod chatrecall;` | — |
| `platform_extensions\mod.rs:95-110` | registro `chatrecall`, `default_enabled: true`, `unprefixed_tools: false` → tool `chatrecall__chatrecall` | `PLATFORM_EXTENSIONS` |
| `...\chatrecall.rs:19` | `EXTENSION_NAME = "chatrecall"` | — |
| `...\chatrecall.rs:22-50` | parametros: `query`, `session_id`, `limit`, `after_date`, `before_date`, `current_session`, `message_id`, `offset`, `max_chars` | schema |
| `...\chatrecall.rs:57-62` | salida con `audience=[Assistant]`: el resultado es **agent-only**, el usuario no lo ve | respuestas |
| `...\chatrecall.rs:131-141` | `search_session_types()`: sesion `Acp` busca solo `Acp`; el resto busca `User`+`Scheduled` (excluye `Hidden`) | `handle_chatrecall` |
| `...\chatrecall.rs:155-187` | rama `current_session` / `message_id`: prohibe `session_id`, carga la sesion completa (`get_session(id, true)`) y delega en `current_history::retrieve` | tool |
| `...\chatrecall.rs:194-229` | modo LOAD (`session_id`): primeras 3 + ultimas 3 (`format_agent_visible_excerpt`, `:64-106`) | tool |
| `...\chatrecall.rs:230-320` | modo SEARCH: `search_chat_history(query, limit≤50, fechas, exclude=sesion actual, tipos)` | tool |
| `...\chatrecall\current_history.rs:4-18` | `searchable_messages()`: excluye `<turn-context>`, exige `user_visible || is_tool_response`, proyecta a `agent_visible_content()` (asi entran los originales que la compactacion oculto al modelo) | `retrieve` |
| `...\current_history.rs:24-82` | `retrieve()`: `message_id` → pagina por `offset`/`max_chars` (clamp 1..12.000, `:32`); `query` → **AND por substring** sobre todo el texto (`:53-69`), mas nuevos primero (`:70`), `limit` clamp 1..20 (`:72`) | `chatrecall.rs:169` |
| `src\crates\aegis\src\session\chat_history_search.rs:81-97` | `execute()`: keywords → `fts_query()` → `fetch_rows` → agrupa → totales → resultados | `chatrecall.rs:259` |
| `...\chat_history_search.rs:134-163` | `fts_query()`: si existe `messages_fts`, arma `termino*  OR termino*` (min 2 chars, minusculas); si no, `None` | `execute` |
| `...\chat_history_search.rs:165-170` | fallback: `%palabra%` por cada termino | `build_sql` |
| `...\chat_history_search.rs:172-261` | SQL: `agentVisible=1`, `turnContext=0`, contenido con `audience` asistente, `ORDER BY m.timestamp DESC LIMIT ?` (`:258`) | `fetch_rows` |
| `...\chat_history_search.rs:315-347` | totales por sesion: **un `COUNT(*)` por cada sesion devuelta** (N+1) | `execute` |
| `...\chat_history_search.rs:349-395` | agrupa por sesion, ordena por `last_activity` desc, `total_matches` = suma de mensajes | `execute` |
| `src\crates\aegis\src\session\session_manager.rs:811` y `:3246` | `search_chat_history(...)` (API publica que envuelve lo anterior) | chatrecall, UI |
| `session_manager.rs:400-449` | version FTS del filtro de listado, con subconsulta **no correlacionada** (comentario: con `EXISTS` tardaba 25 s) | listado de sesiones |
| `session_manager.rs:1436-1450` | creacion idempotente de `messages_fts` + triggers `ai/ad/au` + backfill (para stores nuevos) | `SessionStorage::open` |
| `session_manager.rs:473-483` | `messages_fts_available()` (fallback si no hay FTS5) | ambos |
| `src\crates\aegis\src\context_mgmt\mod.rs:75,81,87` | el resumen de compactacion le dice al modelo: usa `chatrecall current_session=true` en vez de adivinar | compaction |

### 1.5 Operacion y UI

| ruta:linea | que hace |
|---|---|
| `src\crates\aegis-server\src\main.rs:403-419` | `--memory-consolidate`: corre `store::consolidate` e imprime el reporte (sin levantar el serve) |
| `core\ops\memory-maintenance.ps1:9,16` | tarea programada 04:00: `aegis-current.exe --memory-consolidate` → `state\data\memory\consolidate.log` |
| `web\src\server.ts:93` | `MEMORY_DIR` (respeta `AEGIS_PATH_ROOT`) |
| `web\src\server.ts:1519-1620` | `POST /memory.json`: acciones `add`, `confirm`, `reject`, `pin`, `consolidate`; `consolidate` **delega en el binario** (`execFileSync(exe, ['--memory-consolidate'])`, `:1538`), no reimplementa reglas |
| `web\src\memory.ts:1-321` | panel "Memoria del operador": badges `confirmado/candidato/rechazado/archivado` (`:42-54`), filtro por estado, acciones por hecho |
| `web\src\server.ts:1763` | `memory.js` se inyecta en `index.html` |

---

## 2. Modelo de datos de un hecho

Archivo: **`state\data\memory\facts.jsonl`** (una linea JSON por hecho, sin SQLite, sin tabla). Esquema literal (`store.rs:68-95`):

| campo | tipo | default | semantica |
|---|---|---|---|
| `id` | string | — | `F-0001`… (`next_id`, `store.rs:215`) |
| `text` | string | — | el hecho, una frase, idioma del operador |
| `kind` | string | `""` | `preference\|fact\|goal\|decision\|style` |
| `tags` | `[string]` | `[]` | agrupacion libre |
| `confidence` | f32 | `0.8` | 0..1; el extractor nunca pasa de 0.6 |
| `pinned` | bool | `false` | entra siempre al digest |
| `status` | enum | `confirmed` | `candidate\|confirmed\|rejected\|stale` (legacy sin campo = confirmed) |
| `source` | enum | `declared` | `declared\|inferred\|imported` |
| `evidence` | `[string]` | `[]` | `"<session_id>: <cita ≤160>"` o `"<session_id>: declarado"`, `"panel: declarado"` |
| `created`/`updated`/`last_seen` | RFC3339 UTC | `""` | `last_seen` manda para el orden del digest y para `stale` |
| `session` | string | `""` | sesion donde nacio |

No hay `operator.db`: **verificado** con busqueda recursiva en `C:\Aegis-Proyects\state` (`Get-ChildItem -Recurse -Filter operator.db` → 0 resultados). El estado vive en el JSONL; el reporte en `memory-report.md`; el log de la tarea en `consolidate.log`.

---

## 3. Ciclo completo de la memoria

```
turno termina (agent.rs:964-968)
  └─ spawn_post_turn_memory_extraction (agent.rs:403)
       └─ extraction::spawn  → tokio::spawn detached (extraction.rs:329)
            ├─ enabled()?            AEGIS_MEMORY_EXTRACTION (default true)
            ├─ pick_extractor()      AEGIS_MEMORY_EXTRACT_PROVIDER + _MODEL
            ├─ get_session(id,true)  recarga la conversacion completa
            └─ run_turn()
                 ├─ last_turn_text()                  ultimo user→assistant
                 ├─ assistant < 200 chars → return 0  (extraction.rs:205)
                 ├─ already_extracted(session,marker)? (VecDeque 256, en proceso)
                 ├─ complete_one_shot(SYSTEM_PROMPT)  modelo barato
                 ├─ record_usage_metrics()            ledger, con el provider real
                 └─ apply() → append_candidate()      status=candidate, source=inferred, conf ≤0.6
                                                      write_to(): tmp + rename
```

Despues, fuera de banda:

```
aegis-current.exe --memory-consolidate   (04:00, memory-maintenance.ps1)
  └─ store::consolidate
       ├─ merge_duplicates()      mismo normalize(text) → id mas bajo
       ├─ promote_candidates()    ≥2 sesiones distintas en evidence  ── o ── pinned
       └─ mark_stale()            confirmed, sin pin, conf<0.9, ≥90 dias
```

Y el camino humano: `memory_confirm` (tool) o el panel web (`POST /memory.json {action:'confirm'}`) → `store::confirm` → `status=confirmed`.

Umbrales exactos:

| umbral | valor | ruta |
|---|---|---|
| respuesta minima para extraer | 200 chars | `extraction.rs:23` |
| hechos por turno | 3 | `extraction.rs:25` |
| techo de confianza inferida | 0.6 (y `+0.1` por repeticion, igual techo) | `store.rs:26`, `:313` |
| promocion automatica | 2 sesiones distintas **o** pin | `store.rs:381` |
| confianza al promover | `max(0.7)` | `store.rs:383` |
| archivo por vejez | 90 dias sin verse, `confirmed`, sin pin, `conf<0.9` | `store.rs:398-412` |
| digest | 24 hechos / 4.000 chars | `store.rs:32-33` |
| contexto minimo para inyectar MOIM | 32.000 tokens | `moim.rs:6` |

---

## 4. Inyeccion: como se arma "Memoria del operador"

1. `ExtensionLease::moim()` (`lease.rs:557-571`) recorre las extensiones de plataforma arrancadas y pide `get_moim`. La de memoria devuelve `store::digest(read_from(store_path()))` (`memory.rs:438-440`).
2. `digest` filtra por `is_digest_eligible`, ordena **`pinned` primero, despues `last_seen` desc** (`store.rs:572-576`), toma hasta 24 y corta cuando el costo acumulado (`chars del texto + 16`) pasa 4.000 (`store.rs:580-587`).
3. Formato: `## Memoria del operador\n\n- [F-0120] texto (fact, conf 0.90)\n…`; un candidato se marca `(candidato, sin confirmar)` (`store.rs:592-606`).
4. `compose_moim` lo mete como **una parte mas** del `<turn-context>` (`moim.rs:128-136`), en un `Message::user()` marcado `agent_only` + `turn_context` (`moim.rs:105-109`).
5. Ese mensaje es el que el motor excluye de la UI, de la busqueda de chat-recall (`chat_history_search.rs:194-198`, `current_history.rs:6`) y de la extraccion (`extraction.rs:111`).

Orden efectivo del bloque: `<turn-context>` → `<current-time>` → `<working-directory>` → [partes de extensiones: memoria, todo, tom, compact… en el orden que devuelve `start_extensions`] → `<compaction>` → `<turn-budget>`.

Dedupe del digest: **no hay dedupe en el digest**; el unico dedupe por texto ocurre al escribir (`normalize`) y en `merge_duplicates` durante la consolidacion. No hay agrupacion por `kind` ni ranking por relevancia con la query del turno: el orden es pin + recencia, punto.

---

## 5. chat-recall en detalle

**Que indexa.** Todos los mensajes de **todas** las sesiones (`messages` JOIN `sessions`), proyectados a texto plano en `messages_fts` (`row_id UNINDEXED, text, tokenize='unicode61 remove_diacritics 2'`, `session_manager.rs:1441`). Mantenido por triggers `messages_fts_ai/_ad/_au` (`:1443-1445`), con backfill idempotente para filas previas (`:1442`). Verificado en vivo: 124.390 filas = 124.390 mensajes.

**Cuando se actualiza.** En cada `INSERT`/`UPDATE OF content_json`/`DELETE` sobre `messages`, por trigger. No hay reindexado periodico ni versionado del indice.

**Como busca.**

| modo | mecanismo | coste |
|---|---|---|
| `query` (otras sesiones) | FTS5 `MATCH` con prefijos OR (`chat_history_search.rs:137-163`), `LIMIT` sobre **mensajes** (`:258`), agrupado por sesion | una pasada de indice + N+1 `COUNT(*)` por sesion devuelta (`:315-347`) |
| `query` (sin FTS5) | `LOWER(json_extract(...)) LIKE '%palabra%'` (`:225`) | escaneo completo de `messages` |
| `query` (sesion actual) | **en memoria**, sobre el `Conversation` cargado: AND de substrings (`current_history.rs:53-69`) | carga la conversacion entera (`get_session(id,true)`) |
| `message_id` | mensaje exacto + paginado `offset`/`max_chars` (1..12.000) con `Next offset` (`current_history.rs:33-51`) | O(n) sobre mensajes |
| `session_id` | primeras 3 + ultimas 3 (`chatrecall.rs:64-106`) | carga la sesion |

**Visibilidad.** Todo lo que devuelve va con `audience=[Assistant]` (`chatrecall.rs:57-62`), asi que no ensucia la vista del usuario. Se respetan `agentVisible` y se excluyen los `<turn-context>` (`chat_history_search.rs:185-198`), o sea que la memoria inyectada no se reencuentra como si fuera texto del operador.

**Por que existe si la sesion ya tiene historial.** Porque la compactacion reemplaza mensajes viejos por un resumen y esos originales dejan de ser visibles al modelo, pero siguen guardados. El resumen es un indice, no la prueba; `current_session=true` busca en los originales y `message_id` los devuelve paginados (`current_history.rs:90-109` prueba exactamente eso, con un mensaje `user_only` + emoji fuera del primer corte). El propio prompt de compactacion lo recuerda (`context_mgmt\mod.rs:75-87`).

**Costo medido/estimado.**

| item | valor |
|---|---|
| `messages_fts_content` | copia el texto de cada mensaje dentro del indice (FTS5 sin `content=` externo): duplica el texto en el `.db` |
| una busqueda tipica | 1 consulta FTS + 1 `COUNT(*)` por sesion devuelta (N+1, N ≤ limit) |
| `limit` | se aplica a **mensajes**, default 10, max 50: una sola sesion charlatana puede consumir todo el cupo |
| salida | hasta `limit` mensajes con encabezado por sesion, sin truncado por mensaje (`chatrecall.rs:294-307`) |

---

## 6. Invariantes y trampas

| # | invariante / trampa | evidencia |
|---|---|---|
| 1 | **Un candidato nunca entra al digest por confianza.** El techo al escribir es 0.6 y la elegibilidad pide `>= 0.85`: la rama `candidate` de `is_digest_eligible` es inalcanzable con los escritores actuales | `store.rs:26` vs `store.rs:106`; rama muerta `store.rs:596-597` |
| 2 | **La promocion automatica pide dos sesiones distintas**, no dos observaciones: repetir el mismo hecho en la misma sesion no lo promueve | `store.rs:373-381` |
| 3 | **Nada se borra**: `forget` es baja logica y deja evidencia | `store.rs:342-352`, test `store.rs:749-760` |
| 4 | **Re-declarar confirma**: `memory_write` sobre un texto existente lo devuelve a `confirmed`, sube confianza y agrega evidencia | `store.rs:239-260`, test `:777-787` |
| 5 | **Un inferido nunca pisa un declarado**: si el texto coincide, solo suma evidencia y `+0.1` si el source es `inferred` | `store.rs:303-319` |
| 6 | **`rejected` es terminal para el extractor**: `append_candidate` lo ignora | `store.rs:304-306` |
| 7 | **Escritura atomica y canonica**: `tmp` + `rename`, filas ordenadas por id → misma entrada, mismos bytes (base de la idempotencia) | `store.rs:195-213`; `consolidate` compara bytes (`:475-492`) |
| 8 | **La consolidacion es idempotente** y lo declara (`changed=false`) | `store.rs:470-492`, test `:698-725`; en vivo: 4 corridas seguidas con `cambios: false` (`consolidate.log`) |
| 9 | **Sin lock entre procesos**: `read_from` + `write_to` es read-modify-write sin mutex. El panel web encola (`withFileQueue`, `server.ts:1527`) pero el motor no: el extractor (tokio) y `memory_write` pueden pisarse y perder un hecho | `store.rs:226-281`, `:285-339` |
| 10 | **`normalize()` es igualdad exacta** tras plegar acentos: dos parafrasis del mismo hecho son dos filas. En vivo, `duplicados fusionados: 0` en todas las corridas con 171 candidatos | `store.rs:150-165`; `consolidate.log` |
| 11 | **`stale` tarda 90 dias** y excluye `pinned` y `conf>=0.9`: hoy 0 stale, y el store nacio el 26/10, asi que el primer archivado posible es ~2027-01 | `store.rs:398-412`; `facts.jsonl` |
| 12 | **El digest no es gratis ni se va**: ~3.759 chars (~1k tok) por turno, y el bloque queda en el historial; el modelo tiene instruccion explicita de que los bloques viejos siguen ahi | `moim.rs:8-23`; medido hoy |
| 13 | **Sin MOIM no hay memoria**: si la ventana del modelo es < 32k no se inyecta nada, y si la extension `memory` no arranca, `moim()` no aporta la parte | `moim.rs:6,112-114`; `lease.rs:563` |
| 14 | **El dedupe del extractor vive en RAM**: `SEEN` es `VecDeque` de 256 claves y se pierde al reiniciar el serve; el mismo ultimo par podria re-extraerse | `extraction.rs:66,83-95` |
| 15 | **El extractor lee el turno del `Conversation` recargado**, no del stream: si la sesion no persiste el ultimo par (o el turno se corto), no hay extraccion | `extraction.rs:336-346` |
| 16 | **chat-recall nunca busca en la sesion actual por la via SQL**: excluye explicitamente la sesion actual (`chatrecall.rs:257`) y la actual la resuelve en memoria | `chat_history_search.rs:237-239` |
| 17 | **La busqueda actual es AND, la historica es OR**: dos semanticas distintas bajo la misma tool | `current_history.rs:64` vs `chat_history_search.rs:161` |
| 18 | **`limit` es de mensajes, no de sesiones**: 10 puede significar 1 sesion | `chat_history_search.rs:258` |

---

## 7. Local vs GitHub (block/goose)

Verificaciones hechas con `gh api` contra `block/goose@main`, 2026-10-29.

| pieza | upstream block/goose | aegis (local) | como se verifico |
|---|---|---|---|
| modulo `memory` (store/extractor) | **no existe** | `crates/aegis/src/memory/` | `gh api repos/block/goose/contents/crates/goose/src/memory` → **404**; lista de `crates/` sin crate de memoria |
| extension de plataforma `memory` | **no existe** | `platform_extensions/memory.rs` | `gh api .../platform_extensions` → lista con `chatrecall.rs` pero sin `memory.rs` |
| tools `memory_write/search/list/forget/confirm/consolidate` | **no existen** | `memory.rs:23-28` | idem |
| `--memory-consolidate` | **no** | `aegis-server/src/main.rs:403-419` | flag local |
| panel web `/memory.json` + `memory.ts` | **no** (es de aegis-web) | `web/src/server.ts:1519`, `web/src/memory.ts` | repo web es local |
| `chatrecall` (extension, tool `chatrecall`) | **si**: `platform_extensions/chatrecall.rs` (archivo suelto) | `platform_extensions/chatrecall.rs` + submodulo `chatrecall/current_history.rs` | upstream no tiene el directorio `chatrecall/` (404); el submodulo es local |
| `current_session` / `message_id` / `offset` | **no** | `chatrecall/current_history.rs` entero | upstream `chatrecall.rs` es un archivo unico |
| FTS5 `messages_fts` + triggers | **no**: `ChatHistorySearch` es LIKE puro | `chat_history_search.rs:134-163`, `session_manager.rs:1436-1450` | `raw.githubusercontent.com/block/goose/main/.../chat_history_search.rs`: `fetch_rows(&keywords)` sin `fts` |
| `search_chat_history` | **si** (misma base LIKE) | heredado + FTS | idem |
| hints de compactacion que mandan a chatrecall | **no** (texto local) | `context_mgmt/mod.rs:75-87` | local |
| `goose` tiene MCP "memory" experimental | el operador lo recordaba; **en el arbol no hay nada**: la memoria por MCP es un servidor de referencia externo (§8), no codigo del core | — | lista de crates y de extensiones, ambas verificadas |

Historial local del subsistema (rama `feat/antigravity-provider`, sin push):

```
00dd34df2 feat(memoria): store con estados, extraccion al cierre de turno y consolidacion
25843de8e feat(memoria): la extraccion puede correr en su propio provider y modelo
956f0306a test(memoria): sonda manual del extractor propio y doc del knob
817e8ea57 test(memoria): sonda end-to-end del extractor, con llamada real a gpt-6-luna
3f099aa8a refactor(memoria): el prompt de extraccion pasa a ingles, la salida sigue en el idioma
d66d9fdbd feat(memoria): la extraccion anota su costo en usage_ledger con el provider que respondio
```

chat-recall aparece en el arbol local solo con `7f394c468 feat(rebrand)` y `06017d466 style: cargo fmt`, o sea: **viene de upstream**; lo local encima son FTS y `current_history`.

---

## 8. Referencias web (URL literal)

| tema | URL | estado |
|---|---|---|
| servidor MCP de memoria de referencia (grafo entidad/relacion/observacion, persistencia en un JSONL) | https://github.com/modelcontextprotocol/servers/tree/main/src/memory | abierta hoy |
| memoria episodica con stream + recuperacion por recencia/importancia/relevancia | https://arxiv.org/abs/2304.03442 | abierta hoy |
| memoria jerarquica con paginado entre contexto y almacenamiento externo (el modelo decide que traer) | https://arxiv.org/abs/2310.08560 | abierta hoy |
| documento FTS5 de SQLite (tokenizer `unicode61 remove_diacritics`, tablas `%_content/_data/_idx`) | https://sqlite.org/fts5.html | **no abierta en esta sesion**; se cita por lo observado en el `.db` |

Contraste util: el servidor de referencia guarda un **grafo** y obliga al modelo a consultarlo; aca el store es **plano con estados**, y hay dos caminos (digest automatico + tools). El digest es la parte "siempre presente" y es donde vive el riesgo de tokens; el grafo externo paga por consulta, no por turno.

---

## 9. Huecos, riesgos y deuda tecnica

| # | hallazgo | evidencia | impacto |
|---|---|---|---|
| 1 | **171 candidatos (70 % del store) son invisibles al modelo y solo se limpian a mano.** No hay promocion por confianza posible (trampa 1) y la repeticion entre sesiones casi no ocurre | `facts.jsonl` (171/245); `consolidate.log`: `promovidos: 0` en las 4 corridas desde el 26/10 | la memoria util crece solo cuando el agente llama `memory_write`; el extractor produce cola muerta |
| 2 | **Sin lock de archivo en el motor**: read-modify-write concurrente (extractor detached + tool + panel) | `store.rs:226-281`; no hay `Mutex`/`flock` en el modulo; el panel encola solo del lado Node (`server.ts:1527`) | perdida silenciosa de hechos; el JSONL se reescribe entero en cada alta (`write_to`) |
| 3 | **Reescritura completa del archivo por cada escritura** | `store.rs:195-213` | a 118 KB es gratis; con 5.000 hechos (~2,5 MB) cada `memory_write` copia el archivo entero, varias veces por turno |
| 4 | **Dedupe por igualdad de texto** | `store.rs:150-165`; `duplicados fusionados: 0` con 171 candidatos | parafrasis = filas distintas; el digest se llena de variantes antes que de hechos nuevos |
| 5 | **El digest no rankea por relevancia**: pin + recencia | `store.rs:572-576` | 16 hechos fijos en el 80 % del cupo; un hecho util reciente sin pin puede quedar afuera |
| 6 | **Coste por turno del digest**: ~1.000 tok, y el bloque viejo no se borra del historial | medido: 3.759 chars; `moim.rs:8-23` | con 15 pinned el digest ya esta casi lleno (3.759/4.000): el siguiente pin desplaza hechos por recencia |
| 7 | **`stale` practicamente no corre**: 90 dias + `conf>=0.9` exento | `store.rs:398-412`; 0 stale hoy | hechos obsoletos siguen elegibles hasta 2027; el unico archivado real es manual (`memory_forget`) |
| 8 | **El panel web reimplementa la escritura** en vez de llamar al motor para `add/confirm/reject/pin` (solo `consolidate` delega) | `web/src/server.ts:1556-1600` | dos implementaciones de las mismas reglas; el `add` del panel escribe `evidence: ["panel: declarado"]`, que despues cuenta como "sesion" en `promote_candidates` (`store.rs:373-381`) |
| 9 | **FTS5 duplica el texto** en el mismo `.db` (`messages_fts_content`) | 696,3 MB con 124.390 mensajes; `sqlite_master` lista `messages_fts_content/_data/_idx` | el store crece mas rapido que los mensajes; el mantenimiento del store (doc 05) tiene que contarlo |
| 10 | **N+1 en chat-recall** | `chat_history_search.rs:315-347` | con `limit=50` son hasta 50 `COUNT(*)`; aceptable hoy, no con 500 sesiones activas |
| 11 | **`user_version` del store es 0** | `pragma user_version` → 0 con las tablas ya migradas | cualquier herramienta que use `user_version` como version de esquema se equivoca; el control real esta en otra tabla — **no verificado cual** |
| 12 | **El parametro `report` de `memory_consolidate` se ignora**: siempre escribe el informe | `memory.rs:370-388` (firma `handle_consolidate(&self)`, sin args) | contrato de tool mentiroso |
| 13 | **Knobs sin documentar en el doc de config**: `AEGIS_MEMORY_EXTRACTION`, `AEGIS_MEMORY_EXTRACT_PROVIDER`, `AEGIS_MEMORY_EXTRACT_MODEL` | `config.yaml:11-12` los usa; `extraction.rs:69-81,286-290` | hallazgo del operador reciente: la extraccion corre en `chatgpt_codex/gpt-6-luna`, no en el provider de la sesion |
| 14 | **`chatrecall` no indexa tool responses ni thinking en el conteo por sesion** pero si los muestra cuando llegan por `message_id` | `chat_history_search.rs:300-313` vs filtro SQL `:199-209` | listas "N de M mensajes" que no cuadran con lo que se ve |

---

## 10. Bateria de pruebas y scripts

| archivo | estado | que hace |
|---|---|---|
| `web\tools\memory-maintenance.ps1` | **no existe** | el operativo real es `core\ops\memory-maintenance.ps1` (tarea 04:00) |
| `web\tools\ctx-db.mjs`, `ctx-db2.mjs` | existen | son de contexto/DB de sesiones; **no tocan memoria** (sin referencias a `facts.jsonl`) |
| `crates/aegis/src/memory/store.rs:637-787` | 7 tests | legacy→confirmed, cap+2 sesiones para promover, idempotencia, merge al id mas bajo, forget suave, digest pin-first, declarado confirma candidato |
| `crates/aegis/src/memory/extraction.rs:355-529` | 6 tests (2 `#[ignore]`, llaman red real) | `extractor_choice`, parseo de JSON en prosa, `nothing_new`, tope 3, no duplicar confirmado |
| `crates/aegis/src/agents/platform_extensions/memory.rs:443-482` | 2 tests | contrato de tools completo; `render_line` con estado/confianza |
| `crates/aegis/src/agents/platform_extensions/chatrecall.rs:397-609` | tests de la extension | modos de la tool |
| `platform_extensions/chatrecall/current_history.rs:84-109` | 1 test | original compactado visible, `user_only` filtrado, paginado con emoji |
| `src\crates\aegis\src\session\session_manager.rs:4797,4838` | tests de FTS | crear/dropear `messages_fts` |

No corri build ni tests en esta sesion (regla read-only). Todo lo de arriba es lectura de codigo y de estado en disco.

---

## No verificado

- Cuanto poda la compactacion de los `<turn-context>` viejos: si no los colapsa, el digest se acumula en el historial a razon de ~1k tok por turno. El codigo dice que los bloques viejos quedan (`moim.rs:19`) pero no medi el efecto sobre una sesion larga.
- Cual es la tabla de version de esquema que reemplaza a `pragma user_version` (que da 0).
- Si el `memory_write` concurrente con el extractor ya perdio hechos: el riesgo es de lectura de codigo, no hay log que lo demuestre.
- Latencia real de `chat_history_search` con FTS sobre este store (696 MB): no ejecute la consulta; el comentario de `session_manager.rs:435-437` mide 25 s para el caso `EXISTS` sobre el listado de sesiones, no para chat-recall.
- Si `goose` upstream tubo un MCP "memory" experimental en otra epoca: en `main` hoy no hay rastro (crates + platform_extensions verificados).

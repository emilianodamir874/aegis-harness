# Backend del harness Aegis — cobertura completa

Investigación del backend entero del harness, en tres fuentes por dominio: código local (`C:\Aegis-Proyects\src`, `C:\Aegis-Proyects\web`), GitHub (`block/goose` upstream, `emilianodamir874/aegis-harness`, `emilianodamir874/aegis-src`, `emilianodamir874/aegis-web`) y documentación web externa con URL literal.

Fecha: 2026-10-29. Estado: 17 documentos, 18 subagentes, HEAD `8d559d0b5` rama `feat/antigravity-provider`.

Régimen: lectura estática. No se compiló, no se corrieron tests, no se reinició ni mató ningún proceso, no se escribió en el store. Cada documento declara su propia sección "No verificado".

---

## 1. Cobertura del backend

| # | Dominio | Documento | Piezas cubiertas |
|---|---|---|---|
| 01 | Turno del agente | `01-turno-agente.md` | state machine de 20 pasos, `aegis-agent`, ops de inferencia/tool/steering, events |
| 02 | Contexto y compactación | `02-contexto-compactacion.md` | `aegis-context-management`, token_counter, umbrales, tool-pair, chunked/recent |
| 03 | Providers y streaming | `03-providers-streaming.md` | trait `Provider`, 48 definiciones declarativas, parser SSE, thinking_effort, errores |
| 04 | Transporte ACP / `aegis-serve` | `04-acp-serve.md` | stdio y HTTP/WS 3284, 17 métodos ACP + 118 `_aegis/unstable/*`, `session/update`, flags |
| 05 | Sesiones y store SQLite | `05-sesiones-store.md` | esquema real v22, migraciones, PRAGMAs, `usage_ledger`, retención, `dbstat` |
| 06 | MCP y extensiones | `06-mcp-extensiones.md` | 4 tipos de extensión, ciclo de vida, `extensionmanager`, plugins, colisiones |
| 07 | Permisos y seguridad | `07-permisos-seguridad.md` | motor de decisión, 37 patrones, sandbox, hooks (visión completa) |
| 07a | Motor de permisos (detalle) | `07a-permisos-motor.md` | orden deny→allow→ask, capas, `permission.yaml` real vs código, diff upstream |
| 07b | Modos, hooks, sandbox (detalle) | `07b-modos-hooks-sandbox.md` | plan/revisar/ejecutar, `session/request_permission`, 12 eventos de hook, `workspace_sandbox` |
| 08 | Recipes, scheduler, skills, prompts | `08-recipes-scheduler-skills-prompt.md` | esquema de recipe, cron de 6 campos, 10 raíces de skills, dedupe de hints |
| 09 | Backend web Node | `09-web-backend-node.md` | 22 endpoints, proxy ACP por WS, auth por ruta, dist-ts vs server.mjs |
| 10 | Memoria y chat-recall | `10-memoria-chatrecall.md` | `facts.jsonl`, ciclo candidato→confirmado, digest `<turn-context>`, FTS5 |
| 11 | Voz: dictado, TTS, inferencia local | `11-voz-dictado-inferencia.md` | `aegis-local-inference`, whisper GGUF, Piper persistente, barge-in, VAD |
| 12 | Telemetría y costo | `12-telemetria-costo.md` | `llm_request.*.jsonl`, rotación, `usage_ledger`, OTLP apagado, qué falta medir |
| 13 | Roaming, apps, gateway, OAuth, SDK, descargas | `13-roaming-apps-gateway-oauth-sdk.md` | iroh/QUIC, MCP Apps, gateway Telegram, PKCE, GDK, descarga de GGUF |
| 14 | Build, deploy, config, CI | `14-build-deploy-config.md` | 15 crates, feature sets, `build.ps1`/`swap.ps1`/`selfheal`, precedencia de config, CI inexistente |
| 15 | Catálogo de tools y artefactos | `15-tools-catalogo-artefactos.md` | 25+ tools, schema, 4 filtros, límites duros, `/dl/<name>`, encoding |
| 16 | Tests y evals | `16-tests-evals.md` | `aegis-test`/`test-support`, rig de refusal (22 variantes), 3847 tests, Justfile |

---

## 2. El backend en una página

```
navegador
  └─ WS JSON-RPC ──► :3788 dist-ts/server.mjs  (proxy crudo /acp, no interpreta ACP)
                       └─ ws://127.0.0.1:3284/acp ──► aegis-v121.exe  (aegis-serve)
                                                        │
                                                        ├─ ACP dispatch (17 métodos + 118 _aegis/unstable/*)
                                                        ├─ state machine (20 steps) ──► Provider::stream ──► HTTP al modelo
                                                        │     ├─ inference_preparation (tools visibles, system prompt, hints)
                                                        │     ├─ tool_approval (PermissionInspector + WorkspaceSandboxInspector)
                                                        │     ├─ toolcalling (buffer_unordered(4) para read/grep/tree)
                                                        │     ├─ compaction (auto / manual / tool-pair)
                                                        │     └─ memory extraction (proceso detached)
                                                        ├─ SessionManager ──► sessions.db (WAL, 9 tablas + FTS5, v22)
                                                        ├─ extensions (platform/builtin/stdio/streamable_http)
                                                        └─ telemetría ──► llm_request.*.jsonl + usage_ledger
```

Cada caja de ese diagrama tiene su documento en la tabla de arriba, con `ruta:línea`.

---

## 3. Hallazgos transversales

Aparecen en dos o más dominios y ninguno se explica por sí solo dentro de un documento.

| # | Hallazgo | Dónde se ve | Evidencia |
|---|---|---|---|
| 1 | **El binario desplegado no coincide con el árbol.** v121 se compiló sin `local-inference` (dictado muerto) y sin `otel` (telemetría apagada) | 11, 12, 14 | `last-build.json.features`; `build.ps1:10` con `--no-default-features`; `dictation.rs:26-30` |
| 2 | **El system prompt desplegado puede no ser el del repo**: `state\config\prompts\system.md` pisa la plantilla embebida | 08 | `prompt_template.rs:114-129` |
| 3 | **El backend web vivo no es `web/server.mjs`** sino `dist-ts/server.mjs` (build de `src/server.ts`); la tarea programada arranca el viejo | 09 | PID 5016, 74.915 B vs 72.677 B; `start-aegis-web.ps1` |
| 4 | **El fork no está pusheado.** HEAD 139 commits adelante de `origin/main`; la rama vive solo en `backup`; 209 commits locales en `aegis-web`; CI eliminado el 2026-10-20 | 09, 14, 16, 05 | `git rev-list`, `actions/workflows total_count = 0` |
| 5 | **Tres números distintos del mismo contexto**: tiktoken del motor, usage del provider, `chars/4` de la UI. Techo real 500 000, no 350 000 | 02 | `config.yaml:4`; `token_counter.rs:221`; `acp/server.rs:1068` |
| 6 | **94,8 % del gasto registrado es estimación**, no cifra del proveedor; `prices.json` desfasado (0,752 vs 0,6208 USD/1M) | 12, 05 | 44.176 filas `estimated` (USD 2.242) vs 1.609 `provider_reported` (USD 1,53) |
| 7 | **Aprobaciones sin timeout.** Si la sesión se corta, queda `ToolConfirmation` colgada para siempre; el único remedio es `--sweep-pending` manual | 07b, 07, 04 | `tool_confirmation_coordinator.rs:90-121`; `pending_confirmations.rs:1-11` |
| 8 | **El modo de sesión no se persiste**: `session_overrides` es un `RwLock<HashMap>` en memoria, todo vuelve a `ejecutar` tras un swap | 07b | `config/permission.rs:42, 252-263` |
| 9 | **El sandbox de escritura existe y está apagado** (`AEGIS_WORKSPACE_SANDBOX: false`), y la UI no tiene control para encenderlo | 07b, 07 | `config.yaml:20` vs default `true` en `agent.rs:377-379` |
| 10 | **La memoria no promueve nada**: el digest exige `confidence >= 0.85` y la escritura tiene techo 0.6 → rama muerta. 171 de 245 hechos son candidatos invisibles, `promovidos: 0` | 10 | `store.rs:106` vs `store.rs:26`; log de consolidación |
| 11 | **El scheduler no excluye por job**: un job lento se solapa consigo mismo y `kill` cancela un solo token | 08 | `full.rs:142-160, 435-448` |
| 12 | **Skills con el store partido en dos**: el CRUD escribe en `~/.agents/skills`, las 41 skills vivas están en `state\config\skills` | 08 | `sources.rs:678-1121`; `skills/mod.rs:487-559` |
| 13 | **El store arrastra muerto y fixtures**: `messages.tokens` 0 de 122.934 filas, `project_id` es el working_dir, 4 sesiones hidden, 20 filas mock, `threads`/`thread_messages` inexistentes | 05 | consultas en solo-lectura del 2026-10-29 |
| 14 | **Tareas programadas viejas** (`aegis-restart-limite`, `aegis-restart-singate`, `aegis-swap-v114`) apuntan a `core\tmp\*` y pueden reiniciar el serve fuera de todo gate | 14 | `Get-ScheduledTask`; los scripts destino |
| 15 | **Superficie expuesta sin auth en LAN**: `/tts` sin auth fuera del túnel, `/changes.json` y `/file.json` con listas de deny distintas, `cloudflared.exe` (55 MB) y contraseña en claro en `tunnel-access.txt`, `secrets.yaml` con 8 claves en claro | 11, 09, 14 | `server.mjs:798-860`; `server.ts:447-463` |
| 16 | **Código muerto conviviendo con el vivo**: `ToolOperation` vs `ToolExecutionOperation`, `check_if_compaction_needed` sin llamadores, `CompactingProvider` nunca instanciado, `SessionEnd` sin emisor, hooks inertes, `compact`/`mode` fuera de `config.yaml` | 01, 02, 05, 06, 07b | greps citados en cada doc |
| 17 | **God objects**: `acp/server.rs` (4.306 líneas + `.bak` dentro de `crates/`), 118 métodos `_aegis/unstable` con dispatch por comparación lineal de strings, `server.ts` 1.979 líneas, `app.ts` 7.361 líneas | 04, 09 | `acp/server.rs.bak-local-titles` |
| 18 | **`aegis-server` tiene 0 tests** y el target `check-tests` del Justfile apunta justo a ese crate: falsa cobertura. La banda de ~46 fallas de entorno no está documentada en ningún archivo del repo | 16 | conteo de `#[test]` por crate |

---

## 4. Contradicciones entre documentos y su resolución

| Afirmación A | Afirmación B | Resolución verificada |
|---|---|---|
| `01` dice que `ReplyParts` no existe (0 matches) | `15` cita `reply_parts.rs:218-226` | Ambas ciertas: el **módulo** `crates/aegis/src/agents/reply_parts.rs` existe (57.858 B, `StreamTiming`, `is_tool_visible_to_model`), el **tipo** `ReplyParts` no. Verificado: 0 coincidencias en 758 archivos |
| Encargo: techo de contexto 350k | `02`: `AEGIS_AUTO_COMPACT_TOKEN_LIMIT: 500000` | El techo es 500 000 desde `933bc945e` (28/10) |
| Contexto del operador: store 534 MB / 93k mensajes | `05`: 690,3 MB / 122.934 mensajes | El store creció; manda la medición del 2026-10-29 12:47 |
| `04`: `web/server.mjs` no lanza el binario, es cliente WS | `09`: el proceso vivo es `dist-ts/server.mjs` | Compatibles: ninguno de los dos lanza el motor; el watchdog es `core/ops/selfheal.ps1` |
| `AGENTS.md` lista `code-mode` como feature | `14` y `16`: 0 coincidencias en todos los `Cargo.toml` y el `Justfile` | `code-mode` no existe; pedirla rompe el build |

---

## 5. Huecos de cobertura

Lo que quedó fuera y por qué. Nada de esto invalida los 17 documentos, pero el backend no está 100 % cubierto sin ello.

| Hueco | Por qué quedó afuera |
|---|---|
| `src/evals/harbor` | El doc 16 cubre `evals/refusal` completo; `harbor` no se analizó |
| `ui/desktop` (Electron) y `ui/text` | Es cliente, no backend. Solo se tocó lo que hacía falta para entender el contrato ACP |
| `web/app.ts` (7.361 líneas de cliente) | Solo lo necesario para explicar los endpoints y el streaming |
| 48 definiciones declarativas de provider, una por una | El doc 03 las cuenta y mapea el mecanismo; no audita cada JSON |
| `web/tools/*` (~250 scripts de diagnóstico) | Se citaron los que documentan un contrato; el resto es basura operativa |
| Migración real del esquema 17 → 22 paso a paso | El doc 05 documenta el estado y las migraciones existentes, no valida cada una |
| Comportamiento en ejecución: handshake WS real, OAuth real, pairing de Telegram, latencia de dictado | Requiere ejecutar contra el serve vivo, prohibido en régimen read-only |

---

## 6. Prioridades que salen de la investigación

Ordenadas por relación entre impacto y costo, cada una con su documento.

| P | Acción | Sustento |
|---|---|---|
| P0 | Encender el sandbox de escritura o decidir por escrito que queda apagado (`AEGIS_WORKSPACE_SANDBOX`) | 07b, 07 |
| P0 | Poner timeout a `session/request_permission` y barrido automático de confirmaciones colgadas al arrancar | 07b |
| P0 | Revisar las tres tareas programadas `aegis-restart-*` que pueden reiniciar el serve fuera del gate | 14 |
| P1 | Persistir el modo de sesión (hoy en RAM) para que un swap no lo devuelva a `ejecutar` en silencio | 07b |
| P1 | Corregir el umbral del digest de memoria (0.85 vs techo 0.6) o bajar el techo: 171 hechos invisibles | 10 |
| P1 | Unificar el store de skills (CRUD escribe en `~/.agents/skills`, las 41 vivas en `state\config\skills`) | 08 |
| P1 | Pushear el fork (`origin` 139 commits atrás) y reponer CI: hoy no hay ninguna verificación automática | 14, 16 |
| P1 | Alinear `web/server.mjs` con `src/server.ts` o borrar el viejo, y arreglar la tarea `Aegis_Web` | 09 |
| P2 | Elegir un solo número de contexto (motor / provider / UI) y exponerlo | 02 |
| P2 | Instrumentar duración y costo por herramienta en `usage_ledger` (no hay columnas de tiempo) | 12 |
| P2 | Exclusión por job en el scheduler | 08 |
| P2 | Rebuild con `local-inference` para revivir el dictado (el modelo ya está en disco) | 11 |
| P2 | Cerrar `/tts` en LAN, unificar las listas de deny de `/changes.json` y `/file.json`, sacar `cloudflared.exe` y `tunnel-access.txt` si el túnel ya no se usa | 11, 09 |
| P3 | Borrar el código muerto (`ToolOperation`, `check_if_compaction_needed`, `CompactingProvider`, `.bak` en `crates/`) | 01, 02, 04 |

---

## 7. Cómo verificar cada documento

Todo lo afirmado tiene `ruta:línea` o `archivo:línea`. Para auditar un documento:

1. Abrir la sección 1 (mapa de piezas) y saltar a las líneas citadas.
2. Las mediciones del store (doc 05, 10, 12) se repiten con `sqlite3 -readonly` sobre `state\data\sessions\sessions.db`.
3. Las comparaciones con GitHub se repiten con `gh api repos/block/goose/contents/crates`.
4. Las secciones "No verificado" son honestas: listan lo que no se ejecutó, no lo que se dudó.

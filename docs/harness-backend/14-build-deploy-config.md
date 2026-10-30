# 14 — Build, empaquetado, deploy y config

Capa que hace que el backend exista y arranque: grafo de crates, feature flags, cadena de build,
swap con verificación, convivencia de procesos, resolución de paths y CI.
Medido y verificado el **2026-10-29 12:45 (-03)** sobre el árbol vivo. Todo lo que sigue es lectura
de archivos y estado del host; el único proceso que se ejecutó fue `aegis-v121.exe --print-paths`.

Estado del despliegue en el momento de la medición:

| dato | valor | fuente |
|---|---|---|
| tag del puntero | `v121` | `core\state\current-version.json` |
| exe | `C:\Aegis-Proyects\core\bin\aegis-v121.exe` | idem |
| sha256 | `ECFE44C19D911BFE…` | idem |
| version | `aegis-serve 1.54.0` | idem |
| commit | `660d9ff2c` | `core\state\last-build.json` |
| profile | `release` | `last-build.json` |
| features | `rustls-tls,scheduler,bundled-mcp,chat-recall,acp-http` | `last-build.json` |
| bytes | 95 000 064 (90,6 MB) | `last-build.json` |
| proceso vivo | pid 14468, `core\bin\aegis-v121.exe`, escuchando 3284 | `Get-CimInstance Win32_Process` |
| web vivo | pid 5016, `node …\v22.23.2\installation\node.exe C:\Aegis-Proyects\web\dist-ts\server.mjs` | idem |
| árbol de trabajo | `feat/antigravity-provider` en `8d559d0b5`, 55 entradas sucias, ahead 79 de `backup/…` | `git status -sb` |

Ojo con la lectura directa de ese cuadro: **el binario desplegado se compiló desde un árbol sucio**
(`dirty: true`, `diffSha 8bd76afc…`, recuperable con `git stash apply 8bd76afc`) en el commit
`660d9ff2c`, mientras el HEAD del repo ya está en `8d559d0b5`. `check-consistency.ps1` marca eso como
`INCONSISTENTE` por diseño (ver §4.4).

---

## 1. Grafo de crates

15 miembros de workspace (`members = ["crates/*"]`, `src\Cargo.toml:2-5`), resolver 2, `version`
workspace `1.54.0`, `rust-version 1.94.1`, `edition 2021`. El toolchain real instalado es
`1.99.0` (`src\rust-toolchain.toml:2`): `rust-version` es el mínimo declarado, no el que corre.

| crate | depende de (path) | rol | origen |
|---|---|---|---|
| `aegis-server` | `aegis`, `aegis-mcp` | **el harness**. Un solo binario: `aegis-serve` (`crates\aegis-server\Cargo.toml:14-16`). ACP sobre HTTP/WS + stdio + modos headless (`--print-paths`, `--list-skills`, `--list-sessions`, `--run-recipe`, `--memory-consolidate`, `--sweep-pending`) | **fork** (reemplaza `goose-cli`) |
| `aegis` | `aegis-agent`, `aegis-context-management`, `aegis-providers`, `aegis-download-manager`, `aegis-sdk-types`, `aegis-acp-macros`, `aegis-mcp` (dev), `aegis-test-support` (dev) | lógica central: agentes, config, prompts, hints, session/store, checks, providers de alto nivel, skills, memory | fork de `goose` |
| `aegis-agent` | `aegis-provider-types` | runtime de agente compartido | upstream renombrado |
| `aegis-providers` | `aegis-local-inference`, `aegis-provider-types` | implementaciones de provider (incluye `open_design`, `chatgpt_codex`, `opencode_go`, `antigravity`, `mlx`) | fork de `goose-providers` |
| `aegis-provider-types` | — | tipos de wire del provider | upstream renombrado |
| `aegis-context-management` | `aegis-provider-types` | compaction, ventana de contexto, tool-pair summarization | fork |
| `aegis-mcp` | — | servidores MCP bundled; acá vive el subsistema `developer` | fork |
| `aegis-acp-macros` | — | macros del ACP | upstream renombrado |
| `aegis-download-manager` | — | descargas (modelos) | upstream renombrado |
| `aegis-local-inference` | `aegis-download-manager`, `aegis-provider-types`, `aegis-sdk-types` | candle/llama.cpp/whisper local | upstream renombrado |
| `aegis-roaming` | — | roaming entre nodos | upstream renombrado |
| `aegis-sdk` | `aegis-context-management`, `aegis-providers`, `aegis-sdk-types` | GDK (API pública publicada) | upstream renombrado |
| `aegis-sdk-types` | — | tipos del GDK | upstream renombrado |
| `aegis-test` | — | helpers de test | upstream |
| `aegis-test-support` | — | fixtures de test | upstream |

Contraste con upstream (`gh api repos/block/goose/contents/crates --jq '.[].name'`, 15 entradas):
`goose, goose-acp-macros, goose-agent, goose-cli, goose-context-management, goose-download-manager,
goose-local-inference, goose-mcp, goose-provider-types, goose-providers, goose-roaming, goose-sdk,
goose-sdk-types, goose-test, goose-test-support`.

Diferencia exacta: **uno por uno menos, uno por uno más**. `goose-cli` no existe (borrado
2026-10-20) y en su lugar está `aegis-server`. El resto es el mismo conjunto renombrado.
`ui/` (Electron), `services/`, `buzz/`, `oidc-proxy/`, `blog/` y los workflows de CI fueron
purgados en el commit `1443e804d` (*chore: purga el andamiaje del upstream*, 2026-10-20).

No hay `aegis` ni `aegis-cli` en el PATH como binario del harness: el lanzador `aegis.cmd` apunta a
`core\bin\aegis-current.exe`. Nota: `crates\aegis\Cargo.toml:307-322` todavía declara los binarios
`aegis-acp`, `analyze_cli` (requiere `tree-sitter`), `build_canonical_models` y
`generate-acp-schema`; ninguno se despliega.

### 1.1 Feature flags — quién Enciende qué

| feature | dónde está definida | quién la enciende |
|---|---|---|
| `rustls-tls` | `aegis-server\Cargo.toml:35-39`, `aegis\Cargo.toml:56-73` | default del serve, build.ps1, Justfile |
| `scheduler` (`tokio-cron-scheduler`) | `aegis-server\Cargo.toml:29`, `aegis:107` | default del serve; también `--enable-scheduler` en runtime |
| `bundled-mcp` | `aegis-server\Cargo.toml:28` → `dep:aegis-mcp` | default del serve |
| `chat-recall` | `aegis-server\Cargo.toml:31`, `aegis:106` | default del serve |
| `acp-http` | `aegis-server\Cargo.toml:32`, `aegis:108` | default del serve |
| `tree-sitter` (10 gramáticas) | `aegis\Cargo.toml:22-33` | **solo** el set de CI / `check-lib` / `test-lib`; **no** va en el binario desplegado |
| `live-voice` | `aegis\Cargo.toml:34` → `aegis-providers/live-websocket` | set de CI; no va en el desplegado |
| `platform-apps` | `aegis\Cargo.toml:105` | set de CI |
| `local-inference` / `cuda` / `vulkan` / `mlx` | `aegis\Cargo.toml:35-55` | solo builds puntuales (v115 fue el último release con `local-inference`: 114,4 MB) |
| `otel`, `aws-providers`, `system-keyring`, `native-tls`, `online-model-meta` | `aegis\Cargo.toml:14-21,45-52,74-93` | no usados por el despliegue |
| `portable-default` | `aegis\Cargo.toml:94-104` | agregado del fork: `rustls-tls,tree-sitter,live-voice,aws-providers,otel,scheduler,platform-apps,chat-recall,acp-http`. **Nadie lo usa** (el paquete portable se arma con el binario release del serve) |

**Default de `crates/aegis-server/Cargo.toml:20-26`** = `rustls-tls, scheduler, bundled-mcp,
chat-recall, acp-http`.

**Set de CI** (el que usan `check-lib` y `test-lib` del Justfile, hoy sin workflow que los llame):

```
rustls-tls,tree-sitter,live-voice,scheduler,platform-apps,chat-recall,acp-http
```

Los dos sets difieren a propósito: el de CI compila más superficie (gramáticas, voz, apps de
plataforma) para que los tests cubran código que el binario desplegado no lleva.

**`code-mode` ya no existe.** Verificado con `Select-String` sobre `Cargo.toml`, `crates\*\Cargo.toml`
y `Justfile`: cero coincidencias de `code-mode`. La cabecera de `core\ops\build.ps1:3-4` lo deja
escrito: *"2026-10-22: la feature `code-mode` ya no existe en aegis-server ni en aegis"*. Sí existen
29 ocurrencias de `code_mode` en `.rs`, pero son otra cosa: `code_mode_enabled` del provider `mlx`
(`crates\aegis-providers\src\providers\mlx.rs:202,376,470,777,816`), el modo de tool-calling
emulado, no una feature de cargo.

### 1.2 Nota sobre `[patch.crates-io]` y perfiles

- `src\Cargo.toml:110-111` parchea `cudaforge` a un rev de git fijo: sin red, un build limpio falla
  al resolver.
- `[profile.dev.package."*"] debug = false` (`:119-120`): las dependencias de terceros van sin
  DWARF; los crates del workspace conservan debug completo. Es lo que mantiene `target\debug` en
  20 GB en vez de 40+.
- `[profile.lean]` (`:122-128`): `opt-level="z"`, `lto="fat"`, `codegen-units=1`,
  `panic="abort"`, `strip="symbols"`. Nadie lo usa en ops.

---

## 2. Cadena de build

### 2.1 Comando canónico

```
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Aegis-Proyects\core\ops\build.ps1 -Tag vNN
```

Y lo que ejecuta adentro, textual (`core\ops\build.ps1:70`):

```
cargo build -p aegis-server --bin aegis-serve --no-default-features \
  --features rustls-tls,scheduler,bundled-mcp,chat-recall,acp-http \
  [--release]
```

Parámetros (`build.ps1:8-15`): `-Tag` (obligatorio, formato `^v\d+$`), `-Features`, `-IdleSeconds`
(60), `-Profile` (`debug` **por defecto** | `release`), `-SkipIdleGate`, `-KeepSccache`.

Consecuencia que ya costó una entrega: **sin `-Profile release` el binario sale debug** y en otra PC
muere con `0xC0000135` por `VCRUNTIME140D.dll` / `ucrtbased.dll`. El v121 se compiló con
`-Profile release` (`last-build.json: "profile": "release"`).

### 2.2 Target dir

| pieza | ruta | evidencia |
|---|---|---|
| `CARGO_TARGET_DIR` (user env) | `C:\Aegis-Proyects\target` | `[Environment]::GetEnvironmentVariable('CARGO_TARGET_DIR','User')` |
| exe debug | `C:\Aegis-Proyects\target\debug\aegis-serve.exe` (115 249 664 B, 28/10 10:14) | `build.ps1:19` |
| exe release | `C:\Aegis-Proyects\target\release\aegis-serve.exe` (95 000 064 B, 28/10 12:15) | idem |
| tamaño | `debug` **20 103 MB**, `release` **4 970 MB**, `tmp` 0 | medición directa |
| `src\target` | no existe (fósil hasta el 2026-10-19) | `build.ps1:7` |

`build.ps1` **clava** las rutas `target\debug` / `target\release`; no lee `CARGO_TARGET_DIR`. Si esa
variable cambia, el build escribe en otro lado y el guard `STALE_SOURCE` (`build.ps1:94-100`) aborta
comparando mtime contra el último `aegis-v*.exe` de `core\bin`. Es a propósito: detecta el build que
fue a parar a un target viejo.

### 2.3 sccache: por qué hay que neutralizarlo

Configs de cargo en juego (precedencia documentada en el Cargo Book: `.cargo/config.toml` del árbol
> `$CARGO_HOME/config.toml`):

| archivo | contenido relevante |
|---|---|
| `C:\Users\Emiliano\.cargo\config.toml` (user) | `[build] rustc-wrapper = "sccache"` + `[target.x86_64-pc-windows-msvc] rustflags = ["-C","symbol-mangling-version=v0"]` |
| `C:\Aegis-Proyects\src\.cargo\config.toml` (proyecto) | `linker = "C:\Users\Emiliano\scoop\apps\llvm\current\bin\lld-link.exe"` + `rustflags = ["-C","link-args=/FORCE:MULTIPLE /STACK:8388608"]` |
| binario | `C:\Users\Emiliano\scoop\shims\sccache.exe` (daemon vivo: `sccache --show-stats` responde, 0 requests) |

Qué hace `build.ps1` (`:63-88`), en este orden y dentro de un `try/finally`:

1. `Copy-Item ~\.cargo\config.toml → config.toml.bak-build`.
2. Comenta toda línea que empiece con `rustc-wrapper` (`-replace '^rustc-wrapper', '#rustc-wrapper'`).
3. Vacía `RUSTC_WRAPPER` y `CARGO_BUILD_RUSTC_WRAPPER` en el proceso (`$env:RUSTC_WRAPPER = ''`).
4. Corre cargo. **Al final, siempre**, restaura el backup y lo borra.

Por qué las dos cosas y no solo la variable: el wrapper declarado en `config.toml` **no lo pisa una
env vacía**, hay que sacarlo del archivo (es la regla 22 de los hints globales, escrita como
"la env no alcanza"). Efecto medible de no neutralizarlo: el enlace con `lld-link` + `/FORCE:MULTIPLE`
y los `rustflags` que sccache hashea se cruzan con builds de feature sets distintos y devuelven
artefactos de otro set. `-KeepSccache` existe para saltarse todo esto a mano.

Nota de precedencia que conviene tener presente: el `.cargo/config.toml` del proyecto **gana** sobre
el del usuario para la clave `target.*.rustflags`, así que en este árbol compila con
`/FORCE:MULTIPLE /STACK:8388608` y **sin** `symbol-mangling-version=v0`.

### 2.4 Tiempos observados

De los logs reales en `C:\Aegis-Proyects\core\logs\build\`:

| tag | perfil | línea de cargo | reloj (inicio→fin del log) |
|---|---|---|---|
| v121 | release | `Finished release profile [optimized] target(s) in 4m 46s` | 12:11:04 → 12:15:52 (4m48) |
| v119 | release | `Finished release profile … in 4m 39s` | 10:41:44 → 10:48:12 (6m28, incluye 7 ciclos de idle gate) |
| v115 | release + `local-inference` | — | 08:13:48 → 08:26:22 (**12m34**, compila llama.cpp/whisper en C++) |

Lectura: con el target caliente, un release del feature set desplegado es **~4m45**; con
`local-inference` se va a **12-25 min**. Un cambio en `Cargo.toml` que refingerprintee la cadena de
dependencias cuesta 2-8 min extra.

### 2.5 Artefactos que produce

| artefacto | ruta | cuándo |
|---|---|---|
| binario de cargo | `target\{debug,release}\aegis-serve.exe` | siempre |
| **el que se despliega** | `core\bin\aegis-<Tag>.exe` (copia con hash verificado) | si exit 0 |
| registro de procedencia | `core\state\last-build.json` | siempre que llegue al final |
| log del build | `core\logs\build\build-<Tag>-<yyyyMMdd-HHmmss>.log` (UTF-8 sin BOM, se escribe línea a línea con `FileShare.Read`) | siempre |
| backup temporal de cargo config | `~\.cargo\config.toml.bak-build` | se borra en el `finally` |

Validaciones que hacen que **no** se copie nada: `Tag` inválido, `VERSION_IN_USE` (exe en uso),
`VERSION_LOCKED`, `EXITCODE != 0`, `NO_SOURCE`, `STALE_SOURCE`, `COPY_FAILED`.

Procedencia (`build.ps1:113-122`): `commit` (HEAD), `dirty`, `diffSha` (`git stash create`: si el
árbol estaba sucio, guarda un commit sintético **sin tocar** worktree ni index), `profile`, `sha256`,
`version`, `features`, `bytes`, `built_at`.

---

## 3. Deploy y rollback

### 3.1 Flujo canónico (3 pasos)

```
# 1) compilar (no toca el puntero)
powershell -File C:\Aegis-Proyects\core\ops\build.ps1 -Tag v122 -Profile release

# 2) promover el puntero SIN reiniciar (seguro desde el turno en curso)
powershell -File C:\Aegis-Proyects\core\ops\swap.ps1 -Tag v122

# 3) reiniciar, SIEMPRE desprendido del turno
powershell -File C:\Aegis-Proyects\core\ops\promote-detached.ps1 -Tag v122 -DelaySecs 45
```

Alternativa encadenada para cuando no hay turno en curso:
`build-and-promote.ps1 -Tag vNN` = `build.ps1` + guard por estado + `swap.ps1 -Restart`.

### 3.2 Qué verifica cada paso

| paso | verificación | si falla |
|---|---|---|
| `build.ps1` idle gate (`:49-56`) | `max(mtime de llm_request.*.jsonl, mtime de sessions.db-wal)` > `now-60s` ⇒ espera 15 s; techo 20 min ⇒ `IDLE_GATE_TIMEOUT` y **sigue** | sigue igual (el techo no aborta) |
| `build.ps1:58-61` | que el exe destino no sea el `ExecutablePath` de un proceso vivo | `VERSION_IN_USE`, `exit 1` |
| `build.ps1:84` | `$LASTEXITCODE` de cargo | `BUILD_FAILED`, `exit 1`, no copia |
| `build.ps1:96-100` | mtime del exe de cargo ≥ mtime del último `aegis-v*.exe` | `STALE_SOURCE`, `exit 1` |
| `build.ps1:103-105` | sha256 origen == sha256 destino | `COPY_FAILED`, `exit 1` |
| `build.ps1:107` | `aegis-vNN.exe --version` responde | (no aborta: queda en el JSON como string vacío) |
| `swap.ps1:18-20` | el exe existe y responde `--version` con exit 0 | `throw` |
| `swap.ps1:22` (`Set-AegisCurrent`) | escribe puntero atómico (`.tmp` + `Move-Item`) y recrea el hardlink `core\bin\aegis-current.exe` | `throw` si el hardlink no se puede recrear |
| `swap.ps1:26-40` | lock `core\state\ops.lock`: si otro owner lo tiene hace <30 min, aborta | `ABORTO`, `exit 1` |
| `swap.ps1:45-59` | mismo idle gate, `-IdleSeconds 25`, techo `-IdleTimeoutSecs 180` | vencido el techo, sigue igual |
| `swap.ps1:60-61` | mata **por dueño del puerto 3284** (`Get-NetTCPConnection`), no por nombre | — |
| `swap.ps1:64-68` | si existe `core\state\vacuum-pending`, corre `prune-sessions.ps1 -VacuumNow` (único momento con el serve parado) | log en el mismo swap |
| `swap.ps1:69-72` | lanza `web\scripts\start-aegis-web.ps1`, espera 6 s, verifica que 3284 escuche y reporta `pid`+`exe` | `SERVE_NOT_UP` |
| `swap.ps1:73-84` | `GET http://127.0.0.1:3284/health` == 200 | **rollback automático** (salvo `-NoRollback`) |
| `swap.ps1:86` | `GET http://127.0.0.1:3788/` (solo informa) | — |
| `verify-after-swap.ps1` | puntero vs sha vivo vs `--version` vs `/health` vs vista `v_visible_messages` vs `schema_version` vs `usage_ledger.provider` nulos 24 h vs `check-consistency.ps1` | informa, no aborta |
| `health-gate.ps1 -Deep` | puntero, `/health`, **sha del proceso vivo == sha del puntero**, web + refs de `index.html`, `node --check` de `server.mjs` y `app\*.js`, `--print-paths` exit 0, `schema_version` + `pragma quick_check`, y **turno canario real** contra el provider barato | `overall` = `sano`/`degradado`/`roto`, exit 0/1/2, escribe `core\state\health.json` |

El canario (`health-gate.ps1:162-204`) es la parte que mide por **efecto**: copia `config.yaml` +
`secrets.yaml` a `core\state\canary\config`, apunta `AEGIS_PATH_ROOT` ahí (store aislado, no ensucia
el `sessions.db` real), corre `aegis-serve.exe --run-recipe core\ops\canary.yaml` con timeout 90 s y
exige `ok` en la salida y exit 0. El recipe (`core\ops\canary.yaml`) es una línea:
`prompt: Responde unicamente con la palabra ok.` — a propósito el provider barato; si eso falla, el
harness no sirve aunque el puerto esté abierto.

### 3.3 Rollback — tres niveles

| nivel | cómo | qué restaura |
|---|---|---|
| automático | `swap.ps1:76-84`: si `/health != 200` y hay puntero previo, `Set-AegisCurrent` al exe anterior, mata el 3284, relanza y vuelve a medir `/health` | puntero + hardlink + proceso |
| manual, puntero | `swap.ps1 -Tag v120` (sin `-Restart`) y después `promote-detached.ps1 -Tag v120` | lo mismo, con control del timing |
| automático por salud | tarea programada **Aegis SelfHeal** (`install-selfheal.ps1`, cada 3 min) → `selfheal.ps1`: si `health-gate.ps1` da rojo **2 veces seguidas** (`heal-streak.json`), repone el despliegue (puntero, binario, `web\`, `state\config\`) desde `core\state\good\` y escribe `heal.log` / `heal-status.json`; todo lo que pisa va antes a `core\state\quarantine\<ts>\`. **Nunca toca `src\`.** | despliegue completo |
| artefacto | `prune-binaries.ps1` conserva 3 tags y archiva el resto en `core\bin\backups\binaries-pruned-<ts>`, nunca toca el binario en uso | — |

Consecuencia no obvia del selfheal: **el puntero se mueve solo**. Un paquete portable que lea
`current-version.json` para elegir exe puede agarrar un `aegis-v114-heal081012.exe` en medio del
armado; el sha del paquete se toma de `last-build.json`, no del puntero (skill `aegis-portable-package`,
trampa medida el 2026-10-28).

### 3.4 Ops legado (no usar)

| script | estado | por qué |
|---|---|---|
| `build-and-swap.ps1` | **legado** | habla de `build-safe.ps1` y `target\debug\aegis-<Version>.exe`; encadena build+swap en el mismo proceso, que es justo lo que mata un turno |
| `build-and-promote.ps1` | vigente pero secundario | encadena `build.ps1` + `swap.ps1 -Restart` con `-IdleSeconds 0 -IdleTimeoutSecs 2` (sin gate): solo sirve si **nadie** está usando el harness |
| `swap-y-restart-desprendido.ps1`, `v120-build-swap.ps1`, `v121-build-swap.ps1` | one-shot por versión | se reemplazan por `build.ps1`/`swap.ps1` parametrizados |
| `promote-detached.ps1` | **vigente** | `Start-Process` con redirección a archivo, **no** tubería: con `| Out-File` el serve nuevo hereda los handles y la tubería nunca recibe EOF (pasó en v84) |

---

## 4. Convivencia de instancias

### 4.1 Qué puede estar vivo

| proceso | puerto | quién lo arranca | evidencia |
|---|---|---|---|
| `core\bin\aegis-vNN.exe --host 0.0.0.0 --port 3284 --platform desktop --enable-scheduler --with-builtin developer --allowed-origin …` | 3284 | `Aegis Serve` (tarea programada) → `core\ops\aegis-serve-launch.vbs`; y `swap.ps1:69` → `web\scripts\start-aegis-web.ps1` | pid 14468 hoy |
| `node.exe …\web\dist-ts\server.mjs` | 3788 http / 3789 https | `Aegis_Web` (tarea) → `web\scripts\aegis-web-launch.vbs`; y `start-aegis-web.ps1:78` | pid 5016 hoy, con `dist-ts`, no `web\server.mjs` |
| `cloudflared` (quick tunnel) | saliente | `Aegis_Web_Tunnel` → `web\scripts\aegis-web-tunnel.vbs loop` | no medido en esta pasada |
| `wscript.exe aegis-serve-launch.vbs` | — | tarea `Aegis Serve` | — |

El lanzador resuelve el exe **desde el puntero** (`aegis-serve-launch.vbs:11,23-29`) y es idempotente:
si ya hay un `aegis-v%.exe` en WMI, sale con 0 (`:16-21`). `start-aegis-web.ps1:38-74` hace lo mismo
por puerto. Por eso "reiniciar" en la práctica es: matar el dueño del 3284 y volver a correr el
launcher.

Flags que importan del lanzador: `--host 0.0.0.0` (expone LAN), 8 `--allowed-origin` (LAN http/https,
loopback http/https y la URL del túnel), `--with-builtin developer`, `--enable-scheduler`.

`AEGIS_SERVER__SECRET_KEY` es obligatorio: sin él `aegis-serve` hace `bail!` (`crates\aegis-server\src\main.rs:238-247`)
salvo `--dangerously-unauthenticated`. Lo setea `start-aegis-web.ps1:40` desde `web\config.json`
(`secretKey`, enmascarado acá). Otras tareas programadas vivas que pueden escribir estado:
`Aegis_Consistency`, `Aegis_Prune_*` (4), `Aegis-MemoryConsolidate`, `Aegis-EvalSuite`,
`Aegis Zombie Watchdog`, `AegisElevated`, `Aegis Backup Local`, más tres one-shot del 27-28/10
(`aegis-restart-limite`, `aegis-restart-singate`, `aegis-swap-v114`) que apuntan a `core\tmp\restart2.ps1`
y `core\tmp\swap-v114.ps1`: **basura operativa que sigue armada y se puede disparar**.

### 4.2 Cómo se evita matar el turno en curso

Regla dura: **el proceso que hospeda la conversación es el `aegis-vNN.exe` del 3284**. Matarlo desde
dentro del turno mata el turno. Los tres mecanismos del repo:

1. **Gate de inactividad** en `build.ps1` (60 s) y `swap.ps1` (25 s, techo 180 s), siempre midiendo
   los dos archivos que escribe un turno de verdad: `state\state\logs\llm_request.*.jsonl` y
   `state\data\sessions\sessions.db-wal`. (Las versiones viejas miraban `%APPDATA%\Aegis`, que no
   existe desde la migración del 15/10 ⇒ el gate daba "idle" siempre. Está corregido en ambos.)
2. **`promote-detached.ps1`**: se lanza con `Start-Process` sobre un `.ps1` que duerme `-DelaySecs`
   (45 por defecto) y escribe su verificación a `core\logs\swap-<tag>.log` + `post-swap-<tag>.log`.
   `swap.ps1 -Restart` **nunca** se corre desde el turno.
3. **`build-and-promote.ps1 -NoRestart`** o `swap.ps1 -Tag` sin `-Restart`: cambiar el puntero sin
   tocar el proceso. El serve vivo sigue con el binario viejo (que ya está deslinkeado en disco) hasta
   el próximo reinicio; `/health` y `check-consistency.ps1` lo detectan como desincronizado.

`check-consistency.ps1` es la red que detecta el desfase puntero ≠ vivo ≠ hardlink, incluyendo el
caso normal (el vivo corre desde `aegis-current.exe`, hardlink del `aegis-vNN.exe` del puntero: mismo
inodo, se acepta por `fsutil hardlink list`, `:19-34`).

---

## 5. Config y resolución de paths

### 5.1 Precedencia

`Config::get_param` (`crates\aegis\src\config\base.rs:773-795`), en orden estricto:

1. **env var con el nombre de la clave en mayúsculas** (`AEGIS_MODE` → `AEGIS_MODE`). Gana siempre.
2. merge de todos los `config_paths`: **sistema** (`system_config_path()`) → **`AEGIS_ADDITIONAL_CONFIG_FILES`** (`base.rs:176,206`) → **usuario** `Paths::config_dir()/config.yaml` (`base.rs:203,207`).

Los secretos van por otra vía (`base.rs:397-415`): con keyring deshabilitado
(`AEGIS_DISABLE_KEYRING`) o en el archivo, `config_dir\secrets.yaml`; si no, keyring del SO
(servicio `windows-native` en Windows).

CLI **no** entra en esta precedencia genérica: los flags de `aegis-serve` se aplican a lo suyo
(`--host`, `--port`, `--allowed-origin`, `--tls*`), y hay dos excepciones explícitas —
`--tls-cert-path`/`--tls-key-path` caen a `AEGIS_TLS_CERT_PATH`/`AEGIS_TLS_KEY_PATH` del config
(`main.rs:281-289`), y `AEGIS_SERVER__SECRET_KEY` (env) es condición de arranque, no una clave de
config (`main.rs:24,238`).

### 5.2 Dónde vive cada archivo (medido)

| archivo | ruta real | contenido |
|---|---|---|
| `config.yaml` | `C:\Aegis-Proyects\state\config\config.yaml` (4 123 B) | 13 claves: `AEGIS_MODE=auto`, `AEGIS_AUTO_COMPACT_TOKEN_LIMIT=500000`, `AEGIS_TURN_TOOL_CALL_LIMIT=10000`, `AEGIS_THINKING_EFFORT=max`, `AEGIS_MEMORY_EXTRACT_PROVIDER=chatgpt_codex`, `AEGIS_MEMORY_EXTRACT_MODEL=gpt-6-luna`, `AEGIS_TOOL_PAIR_SUMMARIZATION=true`, `AEGIS_TOOL_PAIR_COMPACT_MIN_RATIO=0.65`, `SECURITY_PROMPT_ENABLED=false`, `AEGIS_WORKSPACE_SANDBOX=false`, `OPENAI_HOST=http://127.0.0.1:61249`, `extensions:`, `providers:` (`active_provider: open_design`), `LOCAL_WHISPER_MODEL=base`, `LOCAL_WHISPER_LANGUAGE=es`, `AEGIS_VISIBLE_PROVIDERS=open_design,opencode_go,experiential,chatgpt_codex,antigravity` |
| `secrets.yaml` | idem (487 B) | 8 claves **en claro** (`SHARED_API_KEY`, `OPEN_DESIGN_API_KEY`, `EXPERIENTIAL_API_KEY`, `OPENAI_API_KEY`, `OPENAI_PROJECT_API_KEY`, `XAI_API_KEY` y dos `CUSTOM_SHARED_SECRET_*`) — valores enmascarados acá a propósito |
| `permission.yaml` | idem (574 B) | `user:` → `always_allow:` 24 tools (incluye `shell`, `edit`, `write`, `read_file`, `delegate`, `memory__*`, `mode__request_mode`), `ask_before: []`, `never_allow: []`. Parser: `crates\aegis\src\config\permission.rs:13,28-32,71-85` (`PermissionConfig { always_allow, ask_before, never_allow }`) |
| `.lock` de cada uno | `permission.yaml.lock` (0 B), `secrets.yaml.lock` (0 B) | locks de escritura concurrente |
| tokens OAuth | `state\config\chatgpt_codex\tokens.json`, `state\xdg\opencode\auth.json` | rotan; no copiar a mano |
| store | `state\data\sessions\sessions.db` | SQLite |
| logs de request | `state\state\logs\llm_request.*.jsonl` | **no** `state\data\logs` (fósil congelado desde el 15/10) |
| skills | `state\config\skills\<nombre>\SKILL.md` | globales |
| config de la web | `web\config.json` | `webPort 3788`, `httpsPort 3789`, `tlsDir core\state\tls`, `servePort 3284`, `publicHost 192.168.100.34`, `secretKey` (enmascarado), `appConfig.AEGIS_PATH_ROOT=C:/Aegis-Proyects/state`, `appConfig.AEGIS_WORKING_DIR=C:\Users\Emiliano` |

`secrets.yaml` en claro es una decisión de esta máquina, no un bug: se compensa con que el store
(`state\`) es local y no viaja en el ZIP salvo por lo que el script de empaquetado elige.

### 5.3 `AEGIS_PATH_ROOT` — la raíz del store

`crates\aegis\src\config\paths.rs:8-46`:

- Si `AEGIS_PATH_ROOT` existe **y es absoluta** (`validated_path_root`, `:44-46`), cada carpeta es
  `base\{config,data,state}` + `base\.agents\{plugins,agents}`.
- Si no existe (o es relativa, o vacía), cae a `etcetera::choose_app_strategy`:
  `%APPDATA%\Aegis\aegis` en Windows. **Ese path no existe en esta máquina**; la variable de usuario
  `AEGIS_PATH_ROOT=C:\Aegis-Proyects\state` es lo que sostiene todo el despliegue. Si se pierde, el
  harness arranca con un store vacío en `%APPDATA%` y "no aparece nada" (store sin sesiones, sin
  providers, sin skills).

Salida real de `aegis-v121.exe --print-paths` con `AEGIS_PATH_ROOT=C:\Aegis-Proyects\state`
(`crates\aegis-server\src\main.rs:163-179`, los 8 renglones):

```
config_dir    C:\Aegis-Proyects\state\config
config.yaml   C:\Aegis-Proyects\state\config\config.yaml
data_dir      C:\Aegis-Proyects\state\data
sessions.db   C:\Aegis-Proyects\state\data\sessions\sessions.db
state_dir     C:\Aegis-Proyects\state\state
logs_dir      C:\Aegis-Proyects\state\state\logs
agents_home   C:\Aegis-Proyects\state\.agents
version       1.54.0
```

Ese comando es la respuesta corta a "¿dónde corre esto?" y es también el check `config` del
`health-gate` (exit 0 = `config.yaml` parsea). `state_dir` anidado dentro de la raíz
(`state\state\logs`) confunde a todo el mundo una vez: los logs vivos están en `state\state\logs`.

Variables de entorno relevantes al arranque (SET por `start-aegis-web.ps1`):

| variable | valor | línea |
|---|---|---|
| `AEGIS_SERVER__SECRET_KEY` | de `web\config.json` | `:40` |
| `AEGIS_PATH_ROOT` | `C:\Aegis-Proyects\state` si existe `state\data` | `:32` |
| `AEGIS_SHELL` | `powershell` | `:33` |
| `AEGIS_WEB_TLS_DIR` | `core\state\tls` | `:15` |
| `AEGIS_WEB_HTTPS_PORT` | `3789` | `:16` |
| `AEGIS_WEB_ROOT` | `react` si existe `web\state\use-react-client` | `:19` |

### 5.4 Paquete portable — contraste con la skill

La skill `aegis-portable-package` (`state\config\skills\aegis-portable-package\SKILL.md`) describe
el paquete vigente `v121 localhost`: **39 entradas, 63,1 MB de ZIP sobre 174,4 MB, exe release
`ECFE44C1…`**. Contra el disco, hoy:

| afirmación de la skill | verificación |
|---|---|
| el exe del paquete es el release `ECFE44C1…` del commit `660d9ff2c` | **coincide**: puntero y `last-build.json` dicen exactamente ese sha y ese commit, `profile: release`, 95 000 064 B |
| `build.ps1` compila debug por defecto (trampa 0) | **coincide**: `build.ps1:12` `[string]$Profile = 'debug'` |
| el puntero lo puede mover selfheal | **coincide**: `Aegis SelfHeal` activo cada 3 min, `selfheal.ps1` escribe `current-version.json` |
| la web del paquete sale de `web\dist-ts` (la que sirve el 3788 vivo) | **coincide**: el proceso vivo es `node … web\dist-ts\server.mjs` (pid 5016) |
| `AEGIS_PATH_ROOT` gobierna las rutas y hay overrides `AEGIS_SERVE_BIN`/`AEGIS_SESSIONS_DB` | **coincide** con `paths.rs` para el store; los overrides son del `server.mjs`, no del binario Rust (no auditado acá: ver §9) |
| el `sccache` hay que neutralizarlo para buildear | **coincide y está en el script**, no en la skill: `build.ps1:63-88` |

Lo que la skill **no** cubre y sí afecta al paquete: que `scripts\build-portable.ps1`,
`verify-portable.ps1` y `canary-portable.ps1` viven en `C:\Aegis-Proyects\scripts`, fuera del
alcance de este documento (no auditados).

---

## 6. CI (GitHub Actions)

**No hay CI.** Evidencia dura, tres fuentes independientes:

| comprobación | resultado |
|---|---|
| `Get-ChildItem C:\Aegis-Proyects\src\.github -Recurse -File` | 8 archivos: `copilot-instructions.md`, `dependabot.yml`, `actions\apple-codesign\action.yml`, `actions\generate-release-pr-body\{action.yaml,pr_body_template.txt}`, `recipes\code-review.yaml`, `scripts\pr-review-mcp.py`, `scripts\repair-v8-prebuilt.sh`. **Cero `workflows\`** |
| `git ls-tree -r --name-only HEAD .github` | los mismos 8; nada de `workflows/` en el índice |
| `git show --diff-filter=D --name-only 1443e804d -- .github/workflows` | commit **`1443e804d` (2026-10-20)** *chore: purga el andamiaje del upstream (ui, services, buzz, oidc, ci, blog)*: **43 workflows** borrados (`ci.yml`, `release.yml`, `bundle-windows.yml`, `canary.yml`, `cargo-deny.yml`, `code-review.yml`, …). `git ls-tree origin/main .github/workflows` = 43, `upstream/main` = 43: los tres números coinciden |
| `gh api repos/emilianodamir874/aegis-harness/actions/workflows --jq '.total_count'` | `0` |
| `gh run list --repo emilianodamir874/aegis-harness` | sin salida (ningún run) |

Lo que **sí** queda y sigue apuntando al upstream: `dependabot.yml`, `copilot-instructions.md`, dos
actions de release (`apple-codesign`, `generate-release-pr-body`), un recipe de code-review y dos
scripts (`pr-review-mcp.py`, `repair-v8-prebuilt.sh`). Nada de eso corre en GitHub Actions sin un
workflow que lo invoque: son archivos huérfanos.

Consecuencia práctica: **el único gate de compilación es local** y son los comandos del `Justfile`
recortado (`src\Justfile:1-5` documenta la poda del 2026-10-20):

| recipe | comando |
|---|---|
| `check-everything` | `cargo fmt --all` + `cargo clippy --all-targets -- -D warnings` |
| `check-lib` | `cargo check -p aegis --lib --no-default-features --features rustls-tls,tree-sitter,live-voice,scheduler,platform-apps,chat-recall,acp-http` |
| `check-serve` | `cargo check -p aegis-server --bin aegis-serve --no-default-features --features rustls-tls,scheduler,bundled-mcp,chat-recall,acp-http` |
| `check-tests` | `cargo check --tests -p aegis-server --no-default-features --features rustls-tls,scheduler,bundled-mcp,chat-recall` |
| `test-lib` | `cargo test -p aegis --lib --no-default-features --features <set CI>` |
| `test-providers` | `cargo test -p aegis --features scheduler --lib providers::antigravity::tests` + `providers::open_design::tests` |
| `build-cli` | **desactualizado**: `--features rustls-tls,scheduler,bundled-mcp` y el nombre `build-cli` para construir el *serve* |
| `ship` | `cargo rustc … -- -o "${CARGO_TARGET_DIR:-target}/debug/{{name}}.exe"` — escribe en `$CARGO_TARGET_DIR` si está, o sea **`C:\Aegis-Proyects\target\debug`**, no `src\target` |
| `run-server` | levanta en `127.0.0.1:3000` con `AEGIS_SERVER__SECRET_KEY=test`; usa sintaxis de env bash (`VAR=x cargo …`) que PowerShell no interpreta |
| `snap` | `$env:INSTA_UPDATE="always"` — sintaxis PowerShell, o sea el Justfile está escrito para este host, no para CI |

El Justfile mezcla sintaxis bash y PowerShell en el mismo archivo: como no hay CI que lo corra, no
importa, pero **no es portable** si algún día se restaura un runner.

---

## 7. Local vs GitHub

| pieza | existe solo local | atrasado en `origin/main` (`aegis-harness`) | upstream goose puro |
|---|---|---|---|
| `crates\aegis-server` | **sí** — reemplaza a `goose-cli`; no existe en upstream | — | — |
| `goose-cli` (TUI + CLI) | **no existe** (borrado 2026-10-20) | — | sí, upstream lo tiene |
| los otros 14 crates | renombrados + modificados | están en `origin/main` con el nombre viejo `goose-*` | base |
| `.github\workflows\*` (**43**) | **no existen** (borrados en `1443e804d`) | sí, `origin/main` los tiene (43) | sí (43) |
| `ui\`, `services\`, `buzz\`, `oidc-proxy\`, `blog\` | **no existen** | sí | sí |
| `Justfile` | recortado a **58 líneas** (el propio header dice que el de upstream tenía 546 y se recortó el 2026-10-20, `Justfile:1-5`) | versión completa | completa |
| `src\Cargo.toml` | `[workspace.package]` con autor/descripción propios, feature `portable-default` (sin uso), `[profile.lean]`, `[patch.crates-io]` de `cudaforge` a un rev fijo | versión upstream | versión upstream |
| `.cargo\config.toml` | `lld-link` absoluto + `/FORCE:MULTIPLE /STACK:8388608` | no existe con ese contenido | no existe |
| rama de trabajo | `feat/antigravity-provider` = `8d559d0b5`, **139 commits adelante de `origin/main`, 26 atrás de `upstream/main`** | `origin/main` = `3bd852002` (2026-10-09, *agent-loop: changed yield_to_customer to next enum (#12789)*), y **es ancestro** de HEAD | `upstream/main` = `0df818175` (2026-10-15, *docs: correct toggle sidebar shortcut (#12901)*) |
| push | la rama **no está pusheada**: sólo existe en `backup` (`aegis-src`), ahead 79 | — | — |

`origin` = `https://github.com/emilianodamir874/aegis-harness.git`, `backup` =
`.../aegis-src.git`, `upstream` = `https://github.com/block/goose.git`. El `origin/main` del fork es
un espejo de goose del 2026-10-09; **nada del fork está en `origin`**: 0 workflows, y el trabajo vive
en la rama local + el backup.

---

## 8. Mapa de piezas (ruta:línea → qué hace → quién la llama)

### 8.1 Código

| ruta:línea | qué hace | quién la llama |
|---|---|---|
| `src\Cargo.toml:2-5` | `members = ["crates/*"]` | cargo |
| `src\Cargo.toml:11` | `rust-version = "1.94.1"` (mínimo declarado) | cargo |
| `src\Cargo.toml:119-120` | `debug=false` para dependencias | perfiles de cargo |
| `src\rust-toolchain.toml:2` | `channel = "1.99.0"` | rustup |
| `src\.cargo\config.toml:5-6` | linker `lld-link` absoluto + `/FORCE:MULTIPLE /STACK:8388608` | cargo (gana sobre el config del usuario) |
| `crates\aegis-server\Cargo.toml:14-16` | declara el bin `aegis-serve` | `build.ps1` |
| `crates\aegis-server\Cargo.toml:20-26` | default de features | cargo, `swap`, `Justfile` |
| `crates\aegis\Cargo.toml:94-104` | `portable-default` (sin uso) | — |
| `crates\aegis\src\config\paths.rs:8-38` | `get_dir` por `DirType` | todo el crate |
| `crates\aegis\src\config\paths.rs:40-46` | `validated_path_root`: exige absoluta | `get_dir` |
| `crates\aegis\src\config\base.rs:200-232` | `Config::default`: arma `config_paths` (sistema → additional → usuario) y elige keyring/archivo | `Config::global()` |
| `crates\aegis\src\config\base.rs:757-795` | precedencia env → yaml | todo `get_param` |
| `crates\aegis\src\config\base.rs:397-415` | `secrets.yaml` vs keyring | lectura de secretos |
| `crates\aegis\src\config\permission.rs:13,28-32,71-85` | `permission.yaml` → `PermissionManager` | capa de tools |
| `crates\aegis-server\src\main.rs:24` | `SECRET_KEY_ENV = "AEGIS_SERVER__SECRET_KEY"` | arranque |
| `crates\aegis-server\src\main.rs:163-179` | `--print-paths` (8 líneas) | `health-gate`, smoke del portable |
| `crates\aegis-server\src\main.rs:238-252` | exige secret o `--dangerously-unauthenticated` | arranque |
| `crates\aegis-server\src\main.rs:280-289` | TLS por flag o por config | arranque |

### 8.2 Ops (`C:\Aegis-Proyects\core\ops\`)

| ruta:línea | qué hace | quién la llama |
|---|---|---|
| `_pointer.ps1:3-6` | `AegisRoot=core`, `PointerFile=core\state\current-version.json`, `BinDir=core\bin`, `ServePort=3284` | dot-source de todos |
| `_pointer.ps1:8-11` | `Get-AegisCurrent` | swap, check-consistency, health-gate, prune-binaries |
| `_pointer.ps1:13-20` | `Refresh-AegisCurrentLink` (hardlink `aegis-current.exe`) | `Set-AegisCurrent` |
| `_pointer.ps1:22-51` | `Set-AegisCurrent`: escribe puntero atómico + hardlink | `swap.ps1:22`, rollback `:78`, selfheal |
| `_pointer.ps1:53-57` | `Get-AegisLiveServe` (dueño del 3284) | `check-consistency` |
| `build.ps1:37-56` | `Last-ModelWrite` + idle gate | sí mismo |
| `build.ps1:58-61` | guard `VERSION_IN_USE` / `VERSION_LOCKED` | sí mismo |
| `build.ps1:63-88` | neutraliza/restaura sccache en `~\.cargo\config.toml` | sí mismo |
| `build.ps1:70` | invocación exacta de cargo | sí mismo |
| `build.ps1:90-100` | guard `STALE_SOURCE` (mtime) | sí mismo |
| `build.ps1:102-107` | copia + sha256 + `--version` | sí mismo |
| `build.ps1:113-123` | `last-build.json` (procedencia: commit, dirty, diffSha) | `build-and-promote`, `check-consistency`, `build-portable` |
| `swap.ps1:18-20` | valida exe y `--version` | sí mismo |
| `swap.ps1:22-24` | escribe puntero; sin `-Restart` termina acá | operador |
| `swap.ps1:26-40` | lock `core\state\ops.lock` | swap ↔ wipe ↔ prune |
| `swap.ps1:45-59` | idle gate (25 s / techo 180 s) | sí mismo |
| `swap.ps1:60-61` | mata el dueño del 3284 | sí mismo |
| `swap.ps1:64-68` | drena `core\state\vacuum-pending` vía `prune-sessions.ps1 -VacuumNow` | `prune-sessions.ps1` |
| `swap.ps1:69-72` | lanza `web\scripts\start-aegis-web.ps1` y confirma puerto | sí mismo |
| `swap.ps1:73-84` | `/health` + **rollback** | sí mismo |
| `promote-detached.ps1:20-38` | swap diferido con logs a `core\logs\swap-<tag>.log` | operador (desprendido) |
| `promote-detached.ps1:41-51` | verificación a `core\logs\post-swap-<tag>.log` | idem |
| `build-and-promote.ps1:26-39` | build + guard por `last-build.json` | operador |
| `health-gate.ps1:49-85` | puntero, `/health`, sha vivo vs puntero | `selfheal.ps1:281`, `install-selfheal.ps1:14` |
| `health-gate.ps1:87-112` | web + refs de `index.html` | idem |
| `health-gate.ps1:114-131` | `node --check` de `server.mjs` + `app\*.js` | idem |
| `health-gate.ps1:133-142` | `--print-paths` (config parsea) | idem |
| `health-gate.ps1:144-160` | `schema_version`, `quick_check` | idem |
| `health-gate.ps1:162-204` | turno canario con store aislado (`core\state\canary`) | `-Deep` |
| `canary.yaml:6` | `prompt: Responde unicamente con la palabra ok.` | `health-gate -Deep`, `canary-portable.ps1` |
| `verify-after-swap.ps1:4-33` | verificación post-swap por estado (puntero, sha, `/health`, vista `v_visible_messages`, `schema_version`, `usage_ledger` sin provider, `check-consistency`) | `promote-detached.ps1:45` |
| `check-consistency.ps1:29-84` | puntero = vivo = hardlink + procedencia del build | tarea `Aegis_Consistency`, `verify-after-swap` |
| `selfheal.ps1:1-9,281-306` | si el gate da rojo 2 veces, repone despliegue desde `core\state\good\` (nunca `src\`) | tarea `Aegis SelfHeal` cada 3 min |
| `install-selfheal.ps1:1-14` | instala/desinstala esa tarea | operador |
| `aegis-serve-launch.vbs:11-44` | lanza el exe del puntero si no hay ningún `aegis-v%.exe` vivo | tarea `Aegis Serve` |
| `prune-binaries.ps1:1-6` | conserva 3 tags, archiva el resto | tarea `Aegis_Prune_Binaries` |
| `prune-artifacts.ps1:1-4` | retención de incremental de cargo / temp (`-Days 14`) | tarea `Aegis_Prune_Artifacts` |
| `prune-logs.ps1:1-7` | 14 días o 200 MB por carpeta | tarea `Aegis_Prune_Logs` |
| `prune-sessions.ps1:1-8` | retención del store sin parar el serve; VACUUM diferido a `core\state\vacuum-pending` | tarea `Aegis_Prune_Store`, `swap.ps1:67` |
| `backup-local.ps1:1-8` | backup a `D:\backup` | tarea `Aegis Backup Local` |
| `build-and-swap.ps1:1-8` | **legado** (build-safe + swap en un proceso) | nadie |

### 8.3 Web (arranque del backend, fuera del alcance `src`)

| ruta:línea | qué hace |
|---|---|
| `web\config.json` | puertos 3284/3788/3789, `publicHost`, `secretKey` |
| `web\scripts\start-aegis-web.ps1:22-29` | resuelve el exe **del puntero**, fallback `aegis-current.exe` |
| `web\scripts\start-aegis-web.ps1:38-74` | si 3284 libre: setea secret + arma `--allowed-origin` (incluye la URL del túnel leída de `tunnel-url.txt`) y lanza |
| `web\scripts\start-aegis-web.ps1:76-83` | si 3788 libre: `node server.mjs` en `-WorkingDirectory C:\Aegis-Proyects\web` |
| `web\scripts\start-aegis-web.ps1:60-64` | decide `aegis-serve` vs `aegis serve` por `--version`, no por nombre |

---

## 9. Invariantes y trampas

1. **`build.ps1` sin `-Profile release` produce un binario que no arranca en otra PC.**
   `[string]$Profile = 'debug'` (`build.ps1:12`). Síntoma: `0xC0000135`, imports de
   `VCRUNTIME140D.dll`/`ucrtbased.dll`.
2. **El puntero, el hardlink y el proceso vivo son tres cosas distintas** y `swap.ps1` las mueve
   juntas; `swap.ps1 -Tag` sin `-Restart` las desincroniza a propósito. Nada es "el deploy" hasta que
   `check-consistency.ps1` sale 0.
3. **El gate de inactividad mira `llm_request.*.jsonl` y `sessions.db-wal`, no procesos.** Un turno
   que se queda pensando sin escribir no frena el gate; un turno largo sí. El techo del gate **no
   aborta**, sigue.
4. **La ruta del log del build es doble y una puede no existir.** `build.ps1:26` lo escribe en
   `$AegisRoot\logs\build` = `core\logs\build`, y el header de la skill menciona
   `core\state\logs\build`. La real medida es `C:\Aegis-Proyects\core\logs\build\` (ahí están
   v115…v121). El log se escribe línea a línea con `FileShare.Read`: se puede leer en vivo, y con
   UTF-8 sin BOM (el `>` de PS 5.1 escribía UTF-16 y los lectores veían NUL).
5. **`swap.ps1` calcula una ruta que no existe**: `$opsLock = Join-Path $AegisRoot 'core\state\ops.lock'`
   (`:27`) con `$AegisRoot = 'C:\Aegis-Proyects\core'` da `C:\Aegis-Proyects\core\core\state\ops.lock`
   (verificado: no existe). El mutex funciona igual porque crea la ruta nueva, pero **no protege el
   `vacuum-pending` real** (`core\state\vacuum-pending`, que sí es correcto en `:64`).
6. **sccache hay que sacarlo del archivo, no de la env.** `~\.cargo\config.toml` declara
   `rustc-wrapper = "sccache"`; `build.ps1` lo comenta y después restaura. Si una corrida se corta
   antes del `finally`, **el config del usuario queda con el wrapper comentado** (el `.bak-build`
   también queda).
7. **`CARGO_TARGET_DIR` está fijado en el perfil del usuario**, no en el repo. Otro usuario/máquina
   compila en `src\target` y el guard `STALE_SOURCE` lo detecta (o, si no hay `core\bin\aegis-v*.exe`,
   no detecta nada).
8. **El store depende de una variable de entorno de usuario.** Sin `AEGIS_PATH_ROOT`, todo cae a
   `%APPDATA%\Aegis\aegis` (inexistente) y el harness arranca vacío sin un solo error visible.
   `state\state\logs` (doble `state`) es normal, no un typo.
9. **La web del paquete y la del host no son el mismo archivo.** El proceso vivo corre
   `web\dist-ts\server.mjs`; `start-aegis-web.ps1:78` lanza `server.mjs` con `-WorkingDirectory web`.
   Cambiar `web\server.mjs` no cambia lo que sirve el 3788 hasta que se recompila `dist-ts`.
10. **`AegisSelfHeal` puede mover el puntero en medio de un empaquetado** (cada 3 min). El sha del
    paquete se toma de `last-build.json`, no del puntero.
11. **El exe desplegado se compiló desde un árbol sucio** y `check-consistency.ps1:65-68` lo marca
    como `INCONSISTENTE`. Para dejar el árbol limpio hace falta commitear (`8bd76afc` es el
    `stash create` del estado exacto que se compiló).
12. **`--allowed-origin` no acepta `*`** (`main.rs:259-261`): agregar un origen es tocar
    `start-aegis-web.ps1` o el `.vbs`, no un comodín.
13. **`aegis.cmd` del PATH ≠ el serve vivo.** Resuelve `core\bin\aegis-current.exe`;
    `_pointer.ps1:59-65` (`Get-AegisCliExe`) busca el `aegis-v*.exe` más nuevo de
    `target\debug`, que es un artefacto de build, no un despliegue.

---

## 10. Huecos, riesgos y deuda técnica

| # | hueco | evidencia | impacto |
|---|---|---|---|
| 1 | **Sin CI**: 0 workflows locales y 0 en el remoto | §6 (4 verificaciones) | nada impide mergear código que no compila; el único gate es `cargo check` manual |
| 2 | **El fork no está pusheado**: 139 commits adelante de `origin/main`, rama local sólo espejada en `backup` | `git rev-list --left-right --count HEAD...origin/main` = `139 0`; `git branch -vv` | pérdida del árbol si se pierde el disco; el "repo de GitHub" no es el repo |
| 3 | **`target` = 25 GB** (20 103 MB debug + 4 970 MB release) | medición | `prune-artifacts.ps1` corre cada día (`-Apply`, `-Days 14`) y aun así no baja; `cargo clean -p aegis-server` no está en ningún script |
| 4 | **`ops.lock` en la ruta equivocada** | `swap.ps1:27` vs `Test-Path core\core` = False | swap y prune pueden pisarse el `vacuum-pending` |
| 5 | **Tres tareas programadas one-shot del 27-28/10** apuntando a `core\tmp\restart2.ps1` y `core\tmp\swap-v114.ps1` | `Get-ScheduledTask` | un disparo accidental reinicia el serve con lógica vieja, fuera de todo gate |
| 6 | **Justfile mitad bash, mitad PowerShell**; `build-cli` ya no coincide con el feature set del serve y el nombre miente | `src\Justfile:35-36,55-58` | instructions que se copian y fallan |
| 7 | **`.github` con 8 archivos huérfanos** (2 actions de release, dependabot, code-review) que nadie invoca | §6 | ruido: parece que hay automatización y no hay |
| 8 | **`secrets.yaml` en claro** con 8 claves, incluidas dos de proveedores de pago | §5.2 (valores enmascarados) | cualquier script que copie el `state\` entero filtra todo; la skill del portable insiste en filtrar por nombre |
| 9 | **`portable-default` sin uso** y sin nadie que lo valide | `crates\aegis\Cargo.toml:94-104` | feature set que se pudre en silencio |
| 10 | **El idle gate del build espera 20 min y después sigue**: no falla, así que un build puede arrancar con un turno escribiendo | `build.ps1:49-56` | compite con el serve; los turnos se arrastran |
| 11 | **`build-and-swap.ps1` sigue en `core\ops`** y referencia `build-safe.ps1` (que ya no es el camino) | `build-and-swap.ps1:1-8` | trampa para el próximo que lea ops por nombre |
| 12 | **`verify-after-swap.ps1` está clavado a v76**: exige `v_visible_messages` y "sin `code_execution`" | `verify-after-swap.ps1:1-2,24-27` | si esa vista/migración cambia, el post-swap reporta fallo sin que haya fallo |
| 13 | **El árbol de trabajo tiene 55 entradas sucias y 3 `.bak` dentro de `crates\`** | `git status --porcelain`; `crates\aegis\src\acp\server.rs.bak-local-titles`, `…\tool_calls\enrichment.rs.bak-local-titles`, `…\tool_call_labels.rs.bak-local-titles` | viola la regla "los `.bak` van fuera del repo"; `check-consistency` marca el build como sucio |

---

## 11. Referencias web

- Cargo — jerarquía y precedencia de configuración (`config.toml` del árbol gana sobre
  `$CARGO_HOME/config.toml`): https://doc.rust-lang.org/cargo/reference/config.html
- Cargo — variables de entorno que cargo lee y cómo se pasan al compilador
  (`RUSTC_WRAPPER`, `CARGO_TARGET_DIR`): https://doc.rust-lang.org/cargo/reference/environment-variables.html
- sccache (wrapper de compilador, caché local/remota): https://github.com/mozilla/sccache
- Rust — canal de toolchain declarado por `rust-toolchain.toml`:
  https://rust-lang.github.io/rustup/overrides.html
- GitHub Actions — workflows (lo que **no** hay en este repo):
  https://docs.github.com/en/actions/using-workflows/about-workflows
- GitHub Actions — disparadores (`on:`): https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows
- goose (upstream): `https://github.com/block/goose` hoy redirige a **`https://github.com/aaif-goose/goose`**
  (verificado con fetch; el nombre del proyecto cambió de dueño). La página de instalación
  `https://block.github.io/goose/docs/getting-started/installation` devuelve **404**, así que no se
  cita como fuente viva.
- Listado de crates del upstream usado para la comparación:
  `gh api repos/block/goose/contents/crates --jq '.[].name'` (sigue respondiendo pese al redirect).

---

## 12. No verificado

- **`scripts\build-portable.ps1`, `verify-portable.ps1`, `canary-portable.ps1`**: fuera del alcance
  asignado; la sección §5.4 sólo contrasta la skill contra el estado del disco, no audita esos scripts.
- **Overrides `AEGIS_SERVE_BIN` / `AEGIS_SESSIONS_DB` / `AEGIS_WORKSPACE_ROOTS`**: la skill los
  atribuye a `web\server.mjs`; no los busqué en el JS (es capa web, no de build).
- **`cloudflared` / túnel**: no se comprobó si el proceso del túnel está vivo hoy ni cuál es la URL
  vigente (`web\tunnel-url.txt` y `Aegis_Web_Tunnel` existen; no se ejecutó nada).
- **Contenido de `core\state\good\`** (la foto que repone selfheal): no se listó; se afirma sólo lo
  que dice el encabezado de `selfheal.ps1:1-6`.
- **Tiempo de build en frío** (target limpio): no medido. Los 4m46 son con target caliente.
- **Funcionamiento real del rollback de `swap.ps1`**: leído, no disparado (no se reinició nada).
- **`gh run list`**: devolvió salida vacía sin error; se interpreta como "no hay runs", consistente
  con `actions/workflows total_count = 0`. No se distingue de un fallo silencioso de `gh` en ese
  endpoint.
- **Estado del binario release para otra arquitectura / otra PC**: no probado en esta sesión.

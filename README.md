# C:\Aegis-Proyects

Mapa del proyecto. El codigo del harness vive en un unico repositorio Git en esta raiz desde el 2026-10-30: `src/` (Rust), `web/` (Node y cliente), `core/ops/` (scripts operativos seleccionados). Ver `docs/monorepo.md`. El runtime, los builds y los datos permanecen fuera de Git.

## Que es cada carpeta

| carpeta | que es | se puede borrar? |
|---|---|---|
| `core` | nucleo operativo: binarios versionados (`bin`), puntero de version (`state`), scripts de ops, backups | NO (es el corazon) |
| `web` | cliente web + server Node (http 3788 / https 3789) + tunel Cloudflare + TTS | NO |
| `src` | checkout de aegis (Rust) y del UI | NO (pero `src\ui\node_modules` se regenera con `pnpm install`) |
| `state` | **datos de la app**: `data\sessions\sessions.db` (historial), `config\secrets.yaml` (claves) | NO |
| `core\state` | **estado de la maquina**: `current-version.json` (puntero), `tls` (certificados), `piper` (voces TTS) | NO |
| `bridge` | proyecto abandonado y eliminado el 2026-10-27 | no existe |
| `trading` | proyecto de trading: `data` = market data del colector (9,7 GB) | NO |
| `ml` | Strategy Lab (el vivo). Los snapshots viejos se borraron el 15/10 | snapshots viejos: si |
| `market` | fuentes y archivo de investigacion de mercado | con criterio |
| `archive` | historia: backups y fosiles (`src-target-fossil-20261019`, `legacy-scripts-20261019`) | si, a Drive |
| `workstation` | herramientas de la maquina (Sysinternals, etc.) | NO |
| `worktrees` | worktrees de git (los muertos se podan) | los muertos: si |
| `phone`, `downloads`, `releases` | material del telefono/appliance y releases | con criterio |
| `docs` | documentacion y planes | NO |
| `target` | `CARGO_TARGET_DIR` oficial (builds) | si (se regenera) |
| `tmp`, `home`, `appdata` | escalones de trabajo y junctions de compatibilidad | `tmp`: si |

## Invariantes (no romper)

- **Puntero de version**: `core\state\current-version.json` -> `core\bin\aegis-vNN.exe` (ultimo build: **v58**, 2026-10-20). `core\bin\aegis-current.exe` **es un hardlink** a ese binario, y lo rehace `core\ops\swap.ps1` (`Set-AegisCurrent` -> `Refresh-AegisCurrentLink`). El serve vivo corre el binario del puntero. Verificar con `core\ops\check-consistency.ps1` (**usar pwsh 7**: PS 5.1 no tiene `Get-FileHash`).
- **Build vigente**: `core\ops\build.ps1 -Tag vNN` (features `rustls-tls,scheduler,bundled-mcp,chat-recall,acp-http`, origen `target\debug`) + `core\ops\swap.ps1 -Tag vNN -Restart`. `build-and-swap.ps1` es el camino viejo (llama a `web\tools\build-safe.ps1` y deja `features` vacio en `last-build.json`).
- **Targets**: los builds van a `C:\Aegis-Proyects\target` (`CARGO_TARGET_DIR`). `src\target` dejo de usarse el 15/10 y se archivo el 19/10 en `archive\src-target-fossil-20261019`; si aparece un binario ahi, es fosil.
- **Logs de request LLM**: `state\state\logs\llm_request.*.jsonl` (`Paths::in_state_dir("logs")`). `state\data\logs` quedo congelado el 15/10 y es legacy.
- **Hints globales**: `state\.agents\AGENTS.md` (mapa de runtime + reglas operativas) y `state\config\AGENTS.md`. El viejo `C:\Users\Emiliano\.agents\AGENTS.md` ya no se carga con `AEGIS_PATH_ROOT` puesto.
- **Variables de usuario**: `AEGIS_PATH_ROOT=C:\Aegis-Proyects\state`, `AEGIS_GPT_HOME=...\state\aegis-gpt`, `CARGO_TARGET_DIR=C:\Aegis-Proyects\target`, `AEGIS_WEB_TLS_DIR=...\core\state\tls`, `AEGIS_WEB_HTTPS_PORT=3789`.
- **Puertos**: serve 3284, web 3788 (http) / 3789 (https), aegisd 8765, supervisor 8766, CDP 9229.
- **Un solo tunel** a 3788 (`Aegis_Web_Tunnel`); el duplicado se dio de baja el 15/10.
- **No hay segundo disco local**: `G:` es Google Drive. Si algo no sirve: se borra o se sube a Drive.
- **Lectura en voz alta**: Piper local (voz `es_AR-daniela-high`), endpoint `/tts`, regla 26 de `AGENTS.md`.
- **Podas**: tareas `Aegis_Prune_Binaries`, `Aegis_Prune_Logs` y `Aegis_Prune_Artifacts` (ver `core\ops`).


## El lado WSL (encontrado el 2026-10-15)

El disco de WSL (`%LOCALAPPDATA%\wsl\{ed905725-...}\ext4.vhdx`, **219 GB**) guarda mas datos que el propio proyecto. Mapa (dentro de Ubuntu):

| ruta | tamano | que es | criterio |
|---|---|---|---|
| `/home/emiliano/aegis_55_segments` | 17 GB | **MARKET DATA** (56 `.jsonl` de microstructure) | **NO TOCAR** |
| `/home/emiliano/nuestroos` | 62 GB | workspace de Buildroot: `external` (fuentes, 19 GB, activo) + `output` (10-08), `output-castor` (10-14), `output-vexpress` (10-09) | los `output-*` son builds (28 GB si se sueltan los viejos) |
| `/home/emiliano/aegis-workshop/linux-a52` | 15 GB | arbol de compilacion del kernel de la A52 | rebuild largo si se borra |
| `/home/emiliano/.cache/aegis/cargo-target` | 17 GB | target-dir de cargo dentro de WSL | borrable (rebuild) |
| `/home/emiliano/.cache/sccache` | 4,4 GB | cache de compilacion | **BORRADO** el 15/10 |
| `/home/emiliano/aegis-*` (checkouts) | ~16 GB | releases y labs (varios con cambios sin commitear) | revisar de a uno |
| `.cargo`, `.rustup`, `.local` | 4 GB | toolchains | conservar |

**Importante**: el VHDX NO se encoge solo. Para devolver el espacio a Windows hay que apagarlo y hacerlo disperso: `wsl --shutdown` + `wsl --manage Ubuntu --set-sparse true` (WSL 2.7.11 lo soporta). Ojo: apagar WSL mata lo que corra adentro (habia un `next-server` activo).


### Resultado de la limpieza de WSL (2026-10-15, noche)

- **Borrado**: `nuestroos/output` + `output-vexpress` (28 GB), `.cache/aegis/cargo-target` (17 GB), `aegis-absent-release-cead083` + `aegis-release-308ac87` (6,3 GB, estaban limpios), `.cache/sccache` (4,4 GB). Total **~56 GB** dentro de Linux (213 -> 161 GB usados).
- **NO se toco**: `aegis_55_segments` (**market data**, 17 GB, 56 archivos), `nuestroos/external` (fuentes), `output-castor`, los checkouts con cambios sin commitear, `aegis-workshop/linux-a52` (arbol de compilacion del kernel).
- **Disco compactado**: `ext4.vhdx` paso de **219,35 GB a 171,8 GB** con `diskpart` (`attach vdisk readonly` -> `compact vdisk` -> `detach`), con elevacion. Libre en C: quedo en **355,7 GB**.
- **Cuidado para la proxima**: mientras diskpart tiene el VHDX tomado, WSL **no arranca** (`ERROR_SHARING_VIOLATION`): hay que esperar a que termine el compactado. No se uso `--set-sparse --allow-unsafe` porque WSL avisa de riesgo de daño en los datos.
- El `next-server` que corria adentro de WSL se corto con el apagado y no vuelve solo: hay que relanzarlo a mano.

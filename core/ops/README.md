# ops — scripts de operación de Aegis

Scripts de despliegue y mantenimiento del nodo Aegis (Windows). Se versionan acá para tener
historia de los cambios; antes vivían sin control de versiones.

## Despliegue del binario (cadena)

Camino corto: **`build-and-promote.ps1 -Tag vNN`** encadena los tres pasos y verifica por
estado (`state\last-build.json`), no parseando el log del build (es UTF-16 y el 20/10 un
`Select-String` sin `-Encoding` dio falso y salteo el swap en silencio). Con `-NoRestart`
solo compila y mueve el puntero. Igual que `swap.ps1 -Restart`, hay que correrlo desprendido
si se lanza desde un turno del agente.

1. `build.ps1 -Tag vNN [-Crate serve|cli]` → compila el **harness** (`-p aegis-server --bin
   aegis-serve`, features `rustls-tls,scheduler,bundled-mcp,chat-recall,acp-http,code-mode`) y copia
   a `core\bin\aegis-vNN.exe` con verificacion de SHA256 + `--version`. **No toca el puntero.** Con
   `-Crate cli` compila el binario interactivo viejo (`aegis`), que ya no se despliega.
   `build-and-swap.ps1` queda como camino legacy: llama a `web\tools\build-safe.ps1` y deja
   `features` vacio en `last-build.json`.
2. `swap.ps1 -Tag vNN -Restart -DelaySecs 20` → escribe el puntero, **rehace el hardlink
   `aegis-current.exe`** (`Set-AegisCurrent` → `Refresh-AegisCurrentLink`), espera inactividad
   (mtime de `state\state\logs\llm_request.*.jsonl` + WAL del store) y reinicia el serve con
   rollback si `/health` no da 200. **El reinicio mata los procesos hijos**, así que conviene
   invocarlo desprendido. El hardlink ya no se recrea aparte: esa nota era vieja.
3. `check-consistency.ps1` → exit 0 = puntero = vivo = hardlink. Requiere pwsh 7.

Verificar un despliegue **por contenido** (literales dentro del .exe), nunca por fecha ni por
expresiones de código: un build viejo copiado en silencio ya pasó (v41 fantasma).

## Auto-recuperación del harness (2026-10-28)

Tres piezas, en este orden. La foto es la definición de "harness que funciona"; el gate la mide;
el sanador devuelve el despliegue a la foto cuando el gate da rojo dos veces seguidas.

| script | qué hace | costo |
|---|---|---|
| `health-gate.ps1 [-Deep]` | mide por efecto: `/health` 200, sha del exe vivo vs puntero, `3788/` + los 19 assets que referencia `index.html`, `node --check` de `server.mjs` y `app\*.js`, `--print-paths` (config parsea), `schema_version` del store. Con `-Deep`: `quick_check` del store + turno canario real contra el provider barato en un store aislado (`core\state\canary`). Escribe `core\state\health.json`, exit 0/1/2 = sano/degradado/roto | 2 s shallow, 7 s deep |
| `snapshot-good.ps1 [-Force] [-PublishDue]` | arma `core\state\good\staging` con puntero + binario + `web\` (sin `node_modules`, `logs`, `outbox`) + `state\config\` (sin `.lock` ni `.bak-*`) y un `manifest.json` con sha256 por archivo. Publica con ventana de gracia de 10 min y gate profundo sano: `staging` → `current`, `current` → `prev`. Dos niveles, nunca más | 158 MB, 15–45 s |
| `selfheal.ps1 [-DryRun] [-Force] [-FilesOnly]` | lee `health.json` (o corre el gate si está viejo), mantiene racha en `heal-streak.json`, y con 2 rojos: autosave git de `web\` en `refs/autosave/heal-<ts>`, cuarentena completa de lo que va a pisar, repone binario/puntero/archivos desde `current`, reinicia 3284 y 3788 con gate de inactividad, y verifica con gate profundo. Si `current` no levanta, prueba `prev`. **No toca `src\`** | 1–2 min |

Instalación: `install-selfheal.ps1 [-IntervalMinutes 3] [-Remove]` registra la tarea
**Aegis SelfHeal** (cada 3 min, corre fuera del harness a propósito: si el serve no arranca, un
vigilante que vive adentro tampoco).

Reglas que respeta:

- **Nunca revierte `src\`** ni archivos por mtime. El disparador es la falla funcional, no el cambio.
- `degradado` no se cura: puerto arriba con provider lento o un asset roto no se arregla reiniciando.
- Antes de pisar nada, copia a `core\state\quarantine\<ts>\`; nada se borra.
- `aegis-current.exe` no se copia a la foto (es hardlink del mismo binario, duplicaría 146 MB); la
  restauración lo recrea con `Refresh-AegisCurrentLink`.
- Si el binario está en uso y difiere del de la foto, se despliega como `aegis-vNN-heal<HHmmss>.exe` y
  `Prune-HealBinaries` borra los sobrantes cuando ya no son el puntero.
- Operación: `heal.log`, `heal-status.json` (lo que hizo la última pasada), `health.json` (la última
  medición), `snapshot.log`.

Diagnóstico rápido: `powershell -File core\ops\health-gate.ps1 -Deep` dice qué está roto y por qué
nombre; `selfheal.ps1 -DryRun` dice qué foto usaría, sin escribir nada.

## Otros

| script | para qué |
|---|---|
| `jobs.ps1 start/status/tail/stop/prune` | trabajos en segundo plano con log por trabajo |
| `_pointer.ps1` | leer/escribir el puntero de versión (escanea `C:/Aegis-Proyects/target/debug`) |
| `collect-baks.ps1` | junta los `.bak-*` del repo (los de `.agents/skills` NO: van al lado del SKILL.md) |
| `repoint-paths-proyects.ps1` | reescribe rutas cuando se mueve un proyecto |
| `install-tunnel*.ps1` | tareas programadas de los túneles de la web |
| `cleanup-goose-firewall.ps1 [-Revert]` | renombra `Goose Web 3788/3284 (LAN)` a `Aegis Web …` y borra las 6 reglas muertas con scope `C:\goose\target\debug\goose-serve-v*.exe`. Requiere elevación (se encola en `outbox\elev\job.ps1`) |

## Scripts de migración: archivados (2026-10-22)

`move-checkout.ps1`, `repoint-checkout.ps1`, `rename-deploy-c2.ps1`, `finish-c2.ps1` y
`repoint-tasks.ps1` (los one-shots del 15/10 que movieron `C:\goose` → `src`, `C:\goose-web` →
`web` y renombraron las tareas `Goose_Web*` → `Aegis_Web*`) **ya no viven acá**: se movieron a
`core\backups\20261022-ops-migracion-oneshot\` con su `MANIFEST.txt` y entrada en
`core\backups\INDEX.tsv`. Se sacaron de `core\ops` justamente porque `repoint-checkout.ps1 -Revert`
reescribe el árbol de vuelta a `C:\goose` y `repoint-tasks.ps1` busca tareas que ya no existen.

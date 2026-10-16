# ops — scripts de operación de Aegis

Scripts de despliegue y mantenimiento del nodo Aegis (Windows). Se versionan acá para tener
historia de los cambios; antes vivían sin control de versiones.

## Despliegue del binario (cadena)

1. `build-and-swap.ps1 -Version vNN [-NoRestart]` → compila con `build-safe.ps1` (que deriva el
   target dir de `CARGO_TARGET_DIR`), copia a `core\bin\aegis-vNN.exe`, actualiza el puntero
   (`core\state\current-version.json`) y reinicia el serve.
2. `swap.ps1 -Tag vNN -Restart -DelaySecs 20` → **termina con `exit`**: hay que invocarlo como
   proceso aparte (`Start-Process -Wait`) o queda sin ejecutar. **El reinicio mata los procesos
   hijos**, así que el hardlink `aegis-current.exe` se recrea en un paso aparte con
   `fsutil hardlink create`.
3. `check-consistency.ps1` → exit 0 = puntero = vivo = hardlink. Requiere pwsh 7.

Verificar un despliegue **por contenido** (literales dentro del .exe), nunca por fecha ni por
expresiones de código: un build viejo copiado en silencio ya pasó (v41 fantasma).

## Otros

| script | para qué |
|---|---|
| `jobs.ps1 start/status/tail/stop/prune` | trabajos en segundo plano con log por trabajo |
| `_pointer.ps1` | leer/escribir el puntero de versión (escanea `C:/Aegis-Proyects/target/debug`) |
| `collect-baks.ps1` | junta los `.bak-*` del repo (los de `.agents/skills` NO: van al lado del SKILL.md) |
| `repoint-paths-proyects.ps1` | reescribe rutas cuando se mueve un proyecto |
| `install-tunnel*.ps1` | tareas programadas de los túneles de la web |

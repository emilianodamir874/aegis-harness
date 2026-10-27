# Despliegue de aegis-web (Node + TypeScript)

Vigencia: 2026-10-27. Alcance: **solo el cliente web y su proceso Node** en `C:\Aegis-Proyects\web`. El backend `aegis serve` escucha en 3284 y hospeda esta sesión; Node sirve la UI en el puerto `webPort` de `config.json` (habitualmente 3788). **No usar `core/ops/build.ps1`, `swap.ps1`, `promote-detached.ps1` ni `restart-latest.ps1` para publicar la web. No parar el serve ni cloudflared**: reiniciar el quick tunnel cambia su URL. El backend debe permanecer en el mismo PID y con el mismo binario durante toda la operación.

## Gates antes de publicar

1. Registrar el estado inicial: `git status --short`, PID y línea de comandos de los dueños de `webPort` y `servePort` (`Get-NetTCPConnection -LocalPort <puerto> -State Listen` y `Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"`), respuesta de `http://127.0.0.1:<webPort>/healthz?backend=1`. No asumir que un proceso llamado `node` es el dueño de la web. Si el puerto web pertenece a otro proceso, **abortar**; nunca matar por nombre o patrón.
2. Confirmar que no hay otra publicación/reinicio en curso y que el turno que autoriza el despliegue terminó antes de detener Node. El proxy Node puede cortar WebSockets y la conexión de este cliente; el serve en 3284 hospeda la sesión y no se reinicia. Reservar ventana breve, responsable para leer el log **después** del reinicio y un rollback ya preparado. El gate no es `Start-Sleep` a ciegas: comprobar ausencia de turnos activos y evitar un prompt/stream en curso. Si no se puede comprobar, aplazar; nunca ejecutar el stop inline desde un turno que depende de esta web.
3. Guardar fuera del repo (por ejemplo `C:\Users\Emiliano\backups\web-deploy-<fecha>\`) los **bytes previos** de cada artefacto que se publicará, más su SHA256; anotar PID inicial y lista exacta de archivos. No copiar `config.json`, `auth.json`, `state\config\secrets.yaml`, cookies ni tokens al respaldo, logs, mensajes o repo. No usar `git add -A`. Si hay WIP ajeno, no resetear ni incluir esos cambios en la publicación sin revisarlos.

## Build → revisión → publicación

Desde la raíz `C:\Aegis-Proyects\web`:

```powershell
npm run build
# Salida: dist-ts/server.mjs, dist-ts/app/*.js, dist-ts/tools/*.mjs y dist-ts/tests/*.mjs.
# Si typecheck o esbuild falla, NO publicar.
```

`npm run build` primero hace typecheck y luego `tools/build-typescript.mjs`; **no publica** nada en la raíz servida. Revisar `git diff` de fuentes y HTML/CSS, lista de salidas del build, existencia y sintaxis de los candidatos (`node --check dist-ts/server.mjs`; `node --check dist-ts/app/app.js`; revisar todos los JS afectados). Comparar SHA256 de `dist-ts/server.mjs` con `server.mjs` y de cada `dist-ts/app/*.js` con `app/*.js`; no sobreescribir salidas que no cambiaron sin razón. Revisar que las rutas de los módulos del HTML tengan su archivo generado. En particular, `src/workspace-nav.ts` genera **`dist-ts/app/workspace-nav.js`** y `app/index.html` lo carga: si falta el archivo publicado, el HTML devuelve 200 pero el navegador falla. Un HTML/CSS editado se copia desde `dist-ts/app/index.html` / `dist-ts/app/app.css` después de la revisión, además de los JS correspondientes. Si cambian helpers de Node generados en `dist-ts/tools/*.mjs` o `dist-ts/piper-vivo.js`, incluirlos explícitamente en el manifiesto y respaldo antes de publicar; copiar únicamente `server.mjs` y `app/*.js` no alcanza para cambios de esos helpers.

**Gate único postdeploy:** `node tools/verify-web-deploy.mjs` falla con exit 1 si el dueño TCP no es Node, el `server.mjs` publicado difiere de `dist-ts/server.mjs`, `/healthz?backend=1` no confirma backend, `/changes.json` anónimo no devuelve 401 JSON, el HTML/JS/CSS no descomprime o difiere en SHA-256 del disco y `?v=`, o Chromium (1440×900 y 390×844) no carga ACP y los paneles Actividad/Cambios sin errores. No envía prompts ni crea sesiones; su comprobación de identidad del JS en memoria es conductual (PID estable + contrato nuevo), no criptográfica. Guardar el reporte de salida y abortar/revertir si hay alguna fila FALLA. Antes de la promoción puede fallar a propósito por archivos aún no publicados: eso no autoriza a desactivar un gate.

**Pruebas antes de tocar la web viva:** ejecutar primero las suites aisladas sobre los bundles en `dist-ts` con sus fixtures/store temporales (por ejemplo `node dist-ts/tests/server-regressions.mjs`, `server-workspace-regressions.mjs`, `client-regressions.mjs`, `search-e2e.mjs`, `media-e2e.mjs` según el cambio). No confundirlas con `npm test`: `tests/run.ts` también incluye `ui-mobile` y `gasto` contra `AEGIS_WEB_URL` (por defecto la web viva en 3788). Con `AEGIS_TEST_SMOKE=1`, agrega `reload-smoke`, `rewind-regen` y `dedup-prompt`, que crean sesiones y consumen turnos reales: solo en ventana explícita y con destino/store controlados. Registrar qué se ejecutó realmente; un typecheck no equivale a una prueba del navegador.

Con backup y pruebas aprobados, publicar los archivos revisados desde `dist-ts` a las rutas **de raíz**: `dist-ts/server.mjs` → `server.mjs` y `dist-ts/app/*.js` → `app/` (incluido `workspace-nav.js`), más los estáticos y helpers que figuren en el manifiesto. Antes de copiar, confirmar de nuevo hashes y que ninguna fuente cambió después del build; si cambió, reconstruir y repetir la revisión. Ejemplo de copia, **solo tras respaldo/gates** y adaptando la lista al diff revisado:

```powershell
Copy-Item .\dist-ts\server.mjs .\server.mjs -Force
Get-ChildItem .\dist-ts\app\*.js | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path .\app $_.Name) -Force }
# Si cambiaron: Copy-Item .\dist-ts\app\index.html .\app\index.html -Force
# Si cambiaron: Copy-Item .\dist-ts\app\app.css .\app\app.css -Force
```

Tras copiar, recontar archivos y comprobar SHA256 origen/destino por cada archivo; **no** usar `dist-ts` como directorio de servicio. `src/server.ts` define `APP = join(DIR, 'app')`: Node lee `web/app`, no `dist-ts/app`. Si cambiaron solo estáticos (`app/*.js`, HTML o CSS), Node lee esos archivos por request y **no hace falta reiniciarlo**; igualmente pasar todos los gates posteriores, sin esperar un PID nuevo.

## Reinicio Node desprendido y rollback

Si cambió `server.mjs` (o configuración que Node carga al inicio), reiniciar **solo Node**. `scripts/restart-node.ps1 -DelaySecs N` detiene al dueño del puerto `cfg.webPort`, llama a `scripts/start-aegis-web.ps1`, espera cinco segundos y comprueba `/` y `/config.js`. Este script **no implementa gate de turnos ni rollback automático**; un `web=200` y `cache-busting OK` no prueban render ni readiness. Usarlo únicamente desde un proceso supervisor **desprendido**, lanzado antes de finalizar el turno, con log propio y delay/gate verificados; no ejecutar `Stop-Process` inline desde la sesión. El supervisor debe validar que el PID a detener sigue siendo el Node esperado, que 3284 sigue con su dueño original, que la web no está ocupada y que el backup existe; ante fallo, abortar antes de detener nada. Evitar pipes hacia procesos que dejan descendientes vivos (heredan stdout y el supervisor puede no terminar); redirigir a archivo y verificar el resultado por estado observable. El launcher `start-aegis-web.ps1` es idempotente por puerto: si el serve está escuchando, **no lo reinicia**; si falta el serve, **abortá el procedimiento web-only** en lugar de dejar que el launcher lo arranque incidentalmente. Tras arrancar, revalidar dueño 3284/PID/binario sin cambios y nuevo dueño web = `node ... server.mjs`.

**Rollback por fallo en cualquiera de los gates posteriores:** restaurar *todos* los artefactos modificados desde el backup verificado (no solo `server.mjs`), comparar sus SHA256 originales y reiniciar solo Node con el mismo esquema desprendido y gate. Si el serve cambió de PID, detener la operación y diagnosticar: este runbook no autoriza corregirlo por swap. Repetir los controles de salud, bytes servidos y render tras rollback; si no recupera la web, dejar constancia del estado, PID y log sin publicar éxito falso. `core/ops/swap.ps1` hace rollback del **serve** al fallar `/health`; no sirve como rollback de Node y no se invoca aquí.

## Gates posteriores: efecto observable, no solo HTTP 200

| Gate | Comprobación / criterio de salida |
|---|---|
| Identidad | `Get-NetTCPConnection` muestra el Node esperado en `webPort` (PID nuevo **solo si hubo reinicio**) y el mismo PID/binario de serve en 3284. Si hubo reinicio, revisar `web/logs/server.out.log` y `server.err.log` por errores de arranque. |
| Readiness | `GET http://127.0.0.1:<webPort>/healthz?backend=1` da **200**, `ok:true`, `processReady:true`, `backendTcpReady:true`. `/healthz` sin `backend=1` solo prueba liveness de Node; `/health` del serve es otro endpoint. |
| Bytes servidos | Pedir `GET /` y cada JS afectado (en especial `/app.js` y `/workspace-nav.js`) con `Accept-Encoding: gzip`; comprobar que descomprime, es 200, y que el **SHA256 del cuerpo descomprimido** coincide con el archivo `app/<nombre>.js` publicado. Pedir `/server.mjs` **no** verifica el proceso: ese archivo no se sirve como asset; verificar su identidad con los endpoints/cambios observables del server y el reinicio Node. Guardar respuestas solo en ubicación temporal segura, no volcar `/config.js` (contiene configuración/token dinámico). |
| Versiones/cache | En el HTML, `app.js?v=<sha256>` debe igualar SHA256 del archivo publicado y los módulos críticos deben cargar sin 404. En `src/server.ts` la lista de assets incluye `workspace-nav.js`: comprobar que su hash en `?v=` coincide con el archivo servido; si el bundle publicado no lo incluye, forzar recarga y corregir la discrepancia antes de cerrar el gate. |
| Render real | Abrir en Playwright/Chrome con viewport escritorio y móvil, `Accept-Encoding` del navegador, sin caché; esperar a que carguen los scripts y a la conexión ACP. Verificar controles y navegación de workspace, estado visible/conexión, y cero `pageerror`, errores de consola de módulo y requests 404/decoding failures. Captura y DOM real: un 200 de `/` puede ser una página blanca por gzip roto. No enviar prompts reales para este gate. |

Si algún gate falla, **rollback** y repetirlos. Documentar hashes, respuesta de salud sin secretos, PID antes/después y resultado de render. Solo después informar que está publicado. No tocar tareas ni proceso de cloudflared: su URL pública se conserva mientras el quick tunnel continúe vivo.

# Aegis: repositorio del harness

El repositorio Git esta en `C:\Aegis-Proyects\harness`. La migracion de 2026-10-30 consolido tres historias, con rutas antiguas preservadas por enlaces:

- `src/`: Rust, ACP y UI upstream; historial de la rama local `feat/antigravity-provider`.
- `web/`: cliente web y servidor Node; historial de `master` (incluye los dos commits locales posteriores a `backup/master`).
- `core/ops/`: scripts operativos seleccionados; el commit de importacion conserva el HEAD previo como padre, y captura los archivos operativos tal como estan en disco. Habia WIP previo en este repo: no se le atribuye a la migracion. Los scripts historicos/temporales permanecen en disco y fuera del nuevo indice.

`core/bin/`, `core/state/`, `state/`, `target/`, `archive/`, `worktrees/`, `trading/` y otros proyectos no estan dentro de Git. La raiz usa una lista explicita en `.gitignore` para impedir incorporarlos por accidente. El serve, el proxy Node, el build y el swap siguen usando las rutas antiguas mediante enlaces; cada uno se despliega por separado.

Los tres `.git` originales quedan archivados en `archive/git-before-monorepo-20261030/`, con sus remotos, refs, reflogs y WIP de `core/ops` preservados. El nuevo repositorio conserva por ascendencia los commits originales; el commit de union introduce los prefijos `src/`, `web/` y `core/ops/`. Para el historial anterior a la union, consultar `git log refs/archive/pre-monorepo/src -- crates/`, `git log refs/archive/pre-monorepo/web -- src/` o las refs archivadas, ya que los commits originales todavia usan rutas sin prefijo. Para comparar estados previos exactos, consultar las refs locales `refs/archive/pre-monorepo/{src,web,ops}`. El remoto `origin` es `aegis-harness`; la rama publicada del monorepo es `origin/monorepo-harness`. El `main` remoto ya tenia una historia distinta y NO se reemplazo: no ejecutar `git push origin main` sin una decision de migracion explicita. `backup-src`, `backup-web`, `backup-ops` son los repos historicos, y `upstream` apunta a `block/goose`. Antes de actualizar desde `upstream/block/goose`, elegir un procedimiento de importacion por subarbol: un merge normal desde la raiz no aplica los cambios bajo `src/` automaticamente.

## Carpeta fisica dedicada (2026-10-30)

La raiz Git fisica y el codigo viven en `C:\Aegis-Proyects\harness`: `src/`, `web/`, `core/ops/`, `docs/`, `.git/`, `.gitignore` y `README.md`. En `C:\Aegis-Proyects` persisten enlaces de compatibilidad para `src/`, `web/`, `docs/` y `core/ops/`; los procesos y sesiones antiguas usan sus rutas originales. El Git del directorio padre desaparece; trabajar desde `harness` para commits, build y status. El runtime real sigue fuera del repo: `C:\Aegis-Proyects\state`, `target`, `core/bin`, `core/state`.

Las rutas existentes en scripts y sesiones usan los enlaces sin cambiar identidades de workspace. El indexador de cambios admite explicitamente junctions de los cuatro subproyectos y `core/ops`. Evitar `git add -A` desde `harness`. Si hay que deshacer el traslado fisico, usar el script y log de `core/tmp` y comprobar el estado antes de retirar enlaces.

Los backups del nuevo historial deben incluir el repositorio raiz. Los mirrors historicos de `src`, `web` y `core/ops` siguen siendo archivos separados, no sustitutos del backup de la raiz. Nunca correr `git add -A` desde la raiz; indexar rutas explicitas y auditar `git diff --cached --name-only` antes de commitear.

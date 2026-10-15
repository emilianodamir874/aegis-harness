# Limpieza del store de Aegis (D1): por defecto NO toca nada (dry-run).
#
#   .\prune-store.ps1                      -> informe (que borraria, cuanto pesa)
#   .\prune-store.ps1 -Apply                -> backup + borra sesiones sub_agent viejas + VACUUM
#   .\prune-store.ps1 -Apply -Days 14 -IncludeAcpHidden   -> ademas limpia filas ocultas viejas
#
# Nunca corre con el server vivo si -Apply (el WAL y las escrituras concurrentes ensucian
# el VACUUM): exige parar aegis-web primero.
param([switch]$Apply, [int]$Days = 7, [switch]$IncludeAcpHidden)
$ErrorActionPreference = 'Stop'
$data = "$env:APPDATA\Aegis\aegis\data\sessions"
$db = "$data\sessions.db"
$sqlite = (Get-Command sqlite3 -ErrorAction SilentlyContinue).Source
if (-not $sqlite) { throw 'sqlite3 no esta en el PATH' }
function Run-Sql([string]$sql) { & $sqlite $db $sql }
$before = [math]::Round((Get-Item $db).Length / 1MB, 1)
$wal = "$db-wal"; $walMb = if (Test-Path $wal) { [math]::Round((Get-Item $wal).Length / 1MB, 1) } else { 0 }
Write-Host "store: $db ($before MB) + WAL ($walMb MB)"
Run-Sql "SELECT '--- candidatas: sub_agent mas viejas que $Days dias ---'; SELECT session_type, COUNT(*) FROM sessions WHERE session_type='sub_agent' AND updated_at < datetime('now', '-$Days days') GROUP BY 1;"
Run-Sql "SELECT '--- mensajes de esas sesiones ---'; SELECT COUNT(*) FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE session_type='sub_agent' AND updated_at < datetime('now', '-$Days days'));"
if ($IncludeAcpHidden) {
  Run-Sql "SELECT '--- filas ocultas viejas (acp) ---'; SELECT COUNT(*) FROM messages WHERE COALESCE(metadata_json,'') LIKE '%\"agentVisible\":false%' AND timestamp < datetime('now', '-$Days days');"
}
Run-Sql "SELECT '--- sesiones por tipo ---'; SELECT session_type, COUNT(*), ROUND(SUM(COALESCE(accumulated_cost,0)),2) FROM sessions GROUP BY 1 ORDER BY 2 DESC;"
if (-not $Apply) { Write-Host 'dry-run: nada modificado. Use -Apply para ejecutar (con backup y VACUUM).'; exit 0 }
$owner = (Get-NetTCPConnection -LocalPort 3284 -State Listen -ErrorAction SilentlyContinue)
if ($owner) { throw 'hay un serve escuchando en 3284: paramos aegis-web antes de tocar el store' }
$backup = "$data\sessions.db.bak-prune-$(Get-Date -Format yyyyMMdd-HHmmss)"
Copy-Item $db $backup -Force
Write-Host "backup: $backup"
Run-Sql "DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE session_type='sub_agent' AND updated_at < datetime('now', '-$Days days'));"
if ($IncludeAcpHidden) {
  Run-Sql "DELETE FROM messages WHERE COALESCE(metadata_json,'') LIKE '%\"agentVisible\":false%' AND timestamp < datetime('now', '-$Days days');"
}
Run-Sql "DELETE FROM sessions WHERE session_type='sub_agent' AND updated_at < datetime('now', '-$Days days');"
Run-Sql 'VACUUM;'
Run-Sql 'PRAGMA wal_checkpoint(TRUNCATE);'
$after = [math]::Round((Get-Item $db).Length / 1MB, 1)
Write-Host "listo: $before MB -> $after MB (backup en $backup)"

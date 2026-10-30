# Retencion del store de sesiones (sessions.db) SIN parar el serve.
# El store se resuelve por AEGIS_PATH_ROOT (fallback %APPDATA%\Aegis\aegis): el
# prune-store.ps1 viejo clava %APPDATA% y en esta maquina ese path NO existe.
# Por defecto: dry-run (solo informa). Con -Apply: backup online (VACUUM INTO) y borra
# sesiones vacias viejas + sesiones sub_agent viejas en lotes chicos (sin VACUUM).
# NO hace VACUUM con el serve vivo: deja el pedido en core\state\vacuum-pending y lo
# ejecuta el proximo swap con el serve detenido. Asi el archivo se encoge sin ventana.
# Uso:
#   .\prune-sessions.ps1                                  informe
#   .\prune-sessions.ps1 -Apply                            backup + borrado
#   .\prune-sessions.ps1 -Apply -EmptyDays 5 -SubAgentDays 14
#   .\prune-sessions.ps1 -VacuumNow                        SOLO con el serve detenido
param(
  [switch]$Apply,
  [int]$EmptyDays = 2,
  [int]$SubAgentDays = 7,
  [switch]$VacuumNow,
  [int]$WaitIdleSecs = 0,
  [int]$KeepBackups = 3,
  [string]$BackupDir = 'C:\Users\Emiliano\backups\sessions',
  [int]$ToolResultDays = 14,
  [int]$ToolResultBytes = 32768
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_pointer.ps1')

$storeRoot = if ($env:AEGIS_PATH_ROOT) { $env:AEGIS_PATH_ROOT } else { Join-Path $env:APPDATA 'Aegis\aegis' }
$data = Join-Path $storeRoot 'data\sessions'
$db = Join-Path $data 'sessions.db'
$wal = "$db-wal"
$sqlite = (Get-Command sqlite3 -ErrorAction SilentlyContinue).Source
if (-not $sqlite) { throw 'sqlite3 no esta en el PATH' }
if (-not (Test-Path $db)) { throw "no existe el store: $db" }
$logDir = Join-Path $AegisRoot 'logs\gc'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir ('sessions-' + (Get-Date -Format 'yyyyMMdd') + '.log')
function W($m) { $m; if ($Apply -or $VacuumNow) { $m | Out-File -FilePath $log -Append -Encoding utf8 } }
function Q([string]$q) { & $sqlite $db $q }

W ('== ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' prune-sessions modo=' + $(if ($VacuumNow) { 'vacuum' } elseif ($Apply) { 'apply' } else { 'dry-run' }) + ' vacias>' + $EmptyDays + 'd subagent>' + $SubAgentDays + 'd')
W ('  store: ' + $db)

if ($VacuumNow) {
  $live = Get-AegisLiveServe
  if ($live) { throw "VACUUM exige el serve detenido; hoy escucha $live" }
  W 'VACUUM (serve detenido)'
  Q 'VACUUM;'
  Remove-Item (Join-Path $AegisRoot 'state\vacuum-pending') -Force -ErrorAction SilentlyContinue
  W ('  archivo: ' + [math]::Round((Get-Item $db).Length/1MB,1) + ' MB')
  W 'FIN'
  exit 0
}

$logDirs = @((Join-Path $storeRoot 'data\logs'), (Join-Path $storeRoot 'state\logs'))
$act = @($logDirs | Where-Object { Test-Path $_ } | ForEach-Object { Get-ChildItem (Join-Path $_ 'llm_request.*.jsonl') -ErrorAction SilentlyContinue } | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
$lastLlm = if ($act.Count) { $act[0].LastWriteTime } else { (Get-Date).AddDays(-1) }
$lastWal = if (Test-Path $wal) { (Get-Item $wal).LastWriteTime } else { $lastLlm }
$last = if ($lastWal -gt $lastLlm) { $lastWal } else { $lastLlm }
$deadline = (Get-Date).AddSeconds($WaitIdleSecs)
while ($true) {
  $act = @($logDirs | Where-Object { Test-Path $_ } | ForEach-Object { Get-ChildItem (Join-Path $_ 'llm_request.*.jsonl') -ErrorAction SilentlyContinue } | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
  $lastLlm = if ($act.Count) { $act[0].LastWriteTime } else { (Get-Date).AddDays(-1) }
  $lastWal = if (Test-Path $wal) { (Get-Item $wal).LastWriteTime } else { $lastLlm }
  $last = if ($lastWal -gt $lastLlm) { $lastWal } else { $lastLlm }
  $idle = [int]((Get-Date) - $last).TotalSeconds
  W ('  ultima actividad hace ' + $idle + 's')
  if (-not $Apply -or $idle -ge 60) { break }
  if ($WaitIdleSecs -le 0 -or (Get-Date) -gt $deadline) { W 'ABORTADO: turno en vuelo (actividad < 60s)'; W 'FIN'; exit 1 }
  W ('  esperando inactividad, margen ' + $WaitIdleSecs + 's (una lectura de sqlite tambien cuenta como actividad)')
  Start-Sleep -Seconds 15
}
$walMb = if (Test-Path $wal) { [math]::Round((Get-Item $wal).Length/1MB,2) } else { 0 }
W ('  archivo: ' + [math]::Round((Get-Item $db).Length/1MB,1) + ' MB | WAL: ' + $walMb + ' MB')

$empty = "session_type <> 'schedule' AND updated_at < datetime('now','-" + $EmptyDays + " day') AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = sessions.id)"
$subs = "session_type = 'sub_agent' AND updated_at < datetime('now','-" + $SubAgentDays + " day')"

W '--- estado ---'
W ('  sesiones=' + (Q 'SELECT COUNT(*) FROM sessions;'))
W ('  mensajes=' + (Q 'SELECT COUNT(*) FROM messages;'))
W ('  vacias=' + (Q 'SELECT COUNT(*) FROM sessions s WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id=s.id);'))
W ('  rango=' + (Q 'SELECT MIN(timestamp) FROM messages;') + ' .. ' + (Q 'SELECT MAX(timestamp) FROM messages;'))
W '--- candidatas ---'
W ('  vacias (>' + $EmptyDays + 'd)=' + (Q ('SELECT COUNT(*) FROM sessions WHERE ' + $empty + ';')))
W ('  sub_agent (>' + $SubAgentDays + 'd)=' + (Q ('SELECT COUNT(*) FROM sessions WHERE ' + $subs + ';')))
W ('  mensajes de esos sub_agent=' + (Q ('SELECT COUNT(*) FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE ' + $subs + ');')))

# Candidatos de la poda por tamano (sin tocar nada en dry-run).
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($node) {
  $previa = & $node --no-warnings (Join-Path $PSScriptRoot 'truncate-tool-results.mjs') --db $db --days $ToolResultDays --bytes $ToolResultBytes 2>$null
  W ('resultados de herramientas >' + $ToolResultBytes + 'B con mas de ' + $ToolResultDays + 'd (dry-run): ' + ($previa -join ' '))
}
if (-not $Apply) { W 'dry-run: nada modificado. Use -Apply para ejecutar.'; W 'FIN'; exit 0 }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
New-Item -ItemType Directory -Force $BackupDir | Out-Null
$backup = Join-Path $BackupDir ('sessions.db.bak-prune-' + $stamp)
W ('backup online (VACUUM INTO): ' + $backup)
Q ("VACUUM INTO '" + ($backup -replace '\\','/') + "';")
W ('  backup: ' + [math]::Round((Get-Item $backup).Length/1MB,1) + ' MB')
$viejas = @(Get-ChildItem $BackupDir -Filter 'sessions.db.bak-prune-*' | Sort-Object Name -Descending | Select-Object -Skip $KeepBackups)
foreach ($v in $viejas) { Remove-Item $v.FullName -Force; W ('  copia vieja borrada: ' + $v.Name) }
W ('  copias en ' + $BackupDir + ': ' + (@(Get-ChildItem $BackupDir -Filter 'sessions.db.bak-prune-*').Count) + ' (retencion ' + $KeepBackups + ')')

W 'borrando mensajes de sub_agent viejos (lotes de 500)'
$total = 0
while ($true) {
  $n = & $sqlite $db ("DELETE FROM messages WHERE id IN (SELECT m.id FROM messages m JOIN sessions s ON s.id=m.session_id WHERE " + $subs + " LIMIT 500); SELECT changes();")
  if ([int]$n -le 0) { break }
  $total += [int]$n
  Start-Sleep -Milliseconds 150
}
W ('  mensajes borrados=' + $total)
W ('  sesiones sub_agent borradas=' + (& $sqlite $db ("DELETE FROM sessions WHERE " + $subs + "; SELECT changes();")))
W ('  sesiones vacias borradas=' + (& $sqlite $db ("DELETE FROM sessions WHERE " + $empty + "; SELECT changes();")))

# Poda por tamano de resultados de herramientas: el volumen del store no esta en sesiones vacias
# sino en los toolResponse de megabytes. Conserva encabezado y cola, tira el base64 de las imagenes
# y marca el mensaje como truncated; nunca toca texto de usuario ni de asistente.
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { W 'AVISO: node no esta en el PATH; se omite la poda por tamano' }
else {
  $trunc = & $node --no-warnings (Join-Path $PSScriptRoot 'truncate-tool-results.mjs') --db $db --days $ToolResultDays --bytes $ToolResultBytes --apply 2>$null
  W ('resultados de herramientas: ' + ($trunc -join ' '))
  W ('  mensajes con truncated=true: ' + (Q "SELECT COUNT(*) FROM messages WHERE json_extract(metadata_json,'$.truncated')=1;"))
}
W ('  integrity_check: ' + (Q 'PRAGMA integrity_check;'))
New-Item -ItemType File -Force (Join-Path $AegisRoot 'state\vacuum-pending') | Out-Null
W '  VACUUM diferido: marcado core\state\vacuum-pending (lo corre el proximo swap)'
W ('  ahora: sesiones=' + (Q 'SELECT COUNT(*) FROM sessions;') + ' mensajes=' + (Q 'SELECT COUNT(*) FROM messages;'))
W ('  archivo: ' + [math]::Round((Get-Item $db).Length/1MB,1) + ' MB')
W 'FIN'

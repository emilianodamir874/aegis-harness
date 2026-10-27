# Swap parametrizado del serve: escribe el PUNTERO y (opcional) reinicia con gate de inactividad.
# Reemplaza swap-serve-vNN.ps1 (que ademas apuntaba a goose-<ver>.exe, ruta que no existe).
# Uso:  swap.ps1 -Tag v34                 (solo cambia el puntero)
#       swap.ps1 -Tag v35 -Restart        (ademas reinicia; CORRER DESPRENDIDO, no desde el turno)
param(
  [Parameter(Mandatory=$true)][string]$Tag,
  [string]$Features = '',
  [switch]$Restart,
  [int]$DelaySecs = 0,
  [int]$IdleSeconds = 25,
  [int]$IdleTimeoutSecs = 180,
  [switch]$NoRollback
)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_pointer.ps1')
$launcher = 'C:\Aegis-Proyects\web\scripts\start-aegis-web.ps1'
$exe = Join-Path $BinDir ('aegis-' + $Tag + '.exe')
if (-not (Test-Path $exe)) { throw "no existe $exe (corre build.ps1 -Tag $Tag primero)" }
$v = (& $exe --version 2>&1) -join ' '
if ($LASTEXITCODE -ne 0) { throw "$exe no responde a --version" }
$prev = Get-AegisCurrent
$cur = Set-AegisCurrent -Exe $exe -Tag $Tag -Features $Features -SetBy 'swap.ps1'
'puntero -> ' + $cur.exe + ' (' + $v + ', commit ' + $cur.commit + ')'
if (-not $Restart) { 'solo puntero; el serve vivo no cambia hasta reiniciar'; exit 0 }

# --- lock de operaciones: wipe y swap no se pisan ---------------------------------
$opsLock = Join-Path $AegisRoot 'core\state\ops.lock'
function Test-OpsLockFree([string]$Owner) {
    if (-not (Test-Path $opsLock)) { return $true }
    try { $actual = Get-Content $opsLock -Raw | ConvertFrom-Json } catch { return $true }
    if (((Get-Date) - [datetime]$actual.started).TotalMinutes -gt 30) { return $true }
    return ($actual.owner -eq $Owner)
}
if (-not (Test-OpsLockFree -Owner 'swap')) {
    try { $otro = Get-Content $opsLock -Raw | ConvertFrom-Json } catch { $otro = $null }
    'ABORTO: hay otra operacion en curso (' + $otro.owner + ', pid ' + $otro.pid + '). Espera y reintenta.'
    exit 1
}
@{ owner = 'swap'; pid = $PID; started = (Get-Date).ToString('o') } | ConvertTo-Json -Compress |
    Out-File -FilePath $opsLock -Encoding utf8 -Force
if ($DelaySecs -gt 0) { 'restart en ' + $DelaySecs + 's'; Start-Sleep -Seconds $DelaySecs }
# Actividad real del modelo. La ruta %APPDATA%\Aegis que se usaba antes no existe desde la
# migracion del 15/10: el gate daba siempre "idle" y el swap podia matar un turno en curso.
# Logs de request -> <root>\state\logs ; actividad del store -> <root>\data\sessions\sessions.db-wal.
$pathRoot = if ($env:AEGIS_PATH_ROOT) { $env:AEGIS_PATH_ROOT } else { 'C:\Aegis-Proyects\state' }
$deadline = (Get-Date).AddSeconds($IdleTimeoutSecs)
while ($true) {
  $stamps = @()
  $f = Get-ChildItem -Path (Join-Path $pathRoot 'state\logs\llm_request.*.jsonl') -ErrorAction SilentlyContinue |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($f) { $stamps += $f.LastWriteTime }
  $wal = Get-Item (Join-Path $pathRoot 'data\sessions\sessions.db-wal') -ErrorAction SilentlyContinue
  if ($wal) { $stamps += $wal.LastWriteTime }
  $last = if ($stamps.Count -gt 0) { ($stamps | Sort-Object -Descending | Select-Object -First 1) } else { (Get-Date).AddDays(-1) }
  if ($last -lt (Get-Date).AddSeconds(-$IdleSeconds)) { break }
  if ((Get-Date) -gt $deadline) { 'idle gate vencido (techo ' + $IdleTimeoutSecs + 's), sigo'; break }
  'esperando turno en curso (ultima actividad ' + $last.ToString('HH:mm:ss') + ')'
  Start-Sleep -Seconds 5
}
$c = Get-NetTCPConnection -LocalPort 3284 -State Listen -ErrorAction SilentlyContinue
if ($c) { Stop-Process -Id $c.OwningProcess -Force; Start-Sleep -Seconds 3; 'serve anterior detenido' }
# El VACUUM del store diferido por prune-sessions.ps1 necesita el serve detenido:
# este es el unico momento en que lo esta, asi que se aprovecha el swap.
$vp = Join-Path $AegisRoot 'state\vacuum-pending'
if (Test-Path $vp) {
  'vacuum pendiente -> prune-sessions.ps1 -VacuumNow'
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'prune-sessions.ps1') -VacuumNow 2>&1 | ForEach-Object { '  ' + ($_ -replace '[^\x20-\x7E]', '.') }
}
& powershell -NoProfile -ExecutionPolicy Bypass -File $launcher
Start-Sleep -Seconds 6
$p = Get-NetTCPConnection -LocalPort $script:ServePort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($p) { 'NUEVO SERVE pid=' + $p.OwningProcess + ' exe=' + (Get-Process -Id $p.OwningProcess -ErrorAction SilentlyContinue).Path } else { 'SERVE_NOT_UP' }
$health = $null
try { $health = (Invoke-WebRequest -Uri 'http://127.0.0.1:3284/health' -UseBasicParsing -TimeoutSec 20).StatusCode } catch {}
'health=' + $health
if ($health -ne 200 -and -not $NoRollback -and $prev) {
  'ROLLBACK: el serve nuevo no respondio, vuelvo a ' + $prev.exe
  [void](Set-AegisCurrent -Exe $prev.exe -Tag $prev.tag -Features $prev.features -SetBy 'swap-rollback')
  $c2 = Get-NetTCPConnection -LocalPort 3284 -State Listen -ErrorAction SilentlyContinue
  if ($c2) { Stop-Process -Id $c2.OwningProcess -Force; Start-Sleep -Seconds 3 }
  & powershell -NoProfile -ExecutionPolicy Bypass -File $launcher
  Start-Sleep -Seconds 8
  try { 'health tras rollback=' + (Invoke-WebRequest -Uri 'http://127.0.0.1:3284/health' -UseBasicParsing -TimeoutSec 20).StatusCode } catch { 'health tras rollback: error' }
}
Remove-Item -LiteralPath $opsLock -Force -ErrorAction SilentlyContinue
try { 'web=' + (Invoke-WebRequest -Uri 'http://127.0.0.1:3788/' -UseBasicParsing -TimeoutSec 15).StatusCode } catch { 'web error' }

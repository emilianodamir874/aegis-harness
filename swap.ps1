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
  [int]$IdleTimeoutSecs = 600,
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
if ($DelaySecs -gt 0) { 'restart en ' + $DelaySecs + 's'; Start-Sleep -Seconds $DelaySecs }
$deadline = (Get-Date).AddSeconds($IdleTimeoutSecs)
while ($true) {
  $f = Get-ChildItem "$env:APPDATA\Aegis\aegis\data\logs\llm_request.*.jsonl" -ErrorAction SilentlyContinue |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $lastLlm = if ($f) { $f.LastWriteTime } else { (Get-Date).AddDays(-1) }
  $wal = Get-Item "$env:APPDATA\Aegis\aegis\data\sessions\sessions.db-wal" -ErrorAction SilentlyContinue
  $lastMsg = if ($wal) { $wal.LastWriteTime } else { $lastLlm }
  $last = if ($lastMsg -gt $lastLlm) { $lastMsg } else { $lastLlm }
  if ($last -lt (Get-Date).AddSeconds(-$IdleSeconds)) { break }
  if ((Get-Date) -gt $deadline) { 'idle gate vencido, sigo'; break }
  'esperando turno en curso (ultima actividad ' + $last.ToString('HH:mm:ss') + ')'
  Start-Sleep -Seconds 5
}
$c = Get-NetTCPConnection -LocalPort 3284 -State Listen -ErrorAction SilentlyContinue
if ($c) { Stop-Process -Id $c.OwningProcess -Force; Start-Sleep -Seconds 3; 'serve anterior detenido' }
& powershell -NoProfile -ExecutionPolicy Bypass -File $launcher
Start-Sleep -Seconds 6
$p = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*serve*--port*3284*' } | Select-Object -First 1
if ($p) { 'NUEVO SERVE pid=' + $p.ProcessId + ' exe=' + (Split-Path $p.CommandLine -Leaf) } else { 'SERVE_NOT_UP' }
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
try { 'web=' + (Invoke-WebRequest -Uri 'http://127.0.0.1:3788/' -UseBasicParsing -TimeoutSec 15).StatusCode } catch { 'web error' }

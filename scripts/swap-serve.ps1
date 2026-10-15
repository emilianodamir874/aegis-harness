# Swap generico del serve de aegis-web: repunta el launcher a aegis-<Version>.exe y, si
# se pide, reinicia esperando a que el modelo este quieto (para no matar un turno en curso).
# Uso:  swap-serve.ps1 -Version v21 -Restart -DelaySecs 240
param([Parameter(Mandatory=$true)][string]$Version, [switch]$Restart, [int]$DelaySecs = 0,
      [int]$IdleSeconds = 20, [int]$IdleTimeoutSecs = 600)
$ErrorActionPreference = 'Continue'
$root = 'C:/goose-web'
$exe = "C:\aegis-src/target/debug/goose-$Version.exe"
$launcher = "$root/scripts/start-goose-web.ps1"
if (-not (Test-Path $exe)) { Write-Output "ERROR: no existe $exe"; exit 1 }
$m = (Select-String -Path $launcher -Pattern "serveExe = '([^']+)'").Matches
if (-not $m) { Write-Output 'ERROR: no encuentro serveExe en el launcher'; exit 1 }
$actual = $m[0].Groups[1].Value
$actualName = Split-Path $actual -Leaf
Copy-Item $launcher "$launcher.bak-pre-$Version" -Force
(Get-Content $launcher -Raw).Replace($actualName, "aegis-$Version.exe") | Set-Content -Path $launcher -NoNewline
Write-Output ("launcher: {0} -> aegis-{1}.exe" -f $actualName, $Version)
Get-Item $exe | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize | Out-String -Width 120
if (-not $Restart) { Write-Output 'launcher repuntado; el server vivo sigue igual hasta reiniciar'; exit 0 }
if ($DelaySecs -gt 0) { Write-Output "restart en $DelaySecs s"; Start-Sleep -Seconds $DelaySecs }
$deadline = (Get-Date).AddSeconds($IdleTimeoutSecs)
while ($true) {
  # Dos señales de actividad: la ultima llamada al modelo (llm_request) y la ultima
  # escritura en el store (los tool results se escriben durante todo el turno). Con una
  # sola señal, un turno largo sin llamadas al modelo parece inactivo y el swap lo mata.
  $f = Get-ChildItem "$env:APPDATA/Aegis/aegis/data/logs/llm_request.*.jsonl" -ErrorAction SilentlyContinue |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $lastLlm = if ($f) { $f.LastWriteTime } else { (Get-Date).AddDays(-1) }
  $wal = Get-Item "$env:APPDATA/Aegis/aegis/data/sessions/sessions.db-wal" -ErrorAction SilentlyContinue
  $lastMsg = if ($wal) { $wal.LastWriteTime } else { $lastLlm }
  $last = if ($lastMsg -gt $lastLlm) { $lastMsg } else { $lastLlm }
  if ($last -lt (Get-Date).AddSeconds(-$IdleSeconds)) { break }
  if ((Get-Date) -gt $deadline) { Write-Output 'idle gate vencido, sigo'; break }
  Write-Output ("esperando turno en curso (ultima actividad {0})" -f $last.ToString('HH:mm:ss'))
  Start-Sleep -Seconds 5
}
$conn = Get-NetTCPConnection -LocalPort 3284 -State Listen -ErrorAction SilentlyContinue
if ($conn) { Stop-Process -Id $conn.OwningProcess -Force; Start-Sleep -Seconds 3; Write-Output 'serve anterior detenido' }
& powershell -NoProfile -ExecutionPolicy Bypass -File $launcher
Start-Sleep -Seconds 6
$p = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*serve*--port*3284*' } | Select-Object -First 1
if ($p) { Write-Output ("NUEVO SERVE pid={0} exe={1}" -f $p.ProcessId, ((Split-Path $p.CommandLine -Leaf))) } else { Write-Output 'SERVE_NOT_UP' }
$health = $null
try { $health = (Invoke-WebRequest -Uri 'http://127.0.0.1:3284/health' -UseBasicParsing -TimeoutSec 20).StatusCode } catch { $health = $null }
Write-Output ('health=' + $health)
if ($health -ne 200) {
  # El serve nuevo no quedo sano: se vuelve a la version anterior y se reinicia, para no
  # dejar la web sin backend (pasó el 2026-10-14 y hubo que rescatarla a mano).
  Write-Output 'ROLLBACK: el serve nuevo no respondio, vuelvo a ' + $actualName
  (Get-Content $launcher -Raw).Replace('aegis-' + $Version + '.exe', $actualName) | Set-Content -Path $launcher -NoNewline
  $c2 = Get-NetTCPConnection -LocalPort 3284 -State Listen -ErrorAction SilentlyContinue
  if ($c2) { Stop-Process -Id $c2.OwningProcess -Force; Start-Sleep -Seconds 3 }
  & powershell -NoProfile -ExecutionPolicy Bypass -File $launcher
  Start-Sleep -Seconds 8
  try { Write-Output ('health tras rollback=' + (Invoke-WebRequest -Uri 'http://127.0.0.1:3284/health' -UseBasicParsing -TimeoutSec 20).StatusCode) } catch { Write-Output 'health tras rollback: error' }
}
try { Write-Output ('web=' + (Invoke-WebRequest -Uri 'http://127.0.0.1:3788/' -UseBasicParsing -TimeoutSec 15).StatusCode) } catch { Write-Output 'web error' }

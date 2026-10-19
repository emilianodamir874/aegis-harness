# VACUUM del store con el serve parado (D1), en segundo plano: espera inactividad, frena el
# serve, corre prune-store.ps1 -Apply (backup + VACUUM) y lo vuelve a levantar.
# 2026-10-19: el store sale de AEGIS_PATH_ROOT (C:\Aegis-Proyects\state), no de %APPDATA%\Aegis.
param([int]$DelaySecs = 60, [int]$IdleSeconds = 25, [int]$IdleTimeoutSecs = 900)
$root = if ($env:AEGIS_PATH_ROOT) { $env:AEGIS_PATH_ROOT } else { 'C:\Aegis-Proyects\state' }
$dbPath = Join-Path $root 'data\sessions\sessions.db'
$log = 'C:/Aegis-Proyects/web/logs/prune.log'
function W($m) { Add-Content $log ((Get-Date).ToString('HH:mm:ss') + ' ' + $m) }
Start-Sleep -Seconds $DelaySecs
$deadline = (Get-Date).AddSeconds($IdleTimeoutSecs)
while ($true) {
  $stamps = @()
  $f = Get-ChildItem -Path (Join-Path $root 'state\logs\llm_request.*.jsonl') -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($f) { $stamps += $f.LastWriteTime }
  $wal = Get-Item "$dbPath-wal" -ErrorAction SilentlyContinue
  if ($wal) { $stamps += $wal.LastWriteTime }
  $last = if ($stamps.Count -gt 0) { ($stamps | Sort-Object -Descending | Select-Object -First 1) } else { (Get-Date).AddDays(-1) }
  if ($last -lt (Get-Date).AddSeconds(-$IdleSeconds)) { break }
  if ((Get-Date) -gt $deadline) { W 'idle gate vencido, sigo'; break }
  Start-Sleep -Seconds 5
}
W ('store antes: ' + [math]::Round((Get-Item $dbPath).Length / 1MB, 1) + ' MB')
$conn = Get-NetTCPConnection -LocalPort 3284 -State Listen -ErrorAction SilentlyContinue
if ($conn) { Stop-Process -Id $conn.OwningProcess -Force; Start-Sleep -Seconds 3; W 'serve detenido' }
& powershell -NoProfile -ExecutionPolicy Bypass -File 'C:/Aegis-Proyects/web/tools/prune-store.ps1' -Apply *>> $log
W ('prune termino (exit ' + $LASTEXITCODE + ')')
& powershell -NoProfile -ExecutionPolicy Bypass -File 'C:/Aegis-Proyects/web/scripts/start-aegis-web.ps1' *>> $log
Start-Sleep -Seconds 8
try { W ('health=' + (Invoke-WebRequest -Uri 'http://127.0.0.1:3284/health' -UseBasicParsing -TimeoutSec 15).StatusCode) } catch { W 'health error' }
W ('store despues: ' + [math]::Round((Get-Item $dbPath).Length / 1MB, 1) + ' MB')

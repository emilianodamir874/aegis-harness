# VACUUM del store con el serve parado (D1), en segundo plano: espera inactividad, frena el
# serve, corre prune-store.ps1 -Apply (backup + VACUUM) y lo vuelve a levantar.
param([int]$DelaySecs = 60, [int]$IdleSeconds = 25, [int]$IdleTimeoutSecs = 900)
$log = 'C:/aegis-web/logs/prune.log'
function W($m) { Add-Content $log ((Get-Date).ToString('HH:mm:ss') + ' ' + $m) }
Start-Sleep -Seconds $DelaySecs
$deadline = (Get-Date).AddSeconds($IdleTimeoutSecs)
while ($true) {
  $f = Get-ChildItem "$env:APPDATA/Aegis/aegis/data/logs/llm_request.*.jsonl" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $lastLlm = if ($f) { $f.LastWriteTime } else { (Get-Date).AddDays(-1) }
  $wal = Get-Item "$env:APPDATA/Aegis/aegis/data/sessions/sessions.db-wal" -ErrorAction SilentlyContinue
  $lastMsg = if ($wal) { $wal.LastWriteTime } else { $lastLlm }
  $last = if ($lastMsg -gt $lastLlm) { $lastMsg } else { $lastLlm }
  if ($last -lt (Get-Date).AddSeconds(-$IdleSeconds)) { break }
  if ((Get-Date) -gt $deadline) { W 'idle gate vencido, sigo'; break }
  Start-Sleep -Seconds 5
}
W 'store antes: ' + ((Get-Item "$env:APPDATA/Aegis/aegis/data/sessions/sessions.db").Length / 1MB).ToString('0.0') + ' MB'
$conn = Get-NetTCPConnection -LocalPort 3284 -State Listen -ErrorAction SilentlyContinue
if ($conn) { Stop-Process -Id $conn.OwningProcess -Force; Start-Sleep -Seconds 3; W 'serve detenido' }
& powershell -NoProfile -ExecutionPolicy Bypass -File 'C:/aegis-web/tools/prune-store.ps1' -Apply *>> $log
W 'prune termino (exit ' + $LASTEXITCODE + ')'
& powershell -NoProfile -ExecutionPolicy Bypass -File 'C:/aegis-web/scripts/start-aegis-web.ps1' *>> $log
Start-Sleep -Seconds 8
try { W ('health=' + (Invoke-WebRequest -Uri 'http://127.0.0.1:3284/health' -UseBasicParsing -TimeoutSec 15).StatusCode) } catch { W 'health error' }
W 'store despues: ' + ((Get-Item "$env:APPDATA/Aegis/aegis/data/sessions/sessions.db").Length / 1MB).ToString('0.0') + ' MB'

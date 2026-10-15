# Reinicia SOLO el server web de aegis-web (node, puerto web). El serve de aegis (3284) no
# se toca: el launcher es idempotente y arranca node solo si el puerto no escucha.
param([int]$DelaySecs = 0)
$ErrorActionPreference = 'Continue'
$root = 'C:/aegis-web'
$cfg = Get-Content "$root/config.json" -Raw | ConvertFrom-Json
if ($DelaySecs -gt 0) { Start-Sleep -Seconds $DelaySecs }
$conn = Get-NetTCPConnection -LocalPort $cfg.webPort -State Listen -ErrorAction SilentlyContinue
if ($conn) { Stop-Process -Id $conn.OwningProcess -Force; Start-Sleep -Seconds 2; Write-Output 'node detenido' } else { Write-Output 'node no estaba escuchando' }
$env:AEGIS_SERVER__SECRET_KEY = $cfg.secretKey
& powershell -NoProfile -ExecutionPolicy Bypass -File "$root/scripts/start-aegis-web.ps1"
Start-Sleep -Seconds 5
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$($cfg.webPort)/" -UseBasicParsing -TimeoutSec 20
  Write-Output ("web=" + $r.StatusCode)
  if ($r.Content -match 'app.js\?v=') { Write-Output 'cache-busting OK' } else { Write-Output 'cache-busting MISSING' }
} catch { Write-Output ('web error: ' + $_.Exception.Message) }
try { Write-Output ('config.js: ' + (Invoke-WebRequest -Uri "http://127.0.0.1:$($cfg.webPort)/config.js" -UseBasicParsing -TimeoutSec 15).Content.Substring(0, 120)) } catch { Write-Output 'config.js error' }

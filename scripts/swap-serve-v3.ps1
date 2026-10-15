# Swap aegis serve v2 -> v3 (v3 = parches de robustez de aegis: stall watchdog,
# aviso de interrupcion inesperada, client_cancelled, touch_progress).
# Uso: powershell -NoProfile -ExecutionPolicy Bypass -File swap-serve-v3.ps1
# NO correr mientras haya un run activo que importe: bajar el serve mata los runs en memoria.
$ErrorActionPreference = 'SilentlyContinue'
$root = 'C:\Aegis-Proyects\web'
$cfg = Get-Content "$root\config.json" -Raw | ConvertFrom-Json
$port = $cfg.servePort

if (-not (Test-Path 'C:\Aegis-Proyects\src\target\debug\goose-serve-v3.exe')) { Write-Output 'ERROR: no existe aegis-serve-v3.exe'; exit 1 }

# 1) bajar el serve actual
$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
  Write-Output "aegis-web: bajando serve pid $($conn.OwningProcess) (v2)"
  Stop-Process -Id $conn.OwningProcess -Force
  Start-Sleep -Seconds 2
} else {
  Write-Output 'aegis-web: no habia serve escuchando'
}

# 2) repuntar el script de arranque v2 -> v3 (backup unico)
$ps1 = "$root\scripts\start-aegis-web.ps1"
if (-not (Test-Path "$ps1.bak-pre-v3")) { Copy-Item $ps1 "$ps1.bak-pre-v3" -Force }
$c = Get-Content $ps1 -Raw
$c = $c -replace 'aegis-serve-v2\.exe', 'aegis-serve-v3.exe'
Set-Content -Path $ps1 -Value $c

# 3) levantar v3 con el mismo script (idempotente)
& $ps1

# 4) verificar
$up = $null
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 2
  $up = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($up) { break }
}
if ($up) { Write-Output "SWAP OK: v3 escuchando en $port (pid $($up.OwningProcess))" }
else { Write-Output 'SWAP FALLO: el puerto no escucha — revisar logs\serve.err.log' }

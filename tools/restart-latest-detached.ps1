# Reinicio detached del serve de aegis-web con la ultima version instalada (launcher).
# Nace de la regla 14: nunca reiniciar dentro del turno el proceso que hospeda la sesion
# (el Stop-Process a 3284 mata el turno a mitad de camino). Este script se lanza con
# Start-Process detached, espera inactividad real (llm_request + WAL del store) y recien
# entonces reapunta/reinicia via swap-serve.ps1, dejando verificacion en logs/.
#
# Uso: powershell -NoProfile -ExecutionPolicy Bypass -File restart-latest-detached.ps1 [-DelaySecs 40] [-IdleSeconds 25]
param([int]$DelaySecs = 40, [int]$IdleSeconds = 25, [int]$IdleTimeoutSecs = 600, [string]$Version = '')
$ErrorActionPreference = 'Continue'
$root = 'C:/aegis-web'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = "$root/logs/restart-latest-$stamp.log"
function W($m) { Add-Content -Path $log -Value ((Get-Date).ToString('HH:mm:ss') + ' ' + [string]$m) }

# (2026-10-15) La version sale del PUNTERO, no del launcher: el launcher ya no tiene la linea
# serveExe (ahora lee current-version.json), y parsearla dejaba este restarter muerto con el
# error "no pude deducir la version del launcher" (log 13:44:51, reproducido).
if (-not $Version) {
  try { $Version = (Get-Content 'C:/aegis/state/current-version.json' -Raw -Encoding UTF8 | ConvertFrom-Json).tag } catch { $Version = '' }
}
if (-not $Version) { W 'ERROR: no pude leer el tag del puntero C:/aegis/state/current-version.json'; exit 1 }
W "reinicio pedido: aegis-$Version (delay=${DelaySecs}s idle=${IdleSeconds}s) log=$log"

# (2026-10-15) Swap canonico (ops/swap.ps1 -Tag), no scripts/swap-serve.ps1: el viejo apuntaba
# a goose-<ver>.exe, que build-safe.ps1 nunca produjo (el desfase de versiones ya documentado).
# OJO con el pipe: el hijo detached (el serve nuevo) HEREDA el handle de stdout, el pipe nunca ve
# EOF y este restarter no termina nunca (15/10: quedo vivo 27 minutos despues de terminar su trabajo,
# sin escribir 'fin'). Redirigir a archivo corta esa herencia.
$swapOut = "$root/logs/swap-out-$stamp.log"
& powershell -NoProfile -ExecutionPolicy Bypass -File 'C:/aegis/ops/swap.ps1' `
    -Tag $Version -Restart -DelaySecs $DelaySecs -IdleSeconds $IdleSeconds -IdleTimeoutSecs $IdleTimeoutSecs *> $swapOut
Get-Content $swapOut -ErrorAction SilentlyContinue | ForEach-Object { W $_ }

$deadline = (Get-Date).AddSeconds(90)
while (-not (Get-NetTCPConnection -LocalPort 3284 -State Listen -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
}
$conn = Get-NetTCPConnection -LocalPort 3284 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
  $p = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
  W ("VERIFY pid={0} exe={1} started={2}" -f $p.Id, $p.Path, $p.StartTime)
  try { W ('version=' + ((& $p.Path --version 2>&1 | Select-Object -First 1))) } catch { W ('version error: ' + $_.Exception.Message) }
} else {
  W 'SERVE_NOT_UP'
}
try { W ('health=' + (Invoke-WebRequest -Uri 'http://127.0.0.1:3284/health' -UseBasicParsing -TimeoutSec 15).StatusCode) } catch { W ('health error: ' + $_.Exception.Message) }
try { W ('web=' + (Invoke-WebRequest -Uri 'http://127.0.0.1:3788/' -UseBasicParsing -TimeoutSec 15).StatusCode) } catch { W ('web error: ' + $_.Exception.Message) }
W 'fin'

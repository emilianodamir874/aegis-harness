# Vuelve la raiz al cliente anterior (vanilla) y deja constancia.
# Se ejecuta en un proceso aparte porque el server que sirve la web es el mismo que hospeda la sesion.
param([int]$Delay = 15, [int]$Port = 3788)
$ErrorActionPreference = 'Continue'
$root = 'C:/Aegis-Proyects/web'
$log = Join-Path $root 'logs\rollback-vanilla.log'
function Diario([string]$t) { Add-Content -Path $log -Value ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $t) -Encoding UTF8 }

Diario "rollback pedido; espera ${Delay}s"
Start-Sleep -Seconds $Delay

# 1. Marca fuera y variable fuera: que ningun arranque futuro sirva React en la raiz.
$marcador = Join-Path $root 'state\use-react-client'
if (Test-Path $marcador) { Remove-Item $marcador -Force; Diario 'marcador borrado' }
Remove-Item Env:\AEGIS_WEB_ROOT -ErrorAction SilentlyContinue

# 2. Bajar el server actual por dueno del puerto y esperar a que quede libre.
for ($intento = 0; $intento -lt 3; $intento++) {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if (-not $conn) { break }
  foreach ($procId in ($conn | Select-Object -ExpandProperty OwningProcess -Unique)) {
    try { Stop-Process -Id $procId -Force -ErrorAction Stop; Diario "detenido pid=$procId" } catch { Diario "no pude detener ${procId}: $($_.Exception.Message)" }
  }
  for ($i = 0; $i -lt 20; $i++) {
    if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
  }
}

# 3. Arrancar el launcher de siempre: ese es el que sirve el cliente anterior en la raiz.
$launcher = Join-Path $root 'scripts\start-aegis-web.ps1'
Diario "arrancando $launcher sin AEGIS_WEB_ROOT"
Start-Process -FilePath powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`"" -WindowStyle Hidden

# 4. Verificar el efecto: la raiz tiene que volver a ser el cliente anterior (sin /app-react/assets).
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 700
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 5
    $react = [regex]::Match($r.Content, '/app-react/assets/').Success
    Diario ("raiz status=" + $r.StatusCode + " bytes=" + $r.Content.Length + " clienteReact=" + $react)
    if ($r.StatusCode -eq 200 -and -not $react) { Diario 'ROLLBACK OK: la raiz sirve el cliente anterior'; break }
  } catch { }
}

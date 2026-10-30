<#
Swap de la web al cliente React, en un proceso aparte y con rollback autom?tico.

Existe porque el proceso que sirve la web es el mismo que hospeda la sesi?n del agente: reiniciarlo
dentro del turno corta la conversacion. Por eso espera `-Delay`, hace el cambio y escribe el
resultado a un log, todo fuera del turno.

Qu? hace, en orden:
  1. espera -Delay segundos (para que el turno que lo lanz? termine de escribir su respuesta);
  2. mata el servidor que escucha en -Port;
  3. arranca dist-ts/server.mjs con AEGIS_WEB_ROOT=react;
  4. espera /healthz y comprueba que "/" apunte a /app-react/assets/? y que el asset d? 200;
  5. si algo de eso falla: mata la instancia nueva, arranca la vieja SIN la variable y deja constancia.

Uso: powershell -NoProfile -File scripts/publish-app-react-swap.ps1 -Port 3788 -Delay 120
#>
param(
  [int]$Port = 3788,
  [int]$Delay = 120,
  [string]$Log = ''
)

$ErrorActionPreference = 'Continue'
$web = Split-Path -Parent $PSScriptRoot
if (-not $Log) { $Log = Join-Path $web ('logs\publish-react-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log') }
$dir = Split-Path -Parent $Log
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$server = Join-Path $web 'dist-ts\server.mjs'

function Diario([string]$texto) {
  $linea = '[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $texto
  Add-Content -Path $Log -Value $linea -Encoding UTF8
}

function Libre([int]$puerto) {
  $c = Get-NetTCPConnection -LocalPort $puerto -State Listen -ErrorAction SilentlyContinue
  return (-not $c)
}

function Health([int]$puerto, [int]$intentos = 40) {
  for ($i = 0; $i -lt $intentos; $i++) {
    try { if ((Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$puerto/healthz" -TimeoutSec 3).StatusCode -eq 200) { return $true } } catch { }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Arrancar([bool]$react) {
  if ($react) { $env:AEGIS_WEB_ROOT = 'react' } else { Remove-Item Env:\AEGIS_WEB_ROOT -ErrorAction SilentlyContinue }
  $env:AEGIS_WEB_PORT = "$Port"
  Start-Process -FilePath node -ArgumentList "`"$server`"" -WorkingDirectory $web -WindowStyle Hidden
}

Diario "swap pedido: puerto $Port, espera ${Delay}s"

# 1. Esperar a que el turno que lanz? esto termine.
for ($i = $Delay; $i -gt 0; $i -= 10) {
  if ($i % 30 -eq 0) { Diario "faltan $i s" }
  Start-Sleep -Seconds ([Math]::Min(10, $i))
}

# 2. Bajar el servidor actual por due?o del puerto, nunca por nombre.
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($conn) {
  foreach ($pid in ($conn | Select-Object -ExpandProperty OwningProcess -Unique)) {
    try {
      $proc = Get-Process -Id $pid -ErrorAction Stop
      Diario "deteniendo pid=$pid ($($proc.ProcessName))"
      Stop-Process -Id $pid -Force -ErrorAction Stop
    } catch {
      Diario "no pude detener pid=$pid : $($_.Exception.Message)"
    }
  }
}
for ($i = 0; $i -lt 20 -and -not (Libre $Port); $i++) { Start-Sleep -Milliseconds 500 }
if (-not (Libre $Port)) {
  Diario 'ABORTADO: el puerto sigue tomado; no toqu? nada m?s'
  exit 1
}
Diario "puerto $Port libre"

# 3. Arrancar el cliente React.
Arrancar $true
if (-not (Health $Port)) {
  Diario 'la instancia React no respondi? /healthz: rollback'
  foreach ($pid in ((Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) | Select-Object -ExpandProperty OwningProcess -Unique)) {
    Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1
  Arrancar $false
  if (Health $Port) { Diario 'rollback ok: la web volvi? al cliente actual' } else { Diario 'CRITICO: ni el rollback respondi?; revisar a mano' }
  exit 1
}

# 4. Verificar que la raiz sirva el React de verdad.
try {
  $raiz = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/" -TimeoutSec 10
  $asset = [regex]::Match($raiz.Content, '/app-react/assets/[^"]+\.js').Value
  if (-not $asset) { throw 'la raiz no apunta a /app-react/assets' }
  $js = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port$asset" -TimeoutSec 20
  if ($js.StatusCode -ne 200) { throw "el asset respondi? $($js.StatusCode)" }
  Diario "PUBLICADO: raiz -> $asset ($($js.RawContentLength) bytes), healthz ok"
  Diario 'rollback manual: scripts/publish-app-react.ps1 -Rollback, o arrancar node sin AEGIS_WEB_ROOT'
} catch {
  Diario "verificacion fallida: $($_.Exception.Message) - rollback"
  foreach ($pid in ((Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) | Select-Object -ExpandProperty OwningProcess -Unique)) {
    Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1
  Arrancar $false
  if (Health $Port) { Diario 'rollback ok: la web volvi? al cliente actual' } else { Diario 'CRITICO: ni el rollback respondi?' }
  exit 1
}

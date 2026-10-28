<#
Publica el cliente React en la raíz del servidor web, con rollback automático.

Qué hace, en orden:
  1. Comprueba que existan frontend/dist/index.html y dist-ts/server.mjs.
  2. Levanta una instancia NUEVA con AEGIS_WEB_ROOT=react en el puerto destino y espera /healthz.
  3. Pide "/" y verifica que el HTML apunte a /app-react/assets y que ese asset responda 200.
  4. Sólo si (3) pasa, libera el puerto viejo y deja la instancia nueva.
  5. Si algo falla, mata la instancia nueva y NO toca la que estaba: rollback = no haber hecho nada.

Uso:
  pwsh -File scripts/publish-app-react.ps1                 # publica en 3788 (el puerto real)
  pwsh -File scripts/publish-app-react.ps1 -Port 3792 -DryRun   # ensaya en otro puerto sin tocar el real

Para volver atrás después de publicar: scripts/publish-app-react.ps1 -Rollback
#>
param(
  [int]$Port = 3788,
  [switch]$DryRun,
  [switch]$Rollback
)

$ErrorActionPreference = 'Stop'
$web = Split-Path -Parent $PSScriptRoot
$server = Join-Path $web 'dist-ts\server.mjs'
$index = Join-Path $web 'frontend\dist\index.html'

function Esperar-Health([int]$puerto, [int]$intentos = 30) {
  for ($i = 0; $i -lt $intentos; $i++) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$puerto/healthz" -TimeoutSec 3
      if ($r.StatusCode -eq 200) { return $true }
    } catch { Start-Sleep -Milliseconds 500 }
  }
  return $false
}

function Puerto-Ocupado([int]$puerto) {
  try { return (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$puerto/healthz" -TimeoutSec 2).StatusCode -eq 200 } catch { return $false }
}

if ($Rollback) {
  if (-not (Test-Path $server)) { throw "falta ${server}: compilá con npm run build en web/" }
  if (Puerto-Ocupado $Port) { throw "el puerto ${Port} ya responde: paralo antes de hacer rollback (el proceso viejo es el que sirve el cliente actual)" }
  Remove-Item Env:\AEGIS_WEB_ROOT -ErrorAction SilentlyContinue
  Start-Process -FilePath node -ArgumentList "`"$server`"" -WorkingDirectory $web -WindowStyle Hidden
  if (Esperar-Health $Port) { Write-Host "rollback ok: $Port sirve el cliente actual otra vez" } else { throw 'el rollback no respondió' }
  exit 0
}

if (-not (Test-Path $index)) { throw "falta ${index}: corré npm --prefix frontend run build y node frontend/scripts/precompress.mjs frontend/dist" }
if (-not (Test-Path $server)) { throw "falta ${server}: corré npm run build en web/" }

if ((Puerto-Ocupado $Port) -and -not $DryRun) {
  throw "el puerto ${Port} ya está sirviendo: este script levanta la instancia nueva antes de tirar la vieja, así que necesita el puerto libre. Plan B: publicá con AEGIS_WEB_ROOT=react en el launcher y reiniciá con el watchdog."
}

$env:AEGIS_WEB_ROOT = 'react'
$env:AEGIS_WEB_PORT = "$Port"
if (-not $env:AEGIS_WEB_TLS_DIR) { $env:AEGIS_WEB_TLS_DIR = 'C:/nonexistent-tls' }

$nuevo = Start-Process -FilePath node -ArgumentList "`"$server`"" -WorkingDirectory $web -PassThru -WindowStyle Hidden
try {
  if (-not (Esperar-Health $Port)) { throw "la instancia nueva no respondió /healthz en $Port" }
  $raiz = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/" -TimeoutSec 10
  $asset = [regex]::Match($raiz.Content, '/app-react/assets/[^"]+\.js').Value
  if (-not $asset) { throw 'la raíz no apunta a /app-react/assets: AEGIS_WEB_ROOT no tomó efecto' }
  $js = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port$asset" -TimeoutSec 20
  if ($js.StatusCode -ne 200 -or $js.RawContentLength -lt 1000) { throw "el asset $asset no salió bien" }
  Write-Host "publicado en $Port`: raiz -> $asset ($($js.RawContentLength) bytes)"
  if ($DryRun) {
    Write-Host 'dry-run: dejo la instancia nueva viva para inspección y salgo'
  }
} catch {
  Write-Host "fallo: $($_.Exception.Message)"
  Write-Host 'rollback: mato la instancia nueva; la anterior no se tocó'
  Stop-Process -Id $nuevo.Id -Force -ErrorAction SilentlyContinue
  throw
}

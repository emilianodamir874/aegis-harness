# Reinicia SOLO el server web de aegis-web (node, puerto web). El serve de aegis (3284) no se toca.
#
# Un solo paso: mata por due??o del puerto, espera a que el puerto quede libre de verdad y arranca
# `dist-ts/server.mjs` con el entorno ya resuelto. Antes delegaba en start-aegis-web.ps1, que a su vez
# era idempotente ("ya escucha, no hago nada"): el proceso viejo sobreviv??a y las variables nuevas
# nunca se aplicaban. Ese era el motivo de que AEGIS_WEB_ROOT no tomara efecto.
#
# Publicaci??n del cliente React: si existe web/state/use-react-client, la ra??z sirve frontend/dist.
# Rollback: borrar ese archivo y volver a correr esto.
param([int]$DelaySecs = 0)
$ErrorActionPreference = 'Continue'
$root = 'C:/Aegis-Proyects/web'
$cfg = Get-Content "$root/config.json" -Raw | ConvertFrom-Json
if ($DelaySecs -gt 0) { Start-Sleep -Seconds $DelaySecs }

function Puerto-Libre([int]$puerto) {
  return (-not (Get-NetTCPConnection -LocalPort $puerto -State Listen -ErrorAction SilentlyContinue))
}

# 1. Bajar lo que escuche en el puerto web, y esperar de verdad.
for ($intento = 0; $intento -lt 3; $intento++) {
  $conn = Get-NetTCPConnection -LocalPort $cfg.webPort -State Listen -ErrorAction SilentlyContinue
  if (-not $conn) { break }
  foreach ($procId in ($conn | Select-Object -ExpandProperty OwningProcess -Unique)) {
    try { Stop-Process -Id $procId -Force -ErrorAction Stop; Write-Output "node detenido (pid $procId)" } catch { Write-Output ('no pude detener ' + $procId + ': ' + $_.Exception.Message) }
  }
  for ($i = 0; $i -lt 20 -and -not (Puerto-Libre $cfg.webPort); $i++) { Start-Sleep -Milliseconds 500 }
}

if (-not (Puerto-Libre $cfg.webPort)) {
  Write-Output "ABORTADO: el puerto $($cfg.webPort) sigue tomado; no arranco nada"
  exit 1
}

# 2. Entorno: lo que el server necesita y lo que decide qu?? cliente sirve la ra??z.
$env:AEGIS_SERVER__SECRET_KEY = $cfg.secretKey
if (-not $env:AEGIS_WEB_TLS_DIR) { $env:AEGIS_WEB_TLS_DIR = 'C:\Aegis-Proyects\core\state\tls' }
if (-not $env:AEGIS_WEB_HTTPS_PORT) { $env:AEGIS_WEB_HTTPS_PORT = '3789' }
if (-not $env:AEGIS_PATH_ROOT -and (Test-Path 'C:\Aegis-Proyects\state\data')) { $env:AEGIS_PATH_ROOT = 'C:\Aegis-Proyects\state' }
if (-not $env:AEGIS_SHELL) { $env:AEGIS_SHELL = 'powershell' }
$marcador = Join-Path $root 'state\use-react-client'
if (-not $env:AEGIS_WEB_ROOT -and (Test-Path $marcador)) { $env:AEGIS_WEB_ROOT = 'react' }
Write-Output ('AEGIS_WEB_ROOT=' + ($(if ($env:AEGIS_WEB_ROOT) { $env:AEGIS_WEB_ROOT } else { '(sin definir)' })))

# 3. Arrancar el server compilado (dist-ts), que es el que entiende el interruptor.
$server = Join-Path $root 'dist-ts\server.mjs'
if (-not (Test-Path $server)) { Write-Output "falta $server : compil?? con npm run build en web/"; exit 1 }
Start-Process -FilePath node -ArgumentList "`"$server`"" -WorkingDirectory $root -WindowStyle Hidden

# 4. Verificar el efecto, no la intenci??n.
$listo = $false
for ($i = 0; $i -lt 40; $i++) {
  try { if ((Invoke-WebRequest -Uri "http://127.0.0.1:$($cfg.webPort)/healthz" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { $listo = $true; break } } catch { }
  Start-Sleep -Milliseconds 500
}
if (-not $listo) { Write-Output 'web: no respondi?? /healthz'; exit 1 }

try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$($cfg.webPort)/" -UseBasicParsing -TimeoutSec 20
  $asset = [regex]::Match($r.Content, '/app-react/assets/[^"]+\.js').Value
  Write-Output ("web=" + $r.StatusCode + " clienteReact=" + [bool]$asset + " asset=" + $asset)
  if ($asset) {
    $js = Invoke-WebRequest -Uri "http://127.0.0.1:$($cfg.webPort)$asset" -UseBasicParsing -TimeoutSec 20
    Write-Output ("asset=" + $js.StatusCode + " bytes=" + $js.RawContentLength)
  } elseif ($r.Content -match 'app\.js\?v=') {
    Write-Output 'cache-busting OK (cliente actual)'
  }
} catch { Write-Output ('web error: ' + $_.Exception.Message) }

# aegis-web: start backend (aegis serve) + web UI if not already listening.
# Idempotent. Hidden-window friendly (used by the Aegis_Web scheduled task).
$ErrorActionPreference = 'SilentlyContinue'

$root = 'C:\Aegis-Proyects\web'
$nodeCandidates = @(
  'C:\Users\Emiliano\AppData\Local\hermes\tools\node-26.7.0-win32-x64\node.exe',
  'C:\Users\Emiliano\scoop\apps\fnm\current\node-versions\v22.23.2\installation\node.exe',
  'C:\Users\Emiliano\AppData\Local\hermes\tools\.reclaim-b5211fe162ad438ca39ea28e075f9794\node.exe'
)
$node = ($nodeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1)
if (-not $node) { Write-Output 'aegis-web: NO hay node.exe disponible'; exit 1 }
# HTTPS en LAN (3789): sin esto el dictado por voz no anda por la IP, porque getUserMedia
# exige contexto seguro. El 3788 sigue siendo http (origen del tunel y de los enlaces viejos).
if (-not $env:AEGIS_WEB_TLS_DIR) { $env:AEGIS_WEB_TLS_DIR = 'C:\Aegis-Proyects\core\state\tls' }
if (-not $env:AEGIS_WEB_HTTPS_PORT) { $env:AEGIS_WEB_HTTPS_PORT = '3789' }
# Version del serve: sale del PUNTERO (C:\Aegis-Proyects\core\state\current-version.json), no de este archivo.
# Antes estaba clavada aca (aegis-v34.exe): asi se desincronizo del resto del stack el 14/10.
$ptrFile = 'C:\Aegis-Proyects\core\state\current-version.json'
$serveExe = $null
if (Test-Path $ptrFile) {
  try { $serveExe = (Get-Content $ptrFile -Raw -Encoding UTF8 | ConvertFrom-Json).exe } catch { $serveExe = $null }
}
if (-not $serveExe -or -not (Test-Path $serveExe)) { $serveExe = 'C:\Aegis-Proyects\core\bin\aegis-current.exe' }
if (-not (Test-Path $serveExe)) { Write-Output 'aegis-web: NO hay binario del serve (ni puntero ni current)'; exit 1 }
Write-Output ('aegis-web: serveExe=' + $serveExe)
# El shell del agente en Windows: powershell en vez de cmd (sin los problemas de
# quoting de cmd y con multilinea). Quitar esta linea para volver a cmd.
if (-not $env:AEGIS_PATH_ROOT -and (Test-Path 'C:\Aegis-Proyects\state\data')) { $env:AEGIS_PATH_ROOT = 'C:\Aegis-Proyects\state' }  # el dato vive con el proyecto
if (-not $env:AEGIS_SHELL) { $env:AEGIS_SHELL = 'powershell' }
$cfg = Get-Content "$root\config.json" -Raw | ConvertFrom-Json

New-Item -ItemType Directory -Force "$root\logs" | Out-Null

$serveUp = Get-NetTCPConnection -LocalPort $cfg.servePort -State Listen -ErrorAction SilentlyContinue
if (-not $serveUp) {
  $env:AEGIS_SERVER__SECRET_KEY = $cfg.secretKey
  Start-Process -FilePath $serveExe -ArgumentList @(
    'serve', '--host', '0.0.0.0', '--port', "$($cfg.servePort)",
    '--platform', 'desktop', '--enable-scheduler', '--with-builtin', 'developer',
    '--allowed-origin', "http://$($cfg.publicHost):$($cfg.webPort)",
    '--allowed-origin', "http://127.0.0.1:$($cfg.webPort)",
    '--allowed-origin', "http://localhost:$($cfg.webPort)"
  ) -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput "$root\logs\serve.out.log" -RedirectStandardError "$root\logs\serve.err.log"
  Write-Output "aegis-web: started serve on $($cfg.servePort)"
} else {
  Write-Output "aegis-web: serve already listening on $($cfg.servePort)"
}

$webUp = Get-NetTCPConnection -LocalPort $cfg.webPort -State Listen -ErrorAction SilentlyContinue
if (-not $webUp) {
  Start-Process -FilePath $node -ArgumentList 'server.mjs' -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput "$root\logs\server.out.log" -RedirectStandardError "$root\logs\server.err.log"
  Write-Output "aegis-web: started web UI on $($cfg.webPort)"
} else {
  Write-Output "aegis-web: web UI already listening on $($cfg.webPort)"
}

Write-Output "aegis-web: URL http://$($cfg.publicHost):$($cfg.webPort)"









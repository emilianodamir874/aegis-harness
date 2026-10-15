# goose-web: start backend (goose serve) + web UI if not already listening.
# Idempotent. Hidden-window friendly (used by the Goose_Web scheduled task).
$ErrorActionPreference = 'SilentlyContinue'

$root = 'C:\goose-web'
$nodeCandidates = @(
  'C:\Users\Emiliano\AppData\Local\hermes\tools\node-26.7.0-win32-x64\node.exe',
  'C:\Users\Emiliano\scoop\apps\fnm\current\node-versions\v22.23.2\installation\node.exe',
  'C:\Users\Emiliano\AppData\Local\hermes\tools\.reclaim-b5211fe162ad438ca39ea28e075f9794\node.exe'
)
$node = ($nodeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1)
if (-not $node) { Write-Output 'goose-web: NO hay node.exe disponible'; exit 1 }
$serveExe = 'C:\goose\target\debug\goose-v28.exe'
$cfg = Get-Content "$root\config.json" -Raw | ConvertFrom-Json

New-Item -ItemType Directory -Force "$root\logs" | Out-Null

$serveUp = Get-NetTCPConnection -LocalPort $cfg.servePort -State Listen -ErrorAction SilentlyContinue
if (-not $serveUp) {
  $env:GOOSE_SERVER__SECRET_KEY = $cfg.secretKey
  Start-Process -FilePath $serveExe -ArgumentList @(
    'serve', '--host', '0.0.0.0', '--port', "$($cfg.servePort)",
    '--platform', 'desktop', '--enable-scheduler', '--with-builtin', 'developer',
    '--allowed-origin', "http://$($cfg.publicHost):$($cfg.webPort)",
    '--allowed-origin', "http://127.0.0.1:$($cfg.webPort)",
    '--allowed-origin', "http://localhost:$($cfg.webPort)"
  ) -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput "$root\logs\serve.out.log" -RedirectStandardError "$root\logs\serve.err.log"
  Write-Output "goose-web: started serve on $($cfg.servePort)"
} else {
  Write-Output "goose-web: serve already listening on $($cfg.servePort)"
}

$webUp = Get-NetTCPConnection -LocalPort $cfg.webPort -State Listen -ErrorAction SilentlyContinue
if (-not $webUp) {
  Start-Process -FilePath $node -ArgumentList 'server.mjs' -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput "$root\logs\server.out.log" -RedirectStandardError "$root\logs\server.err.log"
  Write-Output "goose-web: started web UI on $($cfg.webPort)"
} else {
  Write-Output "goose-web: web UI already listening on $($cfg.webPort)"
}

Write-Output "goose-web: URL http://$($cfg.publicHost):$($cfg.webPort)"









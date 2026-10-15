# aegis-web: stop backend + web UI (kills whatever listens on the configured ports).
$ErrorActionPreference = 'SilentlyContinue'
$root = 'C:\aegis-web'
$cfg = Get-Content "$root\config.json" -Raw | ConvertFrom-Json

foreach ($port in @($cfg.servePort, $cfg.webPort)) {
  $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($l in $listeners) {
    Stop-Process -Id $l.OwningProcess -Force -ErrorAction SilentlyContinue
    Write-Output "aegis-web: stopped pid $($l.OwningProcess) on port $port"
  }
  if (-not $listeners) { Write-Output "aegis-web: nothing listening on $port" }
}

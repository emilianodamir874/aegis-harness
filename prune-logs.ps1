# Retencion de logs. Por defecto MUEVE a backups (rollback trivial); -Hard borra.
# Politica: por carpeta de proceso, 14 dias o 200 MB (lo que ocurra primero).
# Cubre las tres raices reales mientras dure la migracion a C:\Aegis-Proyects\core\logs (que exige reiniciar el tunel).
# Los archivos que un proceso tiene abiertos (cloudflared-*.log, serve.out.log) fallan el move
# y se saltean solos: esos se rotan recien cuando su dueno reinicia.
param([int]$Days = 14, [int]$MaxMB = 200, [switch]$Hard, [switch]$Apply)
$ErrorActionPreference = 'Continue'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$cut   = (Get-Date).AddDays(-$Days)
$arc   = "C:\Aegis-Proyects\core\backups\$stamp-logs-pruned"
$roots = @('C:\Aegis-Proyects\core\logs', 'C:\Aegis-Proyects\web\logs') 
$storeLogs = Join-Path $env:APPDATA 'Aegis\aegis\data\logs'
if (Test-Path $storeLogs) { $roots += $storeLogs }
$logDir = 'C:\Aegis-Proyects\core\logs\gc'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir ('retention-' + (Get-Date -Format 'yyyyMMdd') + '.log')
function W($m) { $m; if ($Apply) { $m | Out-File -FilePath $log -Append -Encoding utf8 } }

$victims = @()
foreach ($root in $roots) {
  if (-not (Test-Path $root)) { continue }
  W ('--- ' + $root)
  foreach ($dir in (Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'gc' })) {
    $files = Get-ChildItem $dir.FullName -Recurse -File -ErrorAction SilentlyContinue
    if ($files.Count -eq 0) { continue }
    $pick = @()
    $pick += $files | Where-Object { $_.LastWriteTime -lt $cut }
    $rest = $files | Where-Object { $_.LastWriteTime -ge $cut } | Sort-Object LastWriteTime -Descending
    $acc = 0.0
    foreach ($f in $rest) { $acc += $f.Length/1MB; if ($acc -gt $MaxMB) { $pick += $f } }
    $pick = $pick | Sort-Object FullName -Unique
    W ('  ' + $dir.Name + ': ' + $files.Count + ' arch, ' + [math]::Round(($files | Measure-Object Length -Sum).Sum/1MB,2) + 'MB -> poda ' + $pick.Count)
    $victims += $pick
  }
  # archivos sueltos en la raiz (build-*.log, swap-*.log, serve.*.log)
  $loose = Get-ChildItem $root -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt $cut }
  if ($loose.Count -gt 0) { W ('  (raiz) ' + $loose.Count + ' archivos viejos'); $victims += $loose }
}
$victims = $victims | Sort-Object FullName -Unique
$mb = [math]::Round((($victims | Measure-Object Length -Sum).Sum)/1MB,2)
W ('TOTAL a podar: ' + $victims.Count + ' archivos, ' + $mb + ' MB')
if ($victims.Count -eq 0) { W 'nada que podar'; exit 0 }
if (-not $Apply) { $victims | Select-Object -First 20 | ForEach-Object { '  (dry) ' + $_.FullName }; W 'dry-run: use -Apply'; exit 0 }
if ($Hard) {
  foreach ($f in $victims) { Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue }
  W ('borrado (hard): ' + $victims.Count)
} else {
  New-Item -ItemType Directory -Force $arc | Out-Null
  $n = 0; $skip = 0
  foreach ($f in $victims) {
    $rel = ($f.FullName -replace '^[A-Za-z]:','') -replace '[\\/:]','_'
    try { Move-Item $f.FullName (Join-Path $arc $rel) -Force -ErrorAction Stop; $n++ } catch { $skip++ }
  }
  W ('movidos a ' + $arc + ': ' + $n + ' | salteados (en uso): ' + $skip)
}

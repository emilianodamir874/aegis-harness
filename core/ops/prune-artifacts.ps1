# Retencion de artefactos de compilacion y basura de trabajo.
# Por defecto DRY-RUN: muestra que haria. Con -Apply ejecuta.
# No toca nada vivo: solo incremental de cargo, temp viejo, tmp del proyecto y reporta el resto.
param([int]$Days = 14, [int]$TempDays = 7, [int]$WarnFreeGB = 60, [switch]$Apply)
$ErrorActionPreference = 'Continue'
$R = 'C:\Aegis-Proyects'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logDir = Join-Path $R 'core\logs\gc'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir ('artifacts-' + (Get-Date -Format 'yyyyMMdd') + '.log')
$lineas = @()
function W($m) { $script:lineas += $m; $m }
$cut = (Get-Date).AddDays(-$Days)
$cutTemp = (Get-Date).AddDays(-$TempDays)
$borrados = 0; $mb = 0

W ('=== poda de artefactos ' + $stamp + ($(if ($Apply) { ' (APPLY)' } else { ' (dry-run)' })) + ' ===')

# 1) incremental de cargo: siempre regenerable
foreach ($base in @((Join-Path $R 'target'), (Join-Path $R 'bridge\target'), (Join-Path $R 'trading\target'))) {
  if (-not (Test-Path $base)) { continue }
  $inc = Get-ChildItem $base -Recurse -Directory -Filter 'incremental' -Depth 2 -ErrorAction SilentlyContinue
  foreach ($d in $inc) {
    $sz = [math]::Round(((Get-ChildItem $d.FullName -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum)/1MB,1)
    W ('incremental: ' + $d.FullName + ' = ' + $sz + ' MB')
    if ($Apply) { try { Remove-Item $d.FullName -Recurse -Force -ErrorAction Stop; $borrados++; $mb += $sz } catch { W '  BLOQUEADO ' + $_.Exception.Message } }
    else { $mb += $sz }
  }
}
# 2) temp del usuario, archivos viejos (no carpetas en uso)
$tmp = Join-Path $env:LOCALAPPDATA 'Temp'
if (Test-Path $tmp) {
  $viejos = Get-ChildItem $tmp -Force -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt $cutTemp }
  foreach ($v in $viejos) {
    $sz = [math]::Round($(if ($v.PSIsContainer) { (Get-ChildItem $v.FullName -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum } else { $v.Length })/1MB, 1)
    if ($Apply) { try { Remove-Item $v.FullName -Recurse -Force -ErrorAction Stop; $borrados++; $mb += $sz } catch { } }
    else { $mb += $sz; if ($mb -lt 1) { } }
  }
  W ('temp: ' + @($viejos).Count + ' items de mas de ' + $TempDays + ' dias')
}
# 3) tmp del proyecto, archivos viejos
if (Test-Path (Join-Path $R 'tmp')) {
  $t = Get-ChildItem (Join-Path $R 'tmp') -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt $cut }
  foreach ($v in $t) { $sz = [math]::Round($v.Length/1MB,1); if ($Apply) { try { Remove-Item $v.FullName -Force -ErrorAction Stop; $borrados++; $mb += $sz } catch {} } else { $mb += $sz } }
  W ('tmp del proyecto: ' + @($t).Count + ' archivos de mas de ' + $Days + ' dias')
}
# 4) reporte (no borra): snapshots viejos de archive y evidencia
foreach ($p in @((Join-Path $R 'archive'), (Join-Path $R 'trading\artifacts'), (Join-Path $R 'bridge\.desktop-runtime'))) {
  if (Test-Path $p) {
    $sz = [math]::Round(((Get-ChildItem $p -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum)/1MB,1)
    W ('REPORTE (no se toca): ' + $p + ' = ' + $sz + ' MB')
  }
}
$free = [math]::Round((Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'").FreeSpace / 1GB, 1)
W ('libre en C: ' + $free + ' GB (umbral de aviso: ' + $WarnFreeGB + ' GB)')
if ($free -lt $WarnFreeGB) { W 'AVISO: queda poco espacio libre' }
W ('recuperable/recuperado: ' + [math]::Round($mb,1) + ' MB en ' + $borrados + ' items')
$lineas | Out-File -FilePath $log -Encoding UTF8 -Append

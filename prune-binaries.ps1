# Retencion de binarios del serve: conserva los N tags mas nuevos y archiva el resto.
# Nunca toca el binario en uso. -Apply para ejecutar (por defecto dry-run).
param([int]$Keep = 3, [switch]$Apply)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_pointer.ps1')
$arc = Join-Path $AegisRoot ('backups\binaries-pruned-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$inUse = @(Get-CimInstance Win32_Process | ForEach-Object { $_.ExecutablePath } | Where-Object { $_ }) | Sort-Object -Unique
$cur = Get-AegisCurrent

$all = Get-ChildItem $BinDir -File -Filter 'aegis-v*.exe' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
'binarios en ' + $BinDir + ': ' + $all.Count + ' | conservo: ' + $Keep
$protect = @()
if ($cur) { $protect += $cur.exe.ToLower() }
foreach ($f in $all) { if ($inUse -contains $f.FullName) { $protect += $f.FullName.ToLower() } }

$keepSet = @(); $i = 0
foreach ($f in $all) {
  if ($protect -contains $f.FullName.ToLower()) { $keepSet += $f.Name; continue }
  if ($i -lt $Keep) { $keepSet += $f.Name; $i++; continue }
}
$move = $all | Where-Object { $keepSet -notcontains $_.Name }
'conservo: ' + ($keepSet -join ', ')
if ($move.Count -eq 0) { 'nada que archivar'; exit 0 }
$mb = [math]::Round((($move | Measure-Object Length -Sum).Sum)/1MB,1)
'archivo: ' + $move.Count + ' binarios, ' + $mb + ' MB -> ' + $arc
if (-not $Apply) { $move | ForEach-Object { '  (dry) ' + $_.Name }; 'dry-run: use -Apply'; exit 0 }
New-Item -ItemType Directory -Force $arc | Out-Null
foreach ($f in $move) {
  try { Move-Item $f.FullName $arc -Force -ErrorAction Stop; '  movido ' + $f.Name }
  catch { '  BLOQUEADO ' + $f.Name + ' :: ' + $_.Exception.Message }
}

# Mueve el checkout del fork C:\goose -> C:\Aegis-Proyects\src, con rollback escrito.
# Pasos: (1) guarda si algo lo usa, (2) repunta las referencias, (3) renombra,
# (4) si el rename falla, revierte las referencias. (5) verifica.
# Basado en el enfoque de tools\aegis-rename\move-checkout.ps1, pero con el destino
# C:\Aegis-Proyects\src (el kit apuntaba a C:\Aegis-Proyects\core, que es la raiz de artefactos del plan).
param([switch]$Apply)
$ErrorActionPreference = 'Continue'
$src = 'C:\goose'
$dst = 'C:\Aegis-Proyects\src'
$ops = 'C:\Aegis-Proyects\core\ops'
$logDir = 'C:\Aegis-Proyects\core\logs\gc'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir 'move-checkout.log'
function L($m) { $x = ((Get-Date -Format 'HH:mm:ss') + ' ' + $m); $x; $x | Out-File -FilePath $log -Append -Encoding utf8 }

L ('==== move-checkout (Apply=' + $Apply + ') ====')
if (-not (Test-Path $src)) { L ('no existe ' + $src + ' (ya movido?)'); exit 0 }
if (Test-Path $dst) { L ('ABORTA: ya existe ' + $dst); exit 1 }

$rx = [regex]('(?i)C:[\\/]+goose(?![-A-Za-z0-9_])')
$inUse = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ExecutablePath -and ($rx.IsMatch($_.ExecutablePath))
}
if ($inUse) {
  L 'ABORTA: hay procesos corriendo desde el checkout:'
  $inUse | ForEach-Object { L ('   pid ' + $_.ProcessId + '  ' + $_.Name + '  ' + $_.ExecutablePath) }
  exit 1
}
L 'checkout libre (ningun proceso corre desde ahi)'

if (-not $Apply) {
  L 'DRY: repuntaria las referencias y despues renombraria'
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ops 'repoint-checkout.ps1') 2>&1 | Select-Object -Last 4 | ForEach-Object { L $_ }
  exit 0
}

L '--- repuntando referencias ---'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ops 'repoint-checkout.ps1') -Apply 2>&1 | Select-Object -Last 5 | ForEach-Object { L $_ }
L '--- renombrando ---'
try {
  Rename-Item -Path $src -NewName 'aegis-src' -ErrorAction Stop
  L ('checkout renombrado -> ' + $dst)
} catch {
  L ('ERROR renombrando: ' + $_.Exception.Message + ' -- revirtiendo referencias')
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ops 'repoint-checkout.ps1') -Apply -Revert 2>&1 | Select-Object -Last 3 | ForEach-Object { L $_ }
  exit 1
}

L '--- verificacion ---'
L ('existe ' + $dst + ': ' + (Test-Path $dst))
L ('git status limpio: ' + (((git -C $dst status --porcelain=v1) | Measure-Object).Count -eq 0))
L ('git HEAD: ' + (git -C $dst log --oneline -1))
$agsDir = (Select-String -Path "$env:LOCALAPPDATA\hermes\bin\aegis.cmd" -Pattern 'AEGIS_DIR=(.+)$').Matches[0].Groups[1].Value.Trim()
L ('aegis.cmd AEGIS_DIR = ' + $agsDir + ' | existe: ' + (Test-Path $agsDir))
L ('referencias vivas a C:\goose que quedaron: ' + ((& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ops 'repoint-checkout.ps1')) | Select-String 'archivos: ').Line)
L 'FIN'

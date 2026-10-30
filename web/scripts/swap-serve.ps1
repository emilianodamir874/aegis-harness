# LEGACY shim (2026-10-19). El swap real vive en core\ops\swap.ps1: escribe el puntero,
# rehace el hardlink aegis-current.exe y espera inactividad leyendo state\state\logs y el WAL del store.
# Este archivo apuntaba a C:\Aegis-Proyects\src\target\debug\goose-<ver>.exe, ruta que no existe
# desde la migracion del 15/10. Se conserva como puente para invocaciones viejas (tareas, docs).
param(
  [Parameter(Mandatory=$true)][string]$Version,
  [switch]$Restart,
  [int]$DelaySecs = 0
)
$target = 'C:\Aegis-Proyects\core\ops\swap.ps1'
if (-not (Test-Path $target)) { Write-Output "ERROR: no existe $target"; exit 1 }
$a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $target, '-Tag', $Version)
if ($Restart) { $a += '-Restart' }
if ($DelaySecs -gt 0) { $a += @('-DelaySecs', "$DelaySecs") }
Write-Output ("swap-serve.ps1 -> core\ops\swap.ps1 -Tag " + $Version)
& powershell @a
exit $LASTEXITCODE

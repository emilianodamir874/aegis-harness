# Front-end del reinicio del serve de aegis-web: lanza restart-latest-detached.ps1
# DESPRENDIDO (regla 14: matar el 3284 dentro del turno corta la respuesta en curso) y
# devuelve la ruta del log de verificacion.
#
# Uso: powershell -NoProfile -ExecutionPolicy Bypass -File restart-latest.ps1
#        [-DelaySecs 40] [-IdleSeconds 25] [-Wait]
param([int]$DelaySecs = 40, [int]$IdleSeconds = 25, [int]$IdleTimeoutSecs = 600, [switch]$Wait)
$ErrorActionPreference = 'Stop'
$self = 'C:\Aegis-Proyects\web\tools\restart-latest-detached.ps1'
if (-not (Test-Path $self)) { throw "no existe $self" }
$before = Get-ChildItem 'C:\Aegis-Proyects\web\logs\restart-latest-*.log' -ErrorAction SilentlyContinue
Start-Process -FilePath 'powershell.exe' -ArgumentList @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $self,
  '-DelaySecs', "$DelaySecs", '-IdleSeconds', "$IdleSeconds", '-IdleTimeoutSecs', "$IdleTimeoutSecs"
) -WindowStyle Hidden
Start-Sleep -Seconds 6
$log = Get-ChildItem 'C:\Aegis-Proyects\web\logs\restart-latest-*.log' -ErrorAction SilentlyContinue |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $log -or ($before -and $log.FullName -eq $before[-1].FullName)) { 'ERROR: no arranco el restarter (sin log nuevo)'; exit 1 }
"restarter desprendido. log: $($log.FullName)"
if ($Wait) {
  $deadline = (Get-Date).AddSeconds(($DelaySecs + $IdleTimeoutSecs + 120))
  do { Start-Sleep -Seconds 10; $t = Get-Content $log.FullName -Tail 1 } while ($t -notmatch 'fin$' -and (Get-Date) -lt $deadline)
}
Get-Content $log.FullName

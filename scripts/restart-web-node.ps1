# Reinicia SOLO el node de la UI web (3788) para que tome server.mjs nuevo.
# No toca aegis-serve (3284) ni el watchdog del tunel.
$ErrorActionPreference = 'Stop'
$conn = Get-NetTCPConnection -LocalPort 3788 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $conn) { Write-Output 'nada escuchando en 3788'; exit 0 }
$viejo = $conn.OwningProcess
$cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$viejo").CommandLine
Write-Output "pid viejo=$viejo cmd=$cmd"
if ($cmd -notmatch 'server\.mjs') { Write-Output "ABORT: el dueno del 3788 no es server.mjs"; exit 1 }
Stop-Process -Id $viejo -Force
Start-Sleep -Seconds 2
Start-Process -FilePath 'node' -ArgumentList 'server.mjs' -WorkingDirectory 'C:\Aegis-Proyects\web' -WindowStyle Hidden
Start-Sleep -Seconds 4
$nuevo = (Get-NetTCPConnection -LocalPort 3788 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
$html = (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3788/').Content
$ver = [regex]::Matches($html, '\./bundle\.js\?v=([a-f0-9]{8})') | ForEach-Object { $_.Groups[1].Value }
Write-Output "pid nuevo=$nuevo"
Write-Output ("bundle versionado: " + ($(if ($ver) { $ver } else { 'NO' })))

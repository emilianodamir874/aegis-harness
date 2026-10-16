<#
build-and-swap.ps1 - compila una version nueva y la deja EN SERVICIO, con verificacion.

Que hace, en orden (y aborta si algo no cuadra):
  1. build-safe.ps1 -> target\debug\aegis-<Version>.exe (espera a que el modelo este idle)
  2. copia a core\bin\aegis-<Version>.exe y COMPARA EL SHA256
  3. swap.ps1 -Tag <Version> -Restart -DelaySecs N -> apunta el puntero y reinicia el serve
  4. REHA CE el hardlink aegis-current.exe (swap.ps1 NO lo hace: sin esto check-consistency da INCONSISTENTE)
  5. check-consistency.ps1 -> debe decir CONSISTENTE
  6. salud: puertos 3284/3788/3789, web y el proceso del serve

Uso:
  powershell -NoProfile -ExecutionPolicy Bypass -File core\ops\build-and-swap.ps1 -Version v39
  (agregar -NoRestart para solo compilar y copiar, sin tocar el serve)

Requiere PowerShell 7 (Get-FileHash) y correr DESPRENDIDO si se lanza desde un turno del agente:
el reinicio del serve corta el turno en curso.
#>
param(
  [Parameter(Mandatory=$true)][string]$Version,
  [int]$DelaySecs = 60,
  [switch]$NoRestart
)
$ErrorActionPreference = 'Continue'
$log = "C:\Users\Emiliano\tmp\inv\swap-$Version.log"
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
function W($m) { Add-Content -Path $log -Value ("  " + $m) -ErrorAction SilentlyContinue }
Set-Content -Path $log -Value ("== $Version " + (Get-Date).ToString('HH:mm:ss') + " ==") -Encoding UTF8
$src = "C:\Aegis-Proyects\target\debug\aegis-$Version.exe"   # CARGO_TARGET_DIR real (no src\target)
$dst = "C:\Aegis-Proyects\core\bin\aegis-$Version.exe"
$link = 'C:\Aegis-Proyects\core\bin\aegis-current.exe'
$pwsh = 'C:\Users\Emiliano\scoop\shims\pwsh.exe'

W 'build (build-safe.ps1)'
& powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\Aegis-Proyects\web\tools\build-safe.ps1' -Version $Version -SkipIdleGate *>&1 |
  Select-Object -Last 4 | ForEach-Object { W ("  build: " + ($_ -replace '[^\x20-\x7E]', '.')) }
$bl = "C:\Aegis-Proyects\web\logs\build-$Version.log"
if (Test-Path $bl) {
  $c = Get-Content $bl -Raw
  W ("  EXITCODE: " + (([regex]::Match($c, 'EXITCODE=(-?\d+)')).Groups[1].Value))
  W ("  errores: " + ([regex]::Matches($c, '(?m)^error').Count))
}
if (-not (Test-Path $src)) { W 'ABORTADO: no se genero el binario'; W 'FIN'; exit 1 }
W ("  binario: " + [math]::Round((Get-Item $src).Length / 1MB, 1) + " MB")

W 'copiando a core\bin con verificacion de hash'
Copy-Item $src $dst -Force
$h1 = (Get-FileHash $src -Algorithm SHA256).Hash
$h2 = (Get-FileHash $dst -Algorithm SHA256).Hash
W ("  hash " + $h1.Substring(0, 16) + " == " + $h2.Substring(0, 16) + " : " + ($h1 -eq $h2))
if ($h1 -ne $h2) { W 'ABORTADO: hash distinto'; W 'FIN'; exit 1 }

if ($NoRestart) { W 'sin reinicio (-NoRestart): queda compilado y copiado'; W 'FIN'; exit 0 }

W "swap ($Version)"
& $pwsh -NoProfile -ExecutionPolicy Bypass -File 'C:\Aegis-Proyects\core\ops\swap.ps1' -Tag $Version -Restart -DelaySecs $DelaySecs 2>&1 |
  ForEach-Object { W ("  " + ($_ -replace '[^\x20-\x7E]', '.')) }

W 'rehaciendo el hardlink aegis-current.exe (swap.ps1 no lo hace)'
Start-Sleep -Seconds 30
& $pwsh -NoProfile -ExecutionPolicy Bypass -File 'C:\Aegis-Proyects\core\ops\_pointer.ps1' -Exe $dst *>&1 | Out-Null
Remove-Item $link -Force -ErrorAction SilentlyContinue
& fsutil hardlink create $link $dst 2>&1 | ForEach-Object { W ("  " + ($_ -replace '[^\x20-\x7E]', '.')) }
W ("  current == $Version : " + ((Get-FileHash $link -Algorithm SHA256).Hash -eq $h2))

W 'consistencia'
& $pwsh -NoProfile -ExecutionPolicy Bypass -File 'C:\Aegis-Proyects\core\ops\check-consistency.ps1' 2>&1 |
  Select-Object -Last 2 | ForEach-Object { W ("  " + ($_ -replace '[^\x20-\x7E]', '.')) }

W 'salud'
foreach ($p in 3284, 3788, 3789) { W ("  puerto " + $p + " = " + $(if (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) { 'ok' } else { 'LIBRE' })) }
W ("  web = " + (& curl.exe -s -o NUL -w "%{http_code}" --max-time 15 http://127.0.0.1:3788/))
W ("  serve: " + ((Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'aegis-v\d+' } | ForEach-Object { $_.Name + " pid " + $_.ProcessId }) -join ' ; '))
W 'FIN'

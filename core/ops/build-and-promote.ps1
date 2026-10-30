# build-and-promote.ps1 - compila un tag y, solo si compilo, lo promueve.
#
# Encadena build.ps1 + swap.ps1 verificando por ESTADO (last-build.json), no por log: el
# log del build es UTF-16 y un Select-String sin -Encoding lo lee mal. Paso el 2026-10-20:
# el build salio bien y el swap se salteo en silencio porque el guard dio falso.
#
# Uso: build-and-promote.ps1 -Tag v65 [-DelaySecs 30] [-NoRestart] [-SkipIdleGate]
# Si lo lanzas desde un turno del agente, correlo DESPRENDIDO: el reinicio del serve
# corta el turno.
param(
  [Parameter(Mandatory=$true)][string]$Tag,
  [int]$DelaySecs = 30,
  [switch]$NoRestart,
  [switch]$SkipIdleGate
)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_pointer.ps1')

if ($Tag -notmatch '^v\d+$') { throw "Tag invalido: '$Tag' (formato vNN)" }
$logDir = Join-Path $AegisRoot 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir ('promote-' + $Tag + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
function W($m) { $m; Add-Content -Path $log -Value $m -Encoding UTF8 }

W ('== build ' + $Tag + ' ' + (Get-Date -Format o) + ' ==')
$buildArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'build.ps1'), '-Tag', $Tag)
if ($SkipIdleGate) { $buildArgs += '-SkipIdleGate' }
& powershell @buildArgs *>&1 | ForEach-Object { W ('  ' + ($_ -replace '[^\x20-\x7E]', '.')) }
$buildExit = $LASTEXITCODE
W ('build exit=' + $buildExit)
if ($buildExit -ne 0) { W 'ABORTADO: el build fallo, no se promueve'; exit 1 }

# Verificacion por estado: last-build.json es la fuente de verdad del ultimo build.
$lbPath = Join-Path $AegisRoot 'state\last-build.json'
if (-not (Test-Path $lbPath)) { W 'ABORTADO: no hay state\last-build.json'; exit 1 }
$lb = Get-Content $lbPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($lb.tag -ne $Tag) { W ('ABORTADO: last-build.json dice ' + $lb.tag + ', esperaba ' + $Tag); exit 1 }
if (-not (Test-Path $lb.exe)) { W ('ABORTADO: no existe ' + $lb.exe); exit 1 }
W ('binario ok: ' + $lb.exe + ' sha=' + ('' + $lb.sha256).Substring(0, 16))

$swapArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'swap.ps1'), '-Tag', $Tag)
if ($NoRestart) {
  # swap.ps1 no reinicia si no se le pasa -Restart: aca no se agrega nada
} else {
  $swapArgs += @('-Restart', '-DelaySecs', "$DelaySecs", '-IdleSeconds', '0', '-IdleTimeoutSecs', '2')
}
W ('== swap ' + $Tag + ' ' + (Get-Date -Format o) + ' ==')
& powershell @swapArgs *>&1 | ForEach-Object { W ('  ' + ($_ -replace '[^\x20-\x7E]', '.')) }
$swapExit = $LASTEXITCODE
W ('swap exit=' + $swapExit)

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'check-consistency.ps1') *>&1 |
  ForEach-Object { W ('  ' + $_) }
W ('FIN ' + (Get-Date -Format o))
exit $swapExit

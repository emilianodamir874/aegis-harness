# Corrida nocturna de la suite de evaluacion del harness.
# Corre los 24 casos (livianos y pesados) contra el binario desplegado y compara contra la corrida
# anterior: una regresion queda marcada en el JSON y en el log.
#
# Dos cosas que se aprendieron el 2026-10-27:
# - `--isolated`: cada corrida usa un store temporal. Sin esto metia ~15 sesiones por noche en el
#   store vivo y los jobs de mantenimiento encontraban basura.
# - `--timeout`: techo global por caso. Un caso que explora sin cerrar se cancela y deja evidencia en
#   vez de comerse la ventana entera de la madrugada.
#
# Lo programa el job "Aegis-EvalSuite" (05:00). A mano: powershell -File este-archivo.ps1

$ErrorActionPreference = 'Continue'
$root = 'C:\Aegis-Proyects'
$runs = Join-Path $root 'src\evals\harness\runs'
$log = Join-Path $root 'core\logs\eval-suite.log'
$prev = Join-Path $runs 'previous.json'
$latest = Join-Path $runs 'latest.json'

New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
if (Test-Path $latest) { Copy-Item $latest $prev -Force }

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$suiteArgs = @(
    (Join-Path $root 'src\evals\harness\run_suite.py'),
    '--isolated',
    '--include-heavy',
    '--timeout', '900'
)
if (Test-Path $prev) { $suiteArgs += @('--baseline', $prev) }
$env:AEGIS_EVAL_BIN = (Join-Path $root 'core\bin\aegis-current.exe')
$out = & python @suiteArgs 2>&1
$code = $LASTEXITCODE

$summary = ($out | Select-Object -Last 6) -join ' | '
"$stamp exit=$code $summary" | Out-File -FilePath $log -Append -Encoding utf8

# Una regresion deja el detalle al lado del log, para no tener que abrir el JSON entero.
$regressions = $out | Select-String -Pattern '^regresiones:'
if ($regressions) {
    "$stamp $($regressions.Line)" | Out-File -FilePath $log -Append -Encoding utf8
}

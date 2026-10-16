# Responde de una: el proceso vivo = el puntero = el hardlink. Es lo que evita que vuelva
# a pasar el bug goose-v15 vs v33. Exit 0 = consistente, 1 = desincronizado.
param([switch]$Quiet)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_pointer.ps1')
$problems = @()
$notes = @()

$cur  = Get-AegisCurrent
$live = Get-AegisLiveServe
$cli  = Get-AegisCliExe
$link = Join-Path $BinDir 'aegis-current.exe'

function HashOf($p) { try { $h = (Get-FileHash $p -Algorithm SHA256 -ErrorAction SilentlyContinue).Hash; if ($h) { return $h } } catch {}; $c = (& certutil -hashfile $p SHA256 2>$null | Select-Object -Skip 1 -First 1); if ($c) { return (($c -replace '\s','').ToUpper()) }; return $null }

if (-not $cur)  { $problems += 'no hay puntero (state\current-version.json)' }
if (-not $live) { $problems += 'nada escucha en el 3284' }

# Dos rutas son el mismo archivo si comparten el inodo (hardlinks). fsutil lo dice sin depender del hash.
function Same-Inode($a, $b) {
  try {
    $la = & fsutil hardlink list $a 2>$null
    if (-not $la) { return $false }
    $rel = ($b -replace '^[A-Za-z]:', '').ToLower()
    foreach ($l in $la) { if (([string]$l).Trim().ToLower() -eq $rel) { return $true } }
  } catch { }
  return $false
}

if ($cur -and $live) {
  if ($cur.exe.ToLower() -eq $live.ToLower()) {
    # identicos: ok
  } elseif (Same-Inode $cur.exe $live) {
    # hardlinks del mismo archivo: es el estado NORMAL (binaegis-current.exe <-> binaegis-v34.exe)
    $notes += ('el vivo corre desde ' + $live + ', hardlink del binario del puntero (' + $cur.exe + '): mismo archivo')
  } elseif ((HashOf $cur.exe) -and ((HashOf $cur.exe) -eq (HashOf $live))) {
    $notes += ('el vivo corre desde ' + $live + ': mismo CONTENIDO que el puntero pero archivo DISTINTO (copia, no hardlink)')
  } else {
    $problems += ('DESINCRONIZADO: vive ' + $live + ' pero el puntero dice ' + $cur.exe)
  }
}
if ($cur -and (-not $cur.sha256)) { $problems += 'el puntero no tiene sha256' }
if (Test-Path $link) {
  if ($cur -and $cur.sha256 -and ((HashOf $link) -ne $cur.sha256)) { $problems += 'bin\aegis-current.exe no coincide con el puntero' }
} else { $problems += 'falta bin\aegis-current.exe' }
if ($cli -and $cur -and $cur.sha256 -and ((HashOf $cli) -ne $cur.sha256)) {
  $problems += ('la CLI resolveria ' + $cli + ', distinto del puntero')
}

foreach ($n in $notes) { Write-Output ('AVISO: ' + $n) }
if ($problems.Count -eq 0) {
  if (-not $Quiet) { Write-Output ('CONSISTENTE: puntero = vivo = hardlink' + $(if ($cur) { ' (' + $cur.tag + ', commit ' + $cur.commit + ')' })) }
  exit 0
}
foreach ($p in $problems) { Write-Output ('INCONSISTENTE: ' + $p) }
exit 1

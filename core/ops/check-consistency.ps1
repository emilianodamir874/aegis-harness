# Responde de una: el proceso vivo = el puntero = el hardlink. Es lo que evita que vuelva
# a pasar el bug goose-v15 vs v33. Exit 0 = consistente, 1 = desincronizado.
param([switch]$Quiet)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_pointer.ps1')
$problems = @()
$notes = @()

$cur  = Get-AegisCurrent
$live = Get-AegisLiveServe
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

function Corto($s) { if ($s -and $s.Length -gt 12) { return $s.Substring(0,12) } else { return [string]$s } }

# sha256 del archivo que el puntero nombra (no solo del hardlink bin\aegis-current.exe) y del vivo:
# con rutas identicas antes no se hasheaba nada.
if ($cur -and $cur.sha256 -and (Test-Path $cur.exe)) {
  $hu = HashOf $cur.exe
  if ($hu -and $hu -ne $cur.sha256) { $problems += ('el ejecutable del puntero no coincide con su sha256 (' + $cur.tag + ': ' + (Corto $hu) + ' vs ' + (Corto $cur.sha256) + ')') }
}
if ($live -and $cur -and $cur.sha256) {
  $hl = HashOf $live
  if ($hl -and $hl -ne $cur.sha256) { $problems += ('el proceso vivo ' + $live + ' no coincide con el sha256 del puntero (' + (Corto $hl) + ' vs ' + (Corto $cur.sha256) + ')') }
}

# Procedencia del build: que se compilo, desde que commit y si el arbol estaba sucio.
$lbPath = Join-Path $AegisRoot 'state\last-build.json'
if (Test-Path $lbPath) {
  try { $lb = Get-Content $lbPath -Raw | ConvertFrom-Json } catch { $lb = $null }
  if ($lb) {
    $sufijo = if ($lb.diffSha) { ' (arbol recuperable con: git stash apply ' + (Corto $lb.diffSha) + ')' } else { '' }
    if ($lb.dirty) {
      if ($cur -and $lb.tag -eq $cur.tag) { $problems += ('el binario en servicio (' + $lb.tag + ') se compilo desde un arbol SUCIO' + $sufijo) }
      else { $notes += ('el ultimo build (' + $lb.tag + ') salio de un arbol sucio' + $sufijo) }
    }
    if ($lb.commit -and $cur -and $cur.commit) {
      if ($lb.tag -eq $cur.tag -and $lb.commit -ne $cur.commit) {
        $problems += ('mismo tag ' + $lb.tag + ': el puntero dice commit ' + $cur.commit + ' y last-build.json ' + $lb.commit)
      } elseif ($lb.commit -ne $cur.commit) {
        $notes += ('ultimo build ' + $lb.tag + ' en ' + $lb.commit + '; el vivo ' + $cur.tag + ' en ' + $cur.commit)
      }
    }
    if (-not $lb.profile) { $notes += 'last-build.json no registra profile (build anterior a la fase 7)' }
  }
} else { $notes += 'no hay state\last-build.json' }

foreach ($n in $notes) { Write-Output ('AVISO: ' + $n) }
if ($problems.Count -eq 0) {
  if (-not $Quiet) { Write-Output ('CONSISTENTE: puntero = vivo = hardlink' + $(if ($cur) { ' (' + $cur.tag + ', commit ' + $cur.commit + ')' })) }
  exit 0
}
foreach ($p in $problems) { Write-Output ('INCONSISTENTE: ' + $p) }
exit 1

# D8: saca los .bak de los arboles vivos y los junta en C:\Aegis-Proyects\core\backups\<fecha>-baks-<arbol>.
# Criterio de "es un backup": el NOMBRE contiene ".bak" (asi "bak-clean.ps1" queda afuera).
# No toca los que ya viven dentro de un directorio de backups. Mueve, nunca borra.
param([switch]$Apply)
$ErrorActionPreference = 'Continue'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dest  = "C:\Aegis-Proyects\core\backups\$stamp-baks"
$targets = @(
  @{ root = "$env:LOCALAPPDATA\hermes\bin";       label = 'hermes-bin';          rec = $true  },
  # .agents/skills NO va aca: la regla 21 dice que el .bak al lado del SKILL.md esta BIEN.
  # (si se mueven a un directorio comun, los SKILL.md.bak-<motivo> de distintas skills colisionan
  #  y se pisan entre si: paso el 2026-10-15 y se perdieron 2).
  @{ root = "$env:APPDATA\Aegis\aegis\config";   label = 'store-aegis-config';  rec = $true  },
  @{ root = 'C:\Users\Emiliano\.cargo';          label = 'cargo';              rec = $false },
  @{ root = 'C:\Aegis-Proyects\web';                        label = 'aegis-web';          rec = $true  }
)
$all = @()
foreach ($t in $targets) {
  if (-not (Test-Path $t.root)) { continue }
  $f = if ($t.rec) { Get-ChildItem $t.root -Recurse -File -Force -ErrorAction SilentlyContinue }
       else        { Get-ChildItem $t.root -File -Force -ErrorAction SilentlyContinue }
  $f = $f | Where-Object { $_.Name -like '*.bak*' -and $_.DirectoryName -notmatch '\\backups(\\|$)' -and $_.DirectoryName -notmatch '\\registry' }
  foreach ($x in $f) { $all += [pscustomobject]@{ src = $x.FullName; label = $t.label; name = $x.Name } }
}
'candidatos: ' + $all.Count
$all | Group-Object label | ForEach-Object { '  ' + $_.Name + ': ' + $_.Count }
if (-not $Apply) { $all | ForEach-Object { '  (dry) ' + $_.label + ' | ' + $_.name }; 'dry-run: use -Apply'; exit 0 }
$n = 0
foreach ($x in $all) {
  $out = Join-Path $dest $x.label
  New-Item -ItemType Directory -Force $out | Out-Null
  try { Move-Item $x.src (Join-Path $out $x.name) -Force -ErrorAction Stop; $n++ }
  catch { 'BLOQUEADO ' + $x.src + ' :: ' + $_.Exception.Message }
}
'movidos: ' + $n + ' -> ' + $dest
$all | ForEach-Object { ($_.label + '\' + $_.name) } | Set-Content (Join-Path $dest 'MANIFEST.txt') -Encoding UTF8

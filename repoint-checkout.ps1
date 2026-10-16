# Repunta las referencias al checkout del fork. C:\goose <-> C:\Aegis-Proyects\src (-Revert para volver).
# NO toca C:\Aegis-Proyects\web ni C:\Aegis-Proyects\core: la regex exige que tras "goose" no venga "-" ni caracter de palabra.
# Backups en C:\Aegis-Proyects\core\backups\<fecha>-checkout-repoint\<root>\<ruta_relativa> (sin colisiones).
#
# OJO al editar este archivo: NO usar la forma 'dolar llave n' de .NET (se interpola si el archivo se
# genera desde un template) -> por eso se usan dos reemplazos literales, uno por tipo de separador.
param([switch]$Apply, [switch]$Revert)
$ErrorActionPreference = 'Continue'

if ($Revert) {
  $reps = @(
    @{ rx = [regex]'(?i)C:\\+aegis-src(?![-A-Za-z0-9_])'; to = 'C:\goose' },
    @{ rx = [regex]'(?i)C:/+aegis-src(?![-A-Za-z0-9_])';  to = 'C:/goose' }
  )
  $label = 'C:\Aegis-Proyects\src -> C:\goose'
} else {
  $reps = @(
    @{ rx = [regex]'(?i)C:\\+goose(?![-A-Za-z0-9_])'; to = 'C:\Aegis-Proyects\src' },
    @{ rx = [regex]'(?i)C:/+goose(?![-A-Za-z0-9_])';  to = 'C:/Aegis-Proyects/src' }
  )
  $label = 'C:\goose -> C:\Aegis-Proyects\src'
}

$roots = @(
  "$env:LOCALAPPDATA\hermes\bin",
  'C:\Users\Emiliano\.agents',
  'C:\Users\Emiliano\scripts',
  'C:\Users\Emiliano\tools',
  'C:\Aegis-Proyects\web',
  'C:\Aegis-Proyects\core\ops'
)
$skipDirs = @('.git','node_modules','target','dist','__pycache__','logs','backups','.venv',
              'aegis-rename','platform-tools','shots')
$skipFileRx = '\.bak|\.old$|~$|^rename-report-|^commit-msg|^PROMPT-|^repoint-checkout\.ps1$|^move-checkout\.ps1$'
$skipExt = '.png','.jpg','.jpeg','.gif','.ico','.webp','.mp4','.pdf','.zip','.exe','.dll','.db','.log','.out','.err','.woff','.woff2','.pdb','.rlib'

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bk = "C:\Aegis-Proyects\core\backups\$stamp-checkout-repoint"
$touched = @()
foreach ($root in $roots) {
  if (-not (Test-Path $root)) { continue }
  $files = Get-ChildItem $root -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object {
      $rel = $_.FullName.Substring($root.Length)
      $parts = $rel -split '[\\/]'
      -not ($parts | Where-Object { $skipDirs -contains $_ }) -and
      $skipExt -notcontains $_.Extension.ToLower() -and
      $_.Name -notmatch $skipFileRx -and
      $_.Length -lt 5MB
    }
  foreach ($f in $files) {
    $c = $null
    try { $c = Get-Content $f.FullName -Raw -Encoding UTF8 } catch { continue }
    if (-not $c) { continue }
    $new = $c; $n = 0
    foreach ($r in $reps) { $h = $r.rx.Matches($new).Count; if ($h) { $n += $h; $new = $r.rx.Replace($new, $r.to) } }
    if ($n -eq 0) { continue }
    $rel = $f.FullName.Substring($root.Length).TrimStart('\')
    $touched += [pscustomobject]@{ root = $root; rel = $rel; full = $f.FullName; n = $n }
    if ($Apply) {
      $out = Join-Path (Join-Path $bk (($root -replace '^[A-Za-z]:','') -replace '[\\/:]','_')) (Split-Path $rel -Parent)
      New-Item -ItemType Directory -Force $out | Out-Null
      Copy-Item $f.FullName (Join-Path $out $f.Name) -Force -ErrorAction SilentlyContinue
      Set-Content -Path $f.FullName -Value $new -NoNewline -Encoding UTF8
    }
  }
}
'=== repoint ' + $label + ' ' + $(if ($Apply) { '[APLICADO]' } else { '[DRY-RUN]' }) + ' ==='
'archivos: ' + $touched.Count + ' | ocurrencias: ' + (($touched | Measure-Object n -Sum).Sum)
$touched | Sort-Object root, rel | ForEach-Object { '  ' + $_.n.ToString().PadLeft(3) + '  ' + $_.root.Replace('C:\Users\Emiliano','~') + '\' + $_.rel }
if ($Apply) {
  $touched | ForEach-Object { ($_.n.ToString() + ' ' + $_.full) } | Set-Content (Join-Path $bk 'MANIFEST.txt') -Encoding UTF8
  'backups en: ' + $bk
}

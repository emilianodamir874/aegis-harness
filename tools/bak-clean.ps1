# Mueve los backups .bak-* que quedaron DENTRO del repo a la carpeta de backups (D3).
# Regla 21: los backups de archivos del repo van fuera de crates/ para no ensuciar git status.
param([switch]$Apply, [string]$Repo = 'C:\aegis-src', [string]$Dest = 'C:/Users/Emiliano/backups')
$ErrorActionPreference = 'Stop'
$files = Get-ChildItem $Repo -Recurse -File -Include '*.bak-*','*.bak','*.bak.*' -ErrorAction SilentlyContinue |
         Where-Object { $_.FullName -notlike '*\target\*' -and $_.FullName -notlike '*\.git\*' }
if (-not $files) { Write-Output 'no hay backups dentro del repo'; exit 0 }
$stamp = Get-Date -Format yyyyMMdd-HHmmss
$out = Join-Path $Dest "aegis-repo-baks-$stamp"
Write-Output ("encontrados {0} backups; destino {1}" -f $files.Count, $out)
$files | ForEach-Object { '  ' + $_.FullName.Substring($Repo.Length + 1) + '  (' + [math]::Round($_.Length/1KB) + ' KB)' }
if (-not $Apply) { Write-Output 'dry-run: nada movido. Use -Apply.'; exit 0 }
New-Item -ItemType Directory -Force $out | Out-Null
foreach ($f in $files) {
  $rel = $f.FullName.Substring($Repo.Length + 1).Replace('\', '_')
  Move-Item $f.FullName (Join-Path $out $rel) -Force
}
Write-Output ("movidos {0} archivos a {1}" -f $files.Count, $out)
Set-Location $Repo
Write-Output '--- git status (solo bak) ---'
(& git status --porcelain) | Where-Object { $_ -match '\.bak' } | ForEach-Object { $_ }
Write-Output '--- fin ---'

$paths = @(
  (Join-Path $env:APPDATA 'Mozilla\sccache\config.toml'),
  (Join-Path $env:LOCALAPPDATA 'Mozilla\sccache\config.toml'),
  (Join-Path $env:USERPROFILE '.config\sccache\config'),
  (Join-Path $env:APPDATA 'sccache\config.toml'),
  (Join-Path $env:USERPROFILE '.sccache\config'),
  (Join-Path $env:USERPROFILE '.cache\sccache\config')
)
foreach ($p in $paths) { if (Test-Path $p) { Write-Output ('=== ' + $p); Get-Content $p -Raw } else { Write-Output ('no: ' + $p) } }
Write-Output '--- dirs ---'
Get-ChildItem $env:USERPROFILE -Force -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*sccache*' -or $_.Name -eq '.cache' -or $_.Name -eq '.config' } | ForEach-Object { $_.FullName }
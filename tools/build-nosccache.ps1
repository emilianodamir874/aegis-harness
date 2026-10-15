$cfg = 'C:\Users\Emiliano\.cargo\config.toml'
Copy-Item $cfg ($cfg + '.bak-test') -Force
try {
  (Get-Content $cfg) -replace '^rustc-wrapper', '#rustc-wrapper' | Set-Content $cfg
  $env:RUSTC_WRAPPER = ''
  $env:CARGO_BUILD_RUSTC_WRAPPER = ''
  Set-Location C:\Aegis-Proyects\src
  $out = & cargo check -p aegis-provider-types 2>&1 | Out-String
  $has = $out -match 'sccache'
  Write-Output ('SCCACHE_EN_LA_SALIDA=' + $has)
  Write-Output ($out.Substring([Math]::Max(0, $out.Length - 400)))
} finally {
  Copy-Item ($cfg + '.bak-test') $cfg -Force
  Remove-Item ($cfg + '.bak-test') -Force
  Write-Output ('CFG_RESTAURADO=' + ((Get-Content $cfg -TotalCount 3) -join ' | '))
}
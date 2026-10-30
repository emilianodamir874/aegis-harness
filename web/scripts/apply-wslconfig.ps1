# Aplica el .wslconfig corregido (memory + autoMemoryReclaim + sparseVhd). NO reinicia WSL:
# el cambio toma efecto en el proximo arranque de WSL (o con 'wsl --shutdown' cuando lo decidas).
$cfg = "$env:USERPROFILE\.wslconfig"
$stamp = Get-Date -Format yyyyMMdd-HHmmss
if (Test-Path $cfg) { Copy-Item $cfg "$cfg.bak-pre-prune-$stamp" -Force; Write-Output "backup: $cfg.bak-pre-prune-$stamp" }
@'
[wsl2]
memory=16GB
# La RAM que WSL no use vuelve a Windows (antes: memory=20GB fijo, sin reclaim: 0.8 GB libres)
autoMemoryReclaim=gradual
sparseVhd=true
processors=12
swap=4GB
guiApplications=false
'@ | Set-Content $cfg -Encoding utf8
Write-Output '--- .wslconfig ahora ---'
Get-Content $cfg

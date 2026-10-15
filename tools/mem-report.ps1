# Informe de memoria (B5): quien se come la RAM y que tocar en .wslconfig.
$os = Get-CimInstance Win32_OperatingSystem
$total = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
$free = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
Write-Host "RAM: $free GB libres de $total GB"
Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 12 @{n='proc';e={$_.ProcessName}}, @{n='GB';e={[math]::Round($_.WorkingSet64/1GB,2)}}, @{n='pico_GB';e={[math]::Round($_.PeakWorkingSet64/1GB,2)}} | Format-Table -AutoSize
$wslcfg = "$env:USERPROFILE\.wslconfig"
if (Test-Path $wslcfg) { Write-Host "--- $wslcfg (actual) ---"; Get-Content $wslcfg } else { Write-Host "sin ${wslcfg}: WSL toma hasta el 50% de la RAM y no la devuelve" }
Write-Host @'
Sugerencia (.wslconfig) para que WSL no se coma media maquina ni retenga la RAM:
  [wsl2]
  memory=12GB
  processors=6
  autoMemoryReclaim=gradual
  sparseVhd=true
Se aplica con 'wsl --shutdown' (cierra WSL entero: guarda lo que estes corriendo ahi).
'@
docker context ls 2>$null | Out-Null

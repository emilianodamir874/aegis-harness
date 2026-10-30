$ErrorActionPreference='SilentlyContinue'
$c = Get-Content 'C:\Aegis-Proyects\web\logs\client.log'
Write-Output ('client.log lines=' + $c.Count)
Write-Output ($c | Select-Object -Last 70 | Out-String)
$r = Get-Content 'C:\Aegis-Proyects\web\logs\requests.log'
Write-Output ('requests.log lines=' + $r.Count)
Write-Output ($r | Select-Object -Last 20 | Out-String)

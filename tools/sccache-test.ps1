$env:SCCACHE_DIR = 'C:\Users\Emiliano\AppData\Local\sccache'
sccache --stop-server 2>&1 | Out-Null
taskkill /f /im sccache.exe 2>&1 | Out-Null
Start-Sleep -Seconds 2
sccache --start-server 2>&1 | Out-Null
Start-Sleep -Seconds 2
Write-Output '--- con SCCACHE_DIR seteado ---'
sccache --show-stats 2>&1 | Select-String -Pattern 'Cache location|Compile requests executed|Cache errors' | ForEach-Object { $_.Line }
Write-Output '--- shim ---'
Get-Item C:\Users\Emiliano\scoop\shims\sccache.exe | Select-Object Length | Out-String
Get-ChildItem C:\Users\Emiliano\scoop\apps\sccache -Recurse -Filter sccache.exe -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName + ' ' + [math]::Round($_.Length/1MB,1) + 'MB' }
Write-Output '--- SCCACHE_HOME/USERPROFILE ---'
$env:USERPROFILE
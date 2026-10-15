$ErrorActionPreference = 'Continue'
$root = 'C:\Aegis-Proyects\web'
$node = 'C:\Users\Emiliano\AppData\Local\hermes\tools\node-26.7.0-win32-x64\node.exe'
$cfg = Get-Content "$root\config.json" -Raw | ConvertFrom-Json
$env:AEGIS_SERVER__SECRET_KEY = $cfg.secretKey
$env:AEGIS_RUN_STALL_TIMEOUT_SECS = '3'
$env:AEGIS_RUN_WATCHDOG_POLL_SECS = '5'
$port = 3392
$exe = 'C:\Aegis-Proyects\src\target\debug\goose-serve-v3.exe'
$origins = @("--allowed-origin=http://$($cfg.publicHost):$($cfg.webPort)", '--allowed-origin=http://127.0.0.1:3788')
$args = @('serve', '--host', '0.0.0.0', '--port', "$port", '--platform', 'desktop', '--enable-scheduler', '--with-builtin', 'developer') + $origins
$p = Start-Process -FilePath $exe -ArgumentList $args -WorkingDirectory $root -PassThru -WindowStyle Hidden -RedirectStandardOutput "$root\logs\serve-v3wd.out.log" -RedirectStandardError "$root\logs\serve-v3wd.err.log"
Start-Sleep -Seconds 18
& $node "$root\tools\smoke-watchdog.mjs" $port
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
Write-Output '--- watchdog log lines ---'
Select-String -Path "$root\logs\serve-v3wd.err.log" -Pattern 'stalled|watchdog' -SimpleMatch | Select-Object -Last 6 | ForEach-Object { $_.Line }

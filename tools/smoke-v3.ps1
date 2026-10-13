$ErrorActionPreference = 'Continue'
$root = 'C:\goose-web'
$node = 'C:\Users\Emiliano\AppData\Local\hermes\tools\node-26.7.0-win32-x64\node.exe'
$cfg = Get-Content "$root\config.json" -Raw | ConvertFrom-Json
$env:GOOSE_SERVER__SECRET_KEY = $cfg.secretKey
$port = 3391
$exe = 'C:\goose\target\debug\goose-serve-v3.exe'
$origins = @(
  "--allowed-origin=http://$($cfg.publicHost):$($cfg.webPort)",
  '--allowed-origin=http://127.0.0.1:3788',
  '--allowed-origin=http://localhost:3788'
)
$args = @('serve', '--host', '0.0.0.0', '--port', "$port", '--platform', 'desktop', '--enable-scheduler', '--with-builtin', 'developer') + $origins
$p = Start-Process -FilePath $exe -ArgumentList $args -WorkingDirectory $root -PassThru -WindowStyle Hidden -RedirectStandardOutput "$root\logs\serve-v3.out.log" -RedirectStandardError "$root\logs\serve-v3.err.log"
Start-Sleep -Seconds 18
$up = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
Write-Output ("LISTEN=" + [bool]$up)
& $node "$root\tools\smoke-serve-v2.mjs" $port
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
Write-Output '--- err tail ---'
Get-Content "$root\logs\serve-v3.err.log" -Tail 20 -ErrorAction SilentlyContinue

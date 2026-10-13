$ErrorActionPreference='Continue'
$root='C:\goose-web'
$node='C:\Users\Emiliano\AppData\Local\hermes\tools\node-26.7.0-win32-x64\node.exe'
$cfg=Get-Content "$root\config.json" -Raw | ConvertFrom-Json
$env:GOOSE_SERVER__SECRET_KEY=$cfg.secretKey
$exe='C:\goose\target\debug\goose-serve-v3.exe'
$origins=@("--allowed-origin=http://$($cfg.publicHost):$($cfg.webPort)",'--allowed-origin=http://127.0.0.1:3788','--allowed-origin=http://localhost:3788')
$args=@('serve','--host','0.0.0.0','--port','3391','--platform','desktop','--enable-scheduler','--with-builtin','developer')+$origins
$p=Start-Process -FilePath $exe -ArgumentList $args -WorkingDirectory $root -PassThru -WindowStyle Hidden -RedirectStandardOutput "$root\logs\v3b.out.log" -RedirectStandardError "$root\logs\v3b.err.log"
Start-Sleep -Seconds 18
Write-Output ('LISTEN=' + [bool](Get-NetTCPConnection -LocalPort 3391 -State Listen -ErrorAction SilentlyContinue))
Set-Location C:\goose\ui\desktop
& $node "scripts\goose-web-reload-v3.mjs" 2>&1 | ForEach-Object { $_ }
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Write-Output '--- DB TEST SESSION ---'
$db='C:\Users\Emiliano\AppData\Roaming\Block\goose\data\sessions\sessions.db'
$sid = & sqlite3 $db "select session_id from messages where content_json like '%respond%(e|é) exactamente LISTO%' order by rowid desc limit 1;"
Write-Output ("SID=" + $sid)
& sqlite3 $db "select role||' >> '||replace(substr(content_json,1,80),char(10),' ') from messages where session_id='$sid' order by rowid;"
Write-Output ('LISTO_EN_DB=' + (& sqlite3 $db "select count(*) from messages where session_id='$sid' and content_json like '%LISTO%';"))
# C2 cierre: saca los puentes, reinicia cloudflared y el serve DESDE LA RUTA NUEVA y borra el resto.
# Desprendido: matar el serve corta el turno que lo lanza; todo el resultado queda en el log.
# OJO con no repetir el error de v3: NO se mata "todo lo que tenga goose-web en la linea de comandos".
# Se mata solo: el dueno de 3284, los cloudflared con logfile en el deploy viejo, y los watchdogs.
# Este host tiene PS 7 en scoop: usarlo evita el desastre de encoding de PS 5.1.
param([int]$DelaySecs = 25)
$ErrorActionPreference = 'Continue'
$log = 'C:\Aegis-Proyects\core\tmp\finish-c2.log'
function W($m) { Add-Content -Path $log -Value ((Get-Date).ToString('HH:mm:ss') + ' ' + [string]$m) }
$NEW = 'C:\Aegis-Proyects\web'; $ROOT = 'C:\goose-web'
W ('=== cierre C2 inicio; PS ' + $PSVersionTable.PSVersion.ToString() + ' ===')
Start-Sleep -Seconds $DelaySecs
# 1) los 2 puentes ya no hacen falta
foreach ($f in (Join-Path $ROOT 'scripts\goose-web-tunnel.vbs'), (Join-Path $ROOT 'scripts\goose-web-launch.vbs')) { if (Test-Path $f) { Remove-Item $f -Force -ErrorAction SilentlyContinue; W ('  puente borrado: ' + $f + ' -> ' + (-not (Test-Path $f))) } }
if (Test-Path (Join-Path $ROOT 'scripts')) { $r = @(Get-ChildItem (Join-Path $ROOT 'scripts') -Force); if ($r.Count -eq 0) { Remove-Item (Join-Path $ROOT 'scripts') -Force -ErrorAction SilentlyContinue; W '  carpeta scripts vacia borrada' } }
# 2) parar lo que sostiene la ruta vieja
$cf = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'cloudflared.exe' -and ([string]$_.CommandLine) -match 'goose-web|aegis-web' }
foreach ($c in $cf) { W ('  PARO cloudflared pid=' + $c.ProcessId + ' (se relanza con el logfile nuevo -> URL nueva)'); Stop-Process -Id $c.ProcessId -Force -ErrorAction SilentlyContinue }
$wd = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { ([string]$_.CommandLine) -match 'tunnel-watchdog|tunnel2\.ps1' }
foreach ($w in $wd) { W ('  PARO watchdog pid=' + $w.ProcessId); Stop-Process -Id $w.ProcessId -Force -ErrorAction SilentlyContinue }
$sp = (Get-NetTCPConnection -LocalPort 3284 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
if ($sp) { W ('  PARO el serve pid=' + $sp + ' (aca muere el turno lanzador)'); Stop-Process -Id $sp -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 6
# 3) levantar todo DESDE LA RUTA NUEVA (launcher + watchdog, con los nombres nuevos)
$lz = Join-Path $NEW 'scripts\start-aegis-web.ps1'
if (Test-Path $lz) { Start-Process pwsh -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',$lz; W ('  launcher nuevo lanzado: ' + $lz) } else { W ('  OJO: falta ' + $lz) }
$vb = Join-Path $NEW 'scripts\aegis-web-tunnel.vbs'
if (Test-Path $vb) { Start-Process wscript.exe -ArgumentList ('"' + $vb + '" loop') -WindowStyle Hidden; W '  watchdog del tunel lanzado (loop)' }
W 'esperando 75s a que levante todo...'
Start-Sleep -Seconds 75
# 4) verificar antes de borrar el resto
W '=== VERIFICACION ==='
foreach ($u in 'http://127.0.0.1:3284/health','http://127.0.0.1:3788/','http://127.0.0.1:3788/healthz') { try { W ($u + ' -> ' + (Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 15).StatusCode) } catch { W ($u + ' -> ERROR') } }
$s2 = Get-NetTCPConnection -LocalPort 3284 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($s2) { $p2 = Get-Process -Id $s2.OwningProcess -ErrorAction SilentlyContinue; W ('serve nuevo pid=' + $p2.Id + ' start=' + $p2.StartTime.ToString('HH:mm:ss')) }
$cf2 = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'cloudflared.exe' -and ([string]$_.CommandLine) -match 'aegis-web' }
foreach ($c in $cf2) { W ('cloudflared nuevo pid=' + $c.ProcessId + ' :: ' + ([string]$c.CommandLine).Substring(0,[math]::Min(120,([string]$c.CommandLine).Length))) }
Start-Sleep -Seconds 20
if (Test-Path (Join-Path $NEW 'tunnel-url.txt')) { W ('URL nueva: ' + ((Get-Content (Join-Path $NEW 'tunnel-url.txt') -TotalCount 1))) }
# 5) borrar el resto viejo
W '=== BORRADO DEL RESTO ==='
$h = 'C:\Aegis-Proyects\workstation\Sysinternals\handle64.exe'
$out = & $h -accepteula -nobanner $ROOT 2>&1
$pids = @(); foreach ($l in $out) { if ($l -match 'pid:\s*(\d+)') { $pids += [int]$Matches[1] } }
$pids = $pids | Where-Object { $_ -ne $PID } | Select-Object -Unique
if ($pids.Count -gt 0) { W ('  QUEDAN handles en ' + $ROOT + ': pids ' + ($pids -join ',') + ' -> NO borro (se borra al reiniciar)') }
else { Remove-Item $ROOT -Recurse -Force -ErrorAction SilentlyContinue; W ('  ' + $ROOT + ' borrado: ' + (-not (Test-Path $ROOT))) }
W ('referencias goose-web en el deploy: ' + ((Get-ChildItem $NEW -Recurse -File -Include *.ps1,*.vbs,*.mjs,*.js,*.json,*.md -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '\\(node_modules|\.git|logs)\\' } | Select-String -Pattern 'goose-web' -SimpleMatch -ErrorAction SilentlyContinue | Measure-Object).Count))
W 'fin'
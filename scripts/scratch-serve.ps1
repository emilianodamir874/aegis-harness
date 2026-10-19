# Serve de laboratorio: mismo binario, STORE COPIADO y puerto propio. Sirve para medir sin
# tocar el serve que usa la web (el 2026-10-14 saturé el serve vivo con pruebas y se cayeron
# las conexiones de los clientes reales).
# Uso:  scratch-serve.ps1 [-Version v24] [-Port 3399] [-Stop]
param([string]$Version = 'v55', [int]$Port = 3399, [switch]$Stop)
$root = 'C:/Aegis-Proyects/web'
$probe = "$env:USERPROFILE\aegis-probe-root"
if ($Stop) {
  $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($c) { Stop-Process -Id $c.OwningProcess -Force; Write-Output 'scratch detenido' } else { Write-Output 'no estaba corriendo' }
  exit 0
}
$exe = "C:\Aegis-Proyects\core\bin\aegis-$Version.exe"
if (-not (Test-Path $exe)) { Write-Output "ERROR: no existe $exe"; exit 1 }
if (-not (Test-Path "$probe\data\sessions\sessions.db")) {
  Write-Output 'copiando el store a un root aislado (primera vez)'
  New-Item -ItemType Directory -Force "$probe\config" | Out-Null
  New-Item -ItemType Directory -Force "$probe\data" | Out-Null
  $src = if ($env:AEGIS_PATH_ROOT) { $env:AEGIS_PATH_ROOT } else { 'C:\Aegis-Proyects\state' }
  Copy-Item "$src\config\*" "$probe\config\" -Recurse -Force
  Copy-Item "$src\data\sessions" "$probe\data\sessions" -Recurse -Force
}
$cfg = Get-Content "$root\config.json" | ConvertFrom-Json
$env:AEGIS_PATH_ROOT = $probe
$env:AEGIS_SERVER__SECRET_KEY = $cfg.secretKey
Start-Process -FilePath $exe -ArgumentList 'serve','--host','127.0.0.1','--port',"$Port",'--platform','desktop' -WindowStyle Hidden -RedirectStandardOutput "$root/logs/scratch-$Port.out.log" -RedirectStandardError "$root/logs/scratch-$Port.err.log"
Start-Sleep -Seconds 6
try { Write-Output ('scratch health=' + (Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 15).StatusCode + ' (store aislado en ' + $probe + ')') } catch { Write-Output 'scratch health: error'; Get-Content "$root/logs/scratch-$Port.err.log" -Tail 5 -ErrorAction SilentlyContinue }

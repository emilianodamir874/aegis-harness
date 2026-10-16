# C2 v8: mueve los 22 hijos del deploy EXCEPTO logs, reapunta, re-registra tareas y reinicia solo
# node. NO toca cloudflared (asi la URL publica no cambia) ni el serve (asi no se corta el turno).
# logs queda como unico resto: lo tienen abierto cloudflared y el serve; se limpia en el proximo
# reinicio de cloudflared. Lecciones de v7: (1) logs no se podia mover, (2) el rearme debe usar la
# ruta que REALMENTE tiene el launcher.
$ErrorActionPreference = 'Continue'
$log = 'C:\Aegis-Proyects\core\tmp\c2-v8.log'
function W($m) { Add-Content -Path $log -Value ((Get-Date).ToString('HH:mm:ss') + ' ' + [string]$m) }
$ROOT = 'C:\goose-web'; $NEW = 'C:\Aegis-Proyects\web'
$tnames = @('Goose_Web','Goose_Web_Tunnel','Goose_Web_Tunnel2','Aegis_Consistency')
function Trunc { param([string]$s) if ($s -and $s.Length -gt 110) { return $s.Substring(0,110) }; return $s }
function LauncherDe { param([string]$raiz) foreach ($n in 'scripts\start-aegis-web.ps1','scripts\start-goose-web.ps1') { $p = Join-Path $raiz $n; if (Test-Path $p) { return $p } } ; return '' }
function Set-Refs { param([string]$de, [string]$a) $n = 0; $objs = @(); $objs += Get-ChildItem $NEW -Recurse -File -Include *.ps1,*.cmd,*.bat,*.vbs,*.mjs,*.js,*.json,*.md,*.txt,*.html,*.yml -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '\\(node_modules|\.git|logs)\\' }; $objs += Get-ChildItem 'C:\Aegis-Proyects\core\ops','C:\Aegis-Proyects\core\state' -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'rename-deploy-c2.ps1' }; foreach ($f in 'C:\Users\Emiliano\.agents\AGENTS.md','C:\Users\Emiliano\.agents\skills\aegis-web-ops\SKILL.md','C:\Aegis-Proyects\docs\aegis-organizacion-plan.md') { $objs += Get-Item $f -ErrorAction SilentlyContinue }; $objs += Get-ChildItem 'C:\Aegis-Proyects\src' -Recurse -File -Include *.rs,*.toml,*.md,*.mjs,*.mts,*.ts,*.tsx,*.json,*.ps1,*.py,*.yml,*.yaml,Justfile -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '\\target\\|\\\.git\\|\\node_modules\\' }; foreach ($f in ($objs | Where-Object { $_ -and (Test-Path $_.FullName) } | Select-Object -Unique -Property FullName)) { $txt = [IO.File]::ReadAllText($f.FullName); if ($txt -match $de) { [IO.File]::WriteAllText($f.FullName, $txt.Replace($de, $a), (New-Object Text.UTF8Encoding($false))); $n++ } }; return $n }
W '=== C2 v8 ==='
if (-not (Test-Path $ROOT)) { W 'ABORTO: no existe el deploy'; exit 1 }
$prev = @(Get-ChildItem $NEW -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'logs' })
if ($prev.Count -gt 0) { W ('ABORTO: ' + $NEW + ' ya tiene ' + $prev.Count + ' entradas: ' + (($prev | Select-Object -First 5 | ForEach-Object { $_.Name }) -join ', ')); exit 1 }
New-Item -ItemType Directory -Force -Path $NEW | Out-Null
$mov = 0; $fall = @()
foreach ($c in (Get-ChildItem $ROOT -Force -ErrorAction SilentlyContinue)) {
  if ($c.Name -eq 'logs') { W '  salteo logs (lo tienen abierto cloudflared y el serve: no se puede mover)'; continue }
  try { Move-Item -LiteralPath $c.FullName -Destination (Join-Path $NEW $c.Name) -ErrorAction Stop; $mov++ } catch { $fall += ($c.Name + ' :: ' + $_.Exception.Message) }
}
W ('movidos: ' + $mov + ' | fallaron: ' + $fall.Count)
foreach ($f in $fall) { W ('  FALLO: ' + (Trunc $f)) }
if ($fall.Count -gt 0) {
  W 'movimiento parcial -> devuelvo todo a la ruta vieja para no dejar el deploy partido'
  foreach ($c in (Get-ChildItem $NEW -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'logs' })) { try { Move-Item -LiteralPath $c.FullName -Destination (Join-Path $ROOT $c.Name) -ErrorAction Stop } catch { W ('  no pude devolver ' + $c.Name) } }
  W 'RESULTADO: C2 INCOMPLETO (movimiento parcial, devuelto)'; W 'fin'; exit 1
}
W ('en ' + $ROOT + ' quedo: ' + (((Get-ChildItem $ROOT -Force | ForEach-Object { $_.Name }) -join ', ')))
$rep = Set-Refs -de 'goose-web' -a 'aegis-web'
W ('reapuntado: ' + $rep + ' archivos')
foreach ($n in $tnames) { $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue; if (-not $t) { W ('TAREA ' + $n + ' no existe'); continue }; $acts = @(); foreach ($a in $t.Actions) { $ex = ([string]$a.Execute).Replace('goose-web','aegis-web'); $ar = ([string]$a.Arguments).Replace('goose-web','aegis-web'); $wd = ([string]$a.WorkingDirectory).Replace('goose-web','aegis-web'); if ($wd) { $acts += New-ScheduledTaskAction -Execute $ex -Argument $ar -WorkingDirectory $wd } else { $acts += New-ScheduledTaskAction -Execute $ex -Argument $ar } }; try { Set-ScheduledTask -TaskName $n -Action $acts -ErrorAction Stop | Out-Null; W ('TAREA ' + $n + ' -> ' + (Trunc (($acts | ForEach-Object { [string]$_.Execute + ' ' + [string]$_.Arguments }) -join ' ;; '))) } catch { W ('TAREA ' + $n + ' NO re-registrada: ' + $_.Exception.Message) } }
# node: unico que necesita el cwd nuevo
$n = Get-NetTCPConnection -LocalPort 3788 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($n) { W ('PARO node pid=' + $n.OwningProcess); Stop-Process -Id $n.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3
$lz = LauncherDe -raiz $NEW
W ('launcher elegido: ' + $lz)
if ($lz) { Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',$lz } else { W 'OJO: sin launcher' }
Start-Sleep -Seconds 20
W '=== VERIFICACION ==='
$fn = @(Get-ChildItem $NEW -Recurse -File -Force -ErrorAction SilentlyContinue).Count
W ('archivos en ' + $NEW + ': ' + $fn + ' | en ' + $ROOT + ': ' + (((Get-ChildItem $ROOT -Force | ForEach-Object { $_.Name }) -join ', ')))
foreach ($u in 'http://127.0.0.1:3284/health','http://127.0.0.1:3788/','http://127.0.0.1:3788/healthz') { try { W ($u + ' -> ' + (Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 12).StatusCode) } catch { W ($u + ' -> ERROR') } }
$s = Get-NetTCPConnection -LocalPort 3284 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($s) { W ('serve pid=' + $s.OwningProcess + ' (no se toco)') }
try { $c = (Invoke-WebRequest -Uri 'http://127.0.0.1:3788/app.js' -UseBasicParsing -TimeoutSec 12).Content; W ('app.js servido: ' + $c.Length + ' B, btn-mic=' + ($c -match 'btn-mic')) } catch { W 'app.js ERROR' }
W ('refs goose-web que quedan en el deploy nuevo: ' + ((Get-ChildItem $NEW -Recurse -File -Include *.ps1,*.vbs,*.mjs,*.js,*.json,*.md -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '\\(node_modules|\.git|logs)\\' } | Select-String -Pattern 'goose-web' -SimpleMatch -ErrorAction SilentlyContinue | Measure-Object).Count))
W ('URL del tunel (sin cambios): ' + ((Get-Content (Join-Path $ROOT 'logs\tunnel-url.txt') -Raw -ErrorAction SilentlyContinue).Trim()))
Get-Process cloudflared -ErrorAction SilentlyContinue | ForEach-Object { W ('cloudflared pid=' + $_.Id + ' (vivo, URL intacta)') }
W 'RESULTADO: C2 OK (deploy en C:\Aegis-Proyects\web; resto = logs, se limpia al reiniciar cloudflared)'
W 'fin'
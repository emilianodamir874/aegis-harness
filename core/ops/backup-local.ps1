$ErrorActionPreference = 'Continue'
$log = 'C:\Users\Emiliano\AppData\Local\Temp\backup-local.log'
Remove-Item $log -EA 0
function L($m) { $m | Out-File $log -Append -Encoding utf8; $m }
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
L "=== backup local $stamp"

$dstRoot = 'D:\backup'
$dirs = @{
  store  = "$dstRoot\store"
  config = "$dstRoot\config"
  mirror = 'D:\espejo'
}
foreach ($d in $dirs.Values) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

# 1) sessions.db con la API de backup de SQLite (segura con WAL y con el serve corriendo)
$src  = 'C:\Aegis-Proyects\state\data\sessions\sessions.db'
$dest = "$($dirs.store)\sessions-$stamp.db"
$py = @'
import sqlite3, sys
src, dst = sys.argv[1], sys.argv[2]
s = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
d = sqlite3.connect(dst)
s.backup(d)
d.close(); s.close()
print("ok")
'@
$pyFile = 'C:\Users\Emiliano\AppData\Local\Temp\sqlite_backup.py'
$py | Out-File $pyFile -Encoding utf8
$r = python $pyFile $src $dest 2>&1 | Out-String
L "sessions.db -> $dest : " + ($r -replace '\s+',' ')
if (Test-Path $dest) {
  # verificar integridad de la copia
  $chk = python -c "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute('pragma integrity_check').fetchone()[0]); print(c.execute('select count(*) from messages').fetchone()[0])" $dest 2>&1 | Out-String
  L "  integrity/mensajes: " + ($chk -replace '\s+',' ')
}

# 2) config (sin tocar valores)
$cfgDst = "$($dirs.config)\config-$stamp"
robocopy 'C:\Aegis-Proyects\state\config' $cfgDst /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
L "config -> $cfgDst"

# 3) mirror del monorepo del harness y del proyecto de trading
foreach ($repo in @(@{n='aegis-harness';p='C:\Aegis-Proyects\harness'}, @{n='trading';p='C:\Aegis-Proyects\trading'})) {
  if (Test-Path (Join-Path $repo.p '.git')) {
    $bare = Join-Path $dirs.mirror ($repo.n + '.git')
    if (Test-Path $bare) {
      # El mirror local toma los refs del checkout, no los remotos historicos de GitHub.
      $o = git -C $bare fetch --prune origin '+refs/*:refs/*' 2>&1 | Out-String
    } else {
      $o = git clone --mirror --no-hardlinks $repo.p $bare 2>&1 | Out-String
    }
    $sz = [math]::Round((Get-ChildItem $bare -Recurse -File -Force -EA 0 | Measure-Object Length -Sum).Sum/1MB,1)
    L "mirror $($repo.n) -> $bare ($sz MB) " + (($o -replace '\s+',' ') -replace '^(.{0,120}).*','$1')
  } else { L "mirror $($repo.n): sin .git, salteado" }
}

# 4) trading\data (duckdb, irreproducible si se corrompe)
$dd = "$dstRoot\trading-data"
robocopy 'C:\Aegis-Proyects\trading\data' $dd /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
$dsz = [math]::Round((Get-ChildItem $dd -Recurse -File -Force -EA 0 | Measure-Object Length -Sum).Sum/1GB,2)
L "trading\data -> $dd ($dsz GB)"

# 5) export de la distro WSL (rotacion: una sola copia viva)
$wslDir = "$dstRoot\wsl"
New-Item -ItemType Directory -Force -Path $wslDir | Out-Null
$tar = "$wslDir\ubuntu-$stamp.tar"
$prev = Get-ChildItem $wslDir -Filter 'ubuntu-*.tar' -EA 0 | Sort-Object LastWriteTime -Desc | Select-Object -Skip 1
$t0 = Get-Date
$o = & wsl.exe --export Ubuntu $tar 2>&1 | Out-String
$mins = [math]::Round(((Get-Date) - $t0).TotalMinutes,1)
$sz = if (Test-Path $tar) { [math]::Round((Get-Item $tar).Length/1GB,2) } else { 0 }
L "wsl export -> $tar ($sz GB en $mins min) " + (($o -replace '\s+',' ') -replace '^(.{0,100}).*','$1')
foreach ($p in $prev) { Remove-Item $p.FullName -Force -EA 0; L "rotacion: borrado $($p.Name)" }

L "--- D: libre: " + [math]::Round(((Get-PSDrive D).Free)/1GB,1) + " GB"
L "=== done"

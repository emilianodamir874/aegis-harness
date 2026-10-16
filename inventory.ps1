# Medicion reproducible del entorno (Fase A0). Solo lee. Correr dos veces debe dar lo mismo.
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_pointer.ps1')
'=== BINARIOS ==='
$td = 'C:\Aegis-Proyects\src\target\debug'
$exes = Get-ChildItem $td -File -Filter '*.exe' -ErrorAction SilentlyContinue
$vers = $exes | Where-Object { $_.Name -match '-v\d+\.exe$' }
'target\debug: ' + $exes.Count + ' exe | ' + [math]::Round((($exes | Measure-Object Length -Sum).Sum)/1MB,1) + ' MB | versionados: ' + $vers.Count
Get-ChildItem $td -Directory | ForEach-Object {
  $mb = [math]::Round(((Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum)/1MB,1)
  '  ' + $_.Name + ' = ' + $mb + ' MB'
}
'aegis\bin: ' + (Get-ChildItem $BinDir -File -ErrorAction SilentlyContinue).Count + ' archivos'
'=== PUNTERO / VIVO / CLI ==='
$cur = Get-AegisCurrent
if ($cur) { 'puntero: ' + $cur.tag + ' -> ' + $cur.exe } else { 'puntero: (no existe)' }
'vivo(3284): ' + (Get-AegisLiveServe)
'cli(aegis.cmd): ' + (Get-AegisCliExe)
& (Join-Path $PSScriptRoot 'check-consistency.ps1')
'=== STORES ==='
foreach ($e in '%APPDATA%\Aegis\aegis','%APPDATA%\Block\goose','%APPDATA%\Block\goose-legacy-20261015') {
  $p = [Environment]::ExpandEnvironmentVariables($e)
  if (Test-Path $p) {
    $f = Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue
    '  ' + $p + ' | ' + $f.Count + ' archivos | ' + [math]::Round((($f | Measure-Object Length -Sum).Sum)/1MB,1) + ' MB | ult ' + (($f | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime)
  } else { '  ' + $p + ' | no existe' }
}
'=== VERSIONES CLAVADAS EN SCRIPTS ==='
foreach ($r in 'C:\Aegis-Proyects\web\tools','C:\Aegis-Proyects\web\scripts',"$env:LOCALAPPDATA\hermes\bin",'C:\Aegis-Proyects\core\ops') {
  $n = (Get-ChildItem $r -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -in '.ps1','.bat','.cmd','.vbs','.mjs','.py' } |
        Where-Object { (Get-Content $_.FullName -Raw -ErrorAction SilentlyContinue) -match '\b(aegis|goose)-v\d+' }).Count
  '  ' + $r + ' | archivos con version clavada: ' + $n
}
'=== LOGS / BACKUPS / DISCO ==='
foreach ($d in 'C:\Aegis-Proyects\core\logs','C:\Aegis-Proyects\core\backups','C:\Aegis-Proyects\web\logs') {
  if (Test-Path $d) { $f = Get-ChildItem $d -Recurse -File -ErrorAction SilentlyContinue; '  ' + $d + ' | ' + $f.Count + ' archivos | ' + [math]::Round((($f | Measure-Object Length -Sum).Sum)/1MB,1) + ' MB' }
}
'  C: libre = ' + [math]::Round((Get-PSDrive C).Free/1GB,1) + ' GB / usado = ' + [math]::Round((Get-PSDrive C).Used/1GB,1) + ' GB'
'=== TAREAS DEL STACK ==='
Get-ScheduledTask | ForEach-Object { $t = $_; $a = ($t.Actions | ForEach-Object { $_.Execute + ' ' + $_.Arguments }) -join ' '; if ($a -match 'goose|aegis') { '  ' + $t.TaskName + ' | ' + $t.State } }

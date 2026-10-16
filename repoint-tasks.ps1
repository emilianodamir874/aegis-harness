# Repunta las 2 tareas que quedaron apuntando a los puentes de C:\goose-web (requiere elevacion:
# Set-ScheduledTask daba Acceso denegado sin admin). ASCII a proposito (este archivo lo puede
# ejecutar PS 5.1 o 7; el contenido no tiene acentos).
$ErrorActionPreference = 'Continue'
$log = 'C:\Aegis-Proyects\core\tmp\repoint-tasks.log'
function W($m) { Add-Content -Path $log -Value ((Get-Date).ToString('HH:mm:ss') + ' ' + [string]$m) }
W ('=== repoint tasks inicio; PSVersion ' + $PSVersionTable.PSVersion.ToString() + '; admin=' + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) + ' ===')
foreach ($n in 'Goose_Web','Goose_Web_Tunnel') {
  $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
  if (-not $t) { W ('  ' + $n + ' no existe'); continue }
  W ('  ' + $n + ' antes: ' + (($t.Actions | ForEach-Object { ([string]$_.Execute + ' ' + [string]$_.Arguments) }) -join ' ;; '))
  $acts = @()
  foreach ($a in $t.Actions) {
    $ex = ([string]$a.Execute).Replace('goose-web','aegis-web')
    $ar = ([string]$a.Arguments).Replace('goose-web','aegis-web')
    $wd = ([string]$a.WorkingDirectory).Replace('goose-web','aegis-web')
    if ($wd) { $acts += New-ScheduledTaskAction -Execute $ex -Argument $ar -WorkingDirectory $wd } else { $acts += New-ScheduledTaskAction -Execute $ex -Argument $ar }
  }
  try { Set-ScheduledTask -TaskName $n -Action $acts -ErrorAction Stop | Out-Null; W ('  ' + $n + ' OK -> ' + (($acts | ForEach-Object { ([string]$_.Execute + ' ' + [string]$_.Arguments) }) -join ' ;; ')) }
  catch { W ('  ' + $n + ' FALLO: ' + $_.Exception.Message) }
}
W '=== fin ==='
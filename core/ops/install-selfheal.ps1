# Instala (o reinstala) la tarea programada del sanador del harness.
# Uso:  install-selfheal.ps1                 (cada 3 minutos)
#       install-selfheal.ps1 -IntervalMinutes 5
#       install-selfheal.ps1 -Remove         (desinstala)
# La tarea corre FUERA del harness a proposito: si el serve no arranca, un vigilante que vive
# adentro tampoco arranca. No necesita elevacion (corre como el usuario, igual que Aegis_Web).
param(
  [int]$IntervalMinutes = 3,
  [string]$TaskName = 'Aegis SelfHeal',
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$script = 'C:\Aegis-Proyects\core\ops\selfheal.ps1'
$gate   = 'C:\Aegis-Proyects\core\ops\health-gate.ps1'

if ($Remove) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output ('tarea eliminada: ' + $TaskName)
  } else { Write-Output ('no existia: ' + $TaskName) }
  exit 0
}

foreach ($f in @($script, $gate, 'C:\Aegis-Proyects\core\ops\snapshot-good.ps1', 'C:\Aegis-Proyects\core\ops\canary.yaml')) {
  if (-not (Test-Path $f)) { throw ('falta una pieza: ' + $f) }
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $script + '"')

# Arranca dentro de 1 minuto y se repite cada N minutos, indefinidamente.
$start = (Get-Date).AddMinutes(1)
$trigger = New-ScheduledTaskTrigger -Once -At $start `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -RestartCount 0

$principal = New-ScheduledTaskPrincipal -UserId ($env:USERDOMAIN + '\' + $env:USERNAME) -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Description 'Devuelve el despliegue del harness (puntero, binario, web, config) a la ultima foto sana cuando el gate funcional da rojo.' | Out-Null

$t = Get-ScheduledTask -TaskName $TaskName
$info = $t | Get-ScheduledTaskInfo
Write-Output ('tarea registrada: ' + $t.TaskName + ' (' + $t.State + ')')
Write-Output ('  cada ' + $IntervalMinutes + ' min, primera corrida ' + $start.ToString('HH:mm:ss'))
Write-Output ('  accion: powershell -File ' + $script)
Write-Output ('  next run: ' + $info.NextRunTime)

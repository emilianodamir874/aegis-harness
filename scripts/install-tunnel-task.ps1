# Instala la tarea programada Aegis_Web_Tunnel (requiere elevacion: el registro de tareas
# programadas no lo permite un proceso no elevado).
# Tarea: wscript.exe goose-web-tunnel.vbs loop
#   - trigger: al iniciar sesion + repeticion cada 10 min (red de seguridad si el residente muere)
#   - ExecutionTimeLimit 0 (sin limite: el watchdog queda residente), MultipleInstances IgnoreNew
$ErrorActionPreference = 'Stop'
$log = 'C:\goose-web\logs\install-task.log'
try {
    $vbs = 'C:\goose-web\scripts\goose-web-tunnel.vbs'
    if (-not (Test-Path $vbs)) { throw "falta $vbs" }

    $act = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '" loop')
    $t1 = New-ScheduledTaskTrigger -AtLogOn -User 'Emiliano'
    $t2 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 3650)
    $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    $prn = New-ScheduledTaskPrincipal -UserId 'Emiliano' -LogonType Interactive -RunLevel Limited

    Register-ScheduledTask -TaskName 'Aegis_Web_Tunnel' -Action $act -Trigger $t1, $t2 `
        -Settings $set -Principal $prn -Force `
        -Description 'Tunel Cloudflare de aegis-web: mantiene el quick tunnel a 127.0.0.1:3788 y escribe tunnel-url.txt / tunnel-access.txt.' | Out-Null

    $t = Get-ScheduledTask -TaskName 'Aegis_Web_Tunnel'
    $lines = @(
        ('OK ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')),
        ('State: ' + $t.State),
        ('Action: ' + ($t.Actions | ForEach-Object { $_.Execute + ' ' + $_.Arguments })),
        ('Triggers: ' + (($t.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ', ')),
        ('Settings: limit=' + $t.Settings.ExecutionTimeLimit + ' multi=' + $t.Settings.MultipleInstances)
    )
    [System.IO.File]::WriteAllText($log, ($lines -join "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
} catch {
    [System.IO.File]::WriteAllText($log, ('ERROR ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + "`r`n" + $_), (New-Object System.Text.UTF8Encoding($false)))
    exit 1
}

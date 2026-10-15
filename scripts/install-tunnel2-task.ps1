# Instala la tarea programada Aegis_Web_Tunnel2 (tunel 2 de respaldo de aegis-web).
$ErrorActionPreference = 'Stop'
$log = 'C:\Aegis-Proyects\web\logs\install-task2.log'
try {
    $vbs = 'C:\Aegis-Proyects\web\scripts\aegis-web-tunnel2.vbs'
    if (-not (Test-Path $vbs)) { throw "falta $vbs" }

    $act = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '" loop')
    $t1 = New-ScheduledTaskTrigger -AtLogOn -User 'Emiliano'
    $t2 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 3650)
    $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    $prn = New-ScheduledTaskPrincipal -UserId 'Emiliano' -LogonType Interactive -RunLevel Limited

    Register-ScheduledTask -TaskName 'Aegis_Web_Tunnel2' -Action $act -Trigger $t1, $t2 `
        -Settings $set -Principal $prn -Force `
        -Description 'Segundo tunel Cloudflare de aegis-web (respaldo) a 127.0.0.1:3788; escribe tunnel-url-2.txt / tunnel-access-2.txt.' | Out-Null

    $t = Get-ScheduledTask -TaskName 'Aegis_Web_Tunnel2'
    [System.IO.File]::WriteAllText($log, (@('OK ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), 'State: ' + $t.State, 'Action: ' + ($t.Actions | ForEach-Object { $_.Execute + ' ' + $_.Arguments })) -join "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
} catch {
    [System.IO.File]::WriteAllText($log, ('ERROR ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + "`r`n" + $_), (New-Object System.Text.UTF8Encoding($false)))
    exit 1
}

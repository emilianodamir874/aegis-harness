# aegis-web: one-time elevated setup (firewall rules + logon autostart task).
# Run ELEVATED:  Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','C:\Aegis-Proyects\web\scripts\setup-aegis-web.ps1'
# Log: C:\Aegis-Proyects\web\logs\setup.log
Start-Transcript -Path 'C:\Aegis-Proyects\web\logs\setup.log' -Force | Out-Null
$ErrorActionPreference = 'Continue'
$cfg = Get-Content 'C:\Aegis-Proyects\web\config.json' -Raw | ConvertFrom-Json

# --- firewall: allow LAN (private profile, local subnet only) ---
foreach ($port in @($cfg.webPort, $cfg.servePort)) {
  $name = "Aegis Web $port (LAN)"
  netsh advfirewall firewall delete rule name="$name" | Out-Null
  netsh advfirewall firewall add rule name="$name" dir=in action=allow protocol=TCP localport=$port profile=private remoteip=localsubnet
}

# --- scheduled task: start the stack at logon (hidden) ---
schtasks.exe /Create /TN Aegis_Web /TR "wscript.exe C:\Aegis-Proyects\web\scripts\aegis-web-launch.vbs" /SC ONLOGON /RL LIMITED /F

# --- task settings: no 72h limit, run on battery, don't duplicate ---
$t = Get-ScheduledTask -TaskName 'Aegis_Web'
$t.Settings.ExecutionTimeLimit = 'PT0S'
$t.Settings.DisallowStartIfOnBatteries = $false
$t.Settings.StopIfGoingOnBatteries = $false
$t.Settings.MultipleInstances = 'IgnoreNew'
$t.Settings.StartWhenAvailable = $true
Set-ScheduledTask -TaskName 'Aegis_Web' -Settings $t.Settings | Out-Null

Write-Output '== firewall rules =='
netsh advfirewall firewall show rule name="Aegis Web $($cfg.webPort) (LAN)" | Select-String 'Rule Name|LocalPort|RemoteIP'
netsh advfirewall firewall show rule name="Aegis Web $($cfg.servePort) (LAN)" | Select-String 'Rule Name|LocalPort|RemoteIP'
Write-Output '== task =='
schtasks.exe /Query /TN Aegis_Web /V /FO LIST | Select-String 'TaskName|Status|Run As User|Schedule Type|Task To Run'
Write-Output 'SETUP DONE'
Stop-Transcript | Out-Null

' aegis-web hidden launcher (scheduled task Aegis_Web).
' Starts the aegis serve backend + web UI without flashing a console window.
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Aegis-Proyects\web\scripts\start-aegis-web.ps1", 0, False

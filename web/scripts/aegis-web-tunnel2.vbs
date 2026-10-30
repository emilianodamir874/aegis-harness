' aegis-web tunel 2 (respaldo) - launcher residente oculto.
' Sin args: una pasada. Con arg: loop residente cada 60 s.
Dim sh, extra
Set sh = CreateObject("WScript.Shell")
extra = ""
If WScript.Arguments.Count > 0 Then extra = " -Loop"
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""C:\Aegis-Proyects\web\scripts\aegis-web-tunnel2.ps1""" & extra, 0, False

' aegis-web tunnel watchdog - hidden resident launcher (quick tunnel Cloudflare + stack web).
' Sin args: una pasada (backup si el residente murio). Con arg: loop residente cada 60 s.
Dim sh, extra
Set sh = CreateObject("WScript.Shell")
extra = ""
If WScript.Arguments.Count > 0 Then extra = " -Loop"
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""C:\goose-web\scripts\goose-web-tunnel-watchdog.ps1""" & extra, 0, False

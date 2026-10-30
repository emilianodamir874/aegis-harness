$e=$null;$t=$null
[void][System.Management.Automation.Language.Parser]::ParseFile('C:\Aegis-Proyects\web\scripts\aegis-web-tunnel-watchdog.ps1',[ref]$t,[ref]$e)
if ($e -and $e.Count -gt 0) { $e | ForEach-Object { $_.Message } } else { 'WATCHDOG_PARSE_OK' }
$u = 'https://edinburgh-birth-detection-east.trycloudflare.com/login'
$body = 'password=' + [uri]::EscapeDataString('pizarralaguna-188!')
try {
  $r = Invoke-WebRequest -Uri $u -Method POST -Body $body -ContentType 'application/x-www-form-urlencoded' -MaximumRedirection 0 -TimeoutSec 20 -UseBasicParsing -SessionVariable s
  "POST -> $($r.StatusCode)"
} catch {
  $resp = $_.Exception.Response
  if ($resp) { "POST -> $([int]$resp.StatusCode) set-cookie=$([bool]($resp.Headers['Set-Cookie']))" } else { "POST -> ERR $($_.Exception.Message)" }
}

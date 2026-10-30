# Mide el costo de arranque por el tunel de Cloudflare con sesion real.
# No imprime ni escribe la password: la lee de web\auth.json y la usa solo en el POST /login.
$ErrorActionPreference = 'Stop'
$T = 'https://individually-lawsuit-portions-myrtle.trycloudflare.com'
$jar = 'C:\Aegis-Proyects\core\tmp\tunel-jar.txt'
$auth = Get-Content 'C:\Aegis-Proyects\web\auth.json' -Raw | ConvertFrom-Json
$pw = $auth.password
if (-not $pw) { Write-Output 'ABORT: auth.json sin password'; exit 1 }

$login = curl.exe -s -c $jar --data-urlencode "password=$pw" -o NUL -w "%{http_code} %{time_total}" "$T/login"
Write-Output "login: $login"

$html = curl.exe -s -b $jar "$T/"
$bundle = ([regex]::Match($html, 'bundle\.js\?v=([a-f0-9]+)')).Groups[1].Value
$css = ([regex]::Match($html, 'app\.css\?v=([a-f0-9]+)')).Groups[1].Value
Write-Output ("bundle=" + $bundle.Substring(0,10))

# cada request: bytes transferidos y tiempo total (el TTFB es la mayor parte en un quick tunnel)
foreach ($par in @(
  @{n='index';  u="$T/"},
  @{n='css';    u="$T/app.css?v=$css"},
  @{n='bundle'; u="$T/bundle.js?v=$bundle"}
)) {
  $r = curl.exe -s -b $jar -H 'Accept-Encoding: br' -o NUL -w "%{size_download} %{time_starttransfer} %{time_total}" $par.u
  $p = $r -split ' '
  Write-Output ("{0,-7} {1,9} B  ttfb={2,7}s  total={3,7}s" -f $par.n, $p[0], $p[1], $p[2])
}

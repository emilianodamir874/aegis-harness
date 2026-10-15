# aegis-web: SEGUNDO tunel Cloudflare (quick tunnel) al mismo origen (127.0.0.1:3788).
# URL de respaldo / acceso alterno. NO toca el tunel principal ni su watchdog.
# Log: C:\Aegis-Proyects\web\logs\tunnel2-watchdog.log   URL: tunnel-url-2.txt
param([switch]$Loop)

$ErrorActionPreference = 'SilentlyContinue'
$Root     = 'C:\Aegis-Proyects\web'
$Log      = Join-Path $Root 'logs\tunnel2-watchdog.log'
$UrlFile  = Join-Path $Root 'tunnel-url-2.txt'
$AccFile  = Join-Path $Root 'tunnel-access-2.txt'
$CfLog    = Join-Path $Root 'logs\cloudflared-aegis2.log'
$CfExe    = 'C:\Users\Emiliano\AppData\Local\hermes\bin\cloudflared.exe'
$Origin   = 'http://127.0.0.1:3788'
$AuthFile = Join-Path $Root 'auth.json'

function Write-Log([string]$m) {
    $line = ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
    try {
        if ((Test-Path $Log) -and ((Get-Item $Log).Length -gt 1048576)) { Move-Item -Force $Log ($Log + '.old') }
        Add-Content -Path $Log -Value $line -Encoding ASCII
    } catch {}
}

# cloudflared del tunel 2 = el que usa el logfile cloudflared-aegis2.log
function Get-Tunnel2 {
    Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" |
        Where-Object { $_.CommandLine -like '*cloudflared-aegis2.log*' }
}

function Save-TunnelUrl {
    if (-not (Test-Path $CfLog)) { return }
    $txt = Get-Content -Path $CfLog -Tail 400 | Out-String
    $m = [regex]::Match($txt, 'https://[a-z0-9-]+\.trycloudflare\.com')
    if (-not $m.Success) { return }
    $new = $m.Value
    $old = ''
    if (Test-Path $UrlFile) { $old = (Get-Content -Path $UrlFile -Raw) }
    if ($old -like ('*' + $new + '*')) { return }

    $pw = ''
    if (Test-Path $AuthFile) { $pw = (Get-Content $AuthFile -Raw | ConvertFrom-Json).password }
    @(
        ('URL publica: ' + $new),
        ('Origen: ' + $Origin + '  (aegis web: UI + WS /acp proxeado al serve 3284) - TUNEL 2 (respaldo)'),
        'Usuario: (cualquiera)  Password: ver tunnel-access-2.txt',
        ('Actualizado: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')),
        '',
        'Tunel rapido: cambia de URL si cloudflared se reinicia.',
        'El tunel principal (Aegis_Web_Tunnel) sigue vivo y con su propia URL.'
    ) | Set-Content -Path $UrlFile -Encoding ASCII

    @(
        'aegis web por Cloudflare - acceso (TUNEL 2, respaldo)',
        '',
        ('URL:      ' + $new),
        'Password: ' + $pw,
        ('(local)   ' + $Origin),
        '',
        'Misma app/password que el tunel principal; la sesion dura 30 dias por dispositivo.',
        ('Actualizado: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
    ) | Set-Content -Path $AccFile -Encoding ASCII
    Write-Log ('tunnel2 URL -> ' + $new)
}

$mtx = New-Object System.Threading.Mutex($false, 'Global\AegisWebTunnel2Watchdog')
$owner = $mtx.WaitOne(0)
if (-not $owner) { Write-Log 'otra instancia residente ya vigila (pasada simple)' }
$effectiveLoop = ($Loop -and $owner)

do {
    $t = @(Get-Tunnel2)
    if ($t.Count -eq 0) {
        Write-Log 'tunel 2 ausente -> relanzando quick tunnel'
        Start-Process -FilePath $CfExe `
            -ArgumentList @('tunnel', '--url', $Origin, '--logfile', $CfLog, '--no-autoupdate') `
            -WindowStyle Hidden
        Start-Sleep -Seconds 20
    }
    Save-TunnelUrl
    Write-Log ('pasada ok tunel2=' + @(Get-Tunnel2).Count + ' loop=' + $effectiveLoop)
    if ($effectiveLoop) { Start-Sleep -Seconds 60 }
} while ($effectiveLoop)

if ($owner) { $mtx.ReleaseMutex() }
$mtx.Dispose()

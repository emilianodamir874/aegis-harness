# aegis-web: tunel Cloudflare (quick tunnel) + vigilancia del stack web.
# - Mantiene vivo el tunel a la UI local (127.0.0.1:3788) y, si hace falta, arranca el stack
#   (start-aegis-web.ps1 -> aegis serve + server.mjs).
# - Escribe la URL publica en tunnel-url.txt y las credenciales en tunnel-access.txt.
# - Una pasada por defecto; -Loop queda residente cada 60 s (lanzador oculto aegis-web-tunnel.vbs).
# Log: C:\Aegis-Proyects\web\logs\tunnel-watchdog.log
param([switch]$Loop)

$ErrorActionPreference = 'SilentlyContinue'
$Root    = 'C:\Aegis-Proyects\web'
$Log     = Join-Path $Root 'logs\tunnel-watchdog.log'
$UrlFile = Join-Path $Root 'tunnel-url.txt'
$AccFile = Join-Path $Root 'tunnel-access.txt'
$CfLog   = Join-Path $Root 'logs\cloudflared-aegis.log'
$CfExe   = 'C:\Users\Emiliano\AppData\Local\hermes\bin\cloudflared.exe'
$Origin  = 'http://127.0.0.1:3788'
$StartPs = Join-Path $Root 'scripts\start-aegis-web.ps1'
$AuthFile = Join-Path $Root 'auth.json'

function Write-Log([string]$m) {
    $line = ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
    try {
        if ((Test-Path $Log) -and ((Get-Item $Log).Length -gt 1048576)) { Move-Item -Force $Log ($Log + '.old') }
        Add-Content -Path $Log -Value $line -Encoding ASCII
    } catch {}
}

function Get-WebCode {
    $code = 0
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri ($Origin + '/healthz') -TimeoutSec 10 -MaximumRedirection 0
        $code = [int]$r.StatusCode
    } catch {
        $resp = $_.Exception.Response
        if ($resp) { $code = [int]$resp.StatusCode.value__ }
    }
    return $code
}

# /healthz responde 200 aunque la app sea INVISIBLE en el navegador: el 14/10 el HTML se sirvio
# con 'content-encoding: gzip' y el cuerpo sin comprimir, y todos los navegadores mostraban una
# pagina en blanco mientras este watchdog decia 'pasada ok' (PowerShell no pide gzip, asi que
# nunca veia el error de decodificacion). Este chequeo pide como un navegador y valida el
# contenido real: HTML con cache-busting + el app.js versionado que ese HTML referencia.
function Get-RenderCheck {
    try {
        $h = @{ 'Accept-Encoding' = 'gzip, deflate, br'; 'User-Agent' = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36' }
        $r = Invoke-WebRequest -UseBasicParsing -Uri ($Origin + '/') -Headers $h -TimeoutSec 12
        $html = [string]$r.Content
        if ($r.StatusCode -ne 200) { return ('html ' + $r.StatusCode) }
        if ($html -notmatch 'id="messages"') { return 'html sin cuerpo de la app' }
        $m = [regex]::Match($html, 'app\.js\?v=([a-z0-9]+)')
        if (-not $m.Success) { return 'html sin cache-busting de app.js' }
        $js = Invoke-WebRequest -UseBasicParsing -Uri ($Origin + '/app.js?v=' + $m.Groups[1].Value) -Headers $h -TimeoutSec 15
        $txt = [string]$js.Content
        if ($js.StatusCode -ne 200) { return ('app.js ' + $js.StatusCode) }
        if ($txt.Length -lt 40000) { return ('app.js truncado (' + $txt.Length + ' bytes)') }
        if ($txt -notmatch 'aegis-web') { return 'app.js no parece el cliente web' }
        return 'ok'
    } catch {
        return ('excepcion: ' + $_.Exception.Message)
    }
}

# El backend ACP (aegis serve) puede morir SOLO, sin tocar la UI: /healthz sigue 200 y el render
# sigue ok, asi que el watchdog cantaba 'pasada ok' con la app inservible (incidente 26/10 22:41:
# serve muerto y nadie lo levanto en ~8 h; el usuario encontro la pagina sin backend). El gate
# real tiene que incluir el listener del serve y el flag backendTcpReady de /healthz.
function Get-ServePort {
    try { return [int]((Get-Content (Join-Path $Root 'config.json') -Raw | ConvertFrom-Json).servePort) } catch { return 3284 }
}

function Test-Backend {
    $port = Get-ServePort
    $listen = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if (-not $listen) { return ('sin listener en ' + $port) }
    try {
        $h = Invoke-WebRequest -UseBasicParsing -Uri ($Origin + '/healthz') -TimeoutSec 10
        $j = [string]$h.Content | ConvertFrom-Json
        if ($j.processReady -ne $true) { return 'healthz processReady=false' }
        if ($j.backendTcpReady -ne $true) { return 'healthz backendTcpReady=false' }
    } catch { return ('healthz excepcion: ' + $_.Exception.Message) }
    return 'ok'
}

# Lanzar el launcher/restarter SIN quedarse esperando: '& powershell -File start-aegis-web.ps1 |
# Out-Null' se CUELGA, porque el serve (hijo detached) hereda el pipe del padre y nunca llega el
# EOF: el watchdog quedaba bloqueado dentro de la pasada y dejaba de vigilar (bug visto al probar
# el reinicio del backend el 27/10). Start-Process sin -Wait no hereda el pipe.
function Start-Detached([string]$script) {
    Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script) `
        -WindowStyle Hidden
}

# cloudflared del tunel de aegis-web (no confundir con el del dashboard Hermes).
# Se identifica por SU logfile: el tunel 2 tambien apunta a 3788 y si no, este watchdog
# lo contaria como propio y nunca levantaria el principal (bug visto el 15/10).
function Get-AegisTunnel {
    Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" |
        Where-Object { $_.CommandLine -like '*cloudflared-aegis.log*' }
}

function Save-TunnelUrl {
    if (-not (Test-Path $CfLog)) { return }
    $txt = Get-Content -Path $CfLog -Tail 400 | Out-String
    $ms = [regex]::Matches($txt, 'https://[a-z0-9-]+\.trycloudflare\.com')
    if ($ms.Count -eq 0) { return }
    $new = $ms[$ms.Count - 1].Value
    $old = ''
    if (Test-Path $UrlFile) { $old = (Get-Content -Path $UrlFile -Raw) }
    if ($old -like ('*' + $new + '*')) { return }

    $pw = ''
    if (Test-Path $AuthFile) { $pw = (Get-Content $AuthFile -Raw | ConvertFrom-Json).password }
    @(
        ('URL publica: ' + $new),
        ('Origen: ' + $Origin + '  (aegis web: UI + WS /acp proxeado al serve 3284)'),
        'Usuario: (cualquiera)  Password: ver tunnel-access.txt',
        ('Actualizado: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')),
        '',
        'El tunel rapido de Cloudflare cambia de URL cada vez que cloudflared se reinicia.',
        'Si esta URL no responde, pedile al agente que revise logs\tunnel-watchdog.log.'
    ) | Set-Content -Path $UrlFile -Encoding ASCII

    @(
        'aegis web por Cloudflare - acceso',
        '',
        ('URL:      ' + $new),
        ('Password: ' + $pw),
        ('(local)   ' + $Origin),
        '',
        'La sesion queda guardada 30 dias por dispositivo (cookie firmada).',
        ('Actualizado: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
    ) | Set-Content -Path $AccFile -Encoding ASCII
    Write-Log ('tunnel URL -> ' + $new)
}

$mtx = New-Object System.Threading.Mutex($false, 'Global\AegisWebTunnelWatchdog')
$owner = $mtx.WaitOne(0)
if (-not $owner) { Write-Log 'otra instancia residente ya vigila (pasada simple)' }
$effectiveLoop = ($Loop -and $owner)

do {
    $code = Get-WebCode
    if (-not ($code -ge 200 -and $code -lt 500)) {
        Write-Log 'stack web caido -> start-aegis-web.ps1'
        Start-Detached $StartPs
        Start-Sleep -Seconds 8
        $code = Get-WebCode
    }

    $render = Get-RenderCheck
    if ($render -ne 'ok') {
        # El stack responde pero el navegador no puede cargar la app: launcher idempotente por
        # puerto no arregla nada, hay que reiniciar el cliente web. Con enfriamiento para no
        # entrar en un bucle de reinicios si la causa es un archivo roto.
        Write-Log ('web responde pero la app no carga (' + $render + ')')
        $stamp = Join-Path $Root 'logs\.last-render-restart'
        $due = $true
        if (Test-Path $stamp) {
            if (((Get-Date) - (Get-Item $stamp).LastWriteTime).TotalMinutes -lt 15) {
                $due = $false
                Write-Log 'reinicio por render omitido (enfriamiento 15 min)'
            }
        }
        if ($due) {
            Set-Content -Path $stamp -Value (Get-Date -Format s) -Encoding ASCII
            Write-Log 'reinicio del cliente web (render roto)'
            Start-Detached (Join-Path $Root 'scripts\restart-node.ps1')
            Start-Sleep -Seconds 8
            $render = Get-RenderCheck
            Write-Log ('render tras reinicio: ' + $render)
        }
    }

    # Backend ACP: la UI puede estar perfecta y el serve muerto (lo que paso el 26/10 22:41).
    $backend = Test-Backend
    if ($backend -ne 'ok') {
        $stampB = Join-Path $Root 'logs\.last-backend-restart'
        $dueB = $true
        if (Test-Path $stampB) {
            if (((Get-Date) - (Get-Item $stampB).LastWriteTime).TotalMinutes -lt 10) { $dueB = $false }
        }
        if ($dueB) {
            Set-Content -Path $stampB -Value (Get-Date -Format s) -Encoding ASCII
            Write-Log ('backend ACP caido (' + $backend + ') -> start-aegis-web.ps1')
            Start-Detached $StartPs
            $deadline = (Get-Date).AddSeconds(45)
            while ((Get-Date) -lt $deadline) {
                Start-Sleep -Seconds 3
                if ((Test-Backend) -eq 'ok') { break }
            }
            $backend = Test-Backend
            Write-Log ('backend tras reinicio: ' + $backend)
            # El enfriamiento es para no martillar con reintentos FALLIDOS: si el reinicio funciono,
            # se borra la marca para que el proximo corte se arregle en la pasada siguiente.
            if ($backend -eq 'ok') { Remove-Item -Force $stampB -ErrorAction SilentlyContinue }
        } else {
            Write-Log ('backend ACP caido (' + $backend + ') - reinicio omitido (enfriamiento 10 min)')
        }
    }

    $tun = @(Get-AegisTunnel)
    if ($tun.Count -eq 0) {
        Write-Log 'tunel caido -> relanzando quick tunnel'
        Start-Process -FilePath $CfExe `
            -ArgumentList @('tunnel', '--url', $Origin, '--logfile', $CfLog, '--no-autoupdate') `
            -WindowStyle Hidden
        Start-Sleep -Seconds 20
    }
    Save-TunnelUrl

    Write-Log ('pasada ok web_http=' + $code + ' render=' + $render + ' backend=' + $backend + ' tunel=' + @(Get-AegisTunnel).Count + ' loop=' + $effectiveLoop)
    if ($effectiveLoop) { Start-Sleep -Seconds 60 }
} while ($effectiveLoop)

if ($owner) { $mtx.ReleaseMutex() }
$mtx.Dispose()

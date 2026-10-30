<#
.SYNOPSIS
    Borra el store de sesiones de Aegis (sessions.db + -wal + -shm) y deja el serve recreandolo vacio.

.DESCRIPTION
    `del /f /s /q state\data\sessions` no sirve con el serve corriendo: sessions.db esta tomado por
    aegis-vNN.exe (sharing violation), cmd imprime "Acceso denegado" sobre el archivo grande y puede
    llevarse -wal/-shm, dejando el store a medio borrar. Este script hace el borrado en el orden que
    funciona: backup en frio -> parar el serve -> borrar -> arrancar -> verificar.

    Corre en dos fases:
      (sin -Apply)  plan: tamano, sesiones, mensajes y que se va a perder. No toca nada.
      (-Apply)      ejecuta. MATA la sesion que este en curso: el proceso que hospeda el chat es el
                    mismo que tiene el store abierto. Lanzarlo detached (ver -Detached del README
                    del script o el ejemplo) para que el turno termine antes del stop.

.PARAMETER Apply
    Ejecuta de verdad. Sin este switch es dry-run.

.PARAMETER Port
    Puerto del serve ACP. Default 3284.

.PARAMETER NoBackup
    No guarda copia en frio. Irreversible.

.PARAMETER KeepBackups
    Cuantas copias .bak-wipe-* conservar en C:\Users\Emiliano\backups\sessions. Default 3.

.PARAMETER Detached
    Relanza el trabajo real en un powershell aparte con -DelaySecs de espera y sale de inmediato.

.EXAMPLE
    .\wipe-sessions-store.ps1
    Plan.

.EXAMPLE
    .\wipe-sessions-store.ps1 -Apply -Detached -DelaySecs 90
    Deja el borrado agendado a 90 s; el turno actual alcanza a cerrar antes del stop del serve.
#>
[CmdletBinding()]
param(
    [switch]$Apply,
    [int]$Port = 3284,
    [switch]$NoBackup,
    [int]$KeepBackups = 3,
    [switch]$Detached,
    [switch]$NoRestart,
    [int]$DelaySecs = 90
)

$ErrorActionPreference = 'Stop'

if (-not $env:AEGIS_PATH_ROOT -or $env:AEGIS_PATH_ROOT.Trim() -eq '') {
    $env:AEGIS_PATH_ROOT = 'C:\Aegis-Proyects\state'
}
$Root       = $env:AEGIS_PATH_ROOT
$StoreDir   = Join-Path $Root 'data\sessions'
$DbPath     = Join-Path $StoreDir 'sessions.db'
$BackupDir  = 'C:\Users\Emiliano\backups\sessions'
$LogDir     = 'C:\Aegis-Proyects\core\logs\gc'
$Stamp      = Get-Date -Format 'yyyyMMdd-HHmmss'
$LogFile    = Join-Path $LogDir "wipe-store-$Stamp.log"

function Say([string]$msg) {
    $line = '[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $msg
    Write-Output $line
    if (Test-Path $LogDir) { Add-Content -Path $LogFile -Value $line -Encoding utf8 }
}

# --- lock de operaciones -----------------------------------------------------
# Swap y wipe no pueden pisarse: el 2026-10-27 a las 05:05 el wipe apago el serve que el swap
# acababa de levantar y lo dejo muerto seis horas. Un archivo con dueno y vencimiento alcanza.
# el lock vive junto al puntero de version, fuera del store: $AegisRoot no existe en este script
$Script:OpsLock = 'C:\Aegis-Proyects\core\state\ops.lock'

function Get-OpsLock {
    if (-not (Test-Path $Script:OpsLock)) { return $null }
    try { return (Get-Content $Script:OpsLock -Raw | ConvertFrom-Json) } catch { return $null }
}

function Test-OpsLockFree([string]$Owner) {
    $actual = Get-OpsLock
    if (-not $actual) { return $true }
    $edad = ((Get-Date) - [datetime]$actual.started).TotalMinutes
    if ($edad -gt 30) { return $true }   # lock huerfano: el proceso murio sin limpiar
    if ($actual.owner -eq $Owner) { return $true }
    return $false
}

function Set-OpsLock([string]$Owner) {
    $payload = @{ owner = $Owner; pid = $PID; started = (Get-Date).ToString('o') } | ConvertTo-Json -Compress
    $payload | Out-File -FilePath $Script:OpsLock -Encoding utf8 -Force
}

function Clear-OpsLock {
    Remove-Item -LiteralPath $Script:OpsLock -Force -ErrorAction SilentlyContinue
}

function Get-StoreStats {
    $db = Get-Item $DbPath -ErrorAction SilentlyContinue
    if (-not $db) { return $null }
    $all = Get-ChildItem $StoreDir -Force -ErrorAction SilentlyContinue
    [pscustomobject]@{
        DbMB    = [math]::Round($db.Length / 1MB, 1)
        TotalMB = [math]::Round((($all | Measure-Object Length -Sum).Sum) / 1MB, 1)
        Files   = ($all | ForEach-Object { $_.Name }) -join ', '
    }
}

function Get-ServeProcess {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
         Select-Object -First 1
    if (-not $c) { return $null }
    Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
}

function Test-DbLocked {
    try {
        $fs = [System.IO.File]::Open($DbPath, 'Open', 'ReadWrite', 'None')
        $fs.Close()
        return $false
    } catch { return $true }
}

# --- fase detached: relanza esto mismo separado y sale -----------------------
if ($Apply -and $Detached) {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    # Wrapper a disco en vez de -Command: el quoting anidado por Start-Process se rompe facil.
    $wrapper = Join-Path $LogDir "wipe-store-wrapper-$Stamp.ps1"
    $nb = if ($NoBackup) { '-NoBackup' } else { '' }
    @(
        "Start-Sleep -Seconds $DelaySecs"
        "& '$PSCommandPath' -Apply -Port $Port -KeepBackups $KeepBackups $nb"
    ) | Set-Content -Path $wrapper -Encoding utf8
    Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$wrapper`"") `
        -WindowStyle Hidden | Out-Null
    Say "detached: borrado agendado en $DelaySecs s. wrapper: $wrapper"
    Say "detached: log: $LogFile"
    return
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# --- plan --------------------------------------------------------------------
$stats = Get-StoreStats
$proc  = Get-ServeProcess

Say "store:   $DbPath"
if ($stats) {
    Say ("archivo: {0} MB | total dir: {1} MB | {2}" -f $stats.DbMB, $stats.TotalMB, $stats.Files)
} else {
    Say 'archivo: sessions.db NO EXISTE (ya borrado o ruta distinta)'
}
if ($proc) {
    Say ("serve:   pid {0} {1} en :{2}" -f $proc.ProcessId, $proc.Name, $Port)
} else {
    Say "serve:   nadie escuchando en :$Port"
}
if (Test-Path $DbPath) {
    if (Test-DbLocked) { Say 'lock:    sessions.db TOMADO -> del /f /s /q fallaria con Acceso denegado' }
    else               { Say 'lock:    sessions.db abrible en exclusiva' }
}
$bk = Get-ChildItem $BackupDir -Filter 'sessions.db.bak-*' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending
if ($bk) {
    Say ("backups: {0} copia(s); la mas nueva {1} ({2:N1} MB, {3})" -f `
        $bk.Count, $bk[0].Name, ($bk[0].Length/1MB), $bk[0].LastWriteTime)
} else {
    Say 'backups: ninguno en C:\Users\Emiliano\backups\sessions'
}

if (-not $Apply) {
    Say 'dry-run: nada modificado. -Apply para ejecutar, -Apply -Detached para agendar.'
    return
}

# --- apply -------------------------------------------------------------------
Say '=== APPLY ==='

if (-not (Test-OpsLockFree -Owner 'wipe')) {
    $otro = Get-OpsLock
    Say "ABORTO: hay otra operacion en curso ($($otro.owner), pid $($otro.pid), desde $($otro.started))."
    Say 'esperá a que termine o borrá core\state\ops.lock si quedó huérfano (más de 30 min).'
    return
}
Set-OpsLock -Owner 'wipe'

$exe  = $null
$args = $null
if ($proc) {
    $exe = $proc.ExecutablePath
    # CommandLine viene con el exe entre comillas al principio; el resto son los argumentos crudos.
    $cl  = $proc.CommandLine
    $args = $cl.Substring($cl.IndexOf('"', 1) + 1).Trim()
    Say "restart target: $exe"
    Say "restart args:   $args"
}

if (-not $NoBackup -and (Test-Path $DbPath)) {
    New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
    $bak = Join-Path $BackupDir "sessions.db.bak-wipe-$Stamp"
    Say "backup en frio -> $bak"
    Copy-Item -LiteralPath $DbPath -Destination $bak -Force
    foreach ($sfx in @('-wal','-shm')) {
        if (Test-Path "$DbPath$sfx") { Copy-Item -LiteralPath "$DbPath$sfx" -Destination "$bak$sfx" -Force }
    }
    Say ("backup listo: {0:N1} MB" -f ((Get-Item $bak).Length/1MB))
}

if ($proc) {
    Say "stop serve pid $($proc.ProcessId)"
    Stop-Process -Id $proc.ProcessId -Force
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 400
    }
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
        Say 'ERROR: el puerto sigue escuchando; aborto sin borrar nada.'
        return
    }
    Say 'puerto libre'
}


$victims = Get-ChildItem $StoreDir -Force -ErrorAction SilentlyContinue
foreach ($f in $victims) {
    Say "del $($f.Name) ($([math]::Round($f.Length/1MB,1)) MB)"
    Remove-Item -LiteralPath $f.FullName -Force
}
Say "store dir vaciado: $((Get-ChildItem $StoreDir -Force -ErrorAction SilentlyContinue | Measure-Object).Count) archivo(s) restantes"

if ($KeepBackups -gt 0) {
    $old = Get-ChildItem $BackupDir -Filter 'sessions.db.bak-*' -ErrorAction SilentlyContinue |
           Where-Object { $_.Name -match '\.bak-(prune|wipe)-' } |
           Sort-Object LastWriteTime -Descending | Select-Object -Skip $KeepBackups
    foreach ($o in $old) {
        Say "retencion: borro $($o.Name)"
        Remove-Item -LiteralPath $o.FullName -Force -ErrorAction SilentlyContinue
    }
}

# El wipe apaga el serve para poder borrar el store: tiene que volver a levantarlo, o el puerto queda
# muerto sin que nadie se entere (paso el 2026-10-27 05:05 y costo seis horas de backend abajo).
Clear-OpsLock
if ($exe -and -not $NoRestart) {
    Say "restart: $exe"
    $bootArgs = if ($args) { $args } else { '' }
    Start-Process -FilePath $exe -ArgumentList $bootArgs -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds(40)
    $up = $false
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        try {
            if ((Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200) { $up = $true; break }
        } catch { }
    }
    if ($up) { Say 'serve arriba otra vez (health 200)' } else { Say 'ERROR: el serve no respondio despues del wipe; levantalo a mano' }
} else {
    Say 'sin restart (no habia serve previo o se pidio -NoRestart)'
}

if ($exe) {
    Say "start $exe"
    Start-Process -FilePath $exe -ArgumentList $args -WindowStyle Hidden | Out-Null
    $ok = $false
    $deadline = (Get-Date).AddSeconds(150)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3 -UseBasicParsing
            if ($r.StatusCode -eq 200) { $ok = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 700
    }
    if ($ok) { Say 'health 200' } else { Say 'AVISO: /health no respondio en 150 s' }
} else {
    Say 'sin serve previo: no arranco nada'
}

$after = Get-StoreStats
if ($after) { Say ("store nuevo: {0} MB | {1}" -f $after.TotalMB, $after.Files) }
else        { Say 'store nuevo: todavia sin archivo (el serve lo crea al primer uso)' }
Say 'FIN'

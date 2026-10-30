# Build parametrizado del serve. Reemplaza build-safe.ps1 + build-vNN.bat/ps1 (las copias por version).
# Uso: build.ps1 -Tag v35 [-Features ...] [-SkipIdleGate] [-KeepSccache]
# 2026-10-22: la feature `code-mode` ya no existe en aegis-server ni en aegis; el default
# es el mismo que declara crates/aegis-server/Cargo.toml.
# Deja el binario en C:\Aegis-Proyects\core\bin\aegis-<Tag>.exe y anota core\state\last-build.json.
# NO toca el puntero: promover es tarea de swap.ps1 (separar construir de desplegar evita el acoplamiento).
# 2026-10-19: el origen es C:\Aegis-Proyects\target\debug (CARGO_TARGET_DIR), NO src\target (fosil).
param(
  [Parameter(Mandatory=$true)][string]$Tag,
  [string]$Features = 'rustls-tls,scheduler,bundled-mcp,chat-recall,acp-http',
  [int]$IdleSeconds = 60,
  [ValidateSet('debug','release')][string]$Profile = 'debug',
  [switch]$SkipIdleGate,
  [switch]$KeepSccache
)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_pointer.ps1')
$repo = 'C:\Aegis-Proyects\src'
$cargoDebug = if ($Profile -eq 'release') { 'C:\Aegis-Proyects\target\release' } else { 'C:\Aegis-Proyects\target\debug' }
[string[]]$cargoProfileArgs = @()
if ($Profile -eq 'release') { $cargoProfileArgs = @('--release') }
$cargoPackage = 'aegis-server'
$cargoBin = 'aegis-serve'
$cargoExe = Join-Path $cargoDebug 'aegis-serve.exe'
$pathRoot = if ($env:AEGIS_PATH_ROOT) { $env:AEGIS_PATH_ROOT } else { 'C:\Aegis-Proyects\state' }
$logDir = Join-Path $AegisRoot 'logs\build'
if ($Tag -notmatch '^v\d+$') { throw "Tag invalido: '$Tag' (formato vNN)" }
$log = Join-Path $logDir ('build-' + $Tag + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
$out = Join-Path $BinDir ('aegis-' + $Tag + '.exe')
$cfg = 'C:\Users\Emiliano\.cargo\config.toml'
New-Item -ItemType Directory -Force $logDir, $BinDir | Out-Null
function W($m) { $m; $m | Out-File -FilePath $log -Append -Encoding utf8 }

# Actividad real del modelo: logs de request (state\state\logs) y WAL del store (state\data\sessions).
# La ruta %APPDATA%\Aegis que usaba antes no existe desde la migracion del 15/10, asi que el gate
# daba siempre "idle" y un build podia arrancar en medio de un turno.
function Last-ModelWrite {
  $candidates = @()
  $logsDir = Join-Path $pathRoot 'state\logs'
  $f = Get-ChildItem -Path (Join-Path $logsDir 'llm_request.*.jsonl') -ErrorAction SilentlyContinue |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($f) { $candidates += $f.LastWriteTime }
  $wal = Get-Item (Join-Path $pathRoot 'data\sessions\sessions.db-wal') -ErrorAction SilentlyContinue
  if ($wal) { $candidates += $wal.LastWriteTime }
  if ($candidates.Count -eq 0) { return (Get-Date).AddDays(-1) }
  return ($candidates | Sort-Object -Descending | Select-Object -First 1)
}

if (-not $SkipIdleGate) {
  $deadline = (Get-Date).AddMinutes(20)
  while ((Last-ModelWrite) -gt (Get-Date).AddSeconds(-$IdleSeconds)) {
    if ((Get-Date) -gt $deadline) { W 'IDLE_GATE_TIMEOUT'; break }
    W ('esperando a que el modelo este quieto: ultima actividad ' + (Last-ModelWrite).ToString('HH:mm:ss'))
    Start-Sleep -Seconds 15
  }
}

$inUse = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -eq $out }
if ($inUse) { W ('VERSION_IN_USE: ' + $out + ' pid ' + ($inUse.ProcessId -join ',')); exit 1 }
Remove-Item $out -Force -ErrorAction SilentlyContinue
if (Test-Path $out) { W 'VERSION_LOCKED: no se pudo borrar el destino'; exit 1 }

Copy-Item $cfg ($cfg + '.bak-build') -Force
try {
  if (-not $KeepSccache) {
    (Get-Content $cfg) -replace '^rustc-wrapper', '#rustc-wrapper' | Set-Content $cfg
    $env:RUSTC_WRAPPER = ''; $env:CARGO_BUILD_RUSTC_WRAPPER = ''
  }
  Set-Location $repo
  $cargoArgs = [string[]](@('build','-p',$cargoPackage,'--bin',$cargoBin,'--no-default-features','--features',$Features) + $cargoProfileArgs)
  # El log se escribe linea por linea con FileShare.Read: con Set-Content el archivo quedaba
  # bloqueado en exclusiva y sin contenido durante todo el build, asi que no habia forma de ver
  # progreso hasta que cargo terminaba (un release son 12-25 min de ceguera total).
  # UTF8 explicito: el `>` de PS 5.1 escribia UTF-16 y los lectores veian NUL intercalados.
  $utf8sinBom = New-Object System.Text.UTF8Encoding($false)
  & cargo @cargoArgs 2>&1 | ForEach-Object {
    $linea = [string]$_
    $linea
    [System.IO.File]::AppendAllText($log, $linea + "`r`n", $utf8sinBom)
  }
  $code = $LASTEXITCODE

  W ('EXITCODE=' + $code)
  if ($code -ne 0) { W 'BUILD_FAILED: no se copia nada'; exit 1 }
} finally {
  Copy-Item ($cfg + '.bak-build') $cfg -Force
  Remove-Item ($cfg + '.bak-build') -Force -ErrorAction SilentlyContinue
}

# El binario tiene que ser MAS NUEVO que el ultimo desplegado; si no, el build escribio en otro
# target y el origen es un fosil. (La comparacion de hash sola no lo detecta: copia y origen
# coinciden siempre despues del copy.)
if (-not (Test-Path $cargoExe)) { W ('NO_SOURCE: no existe ' + $cargoExe); exit 1 }
$prev = Get-ChildItem $BinDir -Filter 'aegis-v*.exe' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($prev -and (Get-Item $cargoExe).LastWriteTime -lt $prev.LastWriteTime) {
  W ('STALE_SOURCE: ' + $cargoExe + ' (' + (Get-Item $cargoExe).LastWriteTime + ') es mas viejo que ' + $prev.Name + ' (' + $prev.LastWriteTime + ')')
  W ('Build dirigido a otro target? CARGO_TARGET_DIR=' + $env:CARGO_TARGET_DIR)
  exit 1
}

Copy-Item $cargoExe $out -Force
$s = (Get-FileHash $cargoExe -Algorithm SHA256).Hash
$d = (Get-FileHash $out -Algorithm SHA256).Hash
if ($s -ne $d) { W ('COPY_FAILED: origen ' + $s.Substring(0,16) + ' destino ' + $d.Substring(0,16)); exit 1 }
$i = Get-Item $out
$ver = (& $out --version 2>&1) -join ' '
$commit = ''
try { $commit = (git -C $repo rev-parse --short HEAD 2>$null) } catch {}
# Procedencia: el binario puede venir de un arbol sucio. dirty dice si lo estaba y diffSha es el
# commit que git sintetiza del arbol (git stash create: no toca worktree ni index), asi el arbol
# exacto queda recuperable aunque nadie lo haya commiteado.
$dirty = $false
$diffSha = $null
try {
  $porcelain = (git -C $repo status --porcelain 2>$null | Out-String).Trim()
  $dirty = [bool]$porcelain
  if ($dirty) { $stash = (git -C $repo stash create 2>$null | Out-String).Trim(); if ($stash) { $diffSha = $stash } }
} catch {}
$obj = [ordered]@{ tag=$Tag; exe=$out; commit=$commit; headCommit=$commit; dirty=$dirty; diffSha=$diffSha;
                   profile=$Profile; sha256=$s; version=$ver; features=$Features;
                   bytes=$i.Length; built_at=(Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz') }
($obj | ConvertTo-Json) | Set-Content -Path (Join-Path $AegisRoot 'state\last-build.json') -Encoding UTF8
W ('BUILD_OK ' + $out + ' sha256=' + $s.Substring(0,16) + ' ' + $ver)
W ('promover con: powershell -File C:\Aegis-Proyects\core\ops\swap.ps1 -Tag ' + $Tag)

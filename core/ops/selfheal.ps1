# Sanador del harness: si el gate funcional da rojo dos veces seguidas, devuelve el DESPLIEGUE
# (puntero, binario, web\, state\config\) a la ultima foto sana. Nunca toca src\: el codigo fuente
# es del operador y una reversion ahi borraria el trabajo en curso. Todo lo que pisa se copia a
# core\state\quarantine\<ts>\ antes de pisarlo.
# Uso:  selfheal.ps1                 (lo que corre la tarea programada)
#       selfheal.ps1 -DryRun         (mide y decide, no escribe nada)
#       selfheal.ps1 -Force          (saltea la racha: intenta curar en el acto)
param(
  [int]$RedThreshold  = 2,      # rojos consecutivos antes de curar
  [int]$IdleSeconds   = 30,     # quietud del modelo para considerarlo inactivo
  [int]$IdleTimeoutSecs = 120,  # espera maxima por quietud antes de curar igual
  [int]$PostRestartWaitSecs = 25,
  [switch]$DryRun,
  [switch]$Force,
  [switch]$FilesOnly            # repone archivos y puntero pero no toca procesos (pruebas)
)
$ErrorActionPreference = 'Continue'
$root  = 'C:\Aegis-Proyects'
$core  = Join-Path $root 'core'
$web   = Join-Path $root 'web'
$stateDir = Join-Path $core 'state'
$goodDir  = Join-Path $stateDir 'good'
$healLog  = Join-Path $stateDir 'heal.log'
$streakFile = Join-Path $stateDir 'heal-streak.json'
$statusFile = Join-Path $stateDir 'heal-status.json'
$healthFile = Join-Path $stateDir 'health.json'
$quarantineRoot = Join-Path $stateDir 'quarantine'

function Log([string]$m) {
  $line = (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz') + '  ' + $m
  # Write-Host y no Write-Output: el pipeline de este script se usa para devolver valores
  # (rutas, resultados) y un log por Write-Output contamina esos returns.
  Write-Host $line
  try {
    if ((Test-Path $healLog) -and ((Get-Item $healLog).Length -gt 1MB)) { Move-Item $healLog ($healLog + '.old') -Force }
    Add-Content -Path $healLog -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
  } catch {}
}

function Write-Status($obj) {
  try {
    $tmp = $statusFile + '.tmp'
    ($obj | ConvertTo-Json -Depth 5) | Set-Content -Path $tmp -Encoding UTF8
    Move-Item $tmp $statusFile -Force
  } catch {}
}

# Una sola instancia. Dos sanadores a la vez se pelean por el puerto y por la foto.
$mutex = New-Object System.Threading.Mutex($false, 'Global\AegisSelfHeal')
$gotLock = $false
try { $gotLock = $mutex.WaitOne(0) } catch { $gotLock = $false }
if (-not $gotLock) { Log 'otra instancia del sanador sigue corriendo; salgo sin hacer nada'; exit 0 }

# Actividad real del modelo (mismo criterio que swap.ps1 y build.ps1): logs de request + WAL del store.
function Get-LastModelWrite {
  $pathRoot = if ($env:AEGIS_PATH_ROOT) { $env:AEGIS_PATH_ROOT } else { 'C:\Aegis-Proyects\state' }
  $stamps = @()
  $f = Get-ChildItem -Path (Join-Path $pathRoot 'state\logs\llm_request.*.jsonl') -ErrorAction SilentlyContinue |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($f) { $stamps += $f.LastWriteTime }
  $wal = Get-Item (Join-Path $pathRoot 'data\sessions\sessions.db-wal') -ErrorAction SilentlyContinue
  if ($wal) { $stamps += $wal.LastWriteTime }
  if ($stamps.Count -eq 0) { return (Get-Date).AddDays(-1) }
  return ($stamps | Sort-Object -Descending | Select-Object -First 1)
}

# Nunca matar un turno en curso. Si no hay quietud en IdleTimeoutSecs se cura igual: un harness
# roto tampoco sirve para trabajar.
function Wait-Idle {
  $deadline = (Get-Date).AddSeconds($IdleTimeoutSecs)
  while ((Get-LastModelWrite) -gt (Get-Date).AddSeconds(-$IdleSeconds)) {
    if ((Get-Date) -gt $deadline) { Log ('idle: techo de ' + $IdleTimeoutSecs + 's vencido, sigo igual'); return }
    Log ('esperando turno en curso (ultima actividad ' + (Get-LastModelWrite).ToString('HH:mm:ss') + ')')
    Start-Sleep -Seconds 5
  }
}

function Get-PortOwner([int]$port) {
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $c) { return $null }
  return $c.OwningProcess
}

function Start-Harness {
  # El launcher es idempotente: arranca lo que falte y respeta lo que ya escucha.
  $launcher = Join-Path $web 'scripts\start-aegis-web.ps1'
  if (-not (Test-Path $launcher)) { Log ('no existe el launcher: ' + $launcher); return }
  & powershell -NoProfile -ExecutionPolicy Bypass -File $launcher 2>&1 | ForEach-Object { Log ('  launcher> ' + $_) }
}

function Get-LivePointer {
  $p = Join-Path $stateDir 'current-version.json'
  if (-not (Test-Path $p)) { return $null }
  try { return (Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

function Save-GitAutosave {
  # Red de seguridad antes de pisar web\: el arbol sucio queda en un ref durable.
  # git stash create NO incluye archivos sin trackear; esos quedan en la cuarentena (copia fisica).
  $repo = 'C:\Aegis-Proyects'
  try {
    $dirty = (git -C $repo status --porcelain -- web/ 2>$null | Out-String).Trim()
    if (-not $dirty) { Log 'autosave: web\ esta limpio en git'; return }
    # stash create mira el repo completo: solo crear el ref si no hay cambios ajenos a web/.
    $outside = (git -C $repo status --porcelain -- . ':(exclude)web/' 2>$null | Out-String).Trim()
    if ($outside) { Log 'autosave: cambios fuera de web; usar cuarentena fisica, sin stash global'; return }
    $sha = (git -C $repo stash create 2>$null | Out-String).Trim()
    if (-not $sha) { Log 'autosave: git stash create no devolvio sha'; return }
    $ref = 'refs/autosave/heal-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
    git -C $repo update-ref $ref $sha 2>$null | Out-Null
    Log ('autosave: arbol sucio de web\ guardado en ' + $ref + ' (' + $sha.Substring(0,8) + ')')
  } catch { Log ('autosave fallo: ' + $_.Exception.Message) }
}

function Save-Quarantine([string]$why) {
  $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
  $q = Join-Path $quarantineRoot $ts
  New-Item -ItemType Directory -Force $q | Out-Null
  $webSkip = @('node_modules', 'logs', 'outbox', '.git')
  foreach ($item in @('server.mjs', 'config.json', 'prices.json', 'package.json', 'app', 'src', 'dist-ts', 'scripts', 'tools')) {
    $srcPath = Join-Path $web $item
    if (-not (Test-Path $srcPath)) { continue }
    $dst = Join-Path $q ('web\' + $item)
    New-Item -ItemType Directory -Force (Split-Path $dst -Parent) | Out-Null
    if ((Get-Item $srcPath).PSIsContainer) {
      & robocopy $srcPath $dst /E /NFL /NDL /NJH /NJS /NP /XD $webSkip /XF '*.log' | Out-Null
    } else { Copy-Item $srcPath $dst -Force }
  }
  foreach ($item in @('config.yaml', 'permission.yaml', 'secrets.yaml', 'operador-perfil.md', 'prompts', 'skills', 'custom_providers')) {
    $srcPath = Join-Path (Join-Path $root 'state\config') $item
    if (-not (Test-Path $srcPath)) { continue }
    $dst = Join-Path $q ('config\' + $item)
    if ((Get-Item $srcPath).PSIsContainer) {
      New-Item -ItemType Directory -Force $dst | Out-Null
      & robocopy $srcPath $dst /E /NFL /NDL /NJH /NJS /NP /XF '*.lock' '*.bak-*' | Out-Null
    } else {
      New-Item -ItemType Directory -Force (Split-Path $dst -Parent) | Out-Null
      Copy-Item $srcPath $dst -Force
    }
  }
  Copy-Item (Join-Path $stateDir 'current-version.json') (Join-Path $q 'current-version.json') -Force -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $stateDir 'last-build.json') (Join-Path $q 'last-build.json') -Force -ErrorAction SilentlyContinue
  'motivo: ' + $why + "`r`n" + 'cuando: ' + (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz') +
    "`r`n" + 'este directorio es lo que el desplegable TENIA antes del saneamiento. Nada se borro.' |
    Set-Content -Path (Join-Path $q 'README.txt') -Encoding UTF8
  Log ('cuarentena: ' + $q + ' (' + $why + ')')
  return $q
}

function Read-Manifest([string]$dir) {
  $mf = Join-Path $dir 'manifest.json'
  if (-not (Test-Path $mf)) { return $null }
  try { return (Get-Content $mf -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

function Restore-Files([string]$photoDir, $mf, [string]$why) {
  # Copia solo lo que difiere del manifest: si un archivo coincide en sha256 no se toca.
  $restored = 0
  foreach ($f in $mf.files) {
    $rel = [string]$f.path
    if ($rel -like 'current-version.json' -or $rel -like 'last-build.json' -or $rel -like 'manifest.json') { continue }
    $src = Join-Path $photoDir ($rel -replace '/', '\')
    if (-not (Test-Path $src)) { continue }
    if ($rel -like 'bin/*') { continue }   # el binario se maneja aparte (puede estar en uso)
    if ($rel -like 'web/*')  { $dst = Join-Path $web ($rel.Substring(4) -replace '/', '\') }
    elseif ($rel -like 'config/*') { $dst = Join-Path (Join-Path $root 'state\config') ($rel.Substring(7) -replace '/', '\') }
    else { continue }
    $needCopy = $true
    if (Test-Path $dst) {
      try { if ((Get-FileHash $dst -Algorithm SHA256).Hash -eq $f.sha256) { $needCopy = $false } } catch {}
    }
    if ($needCopy) {
      New-Item -ItemType Directory -Force (Split-Path $dst -Parent) | Out-Null
      try { Copy-Item $src $dst -Force -ErrorAction Stop; $restored++ }
      catch { Log ('  no se pudo reponer ' + $rel + ': ' + $_.Exception.Message) }
    }
  }
  if (-not $DryRun) { Log ('  archivos repuestos: ' + $restored) }
  return $restored
}

function Restore-Binary($mf, [string]$photoDir) {
  $binName = Split-Path ([string]$mf.exe) -Leaf
  $photoBin = Join-Path (Join-Path $photoDir 'bin') $binName
  if (-not (Test-Path $photoBin)) { Log ('  la foto no tiene el binario ' + $binName); return $null }
  $dst = Join-Path (Join-Path $core 'bin') $binName
  # Si el binario desplegado ya es el de la foto, no se toca: copiarlo mientras corre es lo que
  # generaba copias -healNNNNNN.exe y dejaba el puntero apuntando a un nombre raro.
  if (Test-Path $dst) {
    try {
      if ((Get-FileHash $dst -Algorithm SHA256).Hash -eq [string]$mf.exe_sha) {
        Log ('  el binario ' + $binName + ' ya coincide con la foto; no se copia')
        return $dst
      }
    } catch {}
  }
  try {
    Copy-Item $photoBin $dst -Force -ErrorAction Stop
  } catch {
    # binario en uso y distinto: se despliega con otro nombre y el puntero apunta ahi
    $alt = $binName -replace '\.exe$', ('-heal' + (Get-Date -Format 'HHmmss') + '.exe')
    $dst = Join-Path (Join-Path $core 'bin') $alt
    Copy-Item $photoBin $dst -Force -ErrorAction Stop
    Log ('  binario en uso; se desplego como ' + $alt)
  }
  $sha = (Get-FileHash $dst -Algorithm SHA256).Hash
  if ($sha -ne $mf.exe_sha) { Log ('  AVISO: el sha restaurado no coincide con el manifest (' + $sha.Substring(0,16) + ')'); }
  return $dst
}

function Set-PointerTo([string]$exe, $mf) {
  . (Join-Path $core 'ops\_pointer.ps1')
  try {
    $obj = Set-AegisCurrent -Exe $exe -Tag ([string]$mf.tag) -Features ([string]$mf.features) -SetBy 'selfheal'
    Log ('  puntero -> ' + $obj.exe + ' (' + $obj.tag + ', sha ' + $obj.sha256.Substring(0,16) + ')')
    return $true
  } catch { Log ('  no se pudo escribir el puntero: ' + $_.Exception.Message); return $false }
}

function Stop-Port([int]$port, [int]$retries = 12) {
  $killed = $false
  for ($i = 0; $i -lt $retries; $i++) {
    $owner = Get-PortOwner $port
    if (-not $owner) { if ($killed) { Log ('  puerto ' + $port + ' liberado') }; return $true }
    if (-not $killed) { Log ('  deteniendo pid ' + $owner + ' del puerto ' + $port); $killed = $true }
    if ($i -ge 6) {
      # segundas vueltas: si TaskKill no pudo, el proceso cambio de pid o esta en un estado raro
      try { & taskkill /PID $owner /T /F 2>&1 | Out-Null } catch {}
    } else {
      try { Stop-Process -Id $owner -Force -ErrorAction Stop } catch { try { & taskkill /PID $owner /T /F 2>&1 | Out-Null } catch {} }
    }
    Start-Sleep -Seconds 2
  }
  return (-not (Get-PortOwner $port))
}

function Wait-Port([int]$port, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (Get-PortOwner $port) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

function Get-DeployFingerprint {
  # Huella barata del despliegue: puntero + mtime del arbol web + config. No hashea 600 archivos
  # en cada pasada (eso costaria segundos cada 3 minutos).
  $stamps = @()
  $ptr = Join-Path $stateDir 'current-version.json'
  if (Test-Path $ptr) { $stamps += (Get-Item $ptr).LastWriteTime }
  foreach ($p in @('server.mjs', 'config.json', 'app', 'src', 'dist-ts')) {
    $full = Join-Path $web $p
    if (-not (Test-Path $full)) { continue }
    if ((Get-Item $full).PSIsContainer) {
      $newest = Get-ChildItem $full -Recurse -File -ErrorAction SilentlyContinue |
                Where-Object { $_.Extension -in @('.js', '.css', '.html', '.mjs', '.json') } |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
      if ($newest) { $stamps += $newest.LastWriteTime }
    } else { $stamps += (Get-Item $full).LastWriteTime }
  }
  foreach ($p in @('config.yaml', 'permission.yaml')) {
    $full = Join-Path (Join-Path $root 'state\config') $p
    if (Test-Path $full) { $stamps += (Get-Item $full).LastWriteTime }
  }
  if ($stamps.Count -eq 0) { return '' }
  return (($stamps | Sort-Object -Descending | Select-Object -First 1)).ToString('yyyy-MM-ddTHH:mm:ss')
}

function Prune-HealBinaries {
  # Copias -healNNNNNN.exe que dejo un saneo mientras el binario estaba en uso. Se borra todo
  # menos el que apunta el puntero; si nada las limpia, cada saneo deja 146 MB.
  $live = (Get-LivePointer)
  $livePath = ''
  if ($live) { $livePath = [string]$live.exe }
  Get-ChildItem (Join-Path $core 'bin') -Filter 'aegis-*-heal*.exe' -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.FullName -ne $livePath) {
      try { Remove-Item $_.FullName -Force -ErrorAction Stop; Log ('  podado: ' + $_.Name) } catch {}
    }
  }
}

function Invoke-Gate([switch]$Deep) {
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $core 'ops\health-gate.ps1'))
  if ($Deep) { $a += '-Deep' }
  $out = & powershell @a 2>&1 | Out-String
  return @{ code = [int]$LASTEXITCODE; out = $out }
}

function Read-Health {
  if (-not (Test-Path $healthFile)) { return $null }
  try { return (Get-Content $healthFile -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

function Reset-Streak {
  Remove-Item $streakFile -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------- 1. estado actual
$h = Read-Health
$stale = $true
if ($h -and $h.at) { try { $stale = ((Get-Date) - [datetime]::Parse([string]$h.at)).TotalMinutes -gt 6 } catch {} }
# sin nadie escuchando en 3284 no se negocia: se mide en el acto
if (-not (Get-PortOwner 3284)) { $stale = $true }
if ($stale) {
  $g = Invoke-Gate
  $h = Read-Health
  if ($h) { Log ('gate fresco: ' + $h.overall + ' [' + (@($h.reasons) -join ',') + ']') }
  else { Log 'gate no escribio health.json'; $h = [pscustomobject]@{ overall = 'roto'; reasons = @('sin-health') } }
} else {
  Log ('gate reciente (' + $h.at + '): ' + $h.overall + ' [' + (@($h.reasons) -join ',') + ']')
}

$reasons = @($h.reasons) -join ','
$overall = [string]$h.overall

# ---------------------------------------------------------------- 2. sano
if ($overall -eq 'sano') {
  Reset-Streak
  $published = $false
  if (Test-Path (Join-Path $goodDir 'staging')) {
    $pub = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $core 'ops\snapshot-good.ps1') -PublishDue 2>&1 | Out-String
    foreach ($l in ($pub -split "`r?`n")) { if ($l.Trim()) { Log ('  snapshot> ' + $l.Trim()) } }
    $published = ($LASTEXITCODE -eq 0)
  }
  # sin foto vigente no hay red de seguridad: armarla ya
  if (-not (Test-Path (Join-Path $goodDir 'current'))) {
    $snap = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $core 'ops\snapshot-good.ps1') -Force 2>&1 | Out-String
    foreach ($l in ($snap -split "`r?`n")) { if ($l.Trim()) { Log ('  snapshot> ' + $l.Trim()) } }
  } elseif (-not (Test-Path (Join-Path $goodDir 'staging'))) {
    # Hay una foto vigente y no hay staging: si el despliegue cambio (frontend tocado, puntero
    # movido, config editada), se arma una foto nueva que se publica sola cuando la gracia vence.
    $fp = Get-DeployFingerprint
    $curPhoto = Read-Manifest (Join-Path $goodDir 'current')
    $publishedAt = ''
    if ($curPhoto) { $publishedAt = ([string]$curPhoto.published_at) -replace '\+.*$', '' ; $publishedAt = $publishedAt.Substring(0, [Math]::Min(19, $publishedAt.Length)) }
    if ($fp -and $publishedAt -and ([string]$fp -gt [string]$publishedAt)) {
      Log ('despliegue cambio desde la foto (' + $publishedAt + ' -> ' + $fp + '): armo foto nueva')
      $snap = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $core 'ops\snapshot-good.ps1') 2>&1 | Out-String
      foreach ($l in ($snap -split "`r?`n")) { if ($l.Trim()) { Log ('  snapshot> ' + $l.Trim()) } }
    }
  }
  Write-Status ([ordered]@{ at = (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'); overall = 'sano'; action = 'none';
                            published = $published; reasons = @(); attempts = 0 })
  exit 0
}

# degradado no se cura: puerto arriba con el provider lento o un asset faltante no se arregla
# reiniciando, y un reinicio a ciegas asusta mas de lo que ayuda.
if ($overall -eq 'degradado') {
  Log ('degradado [' + $reasons + ']: no se sanea, se vigila')
  Write-Status ([ordered]@{ at = (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'); overall = 'degradado'; action = 'watch'; reasons = @($reasons); attempts = 0 })
  exit 0
}

# ---------------------------------------------------------------- 3. roto: racha
$streak = [ordered]@{ red = 0; since = $null; last_attempt = $null; attempts = 0 }
if (Test-Path $streakFile) {
  try {
    $old = Get-Content $streakFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($old.red) { $streak.red = [int]$old.red }
    $streak.since = $old.since
    $streak.last_attempt = $old.last_attempt
    if ($old.attempts) { $streak.attempts = [int]$old.attempts }
  } catch {}
}
$streak.red = $streak.red + 1
if (-not $streak.since) { $streak.since = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz') }
Log ('roto [' + $reasons + ']: racha ' + $streak.red + '/' + $RedThreshold)

if ($streak.red -lt $RedThreshold -and -not $Force -and -not $DryRun) {
  try { ($streak | ConvertTo-Json) | Set-Content $streakFile -Encoding UTF8 } catch {}
  Write-Status ([ordered]@{ at = (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'); overall = 'roto'; action = 'wait';
                            reasons = @($reasons); red = $streak.red; attempts = $streak.attempts })
  exit 1
}

# cooldown: si el ultimo intento fue hace menos de 5 minutos, no se vuelve a pelear
if ($streak.last_attempt -and -not $Force -and -not $DryRun) {
  $mins = ((Get-Date) - [datetime]::Parse([string]$streak.last_attempt)).TotalMinutes
  if ($mins -lt 5) {
    Log ('cooldown: ultimo intento hace ' + [int]$mins + ' min; espero')
    Write-Status ([ordered]@{ at = (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'); overall = 'roto'; action = 'cooldown';
                              reasons = @($reasons); red = $streak.red; attempts = $streak.attempts })
    exit 1
  }
}

# ---------------------------------------------------------------- 4. sanear
$candidates = @()
if (Test-Path (Join-Path $goodDir 'current')) { $candidates += (Join-Path $goodDir 'current') }
if (Test-Path (Join-Path $goodDir 'prev'))    { $candidates += (Join-Path $goodDir 'prev') }
if ($candidates.Count -eq 0) {
  Log 'NO_HAY_FOTO: hay roto y no existe ninguna foto sana; no se puede sanar solo'
  Write-Status ([ordered]@{ at = (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'); overall = 'roto'; action = 'no-photo';
                            reasons = @($reasons) })
  exit 3
}

Log ('SANEANDO: motivo [' + $reasons + '] fotos disponibles ' + $candidates.Count)
if ($DryRun) {
  foreach ($c in $candidates) {
    $mf = Read-Manifest $c
    Log ('  DryRun: usaria ' + $c + ' (' + $mf.tag + ' sha ' + $mf.exe_sha.Substring(0,16) + ', ' + @($mf.files).Count + ' archivos, publicada ' + $mf.published_at + ')')
  }
  Write-Status ([ordered]@{ at = (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'); overall = 'roto'; action = 'dry-run';
                            reasons = @($reasons); photos = $candidates.Count })
  exit 0
}

if (-not $DryRun) { Save-GitAutosave }
$q = $null
$healed = $false
$healedWith = $null
foreach ($photo in $candidates) {
  $mf = Read-Manifest $photo
  if (-not $mf) { Log ('  foto sin manifest: ' + $photo); continue }
  Log ('  intento con ' + $photo + ' (' + $mf.tag + ', publicada ' + $mf.published_at + ')')
  if (-not $q) { $q = Save-Quarantine $reasons }
  $exe = Restore-Binary $mf $photo
  if (-not $exe) { Log '  sin binario en la foto, sigo con la siguiente'; continue }
  [void](Restore-Files $photo $mf $reasons)
  if (-not (Set-PointerTo $exe $mf)) { continue }
  if ($FilesOnly) {
    Log '  -FilesOnly: no reinicio nada; mido como esta'
    $g0 = Invoke-Gate
    Log ('  gate post-restore (sin reinicio): exit ' + $g0.code)
    if ($g0.code -eq 0) { $healed = $true; $healedWith = $photo; break }
    continue
  }
  Wait-Idle
  # reinicio: 3284 y 3788 (el launcher arranca los dos)
  [void](Stop-Port 3284)
  [void](Stop-Port 3788)
  Start-Harness
  $serveUp = Wait-Port 3284 90
  $webUp = Wait-Port 3788 60
  Log ('  puertos: serve=' + $serveUp + ' web=' + $webUp)
  Start-Sleep -Seconds $PostRestartWaitSecs
  $g = Invoke-Gate -Deep
  Log ('  gate post-saneo: exit ' + $g.code)
  if ($g.code -eq 0) { $healed = $true; $healedWith = $photo; break }
  Log '  la foto no levanto sano; escalo a la anterior'
}

$now = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
if ($healed) {
  Reset-Streak
  Prune-HealBinaries
  Log ('SANEADO con ' + $healedWith + '; el harness vuelve a estar sano. Cuarentena: ' + $q)
  Write-Status ([ordered]@{ at = $now; overall = 'sano'; action = 'healed'; photo = $healedWith;
                            quarantine = $q; reasons = @($reasons); healed = $true })
  exit 0
}

$streak.last_attempt = $now
$streak.attempts = $streak.attempts + 1
try { ($streak | ConvertTo-Json) | Set-Content $streakFile -Encoding UTF8 } catch {}
Log 'NO_SE_PUDO_SANEAR: ninguna foto levanto sana. Requiere intervencion manual (heal.log tiene el detalle)'
Write-Status ([ordered]@{ at = $now; overall = 'roto'; action = 'failed'; reasons = @($reasons);
                          quarantine = $q; attempts = $streak.attempts; healed = $false })
exit 4



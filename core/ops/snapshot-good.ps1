# Foto del "ultimo estado sano" del despliegue: puntero + binario + web\ + state\config\.
# NO toca src\: el codigo fuente es del operador, no del sanador.
# Uso:  snapshot-good.ps1                 (arma el staging y, si el gate esta sano 2 veces, publica)
#       snapshot-good.ps1 -Force          (publica ya, sin esperar la ventana de gracia)
#       snapshot-good.ps1 -PublishDue     (solo promueve un staging pendiente; lo usa selfheal)
# Layout: <StateDir>\good\current  = foto sana vigente
#         <StateDir>\good\prev     = foto sana anterior (un solo nivel de rollback)
#         <StateDir>\good\staging  = foto en cuarentena de tiempo, todavia no publicada
param(
  [string]$WebRoot  = 'C:\Aegis-Proyects\web',
  [string]$StateDir = 'C:\Aegis-Proyects\core\state',
  [switch]$Force,
  [switch]$PublishDue,
  [int]$GraceMinutes = 10
)
$ErrorActionPreference = 'Continue'
$core = 'C:\Aegis-Proyects\core'
. (Join-Path $PSScriptRoot '_pointer.ps1')

$goodDir    = Join-Path $StateDir 'good'
$currentDir = Join-Path $goodDir 'current'
$prevDir    = Join-Path $goodDir 'prev'
$stageDir   = Join-Path $goodDir 'staging'
$logFile    = Join-Path $StateDir 'snapshot.log'

function Log([string]$m) {
  $line = (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz') + '  ' + $m
  # Write-Host: el script se usa como comando y su stdout no debe mezclarse con los valores
  # que devuelven las funciones (una foto armada, un booleano). El registro queda en snapshot.log.
  Write-Host $line
  try {
    if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 1MB)) { Move-Item $logFile ($logFile + '.old') -Force }
    Add-Content -Path $logFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
  } catch {}
}

function Read-Manifest([string]$dir) {
  $mf = Join-Path $dir 'manifest.json'
  if (-not (Test-Path $mf)) { return $null }
  try { return (Get-Content $mf -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

function Write-Manifest([string]$dir, $obj) {
  ($obj | ConvertTo-Json -Depth 6) | Set-Content -Path (Join-Path $dir 'manifest.json') -Encoding UTF8
}

# --- promocion: staging -> current, current -> prev --------------------------------
function Publish-Staging {
  $script:published = $false
  if (-not (Test-Path $stageDir)) { Log 'PublishDue: no hay staging, nada que promover'; return }
  $mf = Read-Manifest $stageDir
  if (-not $mf) { Log 'PublishDue: staging sin manifest, se descarta'; Remove-Item $stageDir -Recurse -Force -ErrorAction SilentlyContinue; return }
  if ($mf.publish_after) {
    $due = [datetime]::Parse([string]$mf.publish_after)
    if ($due -gt (Get-Date) -and -not $Force) {
      Log ('PublishDue: la ventana de gracia vence ' + $due.ToString('HH:mm:ss') + ', todavia no promuevo')
      return
    }
  }
  # antes de pisar la foto vigente hay que confirmar que el despliegue sigue sano
  if (-not $Force) {
    $gate = Join-Path $core 'ops\health-gate.ps1'
    $null = & powershell -NoProfile -ExecutionPolicy Bypass -File $gate 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
      Log 'PublishDue: el gate no esta sano, no promuevo (sigo con la foto anterior)'
      return
    }
  }
  Remove-Item $prevDir -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path $currentDir) { Move-Item $currentDir $prevDir -Force }
  Move-Item $stageDir $currentDir -Force
  $mf2 = Read-Manifest $currentDir
  if ($mf2) {
    $mf2 | Add-Member -NotePropertyName published_at -NotePropertyValue ((Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')) -Force
    Write-Manifest $currentDir $mf2
  }
  $script:published = $true
  Log ('foto publicada: ' + $mf.tag + ' exe ' + ([string]$mf.exe_sha).Substring(0,16) + ' archivos ' + @($mf.files).Count)
}

# --- staging: armar una foto nueva ------------------------------------------------
function Build-Staging {
  if (Test-Path $stageDir) { Remove-Item $stageDir -Recurse -Force -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Force (Join-Path $stageDir 'bin') | Out-Null
  New-Item -ItemType Directory -Force (Join-Path $stageDir 'config') | Out-Null

  $cur = Get-AegisCurrent
  if (-not $cur) { Log 'STAGING_ABORT: no hay puntero'; return $null }
  if (-not (Test-Path $cur.exe)) { Log ('STAGING_ABORT: no existe ' + $cur.exe); return $null }

  # el puntero, el binario y el hardlink aegis-current.exe (los tres son "el despliegue")
  Copy-Item (Join-Path $core 'state\current-version.json') (Join-Path $stageDir 'current-version.json') -Force
  Copy-Item (Join-Path $core 'state\last-build.json') (Join-Path $stageDir 'last-build.json') -Force -ErrorAction SilentlyContinue
  $binName = Split-Path $cur.exe -Leaf
  Copy-Item $cur.exe (Join-Path $stageDir ('bin\' + $binName)) -Force -ErrorAction Stop
  # aegis-current.exe NO se copia: es un hardlink al mismo binario y duplicaria 146 MB.
  # La restauracion lo recrea con Refresh-AegisCurrentLink (que ya usa _pointer.ps1).

  # web: solo lo que es codigo y configuracion estable. node_modules y logs no.
  $webSkip = @('node_modules', 'logs', 'outbox', '.git', 'tests', 'docs', '.cache', 'tmp')
  $webInclude = @('server.mjs', 'config.json', 'prices.json', 'package.json', 'package-lock.json',
                  'piper-vivo.js', 'piper-vivo.mjs', 'app', 'src', 'dist-ts', 'scripts', 'tools')
  $copied = 0
  foreach ($item in $webInclude) {
    $srcPath = Join-Path $WebRoot $item
    if (-not (Test-Path $srcPath)) { continue }
    $dst = Join-Path $stageDir ('web\' + $item)
    New-Item -ItemType Directory -Force (Split-Path $dst -Parent) | Out-Null
    if ((Get-Item $srcPath).PSIsContainer) {
      & robocopy $srcPath $dst /E /NFL /NDL /NJH /NJS /NP /XD $webSkip /XF '*.log' | Out-Null
      if ($LASTEXITCODE -ge 8) { Log ('STAGING_ABORT: robocopy fallo en ' + $item + ' (exit ' + $LASTEXITCODE + ')'); return $null }
    } else {
      Copy-Item $srcPath $dst -Force
      $copied++
    }
  }

  # state\config: lo que define el comportamiento del harness. Sin .lock ni .bak.
  $cfgSrc = 'C:\Aegis-Proyects\state\config'
  $cfgInclude = @('config.yaml', 'permission.yaml', 'secrets.yaml', 'operador-perfil.md',
                  'prompts', 'skills', 'custom_providers')
  foreach ($item in $cfgInclude) {
    $srcPath = Join-Path $cfgSrc $item
    if (-not (Test-Path $srcPath)) { continue }
    $dst = Join-Path $stageDir ('config\' + $item)
    if ((Get-Item $srcPath).PSIsContainer) {
      New-Item -ItemType Directory -Force $dst | Out-Null
      & robocopy $srcPath $dst /E /NFL /NDL /NJH /NJS /NP /XF '*.lock' '*.bak-*' | Out-Null
      if ($LASTEXITCODE -ge 8) { Log ('STAGING_ABORT: robocopy fallo en config\' + $item); return $null }
    } else {
      Copy-Item $srcPath $dst -Force
    }
  }

  # manifest: sha256 de cada archivo (excepto el propio manifest) para detectar toda deriva
  $files = @()
  Get-ChildItem $stageDir -Recurse -File | Where-Object { $_.Name -ne 'manifest.json' } | ForEach-Object {
    $rel = $_.FullName.Substring($stageDir.Length + 1) -replace '\\', '/'
    $files += [ordered]@{ path = $rel; sha256 = (Get-FileHash $_.FullName -Algorithm SHA256).Hash; bytes = $_.Length }
  }
  $now = Get-Date
  $mf = [ordered]@{
    created_at    = $now.ToString('yyyy-MM-ddTHH:mm:sszzz')
    publish_after = $now.AddMinutes($GraceMinutes).ToString('yyyy-MM-ddTHH:mm:sszzz')
    grace_minutes = $GraceMinutes
    tag           = $cur.tag
    commit        = $cur.commit
    version       = $cur.version
    exe           = $cur.exe
    exe_sha       = $cur.sha256
    files         = $files
  }
  Write-Manifest $stageDir $mf
  Log ('staging armado: ' + $cur.tag + ' ' + $files.Count + ' archivos, ' + [int](((Get-ChildItem $stageDir -Recurse -File | Measure-Object Length -Sum).Sum)/1MB) + ' MB')
  return $mf
}

# --- main ------------------------------------------------------------------------
if ($PublishDue -and -not $Force) {
  Publish-Staging
  exit $(if ($script:published) { 0 } else { 1 })
}

$mf = Build-Staging
if (-not $mf) { exit 2 }

if ($Force) {
  Log 'Force: publico sin ventana de gracia'
  Publish-Staging
  exit $(if ($script:published) { 0 } else { 1 })
}

# publicacion con ventana: necesita gate sano dos veces seguidas para no promover algo que
# arranca y explota en el primer turno real.
$gate = Join-Path $core 'ops\health-gate.ps1'
$null = & powershell -NoProfile -ExecutionPolicy Bypass -File $gate -Deep 2>&1 | Out-String
$e1 = $LASTEXITCODE
if ($e1 -ne 0) { Log ('staging descartado: el gate dio ' + $e1 + ', no se promueve nada'); Remove-Item $stageDir -Recurse -Force -ErrorAction SilentlyContinue; exit 1 }
Log 'gate profundo sano (1/2); el staging se publica en la proxima pasada si el gate sigue sano'
exit 0

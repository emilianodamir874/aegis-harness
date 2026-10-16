# jobs.ps1 - trabajos desprendidos con consulta: lanza, mira estado, lee la cola, corta.
# Existe porque los comandos de shell tienen tope de tiempo y los turnos largos se cortan en silencio.
# Uso:
#   jobs.ps1 start -Command "npm run build"        -> lanza desprendido y devuelve el id
#   jobs.ps1 status [-Name id]                      -> tabla de trabajos (vivo? exit?)
#   jobs.ps1 tail   -Name id [-Lines 30]            -> ultimas lineas del log
#   jobs.ps1 stop   -Name id                        -> mata el arbol de procesos
#   jobs.ps1 prune  [-Days 7]                       -> borra trabajos terminados viejos
param(
  [Parameter(Mandatory=$true)][ValidateSet('start','status','tail','stop','prune')][string]$Action,
  [string]$Name,
  [string]$Command,
  [int]$Lines = 30,
  [int]$Days = 7
)
$ErrorActionPreference = 'Continue'
function W($m) { $m }
$root = 'C:\Aegis-Proyects\tmp\jobs'
New-Item -ItemType Directory -Force $root | Out-Null

switch ($Action) {
  'start' {
    if (-not $Command) { W 'falta -Command'; exit 1 }
    $id = (Get-Date -Format 'yyyyMMdd-HHmmss')
    $dir = Join-Path $root $id
    New-Item -ItemType Directory -Force $dir | Out-Null
    $log = Join-Path $dir 'out.log'
    $bat = Join-Path $dir 'run.bat'
    # OJO: el & de cmd separa comandos; el exit se escribe al final para poder consultarlo
    # OJO: la redireccion dentro del .bat no se aplicaba (el log quedaba vacio). Se usa el patron
    # probado: Start-Process con -RedirectStandardOutput/-RedirectStandardError.
    @(
      '@echo off',
      'cd /d C:\Aegis-Proyects',
      $Command,
      'echo EXIT=%ERRORLEVEL%'
    ) | Set-Content -Path $bat -Encoding ASCII
    $p = Start-Process cmd -ArgumentList '/c', $bat -WindowStyle Hidden -PassThru -RedirectStandardOutput $log -RedirectStandardError (Join-Path $dir 'err.log')
    @{ id = $id; comando = $Command; pid = $p.Id; inicio = (Get-Date).ToString('s'); dir = $dir } |
      ConvertTo-Json | Set-Content (Join-Path $dir 'meta.json') -Encoding UTF8
    W ('job ' + $id + ' pid ' + $p.Id + ' | log ' + $log)
    W ('status:  jobs.ps1 status -Name ' + $id)
    W ('log:     jobs.ps1 tail -Name ' + $id)
  }
  'status' {
    $dirs = if ($Name) { @(Join-Path $root $Name) } else { @(Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 12 | ForEach-Object { $_.FullName }) }
    foreach ($d in $dirs) {
      if (-not (Test-Path $d)) { W ('  (no existe) ' + $d); continue }
      $meta = Get-Content (Join-Path $d 'meta.json') -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
      $id = Split-Path $d -Leaf
      $log = Join-Path $d 'out.log'
      $vivo = $false
      if ($meta -and $meta.pid) { $vivo = [bool](Get-Process -Id $meta.pid -ErrorAction SilentlyContinue) }
      $exit = ''
      if (Test-Path $log) { $m = Select-String -Path $log -Pattern '^EXIT=(\d+)' -ErrorAction SilentlyContinue | Select-Object -Last 1; if ($m) { $exit = 'exit ' + $m.Matches[0].Groups[1].Value } }
      $kb = if (Test-Path $log) { [math]::Round((Get-Item $log).Length / 1KB, 1) } else { 0 }
      W ('  ' + $id + ' | ' + $(if ($vivo) { 'CORRIENDO' } else { 'terminado' }) + ' ' + $exit + ' | log ' + $kb + ' KB | ' + $(if ($meta) { $meta.comando } else { '?' }))
    }
  }
  'tail' {
    if (-not $Name) { W 'falta -Name'; exit 1 }
    $log = Join-Path (Join-Path $root $Name) 'out.log'
    if (-not (Test-Path $log)) { W ('sin log: ' + $log); exit 1 }
    Get-Content $log -Tail $Lines | ForEach-Object { W ('  ' + ($_ -replace '[^\x20-\x7E]', '.')) }
  }
  'stop' {
    if (-not $Name) { W 'falta -Name'; exit 1 }
    $meta = Get-Content (Join-Path (Join-Path $root $Name) 'meta.json') -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
    if (-not $meta) { W 'sin meta'; exit 1 }
    try { Stop-Process -Id $meta.pid -Force -ErrorAction Stop; W ('  cortado pid ' + $meta.pid) } catch { W ('  no estaba vivo: ' + $_.Exception.Message) }
  }
  'prune' {
    $corte = (Get-Date).AddDays(-$Days)
    Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt $corte } | ForEach-Object {
      $mb = [math]::Round(((Get-ChildItem $_.FullName -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB), 1)
      Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
      W ('  borrado ' + $_.Name + ' (' + $mb + ' MB)')
    }
  }
}

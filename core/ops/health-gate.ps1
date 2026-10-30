# Gate funcional del harness. Mide por EFECTO, no por proceso: puerto abierto no es harness sano.
# Uso:  health-gate.ps1               (shallow, cada pocos minutos)
#       health-gate.ps1 -Deep         (agrega turno canario real + quick_check del store)
# Salida: core\state\health.json  y  exit 0=sano / 1=degradado / 2=roto
# No escribe nada fuera de health.json y core\state\canary\: es solo medicion.
param(
  [switch]$Deep,
  [int]$CanaryTimeoutSecs = 90,
  [switch]$NoCanary
)
$ErrorActionPreference = 'Continue'
$root = 'C:\Aegis-Proyects'
$core = Join-Path $root 'core'
$web  = Join-Path $root 'web'
. (Join-Path $PSScriptRoot '_pointer.ps1')

$stateFile = Join-Path $core 'state\health.json'
$checks = New-Object System.Collections.ArrayList
$reasons = New-Object System.Collections.ArrayList

function Add-Check([string]$name, [string]$status, [string]$detail) {
  # status: ok | degradado | roto
  [void]$checks.Add([ordered]@{ name = $name; status = $status; detail = $detail })
  if ($status -ne 'ok') { [void]$reasons.Add($name) }
  $line = '{0,-14} {1,-10} {2}' -f $name, $status, $detail
  Write-Output $line
}

function Get-JsonUrl([string]$url, [int]$timeoutSecs = 8) {
  try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $timeoutSecs
    return @{ ok = $true; code = [int]$r.StatusCode; body = $r.Content }
  } catch {
    $code = 0
    if ($_.Exception.Response) { try { $code = [int]$_.Exception.Response.StatusCode } catch {} }
    return @{ ok = $false; code = $code; body = ''; error = $_.Exception.Message }
  }
}

function Get-NodeExe {
  $cands = @(
    'C:\Users\Emiliano\AppData\Local\hermes\tools\node-26.7.0-win32-x64\node.exe',
    'C:\Users\Emiliano\scoop\apps\fnm\current\node-versions\v22.23.2\installation\node.exe',
    'C:\Users\Emiliano\AppData\Local\hermes\tools\.reclaim-b5211fe162ad438ca39ea28e075f9794\node.exe'
  )
  return ($cands | Where-Object { Test-Path $_ } | Select-Object -First 1)
}

# ---------------------------------------------------------------- 1. serve 3284
$cur = Get-AegisCurrent
if (-not $cur) {
  Add-Check 'puntero' 'roto' 'no se puede leer core\state\current-version.json'
} else {
  $exeOk = Test-Path $cur.exe
  if ($exeOk) { Add-Check 'puntero' 'ok' ($cur.tag + ' commit ' + $cur.commit) }
  else { Add-Check 'puntero' 'roto' ('el exe del puntero no existe: ' + $cur.exe) }
}

$conn = Get-NetTCPConnection -LocalPort $script:ServePort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $conn) {
  Add-Check 'serve' 'roto' 'nada escucha en 3284'
} else {
  $h = Get-JsonUrl ('http://127.0.0.1:' + $script:ServePort + '/health') 8
  if ($h.ok -and $h.code -eq 200) {
    Add-Check 'serve' 'ok' ('pid ' + $conn.OwningProcess + ' /health 200')
  } else {
    Add-Check 'serve' 'roto' ('pid ' + $conn.OwningProcess + ' escucha pero /health fallo (' + $h.code + ')')
  }
  # el proceso vivo tiene que ser el binario del puntero (detecta "reinicio pero quedo el viejo")
  $live = (Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue).Path
  if ($live -and $cur) {
    $shaLive = $null
    try { $shaLive = (Get-FileHash $live -Algorithm SHA256 -ErrorAction Stop).Hash } catch {}
    if ($shaLive -eq $cur.sha256) {
      # mismo contenido binario: da igual que el archivo se llame -healNNNNNN.exe
      $extra = ''
      if ($live -ne $cur.exe) { $extra = ' (archivo ' + (Split-Path $live -Leaf) + ', mismo sha que el puntero)' }
      Add-Check 'binario' 'ok' ($cur.tag + ' sha ' + $shaLive.Substring(0,16) + $extra)
    } elseif ($live -ne $cur.exe) {
      Add-Check 'binario' 'degradado' ('vivo=' + (Split-Path $live -Leaf) + ' puntero=' + (Split-Path $cur.exe -Leaf))
    } else {
      Add-Check 'binario' 'degradado' ('sha vivo ' + ([string]$shaLive).Substring(0, [Math]::Min(16, ([string]$shaLive).Length)) + ' != puntero ' + $cur.sha256.Substring(0,16))
    }
  }
}

# ---------------------------------------------------------------- 2. web 3788 + assets
$cfgPath = Join-Path $web 'config.json'
$webPort = 3788
if (Test-Path $cfgPath) {
  try { $webPort = (Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json).webPort } catch {}
}
$w = Get-JsonUrl ('http://127.0.0.1:' + $webPort + '/') 10
if (-not $w.ok -or $w.code -ne 200) {
  Add-Check 'web' 'roto' (':' + $webPort + '/ no responde 200 (' + $w.code + ')')
} else {
  $idx = Join-Path $web 'app\index.html'
  $refs = @()
  if (Test-Path $idx) {
    $html = Get-Content $idx -Raw -Encoding UTF8
    $matches2 = [regex]::Matches($html, '(?:src|href)\s*=\s*"\./([^"]+)"')
    foreach ($m in $matches2) { $refs += $m.Groups[1].Value }
  }
  $missing = @()
  foreach ($r in ($refs | Select-Object -Unique)) {
    $r2 = Get-JsonUrl ('http://127.0.0.1:' + $webPort + '/' + $r) 10
    if (-not $r2.ok -or $r2.code -ne 200) { $missing += $r }
  }
  if ($missing.Count -eq 0) { Add-Check 'web' 'ok' (':' + $webPort + '/ + ' + $refs.Count + ' refs de index.html') }
  elseif ($missing.Count -le 1) { Add-Check 'web' 'degradado' ('refs 404: ' + ($missing -join ',')) }
  else { Add-Check 'web' 'roto' ($missing.Count + ' refs de index.html no responden: ' + (($missing | Select-Object -First 5) -join ',')) }
}

# ---------------------------------------------------------------- 3. sintaxis del frontend y del proxy
$node = Get-NodeExe
if (-not $node) {
  Add-Check 'sintaxis' 'degradado' 'no hay node.exe para validar'
} else {
  $targets = @()
  $srv = Join-Path $web 'server.mjs'
  if (Test-Path $srv) { $targets += $srv }
  $appDir = Join-Path $web 'app'
  if (Test-Path $appDir) { $targets += (Get-ChildItem $appDir -Filter '*.js' -File | Select-Object -ExpandProperty FullName) }
  $bad = @()
  foreach ($t in $targets) {
    $out = & $node --check $t 2>&1
    if ($LASTEXITCODE -ne 0) { $bad += (Split-Path $t -Leaf) }
  }
  if ($bad.Count -eq 0) { Add-Check 'sintaxis' 'ok' ([string]$targets.Count + ' archivos de web parsean') }
  else { Add-Check 'sintaxis' 'roto' ('no parsean: ' + ($bad -join ',')) }
}

# ---------------------------------------------------------------- 4. que la config parsea de verdad
if ($cur -and (Test-Path $cur.exe)) {
  if (-not $env:AEGIS_PATH_ROOT) { $env:AEGIS_PATH_ROOT = Join-Path $root 'state' }
  $pp = & $cur.exe --print-paths 2>&1
  $ppOk = ($LASTEXITCODE -eq 0)
  if ($ppOk) { Add-Check 'config' 'ok' 'config.yaml parsea (--print-paths 0)' }
  else { Add-Check 'config' 'roto' ('config.yaml no parsea: ' + (($pp | Select-Object -First 2) -join ' ')) }
} else {
  Add-Check 'config' 'roto' 'sin binario no se puede validar la config'
}

# ---------------------------------------------------------------- 5. store
$db = Join-Path $root 'state\data\sessions\sessions.db'
$sqlite = (Get-Command sqlite3 -ErrorAction SilentlyContinue).Source
if (-not (Test-Path $db)) {
  Add-Check 'store' 'roto' 'no existe sessions.db'
} elseif (-not $sqlite) {
  Add-Check 'store' 'degradado' 'sqlite3 no esta en el PATH'
} else {
  $sv = (& $sqlite $db 'select max(version) from schema_version;' 2>&1) -join ''
  if ($sv -match '^\d+$') { Add-Check 'store' 'ok' ('schema_version ' + $sv + ' (' + [int]((Get-Item $db).Length/1MB) + ' MB)') }
  else { Add-Check 'store' 'roto' ('store ilegible: ' + $sv) }
  if ($Deep) {
    $qc = (& $sqlite $db 'pragma quick_check;' 2>&1) -join ''
    if ($qc.Trim() -eq 'ok') { Add-Check 'store-check' 'ok' 'quick_check ok' }
    else { Add-Check 'store-check' 'roto' ('quick_check: ' + $qc) }
  }
}

# ---------------------------------------------------------------- 6. turno canario (deep)
if ($Deep -and -not $NoCanary -and $cur -and (Test-Path $cur.exe)) {
  # Store aislado: el canario NO debe escribir en tu sessions.db ni aparecer en la UI.
  $canaryRoot = Join-Path $core 'state\canary'
  $canaryCfg = Join-Path $canaryRoot 'config'
  New-Item -ItemType Directory -Force $canaryCfg | Out-Null
  Copy-Item (Join-Path $root 'state\config\config.yaml') (Join-Path $canaryCfg 'config.yaml') -Force -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $root 'state\config\secrets.yaml') (Join-Path $canaryCfg 'secrets.yaml') -Force -ErrorAction SilentlyContinue
  $recipe = Join-Path $PSScriptRoot 'canary.yaml'
  $cout = Join-Path $canaryRoot 'last.out'
  $cerr = Join-Path $canaryRoot 'last.err'
  Remove-Item $cout, $cerr -Force -ErrorAction SilentlyContinue
  $oldRoot = $env:AEGIS_PATH_ROOT
  $env:AEGIS_PATH_ROOT = $canaryRoot
  try {
    $p = Start-Process -FilePath $cur.exe -ArgumentList @('--run-recipe', ('"' + $recipe + '"')) `
         -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru `
         -RedirectStandardOutput $cout -RedirectStandardError $cerr
    $finished = $p.WaitForExit($CanaryTimeoutSecs * 1000)
    # ExitCode de un proceso lanzado con -PassThru queda vacio en PS 5.1 hasta refrescar HasExited.
    $p.Refresh()
    $exitCode = -1
    if ($p.HasExited) { try { $exitCode = [int]$p.ExitCode } catch { $exitCode = -1 } }
    if (-not $finished) {
      try { $p.Kill() } catch {}
      Add-Check 'canario' 'degradado' ('sin respuesta en ' + $CanaryTimeoutSecs + 's (provider colgado?)')
    } else {
      $text = ''
      if (Test-Path $cout) { $text = [string](Get-Content $cout -Raw -ErrorAction SilentlyContinue) }
      if ($exitCode -ne 0) {
        $e = ''
        if (Test-Path $cerr) { $e = (([string](Get-Content $cerr -Raw -ErrorAction SilentlyContinue)) -replace '\s+', ' ').Trim() }
        Add-Check 'canario' 'degradado' ('exit ' + $exitCode + ': ' + $e.Substring(0, [Math]::Min(160, $e.Length)))
      } elseif ($text -match 'ok') {
        Add-Check 'canario' 'ok' 'turno real contra el provider barato'
      } else {
        Add-Check 'canario' 'degradado' 'el turno corrio pero no devolvio ok'
      }
    }
  } finally {
    if ($oldRoot) { $env:AEGIS_PATH_ROOT = $oldRoot } else { Remove-Item Env:AEGIS_PATH_ROOT -ErrorAction SilentlyContinue }
  }
}

# ---------------------------------------------------------------- resultado
$roto = @($checks | Where-Object { $_.status -eq 'roto' })
$degr = @($checks | Where-Object { $_.status -eq 'degradado' })
$overall = if ($roto.Count -gt 0) { 'roto' } elseif ($degr.Count -gt 0) { 'degradado' } else { 'sano' }
$exit = switch ($overall) { 'sano' { 0 } 'degradado' { 1 } default { 2 } }

$obj = [ordered]@{
  at       = (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz')
  overall  = $overall
  deep     = [bool]$Deep
  reasons  = @($reasons)
  tag      = $(if ($cur) { $cur.tag } else { '' })
  checks   = $checks
}
try {
  $tmp = $stateFile + '.tmp'
  ($obj | ConvertTo-Json -Depth 5) | Set-Content -Path $tmp -Encoding UTF8
  Move-Item $tmp $stateFile -Force
} catch { Write-Output ('no se pudo escribir health.json: ' + $_.Exception.Message) }

Write-Output ('OVERALL=' + $overall)
exit $exit

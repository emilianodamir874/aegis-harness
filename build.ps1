# Build parametrizado del serve. Reemplaza build-safe.ps1 + build-vNN.bat/ps1 (las copias por version).
# Uso: build.ps1 -Tag v35 [-Features ...] [-SkipIdleGate] [-KeepSccache]
# Deja el binario en C:\Aegis-Proyects\core\bin\aegis-<Tag>.exe y anota state\last-build.json. NO toca el puntero:
# promover es tarea de swap.ps1 (separar construir de desplegar es lo que evita el acoplamiento).
param(
  [Parameter(Mandatory=$true)][string]$Tag,
  [string]$Features = 'rustls-tls,scheduler,bundled-mcp,chat-recall,acp-http,code-mode',
  [int]$IdleSeconds = 60,
  [switch]$SkipIdleGate,
  [switch]$KeepSccache
)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_pointer.ps1')
$repo = 'C:\Aegis-Proyects\src'
$logDir = Join-Path $AegisRoot 'logs\build'
if ($Tag -notmatch '^v\d+$') { throw "Tag invalido: '$Tag' (formato vNN)" }
$log = Join-Path $logDir ('build-' + $Tag + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
$out = Join-Path $BinDir ('aegis-' + $Tag + '.exe')
$cfg = 'C:\Users\Emiliano\.cargo\config.toml'
New-Item -ItemType Directory -Force $logDir, $BinDir | Out-Null
function W($m) { $m; $m | Out-File -FilePath $log -Append -Encoding utf8 }
function Last-ModelWrite {
  $f = Get-ChildItem "$env:APPDATA\Aegis\aegis\data\logs\llm_request.*.jsonl" -ErrorAction SilentlyContinue |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($f) { $f.LastWriteTime } else { (Get-Date).AddDays(-1) }
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
  & cargo build -p aegis-cli --bin aegis --no-default-features --features $Features 2>&1 | Set-Content $log
  $code = $LASTEXITCODE
  W ('EXITCODE=' + $code)
  if ($code -ne 0) { W 'BUILD_FAILED: no se copia nada'; exit 1 }
  Copy-Item (Join-Path $repo 'target\debug\aegis.exe') $out -Force
  $s = (Get-FileHash (Join-Path $repo 'target\debug\aegis.exe') -Algorithm SHA256).Hash
  $d = (Get-FileHash $out -Algorithm SHA256).Hash
  if ($s -ne $d) { W ('COPY_FAILED: origen ' + $s.Substring(0,16) + ' destino ' + $d.Substring(0,16)); exit 1 }
} finally {
  Copy-Item ($cfg + '.bak-build') $cfg -Force
  Remove-Item ($cfg + '.bak-build') -Force -ErrorAction SilentlyContinue
}
$i = Get-Item $out
$sha = (Get-FileHash $out -Algorithm SHA256).Hash
$ver = (& $out --version 2>&1) -join ' '
$commit = ''
try { $commit = (git -C $repo rev-parse --short HEAD 2>$null) } catch {}
$obj = [ordered]@{ tag=$Tag; exe=$out; commit=$commit; sha256=$sha; version=$ver; features=$Features;
                   bytes=$i.Length; built_at=(Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz') }
($obj | ConvertTo-Json) | Set-Content -Path (Join-Path $AegisRoot 'state\last-build.json') -Encoding UTF8
W ('BUILD_OK ' + $out + ' sha256=' + $sha.Substring(0,16) + ' ' + $ver)
W ('promover con: powershell -File C:\Aegis-Proyects\core\ops\swap.ps1 -Tag ' + $Tag)

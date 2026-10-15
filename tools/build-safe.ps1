# Build seguro de goose (B1/B3/B4 del relevamiento de dolor):
#  - espera a que no haya actividad del modelo, para no arrastrar tus turnos
#  - neutraliza sccache como corresponde (comentar rustc-wrapper y restaurar)
#  - copia el binario SOLO si el build termino con exit 0
#  - verifica la identidad del binario copiado (--version + hash)
param(
  [Parameter(Mandatory=$true)][string]$Version,
  [string]$Features = 'rustls-tls,scheduler,bundled-mcp,chat-recall,acp-http,code-mode',
  [int]$IdleSeconds = 60,
  [switch]$SkipIdleGate,
  [switch]$KeepSccache
)
$ErrorActionPreference = 'Continue'
$repo = 'C:\goose'; $logDir = 'C:\goose-web\logs'; $log = "$logDir\build-$Version.log"
$cfg = 'C:\Users\Emiliano\.cargo\config.toml'
$out = "$repo\target\debug\goose-$Version.exe"
function Last-ModelWrite {
  $f = Get-ChildItem "$env:APPDATA\Block\goose\data\logs\llm_request.*.jsonl" -ErrorAction SilentlyContinue |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($f) { $f.LastWriteTime } else { (Get-Date).AddDays(-1) }
}
if (-not $SkipIdleGate) {
  $deadline = (Get-Date).AddMinutes(20)
  while ((Last-ModelWrite) -gt (Get-Date).AddSeconds(-$IdleSeconds)) {
    if ((Get-Date) -gt $deadline) { Add-Content $log 'IDLE_GATE_TIMEOUT'; Write-Host 'sigo esperando: use -SkipIdleGate'; break }
    Write-Host ("esperando a que el modelo este quieto: ultima actividad {0}" -f (Last-ModelWrite).ToString('HH:mm:ss'))
    Start-Sleep -Seconds 15
  }
}
$inUse = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -eq $out }
if ($inUse) {
  Add-Content $log ("VERSION_IN_USE: {0} esta corriendo (pid {1}); usa otra -Version" -f $out, ($inUse.ProcessId -join ','))
  Write-Host ("abortado: {0} esta en uso; usa otra -Version" -f $out)
  exit 1
}
Remove-Item $out -Force -ErrorAction SilentlyContinue
if (Test-Path $out) {
  Add-Content $log 'VERSION_LOCKED: no se pudo borrar el binario destino (en uso?)'
  Write-Host 'abortado: el binario destino esta bloqueado'
  exit 1
}
Copy-Item $cfg ($cfg + '.bak-build') -Force
try {
  if (-not $KeepSccache) {
    # set RUSTC_WRAPPER= NO alcanza: cargo cae al rustc-wrapper del config.toml
    (Get-Content $cfg) -replace '^rustc-wrapper', '#rustc-wrapper' | Set-Content $cfg
    $env:RUSTC_WRAPPER = ''; $env:CARGO_BUILD_RUSTC_WRAPPER = ''
  }
  Set-Location $repo
  & cargo build -p goose-cli --bin goose --no-default-features --features $Features 2>&1 | Set-Content $log
  $code = $LASTEXITCODE
  Add-Content $log ("EXITCODE=$code")
  if ($code -ne 0) { Add-Content $log 'BUILD_FAILED: no se copia nada'; exit 1 }
  Copy-Item "$repo\target\debug\goose.exe" $out -Force
  $srcHash = (Get-FileHash "$repo\target\debug\goose.exe" -Algorithm SHA256).Hash
  $dstHash = (Get-FileHash $out -Algorithm SHA256).Hash
  if ($srcHash -ne $dstHash) {
    Add-Content $log ("COPY_FAILED: el destino no coincide con goose.exe (origen {0}, destino {1})" -f $srcHash.Substring(0,16), $dstHash.Substring(0,16))
    Write-Host 'copia fallida: el binario destino quedo viejo (probablemente en uso)'
    exit 1
  }
} finally {
  Copy-Item ($cfg + '.bak-build') $cfg -Force
  Remove-Item ($cfg + '.bak-build') -Force
  Add-Content $log ('CFG_RESTORED ' + ((Get-Content $cfg -TotalCount 3) -join ' | '))
}
$i = Get-Item $out
$ver = & $out --version 2>&1
$hash = (Get-FileHash $out -Algorithm SHA256).Hash.Substring(0,16)
Add-Content $log ("COPIED_OK bytes={0} sha256={1} version={2}" -f $i.Length, $hash, ($ver -join ' '))
Write-Host ("listo: {0} ({1} bytes, {2}, version {3})" -f $out, $i.Length, $hash, ($ver -join ' '))

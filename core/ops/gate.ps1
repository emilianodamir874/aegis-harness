# Gate local obligatorio antes de pushear. Devuelve exit 1 si algo falla.
# Es el reemplazo verificable del CI mientras Actions no arranque steps.
# Uso: core\ops\gate.ps1 [-Fast] [-SkipTests]
param(
  [switch]$Fast,       # solo fmt + check, sin correr tests (para commits chicos)
  [switch]$SkipTests
)

$ErrorActionPreference = 'Continue'
$env:CARGO_TARGET_DIR = 'C:\Aegis-Proyects\target'
$env:AEGIS_DISABLE_KEYRING = '1'
$repo = 'C:\Aegis-Proyects\src'
$CI = 'rustls-tls,tree-sitter,live-voice,scheduler,platform-apps,chat-recall,acp-http'
$SERVE = 'rustls-tls,scheduler,bundled-mcp,chat-recall,acp-http'
$failed = @()
$results = @()

function Run([string]$name, [string[]]$argv) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  Write-Output ('[gate] ' + $name)
  Push-Location $repo
  try { $o = & cargo @argv 2>&1; $code = $LASTEXITCODE } finally { Pop-Location }
  $sw.Stop()
  $secs = [int]$sw.Elapsed.TotalSeconds
  $script:results += [pscustomobject]@{ step = $name; exit = $code; segs = $secs }
  if ($code -ne 0) {
    $script:failed += $name
    Write-Output ('[gate] FALLO ' + $name + ' (' + $secs + 's)')
    $o | Select-Object -Last 15 | ForEach-Object { Write-Output ('   ' + $_) }
  } else {
    Write-Output ('[gate] ok    ' + $name + ' (' + $secs + 's)')
  }
}

Run 'fmt' @('fmt','--all','--','--check')
Run 'check-lib' @('check','-p','aegis','--lib','--no-default-features','--features',$CI)
Run 'check-serve' @('check','-p','aegis-server','--bin','aegis-serve','--no-default-features','--features',$SERVE)
if (-not $Fast) {
  Run 'check-tests' @('check','--tests','-p','aegis','-p','aegis-agent','-p','aegis-mcp','-p','aegis-context-management','-p','aegis-providers','-p','aegis-provider-types','--no-default-features','--features',$CI)
}
if (-not $Fast -and -not $SkipTests) {
  Run 'test-lib' @('test','-p','aegis','--lib','--no-fail-fast','--no-default-features','--features',$CI)
}

Write-Output ''
Write-Output '[gate] resumen'
$results | ForEach-Object { Write-Output (('  {0,-13} exit={1} {2}s' -f $_.step, $_.exit, $_.segs)) }
if ($failed.Count -gt 0) {
  Write-Output ('[gate] ROJO: ' + ($failed -join ', '))
  exit 1
}
Write-Output '[gate] VERDE'
exit 0

# Atribucion de cambios sin commitear.
#
# Responde, para cada archivo sucio de un repo: cuando se modifico, cuanto
# cambio, que commit lo toco por ultima vez y si el cambio es solo formato.
# El objetivo es que ningun WIP quede sin dueno: o se identifica la intencion,
# o se descarta con una razon escrita.
#
# Uso:
#   core\ops\wip-attribution.ps1                 # monorepo del harness
#   core\ops\wip-attribution.ps1 -Repo C:\Aegis-Proyects\trading
#   core\ops\wip-attribution.ps1 -Tsv out.tsv

param(
  [string]$Repo = 'C:\Aegis-Proyects',
  [string]$Tsv
)

$ErrorActionPreference = 'Continue'
if (-not (Test-Path (Join-Path $Repo '.git'))) {
  Write-Output ("no es un repo git: " + $Repo)
  exit 2
}

Push-Location $Repo
try {
  $rows = @()
  $status = git status --porcelain

  $modified = $status | Where-Object { $_ -match '^ ?M' } | ForEach-Object { $_.Substring(3).Trim('"') }
  $untracked = $status | Where-Object { $_ -match '^\?\?' } | ForEach-Object { $_.Substring(3).Trim('"') }

  foreach ($f in $modified) {
    $full = Join-Path $Repo ($f -replace '/', '\')
    $mtime = ''
    if (Test-Path -LiteralPath $full) { $mtime = (Get-Item -LiteralPath $full).LastWriteTime.ToString('yyyy-MM-dd HH:mm') }

    $numstat = (git diff --numstat -- $f)
    $parts = $numstat -split "`t"
    $add = if ($parts.Count -ge 2) { $parts[0] } else { '?' }
    $del = if ($parts.Count -ge 2) { $parts[1] } else { '?' }

    $lastCommit = (git log -1 --format='%h %ad %s' --date=short -- $f)

    # Solo formato: el diff sin espacios ni lineas en blanco queda vacio.
    $semantic = (git diff -w --ignore-blank-lines -- $f | Measure-Object -Line).Lines
    $kind = if ($semantic -le 4) { 'formato' } else { 'semantico' }

    $rows += [pscustomobject]@{
      estado    = 'M'
      tipo      = $kind
      archivo   = $f
      mtime     = $mtime
      add       = $add
      del       = $del
      ultimo    = $lastCommit
    }
  }

  foreach ($f in $untracked) {
    # Los archivos generados por corridas (.json de evals, logs) no son WIP de codigo.
    $kind = if ($f -match '(^|/)(runs|logs|outbox|scratch)/' -or $f -match '\.(json|log|txt|png|wav)$') { 'artefacto' } else { 'nuevo' }
    $full = Join-Path $Repo ($f -replace '/', '\')
    $mtime = ''
    if (Test-Path -LiteralPath $full) { $mtime = (Get-Item -LiteralPath $full).LastWriteTime.ToString('yyyy-MM-dd HH:mm') }
    $rows += [pscustomobject]@{
      estado  = '?'
      tipo    = $kind
      archivo = $f
      mtime   = $mtime
      add     = ''
      del     = ''
      ultimo  = ''
    }
  }

  if ($rows.Count -eq 0) {
    Write-Output 'arbol limpio: nada sin commitear'
    exit 0
  }

  $rows | Sort-Object tipo, estado, archivo | Format-Table -AutoSize | Out-String -Width 200 | Write-Output

  Write-Output '--- resumen ---'
  $rows | Group-Object tipo | Sort-Object Count -Descending | ForEach-Object {
    Write-Output ('{0,4}  {1}' -f $_.Count, $_.Name)
  }
  $sem = ($rows | Where-Object { $_.tipo -eq 'semantico' }).Count
  Write-Output ''
  if ($sem -gt 0) {
    Write-Output ("ATENCION: " + $sem + " archivo(s) con cambio semantico sin commitear. Investiga la intencion antes de commitear o descartar.")
  } else {
    Write-Output 'No hay cambios semanticos pendientes: lo que queda es formato, artefactos o archivos nuevos.'
  }

  if ($Tsv) {
    $rows | Export-Csv -LiteralPath $Tsv -NoTypeInformation -Delimiter "`t" -Encoding utf8
    Write-Output ("tsv: " + $Tsv)
  }
} finally {
  Pop-Location
}

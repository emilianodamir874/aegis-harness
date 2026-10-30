# Fuente unica de "la version actual del serve". Dot-source desde los otros ops.
# ASCII-only a proposito: PowerShell 5.1 lee .ps1 sin BOM como ANSI y rompe los acentos.
$script:AegisRoot   = 'C:\Aegis-Proyects\core'
$script:PointerFile = Join-Path $AegisRoot 'state\current-version.json'
$script:BinDir      = Join-Path $AegisRoot 'bin'
$script:ServePort   = 3284

function Get-AegisCurrent {
  if (-not (Test-Path $PointerFile)) { return $null }
  try { return (Get-Content $PointerFile -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

function Refresh-AegisCurrentLink {
  param([Parameter(Mandatory=$true)][string]$Exe)
  $link = Join-Path $BinDir 'aegis-current.exe'
  if (Test-Path $link) { Remove-Item $link -Force -ErrorAction SilentlyContinue }
  if (Test-Path $link) { return $false }
  New-Item -ItemType HardLink -Path $link -Target $Exe -ErrorAction Stop | Out-Null
  return $true
}

function Set-AegisCurrent {
  param(
    [Parameter(Mandatory=$true)][string]$Exe,
    [string]$Tag = '',
    [string]$Features = '',
    [string]$SetBy = 'manual'
  )
  if (-not (Test-Path $Exe)) { throw "no existe el binario: $Exe" }
  $full = (Resolve-Path $Exe).Path
  $sha  = (Get-FileHash $full -Algorithm SHA256).Hash
  $commit = ''
  try { $commit = (git -C 'C:\Aegis-Proyects\src' rev-parse --short HEAD 2>$null) } catch {}
  $v = ''
  try { $v = ((& $full --version 2>&1) -join ' ') } catch {}
  $obj = [ordered]@{
    tag      = $Tag
    exe      = $full
    commit   = $commit
    sha256   = $sha
    version  = $v
    features = $Features
    set_at   = (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz')
    set_by   = $SetBy
  }
  $tmp = $PointerFile + '.tmp'
  ($obj | ConvertTo-Json) | Set-Content -Path $tmp -Encoding UTF8
  Move-Item $tmp $PointerFile -Force
  if (-not (Refresh-AegisCurrentLink -Exe $full)) { throw "no se pudo recrear el hardlink aegis-current.exe -> $full (algun proceso lo tiene abierto?)" }
  return $obj
}

function Get-AegisLiveServe {
  $c = Get-NetTCPConnection -LocalPort $script:ServePort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $c) { return $null }
  return (Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue).Path
}

function Get-AegisCliExe {
  # lo que resolveria aegis.cmd: el aegis-v*.exe mas nuevo de target\debug
  $d = 'C:\Aegis-Proyects\target\debug'
  $f = Get-ChildItem $d -File -Filter 'aegis-v*.exe' -ErrorAction SilentlyContinue |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($f) { return $f.FullName }
  return (Join-Path $BinDir 'aegis-current.exe')
}

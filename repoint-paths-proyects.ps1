# repoint-paths-proyects.ps1
# Reapunta las rutas viejas del stack Aegis a la mudanza del 2026-10-15
# (C:\Aegis-Proyects\core -> C:\Aegis-Proyects\core, C:\aegis-web -> C:\Aegis-Proyects\web,
#  C:\Aegis-Proyects\src -> C:\Aegis-Proyects\src, C:\Aegis-Proyects\bridge -> C:\Aegis-Proyects\bridge, ...).
#
# ASCII-only a proposito: PS 5.1 lee .ps1 sin BOM como ANSI y rompe los acentos.
# Uso:  powershell -NoProfile -ExecutionPolicy Bypass -File repoint-paths-proyects.ps1            (dry-run)
#       powershell -NoProfile -ExecutionPolicy Bypass -File repoint-paths-proyects.ps1 -Apply     (escribe, con backup)
# Backup: core\backups\<fecha>-proyects-repoint\  (estructura relativa conservada)
# Log:    core\logs\repoint\repoint-<fecha>.log

param([switch]$Apply, [string]$Root = 'C:\Aegis-Proyects')

$ErrorActionPreference = 'Continue'
$inv = [System.Globalization.CultureInfo]::InvariantCulture

# --- mapeos, en orden: lo mas especifico primero ---
$maps = @(
  # --- variantes con doble barra (rutas JSON-escapadas) ---
  @{ o = 'C:\\aegis-web';        n = 'C:\\Aegis-Proyects\\web' },
  @{ o = 'C:\\Aegis-Proyects\\bridge'; n = 'C:\\Aegis-Proyects\\bridge' },
  @{ o = 'C:\\Aegis-Proyects\\src';        n = 'C:\\Aegis-Proyects\\src' },
  @{ o = 'C:\\Aegis-Proyects\\core\\';          n = 'C:\\Aegis-Proyects\\core\\' },
  @{ o = 'C:\\Aegis-Proyects\\core"';           n = 'C:\\Aegis-Proyects\\core"' },
  # --- variantes simples ---
  @{ o = 'C:\aegis-web';                n = 'C:\Aegis-Proyects\web' },
  @{ o = 'C:/aegis-web';                n = 'C:/Aegis-Proyects/web' },
  @{ o = 'C:\Aegis-Proyects\bridge';         n = 'C:\Aegis-Proyects\bridge' },
  @{ o = 'C:/Aegis-Proyects/bridge';         n = 'C:/Aegis-Proyects/bridge' },
  @{ o = 'C:\Aegis-Proyects\src';                n = 'C:\Aegis-Proyects\src' },
  @{ o = 'C:/Aegis-Proyects/src';                n = 'C:/Aegis-Proyects/src' },
  @{ o = 'C:\Aegis-Proyects\ml\aegis_strategy_lab';       n = 'C:\Aegis-Proyects\ml\aegis_strategy_lab' },
  @{ o = 'C:\Aegis-Proyects\trading';               n = 'C:\Aegis-Proyects\trading' },
  @{ o = 'C:\Aegis-Proyects\worktrees';          n = 'C:\Aegis-Proyects\worktrees' },
  @{ o = 'C:\Aegis-Proyects\target';       n = 'C:\Aegis-Proyects\target' },
  @{ o = 'C:\Aegis-Proyects\archive\aegis_archive';            n = 'C:\Aegis-Proyects\archive\aegis_archive' },
  @{ o = 'C:\Aegis-Proyects\releases\aegis-dashboard-releases'; n = 'C:\Aegis-Proyects\releases\aegis-dashboard-releases' },
  @{ o = 'C:\Aegis-Proyects\phone\aegis-phone-kernel';       n = 'C:\Aegis-Proyects\phone\aegis-phone-kernel' },
  @{ o = 'C:\Aegis-Proyects\phone\aegis-phone-linux-native'; n = 'C:\Aegis-Proyects\phone\aegis-phone-linux-native' },
  @{ o = 'C:\Aegis-Proyects\market\aegis-repro';              n = 'C:\Aegis-Proyects\market\aegis-repro' },
  @{ o = 'C:\aegis-shots';              n = 'C:\Aegis-Proyects\releases\aegis-shots' },
  @{ o = 'C:\Aegis-Proyects\core\';                   n = 'C:\Aegis-Proyects\core\' },
  @{ o = 'C:/Aegis-Proyects/core/';                   n = 'C:/Aegis-Proyects/core/' },
  @{ o = "'C:\Aegis-Proyects\core'";                  n = "'C:\Aegis-Proyects\core'" },
  @{ o = '"C:\Aegis-Proyects\core"';                  n = '"C:\Aegis-Proyects\core"' },
  # store del serve: el legacy Block\goose ya no existe (vive en Aegis\aegis)
  @{ o = 'C:\\Users\\Emiliano\\AppData\\Roaming\\Block\\goose'; n = 'C:\\Users\\Emiliano\\AppData\\Roaming\\Aegis\\aegis' },
  @{ o = 'C:/Users/Emiliano/AppData/Roaming/Block/goose';       n = 'C:/Users/Emiliano/AppData/Roaming/Aegis/aegis' }
)

# --- archivos vivos a repuntar (explicito; nada de barridos a ciegas) ---
$pats = @(
  "$Root\web\scripts\*.ps1", "$Root\web\scripts\*.vbs",
  "$Root\web\tools\*.ps1", "$Root\web\tools\*.mjs", "$Root\web\tools\*.js", "$Root\web\tools\*.json",
  "$Root\web\*.json", "$Root\web\*.md",
  "$Root\core\ops\*.ps1", "$Root\core\state\*.json",
  "$Root\bridge\scripts\*.ps1", "$Root\bridge\scripts\*.bat", "$Root\bridge\scripts\*.cmd",
  "$Root\bridge\*.ps1", "$Root\bridge\*.bat", "$Root\bridge\*.cmd", "$Root\bridge\*.yaml", "$Root\bridge\*.md", "$Root\bridge\*.json",
  "$Root\bridge\workstation\*.ps1", "$Root\bridge\workstation\*.md",
  "$Root\bridge\crates\*\src\*.rs",
  "$Root\bridge\.env", "$Root\bridge\.env.example", "$Root\bridge\.env.portable.example",
  "$Root\src\ui\desktop\scripts\*.mjs", "$Root\src\ui\desktop\vite.web.config.mts",
  "$Root\src\docs\guides\antigravity-provider.md", "$Root\src\crates\aegis\src\skills\builtins\web_search.md",
  "$env:USERPROFILE\.agents\AGENTS.md", "$env:USERPROFILE\.agents\skills\*\*.md",
  "$env:LOCALAPPDATA\hermes\bin\aegis.cmd", "$env:LOCALAPPDATA\hermes\bin\aegis-cm.cmd",
  "$env:USERPROFILE\Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1"
)

$excludeRe = '\\(node_modules|\.git|logs|backups|target|dist|\.venv|\.serde|tmp)\\|\\backups\\'
$files = foreach ($p in $pats) { Get-ChildItem -Path $p -File -ErrorAction SilentlyContinue }
$files = $files | Sort-Object FullName -Unique | Where-Object { $_.FullName -notmatch $excludeRe -and $_.Name -ne 'repoint-paths-proyects.ps1' -and $_.Extension -notin '.exe', '.dll', '.png', '.jpg', '.svg', '.ico' }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bkDir = Join-Path $Root "core\backups\$stamp-proyects-repoint"
$logDir = Join-Path $Root 'core\logs\repoint'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "repoint-$stamp.log"
function W($m) { $s = ((Get-Date).ToString('HH:mm:ss') + ' ' + [string]$m); Write-Output $s; Add-Content -Path $log -Value $s -Encoding ASCII }

W ('=== reapunte ' + $(if ($Apply) { 'APPLY' } else { 'DRY-RUN' }) + ' ; archivos candidatos: ' + @($files).Count + ' ===')

$changed = @(); $totalRepl = 0
foreach ($f in $files) {
  $orig = Get-Content -Path $f.FullName -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
  if ($null -eq $orig) { continue }
  $txt = $orig; $hits = @()
  foreach ($m in $maps) {
    $c = ([regex]::Matches($txt, [regex]::Escape($m.o))).Count
    if ($c -gt 0) { $hits += ($c.ToString() + 'x ' + $m.o + ' -> ' + $m.n); $txt = $txt.Replace($m.o, $m.n) }
  }
  if ($txt -ne $orig) {
    $rel = $f.FullName.Substring($Root.Length).TrimStart('\')
    $changed += $rel; $totalRepl += ([regex]::Matches($orig, 'C:[\\/]aegis')).Count
    W ('  ' + $rel + '  ::  ' + ($hits -join ' | '))
    if ($Apply) {
      $dest = Join-Path $bkDir $rel
      New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
      Copy-Item -Path $f.FullName -Destination $dest -Force
      # preservar la presencia/ausencia de BOM: PS 5.1 no debe agregarle BOM a un JSON que node parsea
      $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
      $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
      $enc = New-Object System.Text.UTF8Encoding($hasBom)
      [System.IO.File]::WriteAllText($f.FullName, $txt, $enc)
    }
  }
}
W ('=== archivos con cambios: ' + @($changed).Count + ' ; ocurrencias de C:\Aegis-Proyects\core*: ' + $totalRepl + ' ===')
if ($Apply) { W ('backup: ' + $bkDir) }

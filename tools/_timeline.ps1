$ErrorActionPreference='SilentlyContinue'
$db = 'C:\Aegis-Proyects\state\data\sessions\sessions.db'
$rows = sqlite3 $db "select strftime('%H:%M', datetime(created_timestamp,'unixepoch','localtime')) || '|' || session_id || '|' || model from usage_ledger where created_timestamp > strftime('%s','now') - 6*3600 order by created_timestamp;"
$map = @{}
foreach ($r in $rows) { $p = $r -split '\|'; $k = $p[0]; if (-not $map.ContainsKey($k)) { $map[$k] = 0 }; $map[$k]++ }
Write-Output 'minutos con actividad (ultimas 6h): ' + $map.Count
$hs = @()
foreach ($k in ($map.Keys | Sort-Object)) { $hs += ($k + ':' + $map[$k]) }
Write-Output ($hs -join '  ')

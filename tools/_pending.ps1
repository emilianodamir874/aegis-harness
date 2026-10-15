$ErrorActionPreference='SilentlyContinue'
$db = "$env:APPDATA\Aegis\aegis\data\sessions\sessions.db"
Write-Output '== herramientas sin resultado por sesion (top 10 recientes) =='
$q = "select session_id, role, content_json, datetime(created_timestamp,'unixepoch','localtime') t from messages where session_id in (select id from sessions order by updated_at desc limit 10) order by created_timestamp;"
$rows = sqlite3 -separator $([char]9) $db $q
$open = @{}
foreach ($r in $rows) {
  $p = $r -split [char]9
  $sid = $p[0]; $content = $p[2]
  foreach ($m in [regex]::Matches($content, '"toolRequest"[^}]*"id":"([^"]+)"')) { $open[$sid + '|' + $m.Groups[1].Value] = 1 }
  foreach ($m in [regex]::Matches($content, '"toolResponse"[^}]*"id":"([^"]+)"')) { $k = $sid + '|' + $m.Groups[1].Value; if ($open.ContainsKey($k)) { $open.Remove($k) } }
}
$open.Keys | Group-Object { $_.Split('|')[0] } | Sort-Object Name -Descending | ForEach-Object { $_.Name + ' -> pendientes=' + $_.Count }

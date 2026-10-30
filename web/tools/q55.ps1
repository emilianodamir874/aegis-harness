$db='C:\Aegis-Proyects\state\data\sessions\sessions.db'
'total      = ' + (& sqlite3 $db "select count(*) from messages where session_id='20261012_55';")
'toolResp   = ' + (& sqlite3 $db "select count(*) from messages where session_id='20261012_55' and content_json like '%toolResponse%';")
'rol        = ' + ((& sqlite3 $db "select group_concat(distinct role) from messages where session_id='20261012_55';") -join ',')
$last = & sqlite3 $db "select role || ' >> ' || replace(substr(content_json,1,110),char(10),' ') from messages where session_id='20261012_55' order by rowid desc limit 2;"
'ULTIMOS:'
$last | ForEach-Object { $_ }
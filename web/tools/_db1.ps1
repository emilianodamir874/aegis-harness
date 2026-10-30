$ErrorActionPreference='SilentlyContinue'
$db = 'C:\Aegis-Proyects\state\data\sessions\sessions.db'
Write-Output '== schema usage_ledger =='
sqlite3 $db ".schema usage_ledger"
Write-Output '== schema messages =='
sqlite3 $db ".schema messages"
Write-Output '== ledger ultimas 3h por minuto =='
sqlite3 -header -column $db "select strftime('%H:%M', datetime(created_at,'unixepoch','localtime')) m, model, count(*) n, sum(output_tokens) out from usage_ledger where created_at > strftime('%s','now') - 3*3600 group by m, model order by m desc limit 40;"
Write-Output '== sesiones recientes =='
sqlite3 -header -column $db "select id, name, datetime(updated_at,'localtime') upd from sessions order by updated_at desc limit 15;"

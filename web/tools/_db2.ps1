$ErrorActionPreference='SilentlyContinue'
$db = 'C:\Aegis-Proyects\state\data\sessions\sessions.db'
Write-Output '== ledger ultimas 4h por minuto/modelo =='
sqlite3 -header -column $db "select strftime('%H:%M', datetime(created_timestamp,'unixepoch','localtime')) m, model, count(*) n, coalesce(sum(output_tokens),0) out from usage_ledger where created_timestamp > strftime('%s','now') - 4*3600 group by m, model order by m desc limit 45;"
Write-Output '== total requests ultimas 4h =='
sqlite3 -header -column $db "select count(*) n, min(datetime(created_timestamp,'unixepoch','localtime')) desde, max(datetime(created_timestamp,'unixepoch','localtime')) hasta from usage_ledger where created_timestamp > strftime('%s','now') - 4*3600;"

$ErrorActionPreference='SilentlyContinue'
$base = "$env:APPDATA\Aegis\aegis\data\logs"
Write-Output '== server dir =='
Get-ChildItem "$base\server" -Recurse -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 10 | ForEach-Object { $_.FullName + '  ' + [int]($_.Length/1KB) + 'KB  ' + $_.LastWriteTime }
Write-Output '== debug dir =='
Get-ChildItem "$base\debug" -Recurse -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 10 | ForEach-Object { $_.FullName + '  ' + [int]($_.Length/1KB) + 'KB  ' + $_.LastWriteTime }
Write-Output '== llm_request.0.jsonl tail (types) =='
$l = Get-Content "$base\llm_request.0.jsonl"
Write-Output ('lines=' + $l.Count)
try { $l | ForEach-Object { ($_ | ConvertFrom-Json) } | Group-Object -Property @{e={$_.type}} | ForEach-Object { 'type ' + $_.Name + ' = ' + $_.Count } } catch { Write-Output ('parse err: ' + $_.Exception.Message) }
Write-Output '== server.log / cli log tail =='
Get-ChildItem "$base\server" -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Length -gt 0 } | Select-Object -First 3 | ForEach-Object { Write-Output ('--- ' + $_.FullName); Get-Content $_.FullName -Tail 25 }

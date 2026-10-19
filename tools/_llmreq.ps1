$ErrorActionPreference='SilentlyContinue'
$base = 'C:\Aegis-Proyects\state\state\logs'
$l = Get-Content "$base\llm_request.0.jsonl"
Write-Output '--- line1 (first 700 chars)'
Write-Output ($l[0].Substring(0,[Math]::Min(700,$l[0].Length)))
Write-Output '--- last 2 (first 500 chars each)'
$l[-2..-1] | ForEach-Object { Write-Output ($_.Substring(0,[Math]::Min(500,$_.Length))) }

$ErrorActionPreference='SilentlyContinue'
$c = Get-Content 'C:\aegis-web\logs\client.log' -Raw
$blocks = $c -split '--- '
Write-Output ('bloques=' + ($blocks.Count - 1))
$kinds = @{}
$hits = @()
foreach ($b in $blocks) {
  if ($b -match '"kind":"([a-z]+)"') { $k = $Matches[1]; $kinds[$k] = 1 + $kinds[$k] }
  if ($b -match 'huerfano|huérfano|cortó la conexión|Se cortó|Error:|error') { $hits += ($b -replace '\s+',' ').Substring(0, [Math]::Min(260, $b.Length)) }
}
$kinds.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { 'kind ' + $_.Key + ' = ' + $_.Value }
Write-Output ('--- hits=' + $hits.Count)
$hits | Select-Object -Last 40 | ForEach-Object { Write-Output $_ }

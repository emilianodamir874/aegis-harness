param([string]$Path, [int]$Skip = 0, [int]$Count = 40)
$i = $Skip
Get-Content -LiteralPath $Path | Select-Object -Skip $Skip -First $Count | ForEach-Object {
  $i++
  '{0}: {1}' -f $i, $_
}

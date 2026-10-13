$c='C:\Users\Emiliano\.cargo\config.toml'
Write-Output ('CFG_3=' + (Get-Content $c)[2])
Write-Output ('BAK=' + (Test-Path ($c+'.bak-b')) + ' ' + (Test-Path ($c+'.bak-test')))
foreach ($f in 'goose.exe','goose-serve-v3.exe','goose-serve-v2.exe') { $p='C:\goose\target\debug\'+$f; if (Test-Path $p) { $i=Get-Item $p; Write-Output ($f + ' | ' + $i.LastWriteTime.ToString('dd/MM HH:mm:ss') + ' | ' + [math]::Round($i.Length/1MB) + 'MB') } }
$cfg = 'C:\Users\Emiliano\.cargo\config.toml'
Copy-Item $cfg ($cfg + '.bak-b') -Force
try {
  (Get-Content $cfg) -replace '^rustc-wrapper', '#rustc-wrapper' | Set-Content $cfg
  $env:RUSTC_WRAPPER = ''; $env:CARGO_BUILD_RUSTC_WRAPPER = ''
  Set-Location C:\goose
  & cargo build -p goose-cli --no-default-features --features rustls-tls,scheduler,bundled-mcp,chat-recall,acp-http,code-mode 2>&1 | Select-String -Pattern 'error|warning: unused|Finished|Compiling goose-cli' | Select-Object -Last 8 | ForEach-Object { $_.Line.Substring(0,[Math]::Min(150,$_.Line.Length)) }
  $f = Get-Item C:\goose\target\debug\goose.exe
  Copy-Item $f.FullName 'C:\goose\target\debug\goose-serve-v3.exe' -Force
  Write-Output ('EXE ' + $f.LastWriteTime.ToString('dd/MM HH:mm') + ' ' + [math]::Round($f.Length/1MB) + 'MB')
} finally {
  Copy-Item ($cfg + '.bak-b') $cfg -Force; Remove-Item ($cfg + '.bak-b') -Force
  Write-Output ('CFG_OK=' + ((Get-Content $cfg)[2]))
}
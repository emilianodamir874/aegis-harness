@echo off
cd /d C:\aegis-src
set CARGO_TERM_COLOR=never
echo === aegis-providers lib tests ===
cargo test -p aegis-providers --lib > C:\goose-web\logs\v29-t1-providers.log 2>&1
echo EXIT=%ERRORLEVEL% >> C:\goose-web\logs\v29-t1-providers.log
echo === open_design tests ===
cargo test -p aegis --features scheduler --lib providers::open_design::tests > C:\goose-web\logs\v29-t2-opendesign.log 2>&1
echo EXIT=%ERRORLEVEL% >> C:\goose-web\logs\v29-t2-opendesign.log
echo === check serve gate ===
cargo check -p aegis-cli --bin aegis --no-default-features --features rustls-tls,scheduler,bundled-mcp,chat-recall,acp-http,code-mode > C:\goose-web\logs\v29-t3-checkserve.log 2>&1
echo EXIT=%ERRORLEVEL% >> C:\goose-web\logs\v29-t3-checkserve.log
echo ALLDONE >> C:\goose-web\logs\v29-sequence.done.txt
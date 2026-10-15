@echo off
cd /d C:\aegis-src
set CARGO_TERM_COLOR=never
cargo test -p aegis --features scheduler --lib providers::open_design::tests > C:\goose-web\logs\v29-t2b-opendesign.log 2>&1
echo EXIT=%ERRORLEVEL% >> C:\goose-web\logs\v29-t2b-opendesign.log
echo T2BDONE >> C:\goose-web\logs\v29-t2b.done.txt
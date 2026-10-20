# Justfile (fork) — solo los gates que corren en esta maquina.
#
# El Justfile original del upstream (546 lineas: releases, desktop, docs, npm,
# mcp-conformance, UI) se recorto el 2026-10-20 al borrar ui/, buzz/, services/,
# oidc-proxy/ y los workflows de CI. Lo que sigue compila o testea el harness.

# list all tasks
default:
  @just --list

# Run all style checks and formatting (precommit validation)
check-everything:
    @echo "RUNNING ALL STYLE CHECKS..."
    cargo fmt --all
    cargo clippy --all-targets -- -D warnings
    @echo "OK"

# (fork) Format the workspace
fmt:
    cargo fmt --all

# (fork) Canonical compile gate for the aegis lib (mismas features que test-lib / CI)
check-lib:
    cargo check -p aegis --lib --no-default-features --features rustls-tls,code-mode,tree-sitter,live-voice,scheduler,platform-apps,chat-recall,acp-http

# (fork) Canonical compile gate for the serve binary (feature set que usa aegis-web)
check-serve:
    cargo check -p aegis-server --bin aegis-serve --no-default-features --features rustls-tls,scheduler,bundled-mcp,chat-recall,acp-http,code-mode

# (fork) Compile gate for the harness INCLUDING tests
check-tests:
    cargo check --tests -p aegis-server --no-default-features --features rustls-tls,scheduler,bundled-mcp,chat-recall

# (fork) Build the reduced-feature harness (debug)
build-cli:
    cargo build -p aegis-server --bin aegis-serve --no-default-features --features rustls-tls,scheduler,bundled-mcp

# (fork) Ship a new-named debug binary: just ship aegis-terminal-vN
ship name:
    cargo rustc -p aegis-server --bin aegis-serve --no-default-features --features rustls-tls,scheduler,bundled-mcp,chat-recall -- -o "${CARGO_TARGET_DIR:-target}/debug/{{name}}.exe"

# (fork) Run the aegis lib suite with CI's feature set
test-lib:
    cargo test -p aegis --lib --no-default-features --features rustls-tls,code-mode,tree-sitter,live-voice,scheduler,platform-apps,chat-recall,acp-http

# (fork) Provider tests (antigravity + open_design)
test-providers:
    cargo test -p aegis --features scheduler --lib providers::antigravity::tests
    cargo test -p aegis --features scheduler --lib providers::open_design::tests

# (fork) Regenerate prompt_manager snapshots (they embed ~/.agents/skills)
snap:
    $env:INSTA_UPDATE="always"; cargo test -j 1 -p aegis --no-default-features --features rustls-tls,code-mode,tree-sitter,live-voice,scheduler,platform-apps,chat-recall,acp-http --lib agents::prompt_manager::tests

# Run the ACP backend (harness) on 127.0.0.1:3000
run-server:
    @echo "Running external ACP backend..."
    AEGIS_SERVER__SECRET_KEY="${AEGIS_SERVER__SECRET_KEY:-test}" cargo run -p aegis-server --bin aegis-serve -- --platform desktop --enable-scheduler --host 127.0.0.1 --port 3000

# Justfile (fork) — los gates que corren de verdad en esta maquina.
#
# El Justfile del upstream (546 lineas: releases, desktop, docs, npm,
# mcp-conformance, UI) se recorto el 2026-10-20 al borrar ui/, buzz/, services/,
# oidc-proxy/ y los workflows de CI.
#
# Regla de este archivo: un target o corre y pasa, o no existe. Nada que compile
# un crate sin tests, nada con sintaxis bash que muera en Windows.

set windows-shell := ["powershell.exe", "-NoProfile", "-Command"]

# Set canonico para la suite de la lib `aegis`. Es el mismo que corre la CI.
ci_features := "rustls-tls,tree-sitter,live-voice,scheduler,platform-apps,chat-recall,acp-http"

# Set canonico del binario aegis-serve. Es el que usa aegis-web en produccion.
serve_features := "rustls-tls,scheduler,bundled-mcp,chat-recall,acp-http"

# Crates con tests reales (aegis-server tiene 0: no entra en check-tests)
test_crates := "aegis aegis-agent aegis-mcp aegis-context-management aegis-providers aegis-provider-types"

# list all tasks
default:
    @just --list

# Format the workspace
fmt:
    cargo fmt --all

# Fail if the workspace is not formatted
check-fmt:
    cargo fmt --all -- --check

# Clippy over every target, warnings as errors
clippy:
    cargo clippy --all-targets --no-default-features --features {{ci_features}} -- -D warnings

# Compile gate for the aegis lib (same features as test-lib)
check-lib:
    cargo check -p aegis --lib --no-default-features --features {{ci_features}}

# Compile gate for the serve binary (feature set that aegis-web runs)
check-serve:
    cargo check -p aegis-server --bin aegis-serve --no-default-features --features {{serve_features}}

# Compile gate for every crate that has tests. Compiles the test targets only,
# so an example that does not build is caught here and not at release time.
check-tests:
    cargo check --tests -p {{test_crates}} --no-default-features --features {{ci_features}}

# Everything that must pass before a commit
check-all: check-fmt check-lib check-serve check-tests
    @echo "OK"

# Suite of the aegis lib with the CI feature set
test-lib:
    cargo test -p aegis --lib --no-default-features --features {{ci_features}}

# Integration tests of the aegis crate (38 files, 305 tests)
test-integration:
    cargo test -p aegis --tests --no-default-features --features {{ci_features}}

# Suite of every crate that has tests
test-crates:
    cargo test -p aegis-agent -p aegis-mcp -p aegis-context-management -p aegis-providers -p aegis-provider-types --no-fail-fast

# Everything, no fail fast: this is the baseline command
test-all: test-crates
    cargo test -p aegis --lib --no-fail-fast --no-default-features --features {{ci_features}}
    cargo test -p aegis --tests --no-fail-fast --no-default-features --features {{ci_features}}

# Provider tests (antigravity + open_design)
test-providers:
    cargo test -p aegis --lib --features scheduler providers::antigravity::tests
    cargo test -p aegis --lib --features scheduler providers::open_design::tests

# Full baseline to scratch\baseline.tsv (exit code + seconds per step). Read-only.
baseline:
    powershell -NoProfile -ExecutionPolicy Bypass -File C:\Aegis-Proyects\core\ops\baseline-tests.ps1

# Debug build of the serve binary with the production feature set
build-cli:
    cargo build -p aegis-server --bin aegis-serve --no-default-features --features {{serve_features}}

# Release build of the serve binary with the production feature set
build-release:
    cargo build --release -p aegis-server --bin aegis-serve --no-default-features --features {{serve_features}}

# Regenerate prompt_manager snapshots (they embed ~/.agents/skills)
snap:
    $env:INSTA_UPDATE = "always"; cargo test -j 1 -p aegis --lib --no-default-features --features {{ci_features}} agents::prompt_manager::tests

# Run the ACP backend locally on 127.0.0.1:3000. Needs AEGIS_SERVER__SECRET_KEY.
run-server:
    cargo run -p aegis-server --bin aegis-serve --no-default-features --features {{serve_features}} -- --platform desktop --enable-scheduler --host 127.0.0.1 --port 3000

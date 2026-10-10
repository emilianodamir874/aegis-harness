# Antigravity provider in the Goose fork (Windows)

This provider talks directly to the Google Cloud Code Assist / Antigravity inference service. It does not launch the Antigravity desktop app or `agy.exe` for each request. It currently reuses the `gemini:antigravity` login already present in Windows Credential Manager, renews the access token in memory, and discovers the associated project. Sign in with `agy` once before using Goose. Goose does not copy the refresh token to its own configuration.

## Interactive CLI

For a first-time setup in PowerShell:

```powershell
goose configure
```

Choose `Manual Configuration` → `Antigravity` → a model. This stores your default provider and model in Goose; the Antigravity provider checks the existing `agy` login rather than asking for a new token. Then, from the project directory, launch the interactive session:

```powershell
goose
```

Inside a session, `/model` opens one searchable picker for Antigravity models and Open Design's DeepSeek V4.1 Flash effort variants; choosing a model also switches provider without losing the session. `/model --provider antigravity gemini-3.8-flash-medium` switches directly to Gemini; `/model --provider open_design deepseek-v4.1-flash-max` switches directly to DeepSeek. `/model claude-sonnet-4-6` changes only the model of the current provider, and `/status` shows the current choice.

While Goose responds, a fixed bottom prompt row shows that it is busy (the editor accepts another message once the response finishes). Successful command output is folded by default to save terminal space; `/output` shows the most recent command's full output, and `/r` turns on continuous full tool output. Command errors remain visible.

For a one-word `goose` command in PowerShell, the installed launcher `C:\Users\Emiliano\AppData\Local\hermes\bin\goose.cmd` starts this fork's interactive session in the caller's current directory, initially with Antigravity / Gemini 3.8 Flash Medium and the developer tools. It passes explicit Goose subcommands through unchanged (`goose --version`, `goose configure`, `goose run`, etc.). Alternatively, override the defaults for a single run without configuring Goose:

```powershell
goose session --provider antigravity --model gemini-3.8-flash-medium --with-builtin developer
```

You can select `gemini-3.8-flash` as an alias: with no explicit thinking effort it routes to the `-low` runtime; `medium` and `high` effort route to their respective runtimes. Explicit `-low`, `-medium`, `-high` names pass through unchanged. `claude-sonnet-4-6` is also supported; `claude-opus-4-6` routes to the `-thinking` runtime. The runtime catalog can change; static names alone do not guarantee access or remaining quota.

## Build on Windows

The default Goose CLI features can produce duplicate-symbol errors from V8 and llama.cpp in the Windows linker. Use the same feature set across rebuilds and keep `C:\goose\target` intact:

```powershell
cd C:\goose
$env:RUSTC_WRAPPER = ''
$env:CARGO_BUILD_JOBS = '4'
cargo build -p goose-cli --bin goose --no-default-features --features rustls-tls,scheduler,bundled-mcp
cargo test -p goose --features scheduler --lib providers::antigravity::tests
```

`cargo fmt --all --check` checks formatting. The provider is local fork work, not a released Goose provider; no system-wide installation is required if you call this executable by its absolute path.

## Scope and limitations

- Request metadata follows the current Antigravity client envelope. Goose's Google translator handles streamed text, thinking and tool-call signatures; the provider unwraps the Antigravity SSE response envelope.
- Metadata discovery and inference try alternative Google endpoints on transient network/server failures. A 429 reports the quota/rate-limit response and any `Retry-After` delay instead of blindly retrying with the same account. A 401 triggers one fresh token exchange and retry.
- This Windows implementation does not provide its own interactive Google OAuth login, multiple-account selection, or quota-based account failover. Its static model enum fallback may lag the live catalog. Complex tool schemas, every model family, and cross-process session attribution still require targeted end-to-end validation.
- Before any real project work, check the current Goose working directory: the `developer` extension can read and edit files and execute commands in that directory.

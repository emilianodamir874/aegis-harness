# Open Design: DeepSeek V4.1 Flash in Goose

The built-in `open_design` provider targets the Open Design OpenAI Chat Completions base URL from the connection setup screen: `https://amr-link.open-design.ai/v1`. It only exposes DeepSeek V4.1 Flash. The actual API model ID, as shown in Open Design's public model-price catalog, is `deepseek-v4.1-flash`.

## Where to put the API key (Windows)

Run `goose configure` in PowerShell. Select **Manual Configuration**, then **Open Design**. Paste your Open Design API key when prompted for `OPEN_DESIGN_API_KEY`; the input is masked and Goose saves it through its secret store (normally Windows Credential Manager). The key is not stored in this repository. The Open Design console issues/manages API keys under **API Keys**. Do not paste the key in a chat, a command-line argument or a tracked source file. `goose configure` may update Goose's global default provider/model, but the installed bare `goose` launcher deliberately still starts Antigravity unless explicitly changed.

Alternatively, a PowerShell session can supply `OPEN_DESIGN_API_KEY` as an environment variable before starting Goose; do not place its plaintext value into committed code or shell history.

Once configured, from the already-open interactive CLI:

    /model --provider open_design deepseek-v4.1-flash

Then `/model` opens a searchable picker that includes both Open Design DeepSeek and Antigravity Gemini/Claude in the same Goose session. The Open Design choices are:

- `deepseek-v4.1-flash` — server default: thinking on, high effort.
- `deepseek-v4.1-flash-none` — thinking off.
- `deepseek-v4.1-flash-low` — low.
- `deepseek-v4.1-flash-high` — high.
- `deepseek-v4.1-flash-max` — max.

These names are local Goose selections; all requests use wire model `deepseek-v4.1-flash`. An effort alias overrides an inherited global thinking-effort setting. Goose's `medium` maps to DeepSeek's `high` if explicitly configured on the plain model. The provider uses OpenAI-compatible streaming, forwards the assistant's reasoning content in tool conversations, and sends a bearer token via TLS.

Priority compute: Open Design's published pricing lists "Peak-time priority compute · lower latency" as a plan benefit. No documented per-request priority toggle for the Open Design Chat Completions API was found; Goose intentionally does not send an unverified `priority`/`service_tier` field. If the account's plan has that benefit, Open Design applies it server-side; switching an effort alias does not enable it.

Validation: unit tests and a local mocked Chat Completions SSE request verify model routing, effort controls, auth header, and streaming. A live Open Design inference requires the account's own API key; until it is configured, live connectivity is unverified.

Sources: https://open-design.ai/cloud/workspace/models , https://amr-api.open-design.ai/api/v1/public/model-prices , https://api-docs.deepseek.com/guides/thinking_mode , https://open-design.ai/pricing/

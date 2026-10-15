---
title: Set up aegis in Zed
sidebar_position: 3
description: See how Zed installs and configures aegis as an ACP agent.
---

# Set up aegis in Zed

Zed can run aegis as an ACP agent. Install aegis from the ACP Registry for the
simplest setup, or configure it manually to use your own aegis binary and
environment overrides.

## Install aegis from the ACP Registry

Zed has built-in ACP Registry support, so it can download and run aegis for you
without manual configuration.

1. Open Zed
2. Open Agent Settings
3. Click `Add Agent`, then choose `Install from Registry`
4. Select `aegis`

A registry-installed aegis runs the same `aegis acp` server and reads your
existing aegis configuration, so your providers, models, and extensions carry
over. Zed keeps the installed version up to date for you.

## Configure aegis manually

Use a custom agent if you want to run your own aegis binary, such as a local
development build, or pass environment overrides.

### Prerequisites

Ensure you have both Zed and the aegis CLI installed:

- **Zed**: Download from [zed.dev](https://zed.dev/)
- **aegis CLI**: Follow the [installation guide](/docs/getting-started/installation)

Verify aegis is installed:

```bash
aegis --version
```

### Add aegis to your Zed settings

1. Open Zed
2. Open Agent Settings, click `Add Agent`, then choose `Add Custom Agent`. Zed
   scaffolds an `agent_servers` entry and opens your settings file
3. Edit the entry so it runs aegis:

```json
{
  "agent_servers": {
    "aegis": {
      "type": "custom",
      "command": "aegis",
      "args": ["acp"]
    }
  }
}
```

You can now interact with aegis directly in Zed. ACP sessions use the extensions
enabled in your aegis configuration, so their tools are also available in Zed.

## Override the provider and model

By default, aegis uses the provider and model defined in your
[configuration file](/docs/guides/config-files). Override them for a specific
agent configuration with the `AEGIS_PROVIDER` and `AEGIS_MODEL` environment
variables.

This example configures two aegis agents with different model settings:

```json
{
  "agent_servers": {
    "aegis": {
      "type": "custom",
      "command": "aegis",
      "args": ["acp"]
    },
    "aegis (GPT-4o)": {
      "type": "custom",
      "command": "aegis",
      "args": ["acp"],
      "env": {
        "AEGIS_PROVIDER": "openai",
        "AEGIS_MODEL": "gpt-4o"
      }
    }
  }
}
```

## Use Zed MCP servers with aegis

MCP servers in Zed's `context_servers` configuration are automatically
available to aegis. This lets native Zed features and the aegis agent use the
same MCP servers.

```json
{
  "context_servers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/path/to/allowed/dir"
      ]
    }
  },
  "agent_servers": {
    "aegis": {
      "type": "custom",
      "command": "aegis",
      "args": ["acp"]
    }
  }
}
```

All MCP servers in `context_servers` are available to aegis when they use stdio
(command-based) or HTTP transports. aegis does not support servers using the
deprecated SSE transport.

If a server in `context_servers` has the same name as a aegis extension, aegis
uses its own [configuration](/docs/guides/config-files).

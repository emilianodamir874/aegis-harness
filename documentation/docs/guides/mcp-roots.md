---
sidebar_position: 56
title: MCP Roots
sidebar_label: MCP Roots
description: How aegis shares your working directory with roots-aware MCP extensions
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';
import { PanelLeft } from 'lucide-react';

MCP Roots lets aegis share your session working directory with roots-aware MCP extensions.

This helps extensions understand which folder to use as the active workspace for the current session.

:::info
[MCP Roots](https://modelcontextprotocol.io/specification/2025-06-18/client/roots) is a feature in the Model Context Protocol. aegis automatically enables it for MCP extensions that support roots.
:::

## How MCP Roots Works

When aegis connects to an MCP extension, it advertises roots support during MCP initialization.

An extension that supports roots can then:

- Request the current root list from aegis
- Treat that root as the active workspace boundary
- React if the root changes during the session

In aegis, the root list currently contains one entry:

- Your current session working directory

If you change the session working directory, aegis updates the root and notifies connected extensions automatically.

## Using MCP Roots

There is no separate "Roots" settings screen in aegis. MCP Roots follows the working directory you are already using for the session.

<Tabs groupId="interface">
  <TabItem value="ui" label="aegis Desktop" default>

  In aegis Desktop, the current working directory appears at the bottom of the chat window.

  1. Click the directory display to choose a different folder
  2. aegis updates the session working directory
  3. Connected roots-aware extensions receive the updated root automatically

  To change directories:

  1. Click the <PanelLeft className="inline" size={16} /> button if needed and open a session
  2. Use the directory control shown at the bottom of the chat window
  3. Pick the folder you want aegis and your extensions to work in

  </TabItem>
  <TabItem value="cli" label="aegis CLI">

  In aegis CLI, the session root follows the directory where you launch aegis.

  - Start aegis from the project folder you want to work in
  - When resuming a session, aegis may prompt you to switch back to that session's original working directory

  This means roots-aware extensions see the same workspace directory that aegis is already using in the CLI.

  </TabItem>
</Tabs>

## What Extensions Use It For

MCP Roots is useful for extensions that need to work with local files or understand your project structure.

Without roots, an extension may need to guess which folder you mean or rely on custom configuration. With roots, aegis can tell the extension which directory is currently in scope for the session.

For example, an extension can use roots to:

- Discover the active project directory
- Scope file operations to your current workspace
- Avoid guessing which repository or folder you meant
- Update its behavior when you switch to a different project

## Current Limitations

aegis currently exposes a single root per session rather than a multi-folder workspace. For most workflows, this maps cleanly to how aegis already works: one active project directory at a time.

If you want an extension to work in a different location, change the session working directory first.

## For Extension Developers

If you're building an MCP extension for aegis, support for roots allows your extension to discover the active workspace directory in a standard way instead of relying on custom configuration.

For protocol details, see the [MCP Roots specification](https://modelcontextprotocol.io/specification/2025-06-18/client/roots).

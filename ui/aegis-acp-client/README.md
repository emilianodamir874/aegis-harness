# @aaif/goose-acp-client

TypeScript client library for communicating with Aegis over an existing Agent
Client Protocol (ACP) transport.

This package provides:

- TypeScript types and Zod validators for Aegis ACP extension methods
- `AegisExtClient` for calling Aegis extension methods
- Client capability definitions and MCP Apps helpers

It does not install, resolve, or start the Aegis executable. Applications own
the transport and process lifecycle.

## Installation

```bash
npm install @aaif/goose-acp-client @agentclientprotocol/sdk
```

## Usage

Compose the Aegis extension client with the standard ACP SDK:

```typescript
import {
  client as createAcpClient,
  methods,
  PROTOCOL_VERSION,
  type Stream,
} from "@agentclientprotocol/sdk";
import { AegisExtClient } from "@aaif/goose-acp-client";

async function connectToAegis(stream: Stream) {
  const app = createAcpClient({ name: "my-product" });
  const connection = app.connect(stream);
  const aegis = new AegisExtClient(connection.agent);

  await connection.agent.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientInfo: {
      name: "my-product",
      version: "1.0.0",
    },
    clientCapabilities: {},
  });

  return { connection, aegis };
}
```

The application creates and owns the `stream`, including its connection and
process lifecycle. Call `connection.close()` when the application no longer
needs the connection.

## Development

From `ui/aegis-acp-client`:

```bash
pnpm run build
```

The generated TypeScript types come from the Rust schemas in `crates/aegis`.

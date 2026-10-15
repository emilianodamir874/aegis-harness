# @aaif/goose-acp

Install and resolve the Aegis executable through npm.

This package distributes the Aegis CLI using platform-specific optional npm
dependencies. It does not contain or depend on the Aegis ACP client.

## Installation

```bash
npm install @aaif/goose-acp
```

The matching `@aaif/goose-binary-*` package is installed automatically. Do not
install a platform package directly; `@aaif/goose-acp` provides the supported
`aegis` command.

## Usage

Run the Aegis CLI installed by the package:

```bash
npx aegis acp
npx aegis serve
```

The launcher forwards arguments and standard input, output, and error streams to
the native executable. It preserves the executable's exit status and forwards
termination signals.

Resolve the executable path programmatically:

```typescript
import { resolveAegisBinary } from "@aaif/goose-acp";

const binaryPath = resolveAegisBinary();
```

`resolveAegisBinary()` first uses `AEGIS_BINARY` when it is set. Otherwise, it
selects the package matching `process.platform` and `process.arch`. In both
cases it verifies that the executable exists and returns an absolute path.

Use the override to run a locally built or custom Aegis executable:

```bash
AEGIS_BINARY=/path/to/aegis npx aegis acp
```

`AEGIS_BINARY` must point directly to a native Aegis executable, not a
`node_modules/.bin/aegis` command shim.

Supported platforms:

| Operating system | Architecture |
| ---------------- | ------------ |
| macOS            | ARM64        |
| macOS            | x64          |
| Linux            | ARM64        |
| Linux            | x64          |
| Windows          | x64          |

Package managers must install optional dependencies. If optional dependencies
are disabled, the resolver reports which platform package is missing.

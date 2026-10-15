import type { AegisMcpHostCapabilities } from "./mcp-apps.js";

export interface AegisClientCapabilitiesMeta {
  aegis?: {
    mcpHostCapabilities?: AegisMcpHostCapabilities;
    customNotifications?: boolean;
  };
}

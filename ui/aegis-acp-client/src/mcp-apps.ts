import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  McpUiAppResourceConfig,
  McpUiAppToolConfig,
} from "@modelcontextprotocol/ext-apps/server";
import type {
  BlobResourceContents,
  ReadResourceResult,
  TextResourceContents,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

export const AEGIS_MCP_UI_EXTENSION_ID = "io.modelcontextprotocol/ui" as const;

export interface AegisMcpUiExtensionSettings {
  mimeTypes: string[];
}

export interface AegisMcpHostCapabilities {
  extensions: Record<string, AegisMcpUiExtensionSettings>;
}

export type AegisToolUiMetadata = Extract<
  McpUiAppToolConfig["_meta"],
  { ui: unknown }
>["ui"];

export type AegisToolMetadata = NonNullable<Tool["_meta"]> & {
  ui?: AegisToolUiMetadata;
  aegis_extension?: string;
};

export type AegisSessionTool = Tool & {
  meta?: AegisToolMetadata;
  _meta?: AegisToolMetadata;
};

export type AegisTextResourceContents = TextResourceContents;

export type AegisBlobResourceContents = BlobResourceContents;

export type AegisResourceContents = TextResourceContents | BlobResourceContents;

export type AegisReadResourceResult = ReadResourceResult;

export type AegisResourceMetadata = NonNullable<
  Extract<NonNullable<McpUiAppResourceConfig["_meta"]>, { ui?: unknown }>["ui"]
>;

export interface AegisMcpAppToolPayload {
  toolName: string;
  extensionName: string;
  resourceUri: string;
  toolMeta?: AegisToolMetadata;
  resourceResult?: AegisReadResourceResult | null;
  readError?: string;
}

export interface AegisToolCallUpdateMeta {
  aegis?: {
    mcpApp?: AegisMcpAppToolPayload;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export const DEFAULT_AEGIS_MCP_HOST_CAPABILITIES: AegisMcpHostCapabilities = {
  extensions: {
    [AEGIS_MCP_UI_EXTENSION_ID]: {
      mimeTypes: [RESOURCE_MIME_TYPE],
    },
  },
};

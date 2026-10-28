// Tipos del cable ACP tal como los manda el serve de Aegis.
//
// Fuente: crates/aegis-sdk-types/src/custom_requests.rs y
// ~/.cargo/registry/.../agent-client-protocol-schema-1.9.1/src/v1/{agent,client,tool_call}.rs
// (serde rename_all = camelCase en los request/response custom; los enums de sesión usan
// `sessionUpdate` como discriminante). No se inventa ningún campo: lo que no está acá no
// se lee del socket.

export const ACP_PROTOCOL_VERSION = 1;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: number | string;
  readonly result?: unknown;
  readonly error?: JsonRpcError;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** Respuesta a un pedido del servidor (permission, por ahora la única que manejamos). */
export interface JsonRpcServerRequest {
  readonly jsonrpc: '2.0';
  readonly id: number | string;
  readonly method: string;
  readonly params?: unknown;
}

// ---------------------------------------------------------------------------
// Contenido
// ---------------------------------------------------------------------------

export interface WireText {
  readonly type: 'text';
  readonly text: string;
}

export interface WireImage {
  readonly type: 'image';
  readonly mimeType: string;
  readonly data: string;
  readonly uri?: string | null;
}

export interface WireResourceLink {
  readonly type: 'resource_link';
  readonly uri: string;
  readonly name: string;
  readonly mimeType?: string | null;
}

export type WireContentBlock = WireText | WireImage | WireResourceLink;

export interface WireContentChunk {
  readonly messageId?: string | null;
  readonly content: WireContentBlock;
  readonly _meta?: WireMeta | null;
}

export interface WireMeta {
  readonly aegis?: {
    readonly agentVisible?: boolean;
    readonly activeRunId?: string | null;
    readonly queuedSteer?: { readonly messageId?: string } | null;
    readonly toolCall?: { readonly toolName?: string } | null;
  } | null;
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Herramientas
// ---------------------------------------------------------------------------

export type WireToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type WireToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export interface WireDiff {
  readonly type: 'diff';
  readonly path: string;
  readonly oldText?: string | null;
  readonly newText: string;
}

export interface WireToolContent {
  readonly type: 'content';
  readonly content: WireContentBlock;
}

export interface WireTerminal {
  readonly type: 'terminal';
  readonly terminalId: string;
}

export type WireToolCallContent = WireToolContent | WireDiff | WireTerminal;

export interface WireToolCall {
  readonly toolCallId: string;
  readonly title?: string;
  readonly name?: string | null;
  readonly kind?: WireToolKind;
  readonly status?: WireToolStatus;
  readonly content?: readonly WireToolCallContent[];
  readonly rawInput?: Record<string, unknown> | null;
  readonly rawOutput?: unknown;
  readonly _meta?: WireMeta | null;
  readonly messageId?: string | null;
}

export interface WireToolCallUpdate {
  readonly toolCallId: string;
  readonly title?: string;
  readonly name?: string | null;
  readonly kind?: WireToolKind;
  readonly status?: WireToolStatus;
  readonly content?: readonly WireToolCallContent[];
  readonly rawInput?: Record<string, unknown> | null;
  readonly rawOutput?: unknown;
  readonly _meta?: WireMeta | null;
  readonly messageId?: string | null;
}

// ---------------------------------------------------------------------------
// Actualizaciones de sesión
// ---------------------------------------------------------------------------

export interface WireSessionInfoUpdate {
  readonly sessionUpdate: 'session_info_update';
  readonly title?: string;
  readonly updatedAt?: string;
  readonly _meta?: WireMeta | null;
}

export interface WireUsageUpdate {
  readonly sessionUpdate: 'usage_update';
  readonly used?: number | null;
  readonly size?: number | null;
  readonly totalTokens?: number | null;
  readonly contextLimit?: number | null;
  readonly cost?: number | null;
  readonly accumulatedCost?: number | null;
  readonly accumulatedInputTokens?: number | null;
  readonly accumulatedOutputTokens?: number | null;
  readonly autoCompactAt?: number | null;
  readonly compactionCalls?: number | null;
  readonly contextBreakdown?: readonly unknown[];
  readonly modelUsage?: readonly {
    readonly model?: string;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cost?: number;
  }[];
}

export interface WireMessageUsage {
  readonly sessionUpdate: 'message_usage';
  readonly messageId?: string;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
    readonly cost?: number;
    readonly tokensPerSecond?: number | null;
    readonly generationMs?: number | null;
  } | null;
}

export interface WireAvailableCommands {
  readonly sessionUpdate: 'available_commands_update';
  readonly availableCommands: readonly { readonly name: string; readonly description?: string }[];
}

export interface WireConfigOptionUpdate {
  readonly sessionUpdate: 'config_option_update';
  readonly configOptions?: readonly WireConfigOption[];
}

export interface WireCurrentModeUpdate {
  readonly sessionUpdate: 'current_mode_update';
  readonly currentModeId?: string;
  readonly modes?: WireModes;
}

export interface WireStatusMessage {
  readonly sessionUpdate: 'status_message';
  readonly status?: { readonly type?: string; readonly message?: string };
}

export interface WirePlan {
  readonly sessionUpdate: 'plan';
  readonly entries?: readonly { readonly content?: string; readonly status?: string; readonly priority?: string }[];
}

export type WireSessionUpdate =
  | ({ readonly sessionUpdate: 'user_message_chunk' } & WireContentChunk)
  | ({ readonly sessionUpdate: 'agent_message_chunk' } & WireContentChunk)
  | ({ readonly sessionUpdate: 'agent_thought_chunk' } & WireContentChunk)
  | ({ readonly sessionUpdate: 'tool_call' } & WireToolCall)
  | ({ readonly sessionUpdate: 'tool_call_update' } & WireToolCallUpdate)
  | WireSessionInfoUpdate
  | WireUsageUpdate
  | WireMessageUsage
  | WireAvailableCommands
  | WireConfigOptionUpdate
  | WireCurrentModeUpdate
  | WireStatusMessage
  | WirePlan;

export interface WireSessionNotification {
  readonly sessionId: string;
  readonly update: WireSessionUpdate;
}

export interface WireAegisNotification extends WireSessionNotification {
  readonly aegis?: { readonly activeRunId?: string | null; readonly watcherCount?: number | null } | null;
}

export interface WireReplayGap {
  readonly sessionId: string;
  readonly reason?: string;
  readonly dropped?: number;
}

// ---------------------------------------------------------------------------
// Configuración de sesión
// ---------------------------------------------------------------------------

export interface WireConfigOption {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly currentValue?: string;
  readonly kind?: string;
  readonly options?: readonly { readonly value: string; readonly name: string }[];
}

export interface WireModes {
  readonly currentModeId?: string;
  readonly availableModes?: readonly { readonly id: string; readonly name: string; readonly description?: string }[];
}

export interface WireSessionLoadResponse {
  readonly modes?: WireModes;
  readonly configOptions?: readonly WireConfigOption[];
  readonly _meta?: { readonly replaySkipped?: number } | null;
}

export interface WireSessionRow {
  readonly sessionId: string;
  readonly title?: string;
  readonly updatedAt?: string;
  readonly _meta?: { readonly messageCount?: number; readonly createdAt?: string; readonly archivedAt?: string | null } | null;
}

export interface WireSessionListResponse {
  readonly sessions?: readonly WireSessionRow[];
  readonly nextCursor?: string | null;
}

export interface WireSessionNewResponse {
  readonly sessionId: string;
  readonly configOptions?: readonly WireConfigOption[];
  readonly modes?: WireModes;
}

export interface WireSessionWatchResponse {
  readonly activeRunId: string | null;
  readonly cursor: number;
  readonly epoch: string;
  readonly replay?: readonly JsonRpcNotification[];
}

export interface WirePermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string;
  readonly _meta?: WireMeta | null;
}

export interface WirePermissionRequest {
  readonly sessionId: string;
  readonly toolCall?: WireToolCallUpdate;
  readonly options: readonly WirePermissionOption[];
  readonly _meta?: WireMeta | null;
}

export interface WireRewindResponse {
  readonly hidden: number;
  readonly messageId: string;
  readonly text: string;
  readonly preview: string;
}

export interface WireSteerResponse {
  readonly runId: string;
  readonly messageId: string;
}

export interface WireSessionInfoResponse {
  readonly session: {
    readonly sessionId?: string;
    readonly title?: string;
    readonly cwd?: string;
    readonly _meta?: {
      readonly activeRunId?: string | null;
      readonly watcherCount?: number | null;
      readonly lastMessageAt?: string;
      readonly messageCount?: number;
    } | null;
  };
}

// ---------------------------------------------------------------------------
// Lectura defensiva
// ---------------------------------------------------------------------------

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);
export const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
export const asBoolean = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

export function parseJsonRpc(raw: unknown): JsonRpcMessage | JsonRpcServerRequest | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const hasMethod = typeof parsed['method'] === 'string';
  const hasId = typeof parsed['id'] === 'number' || typeof parsed['id'] === 'string';
  if (hasMethod && hasId) return parsed as unknown as JsonRpcServerRequest;
  if (hasMethod) return parsed as unknown as JsonRpcNotification;
  if (hasId) return parsed as unknown as JsonRpcResponse;
  return null;
}

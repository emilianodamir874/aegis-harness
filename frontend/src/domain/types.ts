import type {
  AttachmentId,
  BlockId,
  MessageId,
  PermissionId,
  RunId,
  Seq,
  SessionId,
  ToolCallId,
} from './ids';

// ---------------------------------------------------------------------------
// Contenido
// ---------------------------------------------------------------------------

export interface TextBlock {
  readonly type: 'text';
  readonly text: string;
}

export interface ImageBlock {
  readonly type: 'image';
  readonly mimeType: string;
  readonly data: string;
  readonly name?: string;
}

export type ContentBlock = TextBlock | ImageBlock;

/** Archivo adjunto del compositor. `text` para archivos de texto, `data` base64 para imágenes. */
export interface Attachment {
  readonly id: AttachmentId;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly text?: string;
  readonly data?: string;
}

// ---------------------------------------------------------------------------
// Mensajes y bloques
// ---------------------------------------------------------------------------

export type MessageRole = 'user' | 'assistant';
export type MessageKind = 'user' | 'assistant' | 'thought' | 'system';

export interface MessageEntity {
  readonly id: MessageId;
  readonly sessionId: SessionId;
  readonly role: MessageRole;
  readonly kind: MessageKind;
  /** Orden de llegada. Monótono dentro de la sesión. */
  readonly seq: Seq;
  readonly blocks: readonly BlockId[];
  readonly createdAt: number;
  /** El mensaje no se le manda al modelo (rewind). Se muestra atenuado. */
  readonly hidden: boolean;
  /** Lo mandó el usuario pero todavía no lo confirmó el servidor. */
  readonly pending: boolean;
}

export type BlockStatus = 'streaming' | 'complete' | 'failed';

export interface BlockEntity {
  readonly id: BlockId;
  readonly messageId: MessageId;
  readonly sessionId: SessionId;
  readonly kind: MessageKind;
  readonly text: string;
  readonly status: BlockStatus;
  /** URL de objeto para imágenes ya decodificadas (no se guarda base64 en el DOM). */
  readonly imageUrl?: string;
  readonly mimeType?: string;
  readonly attachmentName?: string;
}

// ---------------------------------------------------------------------------
// Herramientas
// ---------------------------------------------------------------------------

export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type ToolKind =
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

export interface ToolDiff {
  readonly path: string;
  readonly oldText?: string;
  readonly newText: string;
  /** `true` si el par before/after viene de rawInput de edit/write, no de un bloque Diff ACP. */
  readonly requested: boolean;
}

export interface ToolEntity {
  readonly id: ToolCallId;
  readonly sessionId: SessionId;
  /** Mensaje al que pertenece la tarjeta (el assistant en curso cuando llegó). */
  readonly messageId: MessageId | null;
  readonly title: string;
  readonly name: string | null;
  readonly kind: ToolKind;
  readonly status: ToolStatus;
  readonly seq: Seq;
  readonly rawInput: Readonly<Record<string, unknown>> | null;
  readonly output: string;
  readonly diffs: readonly ToolDiff[];
  /** El resultado llegó después de un corte; la tarjeta lo dice en vez de fingir que sigue. */
  readonly interrupted: boolean;
  readonly updatedAt: number;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface RunEntity {
  readonly id: RunId;
  readonly sessionId: SessionId;
  readonly startedAt: number;
  readonly endedAt: number | null;
  /** Se adoptó al reconectar: el turno lo arrancó otra conexión. */
  readonly adopted: boolean;
  readonly cancelledByUser: boolean;
  /** El prompt local que originó el run, si lo hubo. */
  readonly promptId: string | null;
}

// ---------------------------------------------------------------------------
// Permisos
// ---------------------------------------------------------------------------

export interface PermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string;
}

export interface PermissionRequest {
  readonly id: PermissionId;
  readonly sessionId: SessionId;
  readonly toolCallId: ToolCallId | null;
  readonly title: string;
  readonly options: readonly PermissionOption[];
  readonly createdAt: number;
}

// ---------------------------------------------------------------------------
// Sesión
// ---------------------------------------------------------------------------

export interface SessionConfigOption {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly currentValue?: string;
  readonly options?: readonly { readonly value: string; readonly name: string }[];
}

export interface SessionMode {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface SessionSummary {
  readonly id: SessionId;
  readonly title: string;
  readonly updatedAt: string | null;
  readonly createdAt: string | null;
  readonly messageCount: number | null;
  readonly cwd: string | null;
  readonly archived: boolean;
  /** El servidor dice que hay un run en vuelo para esta sesión. */
  readonly running: boolean;
}

export interface SessionState {
  readonly summary: SessionSummary;
  readonly messages: readonly MessageId[];
  readonly messageIndex: Readonly<Record<string, MessageEntity>>;
  readonly blocks: Readonly<Record<string, BlockEntity>>;
  readonly tools: readonly ToolCallId[];
  readonly toolIndex: Readonly<Record<string, ToolEntity>>;
  readonly run: RunEntity | null;
  readonly permissions: readonly PermissionId[];
  readonly configOptions: readonly SessionConfigOption[];
  readonly modes: readonly SessionMode[];
  readonly currentModeId: string | null;
  /** Mensajes que el server omitió al abrir el chat (cola recortada). */
  readonly replaySkipped: number;
  /** El historial completo ya se cargó con `full`. */
  readonly fullHistory: boolean;
  /** Marca de rewind: desde este mensaje en adelante nada lo ve el modelo. */
  readonly hiddenFrom: MessageId | null;
  readonly lastAppliedCursor: number | null;
  readonly epoch: string | null;
  /** Estado del watch de esta sesión. */
  readonly watch: 'off' | 'watching' | 'replaying' | 'gap' | 'unsupported';
  /** Uso de contexto/tokens de la sesión. */
  readonly usage: SessionUsage | null;
  /** Última tasa de generación medida (tokens/s), para el velocímetro. */
  readonly speed: number | null;
  /** Texto de progreso del servidor (status_message) para la barra de turno. */
  readonly statusText: string | null;
}

export interface SessionUsage {
  readonly used: number | null;
  readonly limit: number | null;
  readonly cost: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly autoCompactAt: number | null;
  readonly modelUsage: readonly { readonly model: string; readonly inputTokens: number; readonly outputTokens: number; readonly cost: number }[];
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

export interface QueuedPrompt {
  /** Id local; el servidor devuelve su propio messageId al confirmarlo. */
  readonly id: string;
  readonly text: string;
  readonly attachments: readonly Attachment[];
  readonly createdAt: number;
  readonly state: 'queued' | 'sending' | 'delivered' | 'failed';
  readonly error?: string;
}

export interface SteerMessage {
  readonly id: string;
  readonly messageId: MessageId;
  readonly text: string;
  readonly createdAt: number;
  readonly state: 'queued' | 'delivered' | 'failed';
  readonly serverQueued: boolean;
}

// ---------------------------------------------------------------------------
// Estado global
// ---------------------------------------------------------------------------

export type ConnectionStatus = 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'closed';

export interface ServerInfo {
  readonly name: string;
  readonly version: string;
  readonly acpUrl: string;
  readonly webHost: string;
}

export interface AppState {
  readonly connection: ConnectionStatus;
  /** Backoff actual en ms, para mostrarlo. */
  readonly retryIn: number | null;
  readonly server: ServerInfo | null;
  readonly activeSessionId: SessionId | null;
  readonly sessions: readonly SessionId[];
  readonly sessionIndex: Readonly<Record<string, SessionState>>;
  readonly archived: readonly SessionId[];
  /** Permisos pedidos por una sesión que no está en pantalla. */
  readonly pendingBySession: Readonly<Record<string, number>>;
  /** Pedidos de permiso vivos, por id. La sesión guarda sólo sus ids. */
  readonly permissionIndex: Readonly<Record<string, PermissionRequest>>;
  readonly queue: readonly QueuedPrompt[];
  readonly steers: readonly SteerMessage[];
  /** Último error visible (toast). */
  readonly lastError: string | null;
  /** Avisos accionables de la conexión: "turno interrumpido", "replay incompleto", etc. */
  readonly notices: readonly Notice[];
  /** Modo de permisos elegido por el operador (plan / revisar / ejecutar). */
  readonly permissionMode: 'plan' | 'revisar' | 'ejecutar';
  readonly seq: Seq;
}

export interface Notice {
  readonly id: string;
  readonly level: 'info' | 'warn' | 'error';
  readonly text: string;
  readonly at: number;
}

// ---------------------------------------------------------------------------
// Eventos del reducer
// ---------------------------------------------------------------------------

export type AppEvent =
  | { type: 'connection/status'; status: ConnectionStatus; retryIn?: number | null }
  | { type: 'connection/server'; server: ServerInfo }
  | { type: 'notice/push'; level: Notice['level']; text: string; id?: string }
  | { type: 'notice/dismiss'; id: string }
  | { type: 'permission/mode'; mode: 'plan' | 'revisar' | 'ejecutar' }
  | { type: 'sessions/replaced'; sessions: readonly SessionSummary[]; archived: readonly SessionSummary[] }
  | { type: 'sessions/upsert'; session: SessionSummary }
  | { type: 'sessions/removed'; sessionId: SessionId; archived: boolean }
  | { type: 'session/open'; summary: SessionSummary; configOptions?: readonly SessionConfigOption[]; modes?: readonly SessionMode[]; currentModeId?: string | null }
  | { type: 'session/reset'; sessionId: SessionId }
  | { type: 'session/close' }
  | { type: 'session/config'; sessionId: SessionId; configOptions: readonly SessionConfigOption[] }
  | { type: 'session/modes'; sessionId: SessionId; modes: readonly SessionMode[]; currentModeId?: string | null }
  | { type: 'session/title'; sessionId: SessionId; title: string }
  | { type: 'session/replaySkipped'; sessionId: SessionId; skipped: number; full: boolean }
  | { type: 'session/watch'; sessionId: SessionId; status: SessionState['watch']; cursor?: number | null; epoch?: string | null }
  | { type: 'session/hiddenFrom'; sessionId: SessionId; from: MessageId | null }
  | { type: 'session/usage'; sessionId: SessionId; usage: SessionUsage }
  | { type: 'session/speed'; sessionId: SessionId; speed: number | null }
  | { type: 'session/status'; sessionId: SessionId; text: string | null }
  | { type: 'run/started'; sessionId: SessionId; runId: RunId; adopted: boolean; promptId?: string | null }
  | { type: 'run/ended'; sessionId: SessionId; runId?: RunId | null; cancelled?: boolean }
  | { type: 'message/chunk'; sessionId: SessionId; messageId: MessageId; kind: MessageKind; text: string; hidden: boolean; restart?: boolean }
  | { type: 'message/image'; sessionId: SessionId; messageId: MessageId; kind: MessageKind; mimeType: string; data: string; name?: string; hidden: boolean }
  | { type: 'message/local'; sessionId: SessionId; messageId: MessageId; role: 'user'; text: string; attachments?: readonly Attachment[]; pending: boolean }
  | { type: 'message/adopt'; sessionId: SessionId; localId: MessageId; serverId: MessageId }
  | { type: 'message/confirmed'; sessionId: SessionId; messageId: MessageId; serverId: MessageId }
  | { type: 'message/hide'; sessionId: SessionId; from: MessageId; hidden: boolean }
  | { type: 'tool/upsert'; sessionId: SessionId; tool: ToolUpsert }
  | { type: 'tools/interrupt'; sessionId: SessionId }
  | { type: 'permission/request'; sessionId: SessionId; request: PermissionRequest }
  | { type: 'permission/resolved'; sessionId: SessionId; permissionId: PermissionId }
  | { type: 'queue/add'; prompt: QueuedPrompt }
  | { type: 'queue/update'; id: string; state: QueuedPrompt['state']; error?: string }
  | { type: 'queue/remove'; id: string }
  | { type: 'steer/add'; steer: SteerMessage }
  | { type: 'steer/update'; messageId: MessageId; state: SteerMessage['state']; serverQueued?: boolean }
  | { type: 'error/set'; message: string | null };

export interface ToolUpsert {
  readonly id: ToolCallId;
  readonly title?: string;
  readonly name?: string | null;
  readonly kind?: ToolKind;
  readonly status?: ToolStatus;
  readonly rawInput?: Record<string, unknown> | null;
  readonly outputChunk?: string;
  readonly diffs?: readonly ToolDiff[];
  readonly interrupted?: boolean;
  readonly messageId?: MessageId | null;
}

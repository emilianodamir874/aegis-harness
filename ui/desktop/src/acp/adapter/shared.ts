import type { ToolCall, ToolCallUpdate } from '@agentclientprotocol/sdk';
import type { TokenState } from '../../types/chat';
import type { Message, NotificationEvent } from '../../types/message';

export type AcpChatStateChange =
  | { type: 'messages'; messages: Message[] }
  | { type: 'tokenState'; tokenState: Partial<TokenState> }
  | { type: 'progressMessage'; message: string | undefined }
  | {
      type: 'sessionInfo';
      name?: string;
      activeRunId?: string | null;
      aegisMode?: string;
    }
  | { type: 'localSteerConfirmed'; messageId: string }
  | { type: 'notification'; notification: NotificationEvent };

export interface AdapterState {
  messages: Message[];
  localSteerTextByMessageId: Map<string, string>;
  toolCallStatesById: Map<string, ToolCallState>;
}

export type ToolCallState = Omit<ToolCallUpdate, '_meta'>;

export interface AegisMessageMeta {
  messageId?: string;
  created?: number;
  outputTokenLimitReached?: boolean;
  fallbackContent?: boolean;
  steer?: boolean;
}

export interface ToolIdentity {
  toolName?: string;
  extensionName?: string;
}

export const DEFAULT_VISIBLE_MESSAGE_METADATA: Message['metadata'] = {
  userVisible: true,
  agentVisible: true,
};

export function messagesChange(state: AdapterState): AcpChatStateChange[] {
  // Pass the live array by reference: the store is the only consumer and it
  // clones on write (applyChatStateChanges). Cloning here as well made every
  // streamed chunk O(messages) twice, which turns session-load replay into
  // O(n^2) on large sessions.
  return [{ type: 'messages', messages: state.messages }];
}

export function cloneMessage(message: Message): Message {
  return {
    ...message,
    content: message.content.map((content) => ({ ...content })),
    metadata: { ...message.metadata },
  };
}

export function getAegisMessageMeta(update: { _meta?: unknown }): AegisMessageMeta {
  if (!isRecord(update._meta)) {
    return {};
  }

  const aegis = update._meta.aegis;
  if (!isRecord(aegis)) {
    return {};
  }

  const outputTokenLimitReached = aegis.outputTokenLimitReached === true;

  return {
    created: typeof aegis.created === 'number' ? aegis.created : undefined,
    messageId: typeof aegis.messageId === 'string' ? aegis.messageId : undefined,
    outputTokenLimitReached: outputTokenLimitReached ? true : undefined,
    fallbackContent: aegis.fallbackContent === true ? true : undefined,
    steer: aegis.steer === true ? true : undefined,
  };
}

export function getAegisActiveRunId(update: { _meta?: unknown }): string | null | undefined {
  if (!isRecord(update._meta)) {
    return undefined;
  }

  const aegis = update._meta.aegis;
  if (!isRecord(aegis) || !('activeRunId' in aegis)) {
    return undefined;
  }

  return typeof aegis.activeRunId === 'string' || aegis.activeRunId === null
    ? aegis.activeRunId
    : undefined;
}

export function getAegisQueuedSteer(update: { _meta?: unknown }): string | undefined {
  if (!isRecord(update._meta)) return undefined;
  const aegis = update._meta.aegis;
  if (!isRecord(aegis) || !isRecord(aegis.queuedSteer)) return undefined;
  return typeof aegis.queuedSteer.messageId === 'string' ? aegis.queuedSteer.messageId : undefined;
}

export function rawInputToArguments(rawInput: unknown): Record<string, unknown> {
  return isRecord(rawInput) ? rawInput : {};
}

export function toolIdentity(update: ToolCall | ToolCallUpdate): ToolIdentity {
  if (!isRecord(update._meta)) {
    return {};
  }

  const aegis = update._meta.aegis;
  if (!isRecord(aegis) || !isRecord(aegis.toolCall)) {
    return {};
  }

  return {
    toolName: typeof aegis.toolCall.toolName === 'string' ? aegis.toolCall.toolName : undefined,
    extensionName:
      typeof aegis.toolCall.extensionName === 'string' ? aegis.toolCall.extensionName : undefined,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

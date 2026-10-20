import type { AegisSessionNotification_unstable } from '@aaif/goose-acp-client';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { Message } from '../types/message';
import {
  applyElicitationRequest as applyElicitationRequestToState,
  applyElicitationStatus as applyElicitationStatusToState,
  type ElicitationStatus,
} from './adapter/elicitations';
import { applyAegisSessionNotification } from './adapter/aegisSessionNotifications';
import { applyContentChunk, applyThoughtChunk } from './adapter/messages';
import {
  applyPermissionRequest as applyPermissionRequestToState,
  cancelPermissionRequest as cancelPermissionRequestInState,
} from './adapter/permissions';
import {
  type AcpChatStateChange,
  type AdapterState,
  cloneMessage,
  getAegisActiveRunId,
  getAegisQueuedSteer,
} from './adapter/shared';
import { applyToolCall, applyToolCallUpdate } from './adapter/tools';
import type { AcpElicitationRequest } from './elicitationRequests';
import type { AcpPermissionRequest } from './permissionRequestTypes';

export type { AcpChatStateChange } from './adapter/shared';

export interface AcpSessionNotificationAdapter {
  apply(notification: SessionNotification): AcpChatStateChange[];
  applyAegis(notification: AegisSessionNotification_unstable): AcpChatStateChange[];
  applyPermissionRequest(request: AcpPermissionRequest): AcpChatStateChange[];
  cancelPermissionRequest(toolCallId: string, generation: string): AcpChatStateChange[];
  applyElicitationRequest(request: AcpElicitationRequest): AcpChatStateChange[];
  applyElicitationStatus(elicitationId: string, status: ElicitationStatus): AcpChatStateChange[];
  getMessages(): Message[];
  getMessagesSnapshot(): Message[];
}

export function createAcpSessionNotificationAdapter(
  initialMessages: Message[] = [],
  localSteerTextByMessageId: Map<string, string> = new Map()
): AcpSessionNotificationAdapter {
  const state: AdapterState = {
    messages: initialMessages.map(cloneMessage),
    localSteerTextByMessageId: new Map(localSteerTextByMessageId),
    toolCallStatesById: new Map(),
  };

  return {
    apply(notification) {
      prepareMessagesForUpdate(state, notification.update);
      return applyAcpSessionNotification(state, notification);
    },
    applyAegis(notification) {
      prepareMessagesForUpdate(state, notification.update);
      return applyAegisSessionNotification(state, notification);
    },
    applyPermissionRequest(request) {
      state.messages = [...state.messages];
      return applyPermissionRequestToState(state, request);
    },
    cancelPermissionRequest(toolCallId, generation) {
      return cancelPermissionRequestInState(state, toolCallId, generation);
    },
    applyElicitationRequest(request) {
      state.messages = [...state.messages];
      return applyElicitationRequestToState(state, request);
    },
    applyElicitationStatus(elicitationId, status) {
      return applyElicitationStatusToState(state, elicitationId, status);
    },
    getMessages() {
      return state.messages.map(cloneMessage);
    },
    getMessagesSnapshot() {
      return state.messages;
    },
  };
}

function applyAcpSessionNotification(
  state: AdapterState,
  notification: SessionNotification
): AcpChatStateChange[] {
  const update = notification.update;

  switch (update.sessionUpdate) {
    case 'user_message_chunk':
      return applyContentChunk(state, 'user', update);
    case 'agent_message_chunk':
      return applyContentChunk(state, 'assistant', update);
    case 'agent_thought_chunk':
      return applyThoughtChunk(state, update);
    case 'tool_call':
      return applyToolCall(state, update);
    case 'tool_call_update':
      return applyToolCallUpdate(state, update);
    case 'session_info_update': {
      const activeRunId = getAegisActiveRunId(update);
      const queuedSteerMessageId = getAegisQueuedSteer(update);
      const changes: AcpChatStateChange[] = [];

      if (update.title || activeRunId !== undefined) {
        changes.push({
          type: 'sessionInfo',
          ...(update.title ? { name: update.title } : {}),
          ...(activeRunId !== undefined ? { activeRunId } : {}),
        });
      }

      if (queuedSteerMessageId) {
        changes.push({ type: 'localSteerConfirmed', messageId: queuedSteerMessageId });
      }

      return changes;
    }
    case 'usage_update':
      return [];
    default:
      return [];
  }
}

// The adapter helpers mutate the message they find. Copy only possible targets
// before invoking them, so published message changes remain stable across chunks.
function prepareMessagesForUpdate(
  state: AdapterState,
  update: SessionNotification['update'] | AegisSessionNotification_unstable['update']
): void {
  switch (update.sessionUpdate) {
    case 'user_message_chunk':
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
    case 'tool_call':
    case 'tool_call_update':
    case 'message_usage':
    case 'status_message':
      break;
    default:
      return;
  }

  const previous = state.messages;
  state.messages = [...previous];
  const copy = (index: number) => {
    if (index >= 0 && state.messages[index] === previous[index]) {
      state.messages[index] = cloneMessage(previous[index]);
    }
  };

  if (update.sessionUpdate === 'status_message' || update.sessionUpdate === 'tool_call_update') {
    if (update.sessionUpdate === 'status_message') return;
    if (update.status !== 'completed' && update.status !== 'failed') return;
    const messageId = messageIdFromMeta(update);
    if (messageId)
      copy(previous.findIndex((message) => message.id === messageId && message.role === 'user'));
    return;
  }

  if (update.sessionUpdate === 'message_usage') {
    const byId = update.messageId
      ? previous.findIndex((message) => message.id === update.messageId)
      : -1;
    if (byId !== -1) {
      copy(byId);
    } else {
      for (let index = previous.length - 1; index >= 0; index--) {
        const message = previous[index];
        if (
          message.role === 'assistant' &&
          message.content.some(
            (content) => content.type !== 'actionRequired' && content.type !== 'systemNotification'
          )
        ) {
          copy(index);
          break;
        }
      }
    }
    return;
  }

  const role = update.sessionUpdate === 'user_message_chunk' ? 'user' : 'assistant';
  const messageId =
    update.sessionUpdate === 'tool_call'
      ? messageIdFromMeta(update)
      : (update.messageId ?? messageIdFromMeta(update));
  if (messageId) {
    copy(previous.findIndex((message) => message.id === messageId && message.role === role));
  }
  const last = previous[previous.length - 1];
  if (last?.role === role && last.metadata.agentVisible !== false && (!messageId || !last.id)) {
    copy(previous.length - 1);
  }
}

function messageIdFromMeta(update: { _meta?: unknown }): string | undefined {
  const meta = update._meta;
  if (!meta || typeof meta !== 'object' || !('aegis' in meta)) return undefined;
  const aegis = meta.aegis;
  if (!aegis || typeof aegis !== 'object' || !('messageId' in aegis)) return undefined;
  return typeof aegis.messageId === 'string' ? aegis.messageId : undefined;
}

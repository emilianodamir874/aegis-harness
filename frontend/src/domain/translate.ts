import { messageId, runId, sessionId as sid, toolCallId } from './ids';
import type { AppEvent, Attachment, ToolDiff, ToolKind } from './types';
import {
  asNumber,
  isRecord,
  type WireAegisNotification,
  type WireContentBlock,
  type WireSessionNotification,
  type WireToolCall,
  type WireToolCallContent,
  type WireToolCallUpdate,
  type WireUsageUpdate,
} from '../acp/protocol';

// ---------------------------------------------------------------------------
// Traducción del alambre al dominio
// ---------------------------------------------------------------------------
// Función pura: entra un `session/update` de ACP y salen eventos del reducer. Así se prueba la
// interpretación del protocolo sin socket, sin React y sin temporizadores.

const textOf = (block: WireContentBlock | undefined): string | null => {
  if (!block) return null;
  return block.type === 'text' ? block.text : null;
};

/** El serve manda algunos números como string (costos, contadores). Se normaliza en el borde. */
const num = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const hiddenOf = (meta: { aegis?: { agentVisible?: boolean } | null } | null | undefined): boolean =>
  meta?.aegis?.agentVisible !== undefined ? meta.aegis.agentVisible !== true : false;

const TOOL_KINDS: ReadonlySet<string> = new Set([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
]);

export const toolKindOf = (kind: string | null | undefined, rawInput: Record<string, unknown> | null): ToolKind => {
  if (kind === 'switch_mode' || kind === 'switchMode') return 'switch_mode';
  if (kind && TOOL_KINDS.has(kind)) return kind as ToolKind;
  if (!rawInput) return 'other';
  if (typeof rawInput['command'] === 'string') return 'execute';
  if (typeof rawInput['query'] === 'string' || typeof rawInput['pattern'] === 'string') return 'search';
  if (typeof rawInput['url'] === 'string') return 'fetch';
  if (typeof rawInput['path'] === 'string' || typeof rawInput['file_path'] === 'string') return 'read';
  return 'other';
};

export const diffsOf = (content: readonly WireToolCallContent[] | undefined): ToolDiff[] => {
  if (!content) return [];
  const diffs: ToolDiff[] = [];
  for (const item of content) {
    if (item.type !== 'diff') continue;
    if (typeof item.newText !== 'string') continue;
    const path = typeof item.path === 'string' && item.path.trim() ? item.path.trim() : 'Archivo sin ruta';
    diffs.push({
      path,
      newText: item.newText,
      requested: false,
      ...(typeof item.oldText === 'string' ? { oldText: item.oldText } : {}),
    });
  }
  return diffs;
};

export const outputOf = (content: readonly WireToolCallContent[] | undefined): string => {
  if (!content) return '';
  let out = '';
  for (const item of content) {
    if (item.type !== 'content') continue;
    const text = textOf(item.content);
    if (text) out += text;
  }
  return out;
};

/**
 * `developer__edit`/`write` no emiten bloque Diff; devuelven el par before/after en rawInput.
 * Cuando el call terminó bien y no hubo bloque Diff, ese par es la única evidencia del cambio.
 */
export const synthesizedDiff = (
  toolName: string | null,
  rawInput: Record<string, unknown> | null,
  status: string | undefined,
): ToolDiff | null => {
  if (status !== 'completed' || !rawInput) return null;
  if (!toolName || !/(?:^|__)(?:edit|write)$/.test(toolName)) return null;
  const path = typeof rawInput['path'] === 'string' ? rawInput['path'] : null;
  if (!path) return null;
  const before = typeof rawInput['before'] === 'string' ? rawInput['before'] : undefined;
  const after =
    typeof rawInput['after'] === 'string'
      ? rawInput['after']
      : typeof rawInput['content'] === 'string'
        ? rawInput['content']
        : undefined;
  if (after === undefined) return null;
  if (before === undefined && !/(?:^|__)write$/.test(toolName)) return null;
  return before === undefined
    ? { path, newText: after, requested: true }
    : { path, oldText: before, newText: after, requested: false };
};

const toolEvent = (
  session: string,
  call: WireToolCall | WireToolCallUpdate,
): AppEvent | null => {
  const idRaw = call.toolCallId;
  if (typeof idRaw !== 'string' || idRaw.length === 0) return null;
  const rawInput = isRecord(call.rawInput) ? call.rawInput : null;
  const name = call.name ?? call._meta?.aegis?.toolCall?.toolName ?? null;
  const diffs = diffsOf(call.content);
  const synthesized = synthesizedDiff(name, rawInput, call.status);
  if (synthesized) diffs.push(synthesized);
  const output = outputOf(call.content);
  return {
    type: 'tool/upsert',
    sessionId: sid(session),
    tool: {
      id: toolCallId(idRaw),
      ...(call.title !== undefined ? { title: call.title } : {}),
      ...(name !== null ? { name } : {}),
      kind: toolKindOf(call.kind, rawInput),
      ...(call.status !== undefined ? { status: call.status } : {}),
      rawInput,
      ...(output ? { outputChunk: output } : {}),
      ...(diffs.length ? { diffs } : {}),
      ...(call.messageId ? { messageId: messageId(call.messageId) } : {}),
    },
  };
};

export const usageEvent = (session: string, usage: WireUsageUpdate): AppEvent => ({
  type: 'session/usage',
  sessionId: sid(session),
  usage: {
    used: num(usage.used ?? usage.totalTokens),
    limit: num(usage.contextLimit ?? usage.size),
    cost: num(usage.accumulatedCost ?? usage.cost),
    inputTokens: num(usage.accumulatedInputTokens),
    outputTokens: num(usage.accumulatedOutputTokens),
    autoCompactAt: num(usage.autoCompactAt),
    modelUsage: (usage.modelUsage ?? []).map((m) => ({
      model: m.model ?? 'modelo',
      inputTokens: num(m.inputTokens) ?? 0,
      outputTokens: num(m.outputTokens) ?? 0,
      cost: num(m.cost) ?? 0,
    })),
  },
});

/** Traduce una notificación `session/update` a eventos del dominio. */
export function translateSessionUpdate(notification: WireSessionNotification): AppEvent[] {
  const session = notification.sessionId;
  if (typeof session !== 'string' || session.length === 0) return [];
  const update = notification.update;
  const events: AppEvent[] = [];

  switch (update.sessionUpdate) {
    case 'user_message_chunk': {
      const text = textOf(update.content);
      const explicit = update.messageId ?? null;
      if (text !== null) {
        events.push({
          type: 'message/chunk',
          sessionId: sid(session),
          messageId: explicit ? messageId(explicit) : messageId('run:local:user'),
          kind: 'user',
          text,
          hidden: hiddenOf(update._meta),
        });
      } else if (update.content.type === 'image') {
        events.push({
          type: 'message/image',
          sessionId: sid(session),
          messageId: explicit ? messageId(explicit) : messageId('run:local:user'),
          kind: 'user',
          mimeType: update.content.mimeType,
          data: update.content.data,
          hidden: hiddenOf(update._meta),
        });
      }
      break;
    }
    case 'agent_message_chunk': {
      const text = textOf(update.content);
      if (text === null) break;
      events.push({
        type: 'message/chunk',
        sessionId: sid(session),
        messageId: update.messageId ? messageId(update.messageId) : messageId('run:stream:assistant'),
        kind: 'assistant',
        text,
        hidden: hiddenOf(update._meta),
      });
      break;
    }
    case 'agent_thought_chunk': {
      const text = textOf(update.content);
      if (text === null) break;
      events.push({
        type: 'message/chunk',
        sessionId: sid(session),
        messageId: update.messageId ? messageId(`${update.messageId}:thought`) : messageId('run:stream:thought'),
        kind: 'thought',
        text,
        hidden: hiddenOf(update._meta),
      });
      break;
    }
    case 'tool_call':
    case 'tool_call_update': {
      const event = toolEvent(session, update);
      if (event) events.push(event);
      break;
    }
    case 'usage_update':
      events.push(usageEvent(session, update));
      break;
    case 'message_usage': {
      const rate = asNumber(update.usage?.tokensPerSecond);
      if (rate !== null && rate > 0) {
        events.push({ type: 'session/speed', sessionId: sid(session), speed: rate });
      }
      break;
    }
    case 'session_info_update': {
      if (update.title) {
        events.push({ type: 'session/title', sessionId: sid(session), title: update.title });
      }
      const activeRunId = update._meta?.aegis?.activeRunId;
      if (activeRunId !== undefined) {
        events.push(
          activeRunId
            ? { type: 'run/started', sessionId: sid(session), runId: runId(activeRunId), adopted: true }
            : { type: 'run/ended', sessionId: sid(session) },
        );
      }
      break;
    }
    case 'config_option_update': {
      if (Array.isArray(update.configOptions)) {
        events.push({
          type: 'session/config',
          sessionId: sid(session),
          configOptions: update.configOptions.map((option) => ({
            id: option.id,
            name: option.name,
            ...(option.description !== undefined ? { description: option.description } : {}),
            ...(option.currentValue !== undefined ? { currentValue: option.currentValue } : {}),
            ...(option.options !== undefined ? { options: option.options } : {}),
          })),
        });
      }
      break;
    }
    case 'current_mode_update': {
      if (update.currentModeId) {
        events.push({
          type: 'session/modes',
          sessionId: sid(session),
          modes: [],
          currentModeId: update.currentModeId,
        });
      }
      break;
    }
    case 'status_message': {
      const message = update.status?.message;
      if (typeof message === 'string' && message.length > 0) {
        events.push({ type: 'session/status', sessionId: sid(session), text: message });
      }
      break;
    }
    default:
      break;
  }
  return events;
}

/** `_aegis/unstable/session/update`: arranque/fin de run y estado de la cola de steer. */
export function translateAegisUpdate(notification: WireAegisNotification): AppEvent[] {
  const session = notification.sessionId;
  if (typeof session !== 'string' || session.length === 0) return [];
  const events: AppEvent[] = [];
  const update = notification.update;
  const meta = update && 'sessionUpdate' in update ? (update as { _meta?: WireAegisNotification['aegis'] }) : null;
  const aegis = notification.aegis ?? meta?._meta ?? null;
  if (aegis && aegis.activeRunId !== undefined) {
    events.push(
      aegis.activeRunId
        ? { type: 'run/started', sessionId: sid(session), runId: aegis.activeRunId as never, adopted: true }
        : { type: 'run/ended', sessionId: sid(session) },
    );
  }
  if (update && update.sessionUpdate === 'session_info_update') {
    const queued = update._meta?.aegis?.queuedSteer?.messageId;
    if (queued) {
      events.push({
        type: 'steer/update',
        messageId: messageId(queued),
        state: 'queued',
        serverQueued: true,
      });
    }
  }
  if (update && update.sessionUpdate === 'usage_update') {
    events.push(usageEvent(session, update));
  }
  if (update && update.sessionUpdate === 'status_message') {
    const message = update.status?.message;
    if (typeof message === 'string' && message.length > 0) {
      events.push({ type: 'session/status', sessionId: sid(session), text: message });
    }
  }
  return events;
}

const FENCE = '```';

/** Bloques de prompt en el formato que espera `session/prompt`. */
export function promptBlocks(text: string, attachments: readonly Attachment[]): unknown[] {
  const blocks: unknown[] = [];
  const trimmed = text.trim();
  const soloAdjuntos = attachments.map((a) => `«${a.name}»`).join(', ');
  blocks.push({ type: 'text', text: trimmed || (attachments.length ? `Adjuntos: ${soloAdjuntos}` : '') });
  for (const attachment of attachments) {
    if (attachment.data) {
      blocks.push({ type: 'image', mimeType: attachment.mimeType, data: attachment.data });
    } else if (attachment.text) {
      blocks.push({
        type: 'text',
        text:
          `Archivo adjunto «${attachment.name}» (${attachment.text.length} caracteres):\n\n` +
          `${FENCE}\n${attachment.text}\n${FENCE}\n`,
      });
    }
  }
  return blocks;
}

/** Idempotencia del prompt: el mismo id en los reintentos evita ejecutar el turno dos veces. */
export const newPromptId = (): string =>
  `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

export const isTransientError = (message: string): boolean =>
  /conexi|closed|ECONNRESET|socket|network|timeout de /i.test(message);

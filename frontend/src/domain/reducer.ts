import { blockId, messageId, type BlockId, type MessageId, type SessionId } from './ids';
import type {
  AppEvent,
  AppState,
  BlockEntity,
  MessageEntity,
  MessageKind,
  Notice,
  SessionState,
  SessionSummary,
  ToolDiff,
  ToolEntity,
  ToolStatus,
} from './types';

// ---------------------------------------------------------------------------
// Helpers inmutables
// ---------------------------------------------------------------------------

const NOTICE_LIMIT = 40;

export const emptyState = (): AppState => ({
  connection: 'idle',
  retryIn: null,
  server: null,
  activeSessionId: null,
  sessions: [],
  sessionIndex: {},
  archived: [],
  pendingBySession: {},
  permissionIndex: {},
  queue: [],
  steers: [],
  lastError: null,
  notices: [],
  seq: 0,
});

const now = (): number => Date.now();

const pushNotice = (state: AppState, notice: Notice): AppState => {
  const rest = state.notices.filter((n) => n.id !== notice.id);
  const notices = [...rest, notice].slice(-NOTICE_LIMIT);
  return { ...state, notices };
};

export const notice = (state: AppState, level: Notice['level'], text: string, id?: string): AppState =>
  pushNotice(state, { id: id ?? `n:${state.seq}:${text.slice(0, 24)}`, level, text, at: now() });

const ensureSession = (state: AppState, summary: SessionSummary): AppState => {
  const existing = state.sessionIndex[summary.id];
  const session: SessionState = existing
    ? { ...existing, summary: { ...existing.summary, ...summary } }
    : {
        summary,
        messages: [],
        messageIndex: {},
        blocks: {},
        tools: [],
        toolIndex: {},
        run: null,
        permissions: [],
        configOptions: [],
        modes: [],
        currentModeId: null,
        replaySkipped: 0,
        fullHistory: false,
        hiddenFrom: null,
        lastAppliedCursor: null,
        epoch: null,
        watch: 'off',
        usage: null,
        speed: null,
        statusText: null,
      };
  const sessions = state.sessions.includes(summary.id) ? state.sessions : [...state.sessions, summary.id];
  return { ...state, sessions, sessionIndex: { ...state.sessionIndex, [summary.id]: session } };
};

const mapSession = (state: AppState, id: SessionId, fn: (s: SessionState) => SessionState): AppState => {
  const current = state.sessionIndex[id];
  if (!current) return state;
  const next = fn(current);
  if (next === current) return state;
  return { ...state, sessionIndex: { ...state.sessionIndex, [id]: next } };
};

const summaryOf = (row: {
  id: SessionId;
  title?: string;
  updatedAt?: string | null;
  createdAt?: string | null;
  messageCount?: number | null;
  cwd?: string | null;
  running?: boolean;
  archived?: boolean;
}): SessionSummary => ({
  id: row.id,
  title: row.title ?? 'Sesión',
  updatedAt: row.updatedAt ?? null,
  createdAt: row.createdAt ?? null,
  messageCount: row.messageCount ?? null,
  cwd: row.cwd ?? null,
  archived: row.archived ?? false,
  running: row.running ?? false,
});

// ---------------------------------------------------------------------------
// Mensajes
// ---------------------------------------------------------------------------

const kindToRole = (kind: MessageKind): 'user' | 'assistant' =>
  kind === 'user' ? 'user' : 'assistant';

function lastMessageOfKind(session: SessionState, kind: MessageKind): MessageEntity | null {
  for (let i = session.messages.length - 1; i >= 0; i -= 1) {
    const id = session.messages[i];
    if (id === undefined) continue;
    const message = session.messageIndex[id];
    if (message && message.kind === kind) return message;
  }
  return null;
}

/**
 * Devuelve el mensaje al que pertenece un chunk. Si el chunk trae `messageId`, ese manda: es la
 * identidad del protocolo. Si no, se usa el último mensaje del mismo tipo del turno en curso, o el
 * id sintético `run:<id>` — determinista, así dos chunks sin id no crean dos mensajes.
 */
function targetMessage(
  state: AppState,
  session: SessionState,
  kind: MessageKind,
  explicit: string | null,
): MessageEntity {
  if (explicit) {
    const id = messageId(explicit);
    const existing = session.messageIndex[id];
    if (existing) return existing;
    const fresh: MessageEntity = {
      id,
      sessionId: session.summary.id,
      role: kindToRole(kind),
      kind,
      seq: state.seq + 1,
      blocks: [],
      createdAt: now(),
      hidden: isHidden(session, null),
      pending: false,
    };
    return fresh;
  }
  const last = lastMessageOfKind(session, kind);
  if (last && (last.id.startsWith('run:') || last.pending)) return last;
  if (last && kind !== 'user') return last;
  const synthetic = messageId(`run:${session.run?.id ?? 'idle'}:${kind}`);
  const existing = session.messageIndex[synthetic];
  if (existing) return existing;
  return {
    id: synthetic,
    sessionId: session.summary.id,
    role: kindToRole(kind),
    kind,
    seq: state.seq + 1,
    blocks: [],
    createdAt: now(),
    hidden: isHidden(session, null),
    pending: false,
  };
}

function isHidden(session: SessionState, mid: MessageId | null): boolean {
  if (!session.hiddenFrom) return false;
  const from = session.messageIndex[session.hiddenFrom];
  if (!from) return false;
  if (!mid) return true;
  const message = session.messageIndex[mid];
  if (!message) return true;
  return message.seq >= from.seq;
}

function upsertMessage(
  state: AppState,
  session: SessionState,
  message: MessageEntity,
): { state: AppState; session: SessionState; message: MessageEntity } {
  const existed = session.messageIndex[message.id] !== undefined;
  const messages = existed ? session.messages : [...session.messages, message.id];
  const messageIndex = { ...session.messageIndex, [message.id]: message };
  const next: SessionState = { ...session, messages, messageIndex };
  return {
    state: { ...state, seq: Math.max(state.seq, message.seq) },
    session: next,
    message,
  };
}

/** Añade (o extiende) un bloque de texto al mensaje. Un chunk siempre cae en el último bloque del mismo tipo. */
function appendText(
  state: AppState,
  sessionId: SessionId,
  mid: MessageId,
  kind: MessageKind,
  text: string,
  hidden: boolean,
  restart = false,
): AppState {
  let result = state;
  let session = state.sessionIndex[sessionId];
  if (!session) return state;
  const existing = session.messageIndex[mid];
  const base: MessageEntity =
    existing ??
    ({
      id: mid,
      sessionId,
      role: kindToRole(kind),
      kind,
      seq: state.seq + 1,
      blocks: [],
      createdAt: now(),
      hidden,
      pending: false,
    } satisfies MessageEntity);
  const message: MessageEntity = { ...base, hidden: hidden || base.hidden, blocks: restart ? [] : base.blocks };
  const seed = upsertMessage(result, session, message);
  result = seed.state;
  session = seed.session;

  const lastBlockId = message.blocks[message.blocks.length - 1];
  const lastBlock = lastBlockId ? session.blocks[lastBlockId] : undefined;
  let blocks = message.blocks;
  let blockIndex = session.blocks;
  let textValue = text;

  if (lastBlock && lastBlock.kind === kind) {
    textValue = lastBlock.text + text;
    blockIndex = { ...blockIndex, [lastBlock.id]: { ...lastBlock, text: textValue, status: 'streaming' } };
  } else {
    const id = blockId(mid, message.blocks.length);
    const block: BlockEntity = {
      id,
      messageId: mid,
      sessionId,
      kind,
      text,
      status: 'streaming',
    };
    blocks = [...message.blocks, id];
    blockIndex = { ...blockIndex, [id]: block };
  }

  const nextMessage: MessageEntity = { ...message, blocks };
  session = {
    ...session,
    messageIndex: { ...session.messageIndex, [mid]: nextMessage },
    blocks: blockIndex,
  };
  return { ...result, sessionIndex: { ...result.sessionIndex, [sessionId]: session } };
}

/** Cierra los bloques en streaming de un mensaje (fin de turno o de bloque). */
function closeStreaming(session: SessionState): SessionState {
  let changed = false;
  const blocks: Record<string, BlockEntity> = { ...session.blocks };
  for (const [id, block] of Object.entries(session.blocks)) {
    if (block.status === 'streaming') {
      blocks[id] = { ...block, status: 'complete' };
      changed = true;
    }
  }
  return changed ? { ...session, blocks } : session;
}

/** Reetiqueta un mensaje local con el id que devolvió el servidor (eco del prompt, steer). */
function rekey(session: SessionState, from: MessageId, to: MessageId): SessionState {
  if (from === to) return session;
  const source = session.messageIndex[from];
  if (!source) return session;
  const message: MessageEntity = { ...source, id: to, pending: false };
  const messageIndex: Record<string, MessageEntity> = { ...session.messageIndex };
  delete messageIndex[from];
  messageIndex[to] = message;
  const blocks: Record<string, BlockEntity> = { ...session.blocks };
  const blockIds: string[] = [];
  source.blocks.forEach((oldBlockId, index) => {
    const block = blocks[String(oldBlockId)];
    if (!block) return;
    const nextId = blockId(to, index);
    delete blocks[String(oldBlockId)];
    blocks[nextId] = { ...block, id: nextId, messageId: to };
    blockIds.push(nextId);
  });
  const messages = session.messages.map((id) => (id === from ? to : id));
  const toolIndex: Record<string, ToolEntity> = {};
  for (const [id, tool] of Object.entries(session.toolIndex)) {
    toolIndex[id] = tool.messageId === from ? { ...tool, messageId: to } : tool;
  }
  return { ...session, messages, messageIndex, blocks, toolIndex };
}

// ---------------------------------------------------------------------------
// Herramientas
// ---------------------------------------------------------------------------

const TOOL_KINDS = new Set([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]);

export const normalizeToolKind = (value: string | null | undefined): ToolEntity['kind'] => {
  if (!value) return 'other';
  if (TOOL_KINDS.has(value)) return value as ToolEntity['kind'];
  if (value === 'switchMode') return 'switch_mode';
  return 'other';
};

/** Estados terminales: un `completed`/`failed` no vuelve a `pending` por un update tardío. */
const terminal = (status: ToolStatus): boolean => status === 'completed' || status === 'failed';

function mergeDiffs(current: readonly ToolDiff[], incoming: readonly ToolDiff[]): readonly ToolDiff[] {
  if (incoming.length === 0) return current;
  const seen = new Set(current.map((d) => `${d.path}\u0000${d.oldText ?? ''}\u0000${d.newText}`));
  const merged = [...current];
  for (const diff of incoming) {
    const key = `${diff.path}\u0000${diff.oldText ?? ''}\u0000${diff.newText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(diff);
  }
  return merged;
}

export const emptySessionSummary = (id: SessionId, title = 'Sesión'): SessionSummary => ({
  id,
  title,
  updatedAt: null,
  createdAt: null,
  messageCount: null,
  cwd: null,
  archived: false,
  running: false,
});

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function reduce(state: AppState, event: AppEvent): AppState {
  switch (event.type) {
    case 'connection/status': {
      const next: AppState = {
        ...state,
        connection: event.status,
        retryIn: event.retryIn ?? (event.status === 'reconnecting' ? state.retryIn : null),
      };
      return next;
    }

    case 'connection/server':
      return { ...state, server: event.server };

    case 'notice/push':
      return pushNotice(state, {
        id: event.id ?? `n:${state.seq}:${event.text.slice(0, 24)}`,
        level: event.level,
        text: event.text,
        at: now(),
      });

    case 'notice/dismiss':
      return { ...state, notices: state.notices.filter((n) => n.id !== event.id) };

    case 'error/set':
      return { ...state, lastError: event.message };

    case 'sessions/replaced': {
      let next: AppState = { ...state, sessions: [], archived: [] };
      for (const summary of event.sessions) next = ensureSession(next, summary);
      for (const summary of event.archived) next = ensureSession(next, summary);
      const live = event.sessions.map((s) => s.id);
      // El chat abierto sigue visible aunque una página de `session/list` no lo traiga: la lista
      // es paginada y una respuesta parcial no puede sacar de pantalla lo que se está leyendo.
      const active = state.activeSessionId;
      const sessions = active && !live.includes(active) ? [...live, active] : live;
      return { ...next, sessions, archived: event.archived.map((s) => s.id) };
    }

    case 'sessions/upsert': {
      const next = ensureSession(state, event.session);
      return { ...next, sessions: next.sessions.filter((id) => id !== event.session.id || !event.session.archived) };
    }

    case 'sessions/removed': {
      const sessionIndex = { ...state.sessionIndex };
      delete sessionIndex[event.sessionId];
      return {
        ...state,
        sessions: state.sessions.filter((id) => id !== event.sessionId),
        archived: state.archived.filter((id) => id !== event.sessionId),
        sessionIndex,
        activeSessionId: state.activeSessionId === event.sessionId ? null : state.activeSessionId,
      };
    }

    case 'session/open': {
      const next = ensureSession(state, event.summary);
      const opened = next.sessionIndex[event.summary.id];
      if (!opened) return next;
      const sessionIndex: Record<string, SessionState> = {
        ...next.sessionIndex,
        [event.summary.id]: {
          ...opened,
          configOptions: event.configOptions ?? opened.configOptions,
          modes: event.modes ?? opened.modes,
          currentModeId: event.currentModeId ?? opened.currentModeId,
        },
      };
      return { ...next, sessionIndex, activeSessionId: event.summary.id };
    }

    case 'session/close':
      return { ...state, activeSessionId: null };

    case 'session/reset':
      return mapSession(state, event.sessionId, (s) => ({
        ...s,
        messages: [],
        messageIndex: {},
        blocks: {},
        tools: [],
        toolIndex: {},
        permissions: [],
        replaySkipped: 0,
        hiddenFrom: null,
        lastAppliedCursor: null,
        epoch: null,
        usage: null,
        speed: null,
        statusText: null,
      }));

    case 'session/config':
      return mapSession(state, event.sessionId, (s) => ({ ...s, configOptions: event.configOptions }));

    case 'session/modes':
      return mapSession(state, event.sessionId, (s) => ({
        ...s,
        modes: event.modes,
        currentModeId: event.currentModeId ?? s.currentModeId,
      }));

    case 'session/title': {
      const session = state.sessionIndex[event.sessionId];
      if (!session) return state;
      const summary: SessionSummary = { ...session.summary, title: event.title };
      return {
        ...state,
        sessionIndex: { ...state.sessionIndex, [event.sessionId]: { ...session, summary } },
      };
    }

    case 'session/replaySkipped':
      return mapSession(state, event.sessionId, (s) => ({ ...s, replaySkipped: event.skipped, fullHistory: event.full }));

    case 'session/watch':
      return mapSession(state, event.sessionId, (s) => ({
        ...s,
        watch: event.status,
        lastAppliedCursor: event.cursor === undefined ? s.lastAppliedCursor : event.cursor,
        epoch: event.epoch === undefined ? s.epoch : event.epoch,
      }));

    case 'session/hiddenFrom': {
      return mapSession(state, event.sessionId, (s) => {
        if (!event.from) {
          return { ...s, hiddenFrom: null };
        }
        const from = s.messageIndex[event.from];
        if (!from) return { ...s, hiddenFrom: event.from };
        const messageIndex: Record<string, MessageEntity> = {};
        for (const [id, message] of Object.entries(s.messageIndex)) {
          messageIndex[id] = { ...message, hidden: message.seq >= from.seq };
        }
        return { ...s, hiddenFrom: event.from, messageIndex };
      });
    }

    case 'session/usage':
      return mapSession(state, event.sessionId, (s) => ({ ...s, usage: event.usage }));

    case 'session/speed':
      return mapSession(state, event.sessionId, (s) => ({ ...s, speed: event.speed }));

    case 'session/status':
      return mapSession(state, event.sessionId, (s) => ({ ...s, statusText: event.text }));

    case 'run/started': {
      const next = mapSession(state, event.sessionId, (s) => ({
        ...s,
        run: {
          id: event.runId,
          sessionId: event.sessionId,
          startedAt: now(),
          endedAt: null,
          adopted: event.adopted,
          cancelledByUser: false,
          promptId: event.promptId ?? null,
        },
        summary: { ...s.summary, running: true },
      }));
      return next;
    }

    case 'run/ended': {
      return mapSession(state, event.sessionId, (s) => {
        if (!s.run) return s;
        if (event.runId && s.run.id !== event.runId) return s;
        const closed = closeStreaming({
          ...s,
          run: { ...s.run, endedAt: now(), cancelledByUser: event.cancelled ?? false },
          summary: { ...s.summary, running: false },
        });
        return closed;
      });
    }

    case 'message/chunk': {
      const session = state.sessionIndex[event.sessionId];
      if (!session) return state;
      // Un mensaje nuevo del usuario después de un rewind es el punto de reanudación: vuelve a
      // entrar al contexto del modelo y el resto del transcript recupera su estado normal.
      const resumes = event.kind === 'user' && !session.messageIndex[event.messageId] && session.hiddenFrom !== null;
      const base = resumes ? mapSession(state, event.sessionId, (s) => ({ ...s, hiddenFrom: null })) : state;
      const current = base.sessionIndex[event.sessionId];
      if (!current) return base;
      const target = targetMessage(base, current, event.kind, event.messageId);
      const hidden = event.hidden || (!resumes && isHidden(current, target.id));
      return appendText(base, event.sessionId, target.id, event.kind, event.text, hidden, event.restart === true);
    }

    case 'message/image': {
      const session = state.sessionIndex[event.sessionId];
      if (!session) return state;
      const target = targetMessage(state, session, event.kind, event.messageId);
      const message: MessageEntity = session.messageIndex[target.id] ?? target;
      const id = blockId(target.id, message.blocks.length);
      const block: BlockEntity = {
        id,
        messageId: target.id,
        sessionId: event.sessionId,
        kind: event.kind,
        text: '',
        status: 'complete',
        mimeType: event.mimeType,
        attachmentName: event.name,
        imageUrl: `data:${event.mimeType};base64,${event.data}`,
      };
      const nextMessage: MessageEntity = { ...message, blocks: [...message.blocks, id] };
      const nextSession: SessionState = {
        ...session,
        messages: session.messages.includes(nextMessage.id) ? session.messages : [...session.messages, nextMessage.id],
        messageIndex: { ...session.messageIndex, [nextMessage.id]: nextMessage },
        blocks: { ...session.blocks, [id]: block },
      };
      return { ...state, seq: state.seq + 1, sessionIndex: { ...state.sessionIndex, [event.sessionId]: nextSession } };
    }

    case 'message/local': {
      const session = state.sessionIndex[event.sessionId];
      if (!session) return state;
      const mid = event.messageId;
      if (session.messageIndex[mid]) {
        return mapSession(state, event.sessionId, (s) => {
          const message = s.messageIndex[mid];
          return message ? { ...s, messageIndex: { ...s.messageIndex, [mid]: { ...message, pending: false } } } : s;
        });
      }
      const seq = state.seq + 1;
      const clientBlock = blockId(mid, 0);
      const blocks: BlockEntity[] = [
        {
          id: clientBlock,
          messageId: mid,
          sessionId: event.sessionId,
          kind: 'user',
          text: event.text,
          status: 'complete',
        },
      ];
      const ids: BlockId[] = [clientBlock];
      (event.attachments ?? []).forEach((att, i) => {
        const id = blockId(mid, i + 1);
        blocks.push({
          id,
          messageId: mid,
          sessionId: event.sessionId,
          kind: 'user',
          text: att.text ?? '',
          status: 'complete',
          mimeType: att.mimeType,
          attachmentName: att.name,
          imageUrl: att.data ? `data:${att.mimeType};base64,${att.data}` : undefined,
        });
        ids.push(id);
      });
      const message: MessageEntity = {
        id: mid,
        sessionId: event.sessionId,
        role: 'user',
        kind: 'user',
        seq,
        blocks: ids,
        createdAt: now(),
        hidden: false,
        pending: event.pending,
      };
      const blockIndex: Record<string, BlockEntity> = { ...session.blocks };
      for (const block of blocks) blockIndex[block.id] = block;
      const nextSession: SessionState = {
        ...session,
        messages: [...session.messages, mid],
        messageIndex: { ...session.messageIndex, [mid]: message },
        blocks: blockIndex,
      };
      return { ...state, seq, sessionIndex: { ...state.sessionIndex, [event.sessionId]: nextSession } };
    }

    case 'message/adopt':
      return mapSession(state, event.sessionId, (s) => rekey(s, event.localId, event.serverId));

    case 'message/confirmed':
      return mapSession(state, event.sessionId, (s) => {
        const current = s.messageIndex[event.messageId];
        if (!current) return s;
        const adopted =
          event.serverId !== event.messageId ? rekey(s, event.messageId, event.serverId) : s;
        const message = adopted.messageIndex[event.serverId];
        return message
          ? { ...adopted, messageIndex: { ...adopted.messageIndex, [event.serverId]: { ...message, pending: false } } }
          : adopted;
      });

    case 'message/hide':
      return mapSession(state, event.sessionId, (s) => {
        const from = s.messageIndex[event.from];
        if (!from) return s;
        const messageIndex: Record<string, MessageEntity> = {};
        for (const [id, message] of Object.entries(s.messageIndex)) {
          messageIndex[id] = { ...message, hidden: event.hidden ? message.seq >= from.seq : message.seq < from.seq ? message.hidden : false };
        }
        return { ...s, messageIndex };
      });

    case 'tool/upsert': {
      const session = state.sessionIndex[event.sessionId];
      if (!session) return state;
      const upsert = event.tool;
      const current = session.toolIndex[upsert.id];
      const seq = current?.seq ?? state.seq + 1;
      const status: ToolStatus = (() => {
        if (!current) return upsert.status ?? 'pending';
        if (terminal(current.status)) {
          // Un resultado real puede limpiar la marca de interrumpido, nunca al revés.
          return current.status;
        }
        return upsert.status ?? current.status;
      })();
      const output = upsert.outputChunk
        ? (current?.output ?? '') + upsert.outputChunk
        : (current?.output ?? '');
      const diffs = mergeDiffs(current?.diffs ?? [], upsert.diffs ?? []);
      const tool: ToolEntity = {
        id: upsert.id,
        sessionId: event.sessionId,
        messageId: upsert.messageId !== undefined ? upsert.messageId : (current?.messageId ?? null),
        title: upsert.title ?? current?.title ?? 'Herramienta',
        name: upsert.name !== undefined ? upsert.name : (current?.name ?? null),
        kind: upsert.kind ?? current?.kind ?? 'other',
        status,
        seq,
        rawInput: upsert.rawInput !== undefined ? upsert.rawInput : (current?.rawInput ?? null),
        output,
        diffs,
        interrupted:
          upsert.status !== undefined && upsert.status !== 'pending'
            ? false
            : (upsert.interrupted ?? current?.interrupted ?? false),
        updatedAt: now(),
      };
      return {
        ...state,
        seq: Math.max(state.seq, seq),
        sessionIndex: {
          ...state.sessionIndex,
          [event.sessionId]: {
            ...session,
            tools: current ? session.tools : [...session.tools, upsert.id],
            toolIndex: { ...session.toolIndex, [tool.id]: tool },
          },
        },
      };
    }

    case 'tools/interrupt':
      return mapSession(state, event.sessionId, (s) => sweepInterruptedTools(s, now()));

    case 'permission/request': {
      const request = event.request;
      const session = state.sessionIndex[event.sessionId];
      const current = state.pendingBySession[event.sessionId] ?? 0;
      const seen = state.permissionIndex[request.id] !== undefined;
      const pendingBySession = { ...state.pendingBySession, [event.sessionId]: seen ? current : current + 1 };
      const permissionIndex = { ...state.permissionIndex, [request.id]: request };
      if (!session) return { ...state, pendingBySession, permissionIndex };
      return {
        ...state,
        pendingBySession,
        permissionIndex,
        sessionIndex: {
          ...state.sessionIndex,
          [event.sessionId]: {
            ...session,
            permissions: session.permissions.includes(request.id) ? session.permissions : [...session.permissions, request.id],
          },
        },
      };
    }

    case 'permission/resolved': {
      const session = state.sessionIndex[event.sessionId];
      const permissionIndex = { ...state.permissionIndex };
      delete permissionIndex[event.permissionId];
      const current = state.pendingBySession[event.sessionId] ?? 0;
      const pendingBySession = { ...state.pendingBySession, [event.sessionId]: Math.max(0, current - 1) };
      if (!session) return { ...state, pendingBySession, permissionIndex };
      return {
        ...state,
        pendingBySession,
        permissionIndex,
        sessionIndex: {
          ...state.sessionIndex,
          [event.sessionId]: { ...session, permissions: session.permissions.filter((id) => id !== event.permissionId) },
        },
      };
    }

    case 'queue/add':
      return { ...state, queue: [...state.queue, event.prompt] };

    case 'queue/update':
      return {
        ...state,
        queue: state.queue.map((item) =>
          item.id === event.id ? { ...item, state: event.state, error: event.error ?? item.error } : item,
        ),
      };

    case 'queue/remove':
      return { ...state, queue: state.queue.filter((item) => item.id !== event.id) };

    case 'steer/add':
      return { ...state, steers: [...state.steers.filter((s) => s.messageId !== event.steer.messageId), event.steer] };

    case 'steer/update':
      return {
        ...state,
        steers: state.steers.map((steer) =>
          steer.messageId === event.messageId
            ? { ...steer, state: event.state, serverQueued: event.serverQueued ?? steer.serverQueued }
            : steer,
        ),
      };

    default: {
      const exhaustive: never = event;
      void exhaustive;
      return state;
    }
  }
}

/** Cierra el streaming de una sesión cuando el turno termina (exportado para el coordinador). */
export function closeSessionStreaming(session: SessionState): SessionState {
  return closeStreaming(session);
}

/** Herramientas que quedaron girando y el turno terminó: se marcan interrumpidas, no exitosas. */
export function sweepInterruptedTools(session: SessionState, nowMs = Date.now()): SessionState {
  let changed = false;
  const toolIndex: Record<string, ToolEntity> = { ...session.toolIndex };
  for (const [id, tool] of Object.entries(session.toolIndex)) {
    const stale = tool.status === 'pending' || tool.status === 'in_progress';
    if (!stale) continue;
    toolIndex[id] = { ...tool, interrupted: true, updatedAt: nowMs };
    changed = true;
  }
  return changed ? { ...session, toolIndex } : session;
}

export { summaryOf };

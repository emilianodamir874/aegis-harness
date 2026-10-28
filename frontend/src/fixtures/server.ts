import type { JsonRpcMessage, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from '../acp/protocol';

/**
 * Servidor ACP de mentira, en memoria.
 *
 * Reproduce lo que el serve de Aegis hace en el cable: initialize, session/new, session/list,
 * session/load (con replay por notificaciones), session/prompt (con promptId idempotente),
 * watch con cursor/epoch y replay, permissions, y los métodos `_aegis/unstable/*` que usa el
 * cliente. Sirve para probar el cliente y el store sin Node, sin red y sin tocar la sesión viva.
 */

export interface FixtureMessage {
  readonly role: 'user' | 'assistant' | 'thought';
  readonly text: string;
  readonly messageId?: string;
  readonly chunks?: number;
}

export interface FixtureSession {
  readonly sessionId: string;
  title: string;
  readonly cwd?: string;
  readonly messages: FixtureMessage[];
  activeRunId: string | null;
  readonly archived?: boolean;
  /** Si el próximo prompt debe fallar con este error (para probar reintentos). */
  failPromptTimes?: number;
  /** Si el prompt debe pedir confirmación antes de seguir. */
  permissionOnPrompt?: boolean;
  /** Herramienta que se emite durante el turno. */
  toolCall?: {
    readonly toolCallId: string;
    readonly title: string;
    readonly name: string;
    readonly kind: string;
    readonly status?: 'completed' | 'failed';
    readonly diff?: { readonly path: string; readonly oldText?: string; readonly newText: string };
  };
}

export interface FixtureOptions {
  readonly sessions: readonly FixtureSession[];
  /** Notificaciones que el server empuja solo (para probar updates de otra sesión). */
  readonly autoStart?: boolean;
}

interface RingEntry {
  readonly seq: number;
  readonly notification: JsonRpcNotification;
}

interface Connection {
  readonly id: number;
  send: (message: JsonRpcMessage) => void;
  closed: boolean;
}

export class FixtureAcpServer {
  private readonly sessions = new Map<string, FixtureSession>();
  private readonly ring = new Map<string, RingEntry[]>();
  private readonly watchers = new Map<string, Set<number>>();
  private readonly cursors = new Map<number, number>();
  private readonly connections = new Map<number, Connection>();
  private nextConnection = 1;
  private seq = 0;
  private nextMessage = 1;
  private epoch = 'epoch-1';
  readonly calls: { method: string; params: unknown }[] = [];
  readonly prompts: { promptId: string; sessionId: string }[] = [];

  constructor(options: FixtureOptions) {
    for (const session of options.sessions) {
      this.sessions.set(session.sessionId, { ...session, messages: [...session.messages] });
      this.ring.set(session.sessionId, []);
    }
  }

  connect(send: (message: JsonRpcMessage) => void): { id: number; close: () => void } {
    const id = this.nextConnection++;
    this.connections.set(id, { id, send, closed: false });
    this.cursors.set(id, this.seq);
    return {
      id,
      close: () => {
        this.connections.delete(id);
        for (const set of this.watchers.values()) set.delete(id);
      },
    };
  }

  session(sessionId: string): FixtureSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Cuenta de watchers de una sesión (para probar unwatch). */
  watcherCount(sessionId: string): number {
    return this.watchers.get(sessionId)?.size ?? 0;
  }

  private connection(id: number): Connection | undefined {
    return this.connections.get(id);
  }

  private publish(sessionId: string, method: string, params: unknown): void {
    this.seq += 1;
    const notification: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    const ring = this.ring.get(sessionId) ?? [];
    ring.push({ seq: this.seq, notification });
    if (ring.length > 200) ring.shift();
    this.ring.set(sessionId, ring);
    for (const connectionId of this.watchers.get(sessionId) ?? []) {
      const connection = this.connection(connectionId);
      if (connection && !connection.closed) connection.send(notification);
    }
    if (sessionId === '__global__') {
      for (const connection of this.connections.values()) {
        if (!connection.closed) connection.send(notification);
      }
    }
  }

  /** Empuja una actualización a todos los watchers de la sesión. */
  sessionUpdate(sessionId: string, update: Record<string, unknown>): void {
    this.publish(sessionId, 'session/update', { sessionId, update });
  }

  aegisUpdate(sessionId: string, update: Record<string, unknown>, aegis?: Record<string, unknown>): void {
    this.publish(sessionId, '_aegis/unstable/session/update', { sessionId, update, ...(aegis ? { aegis } : {}) });
  }

  /** Trunca el ring y avisa del gap (lo que hace el hub cuando se le acaba el buffer). */
  truncateRing(sessionId: string): void {
    this.ring.set(sessionId, []);
    // El aviso de gap NO entra al ring: si entrara, el watch siguiente lo reenviaría y el cliente
    // recargaría en bucle. En el hub real se emite al armar el replay, no como evento guardado.
    const notice: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: '_aegis/unstable/session/replay_gap',
      params: { sessionId, reason: 'ring overflow' },
    };
    for (const connectionId of this.watchers.get(sessionId) ?? []) {
      const connection = this.connection(connectionId);
      if (connection && !connection.closed) connection.send(notice);
    }
  }

  /** Pide confirmación al cliente; resolvé con `answerPermission`. */
  askPermission(sessionId: string, connectionId: number, rpcId: number, options: readonly { optionId: string; name: string; kind: string }[]): void {
    const connection = this.connection(connectionId);
    if (!connection) return;
    connection.send({
      jsonrpc: '2.0',
      id: rpcId,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { toolCallId: 'tool-perm', title: 'Ejecutar comando', kind: 'execute', status: 'pending' },
        options,
      },
    });
  }

  async handle(connectionId: number, message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const connection = this.connection(connectionId);
    if (!connection) return null;
    const params = (message.params ?? {}) as Record<string, unknown>;
    this.calls.push({ method: message.method, params });
    const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id: message.id, result });
    const fail = (code: number, text: string): JsonRpcResponse => ({
      jsonrpc: '2.0',
      id: message.id,
      error: { code, message: text },
    });

    switch (message.method) {
      case 'initialize':
        return reply({ protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'fixture', version: '1' } });

      case 'session/list': {
        const sessions = [...this.sessions.values()].map((session) => ({
          sessionId: session.sessionId,
          title: session.title,
          updatedAt: new Date(1_700_000_000_000).toISOString(),
          _meta: { messageCount: session.messages.length, createdAt: new Date(1_600_000_000_000).toISOString() },
        }));
        const running = [...this.sessions.values()].filter((s) => s.activeRunId).map((s) => s.sessionId);
        return reply({ sessions, nextCursor: null, _meta: { runningSessionIds: running } });
      }

      case 'session/new': {
        const id = `fixture-${this.sessions.size + 1}`;
        this.sessions.set(id, { sessionId: id, title: 'Chat nuevo', messages: [], activeRunId: null });
        this.ring.set(id, []);
        return reply({
          sessionId: id,
          modes: { currentModeId: 'code', availableModes: [{ id: 'code', name: 'Código' }, { id: 'debate', name: 'Debate' }] },
          configOptions: [{ id: 'thinking_effort', name: 'Esfuerzo', currentValue: 'medium', options: [{ value: 'low', name: 'Bajo' }, { value: 'high', name: 'Alto' }] }],
        });
      }

      case 'session/load': {
        const sessionId = String(params['sessionId'] ?? '');
        const session = this.sessions.get(sessionId);
        if (!session) return fail(-32000, 'sesión inexistente');
        const replayTail = Number(params['_meta'] && (params['_meta'] as Record<string, unknown>)['replayTail']);
        const tail = Number.isFinite(replayTail) && replayTail > 0 ? Math.min(replayTail, session.messages.length) : session.messages.length;
        const skipped = session.messages.length - tail;
        for (const entry of session.messages.slice(skipped)) {
          this.deliver(connectionId, sessionId, entry);
        }
        return reply({
          modes: { currentModeId: 'code', availableModes: [{ id: 'code', name: 'Código' }, { id: 'debate', name: 'Debate' }] },
          configOptions: [{ id: 'thinking_effort', name: 'Esfuerzo', currentValue: 'medium' }],
          _meta: { replaySkipped: skipped },
        });
      }

      case 'session/prompt': {
        const sessionId = String(params['sessionId'] ?? '');
        const session = this.sessions.get(sessionId);
        if (!session) return fail(-32000, 'sesión inexistente');
        const meta = (params['_meta'] ?? {}) as Record<string, unknown>;
        const promptId = typeof meta['promptId'] === 'string' ? meta['promptId'] : `anon-${this.prompts.length}`;
        const text = promptText(params['prompt']);
        // Idempotencia: el mismo promptId no vuelve a ejecutar el turno. Un intento que falló
        // antes de arrancar NO se registra: el cliente reintenta con el mismo id y debe ejecutarse.
        if (!this.prompts.some((p) => p.promptId === promptId)) {
          if (session.failPromptTimes && session.failPromptTimes > 0) {
            session.failPromptTimes -= 1;
            return fail(-32000, 'conexión interrumpida (fixture)');
          }
          this.prompts.push({ promptId, sessionId });
          await this.runTurn(connectionId, session, text, promptId);
        }
        return reply({ stopReason: 'end_turn' });
      }

      case 'session/cancel': {
        const sessionId = String(params['sessionId'] ?? '');
        const session = this.sessions.get(sessionId);
        if (session?.activeRunId) {
          const runId = session.activeRunId;
          session.activeRunId = null;
          this.aegisUpdate(sessionId, { sessionUpdate: 'session_info_update', _meta: { aegis: { activeRunId: null } } }, { activeRunId: null });
          void runId;
        }
        return null;
      }

      case '_aegis/unstable/session/watch': {
        const sessionId = String(params['sessionId'] ?? '');
        const session = this.sessions.get(sessionId);
        if (!session) return fail(-32000, 'sesión inexistente');
        const set = this.watchers.get(sessionId) ?? new Set<number>();
        set.add(connectionId);
        this.watchers.set(sessionId, set);
        const since = typeof params['since'] === 'number' ? (params['since'] as number) : null;
        const replay = (this.ring.get(sessionId) ?? [])
          .filter((entry) => since === null || entry.seq > since)
          .map((entry) => entry.notification);
        return reply({
          activeRunId: session.activeRunId,
          cursor: this.seq,
          epoch: this.epoch,
          replay,
        });
      }

      case '_aegis/unstable/session/unwatch': {
        const sessionId = String(params['sessionId'] ?? '');
        this.watchers.get(sessionId)?.delete(connectionId);
        return reply({});
      }

      case '_aegis/unstable/session/info': {
        const sessionId = String(params['sessionId'] ?? '');
        const session = this.sessions.get(sessionId);
        if (!session) return fail(-32000, 'sesión inexistente');
        return reply({
          session: {
            sessionId,
            title: session.title,
            cwd: session.cwd ?? 'C:/Aegis-Proyects',
            _meta: {
              activeRunId: session.activeRunId,
              watcherCount: this.watcherCount(sessionId),
              messageCount: session.messages.length,
            },
          },
        });
      }

      case '_aegis/unstable/session/steer': {
        const sessionId = String(params['sessionId'] ?? '');
        const session = this.sessions.get(sessionId);
        if (!session) return fail(-32000, 'sesión inexistente');
        const expected = String(params['expectedRunId'] ?? '');
        if (!session.activeRunId || session.activeRunId !== expected) {
          return fail(-32001, 'no hay un run con ese id');
        }
        const id = `fig-steer-${this.nextMessage++}`;
        this.sessionUpdate(sessionId, {
          sessionUpdate: 'user_message_chunk',
          messageId: id,
          content: { type: 'text', text: promptText(params['prompt']) },
        });
        return reply({ runId: session.activeRunId, messageId: id });
      }

      case '_aegis/unstable/session/rewind': {
        const sessionId = String(params['sessionId'] ?? '');
        const session = this.sessions.get(sessionId);
        if (!session) return fail(-32000, 'sesión inexistente');
        const back = typeof params['back'] === 'number' ? (params['back'] as number) : 1;
        const userMessages = session.messages.map((m, index) => ({ m, index })).filter((entry) => entry.m.role === 'user');
        const from = userMessages[Math.max(0, userMessages.length - back)];
        if (!from) return fail(-32000, 'no hay turnos');
        return reply({
          hidden: session.messages.length - from.index,
          messageId: from.m.messageId ?? `fig-msg-${from.index}`,
          text: from.m.text,
          preview: from.m.text.slice(0, 40),
        });
      }

      case '_aegis/unstable/session/rename':
        return reply({});

      case '_aegis/unstable/session/export': {
        // Igual que el motor: el texto viene ya formateado en `data`; sin `format` devuelve JSON.
        const fixt = this.sessions.get(String((params as { sessionId?: string }).sessionId ?? ''));
        const formato = (params as { format?: string }).format;
        const data =
          formato === 'markdown'
            ? `# Session Export: ${fixt?.title ?? ''}\n\n*Total messages: ${fixt?.messages.length ?? 0}*\n\n` +
              (fixt?.messages ?? []).map((m) => `### ${m.role === 'user' ? 'User' : 'Assistant'}:\n${m.text}\n`).join('\n')
            : JSON.stringify({ id: fixt?.sessionId ?? '', name: fixt?.title ?? '', messages: fixt?.messages ?? [] });
        return reply({ data });
      }

      case '_aegis/unstable/session/archive':
      case '_aegis/unstable/session/unarchive':
        return reply({});

      case 'session/set_config_option':
        return reply({
          configOptions: [
            { id: String(params['configId'] ?? ''), name: String(params['configId'] ?? ''), currentValue: String(params['value'] ?? '') },
          ],
        });

      case 'session/set_mode':
        return reply({});

      default:
        return fail(-32601, `método no soportado en el fixture: ${message.method}`);
    }
  }

  private deliver(connectionId: number, sessionId: string, message: FixtureMessage): void {    const connection = this.connection(connectionId);
    if (!connection) return;
    const id = message.messageId ?? `fig-msg-${this.nextMessage++}`;
    const kind =
      message.role === 'user' ? 'user_message_chunk' : message.role === 'thought' ? 'agent_thought_chunk' : 'agent_message_chunk';
    connection.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: kind,
          messageId: id,
          content: { type: 'text', text: message.text },
          _meta: { aegis: { agentVisible: message.role !== 'thought' } },
        },
      },
    });
  }

  /** Ejecuta un turno guionado: arranca el run, emite la herramienta, streamea la respuesta y cierra. */
  private async runTurn(connectionId: number, session: FixtureSession, text: string, promptId: string): Promise<void> {
    const sessionId = session.sessionId;
    const runId = `run-${promptId}`;
    const userMessage: FixtureMessage = { role: 'user', text, messageId: `fig-user-${this.nextMessage++}` };
    session.messages.push(userMessage);
    session.activeRunId = runId;
    this.sessionUpdate(sessionId, {
      sessionUpdate: 'user_message_chunk',
      messageId: userMessage.messageId,
      content: { type: 'text', text },
    });
    this.aegisUpdate(sessionId, { sessionUpdate: 'session_info_update', _meta: { aegis: { activeRunId: runId } } }, { activeRunId: runId });

    const tool = session.toolCall;
    const toolMessage = `fig-tool-${this.nextMessage++}`;
    if (tool) {
      this.sessionUpdate(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: tool.toolCallId,
        title: tool.title,
        name: tool.name,
        kind: tool.kind,
        status: 'in_progress',
        rawInput: { command: tool.title },
      });
    }

    if (session.permissionOnPrompt) {
      session.permissionOnPrompt = false;
      this.askPermission(sessionId, connectionId, 9000, [
        { optionId: 'allow', name: 'Permitir', kind: 'allow_once' },
        { optionId: 'deny', name: 'Rechazar', kind: 'reject_once' },
      ]);
    }

    const answerId = `fig-asst-${this.nextMessage++}`;
    const answer = `Recibí: ${text}`;
    for (let i = 0; i < answer.length; i += 12) {
      this.sessionUpdate(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        messageId: answerId,
        content: { type: 'text', text: answer.slice(i, i + 12) },
      });
      await Promise.resolve();
    }
    if (tool) {
      this.sessionUpdate(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: tool.toolCallId,
        status: tool.status ?? 'completed',
        content: [
          ...(tool.diff ? [{ type: 'diff', path: tool.diff.path, newText: tool.diff.newText, ...(tool.diff.oldText !== undefined ? { oldText: tool.diff.oldText } : {}) }] : []),
          { type: 'content', content: { type: 'text', text: 'salida de la herramienta' } },
        ],
        _meta: { aegis: { toolCall: { toolName: tool.name } } },
      });
    }
    session.messages.push({ role: 'assistant', text: answer, messageId: answerId });
    if (tool) session.messages.push({ role: 'thought', text: 'pensando el siguiente paso', messageId: `${toolMessage}` });
    session.activeRunId = null;
    this.aegisUpdate(sessionId, { sessionUpdate: 'session_info_update', _meta: { aegis: { activeRunId: null } } }, { activeRunId: null });
    this.sessionUpdate(sessionId, {
      sessionUpdate: 'usage_update',
      used: 1200,
      contextLimit: 350_000,
      accumulatedCost: 0.02,
    });
  }
}

const promptText = (prompt: unknown): string => {
  if (!Array.isArray(prompt)) return '';
  return prompt
    .map((block) => {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
        return String((block as { text?: string }).text ?? '');
      }
      return '';
    })
    .join('');
};

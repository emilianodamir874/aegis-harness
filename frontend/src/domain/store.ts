import { AcpError, type AcpClient } from '../acp/client';
import {
  isRecord,
  type JsonRpcNotification,
  type JsonRpcServerRequest,
  type WirePermissionRequest,
  type WireRewindResponse,
  type WireSessionInfoResponse,
  type WireSessionListResponse,
  type WireSessionLoadResponse,
  type WireSessionNewResponse,
  type WireSessionWatchResponse,
  type WireSteerResponse,
} from '../acp/protocol';
import { permissionId, sessionId as sid, type SessionId } from './ids';
import { emptyState, reduce, summaryOf } from './reducer';
import { isRunning } from './selectors';
import {
  isTransientError,
  newPromptId,
  promptBlocks,
  translateAegisUpdate,
  translateSessionUpdate,
} from './translate';
import type {
  AppEvent,
  AppState,
  Attachment,
  PermissionRequest,
  QueuedPrompt,
  SessionSummary,
  SteerMessage,
} from './types';

const REPLAY_TAIL = 400;
const REPLAY_MAX_BLOCK = 65536;

interface StoreOptions {
  readonly client: AcpClient;
  readonly defaultCwd?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Cómo se agrupan las notificaciones a React (por defecto rAF en navegador, microtarea en tests). */
  readonly schedule?: (fn: () => void) => void;
}

interface PendingPermission {
  readonly rpcId: number | string;
  readonly sessionId: SessionId;
  readonly request: PermissionRequest;
}

/**
 * Coordinador de la aplicación: una sola fuente de verdad (`AppState`) y todos los efectos ACP.
 *
 * No importa React. La UI se suscribe con `subscribe` y lee `getState()`; todo lo demás (watch,
 * replay, adopción de runs, reintentos idempotentes, permisos de otras sesiones, cola y steer)
 * vive acá y se puede probar con un cliente falso.
 */
export class AegisStore {
  private state: AppState = emptyState();
  private readonly listeners = new Set<() => void>();
  private readonly client: AcpClient;
  private readonly defaultCwd: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly unsubscribers: (() => void)[] = [];
  private readonly loading = new Set<string>();
  private readonly loaded = new Set<string>();
  private readonly watched = new Set<string>();
  private readonly reloading = new Set<string>();
  /**
   * Títulos puestos por el usuario en esta sesión del navegador. El motor acepta
   * `_aegis/unstable/session/rename` pero `session/list` sigue devolviendo el título viejo y no emite
   * `session_info_update` (medido contra el motor real, 2026-10-28), así que sin esta marca el
   * refresco de cada 4 s borraría el nombre recién puesto.
   */
  private readonly renamed = new Map<string, string>();
  private flushing = false;
  private emitScheduled = false;
  private readonly schedule: (fn: () => void) => void;
  private disposed = false;

  constructor(options: StoreOptions) {
    this.client = options.client;
    this.defaultCwd = options.defaultCwd ?? '.';
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
    this.schedule =
      options.schedule ??
      ((fn) => {
        const testEnv = typeof import.meta !== 'undefined' && import.meta.env?.MODE === 'test';
        if (!testEnv && typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fn());
        else queueMicrotask(fn);
      });
    this.unsubscribers.push(this.client.onNotification((message) => this.onNotification(message)));
    this.unsubscribers.push(
      this.client.onStatus((status, retryIn) => {
        this.dispatch({
          type: 'connection/status',
          status: status === 'ready' ? 'ready' : status === 'connecting' ? 'connecting' : status === 'reconnecting' ? 'reconnecting' : 'closed',
          retryIn,
        });
        if (status === 'ready') void this.onReady();
      }),
    );
  }

  getState = (): AppState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(): void {
    // Una sola notificación a React por microtarea: un replay de cientos de frames no puede
    // encadenar renders síncronos (React lo corta con "maximum update depth exceeded").
    if (this.emitScheduled) return;
    this.emitScheduled = true;
    this.schedule(() => {
      this.emitScheduled = false;
      if (this.disposed) return;
      for (const listener of [...this.listeners]) listener();
    });
  }

  dispatch(event: AppEvent): void {
    const next = reduce(this.state, event);
    if (next === this.state) return;
    this.state = next;
    this.emit();
  }

  private apply(events: readonly AppEvent[]): void {
    if (events.length === 0) return;
    let state = this.state;
    for (const event of events) state = reduce(state, event);
    if (state === this.state) return;
    this.state = state;
    this.emit();
  }

  dispose(): void {
    this.disposed = true;
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------
  // Ciclo de conexión
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    await this.client.connect();
  }

  private async onReady(): Promise<void> {
    if (this.disposed) return;
    await this.refreshSessions();
    const watched = [...this.watched] as SessionId[];
    if (watched.length === 0) return;
    // Al volver el socket, el turno puede seguir vivo en el hub: se re-engancha con el cursor
    // aplicado. La respuesta de watch dice si hay run activo y trae lo que se perdió.
    for (const id of watched) {
      const session = this.state.sessionIndex[id];
      if (!session) continue;
      try {
        await this.watchSession(id, session.lastAppliedCursor, session.epoch);
      } catch {
        this.dispatch({ type: 'notice/push', level: 'warn', text: 'No se pudo re-enganchar un chat tras reconectar.' });
      }
    }
  }

  async refreshSessions(): Promise<readonly SessionSummary[]> {
    try {
      const rows: SessionSummary[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page += 1) {
        type ListResponse = WireSessionListResponse & { readonly _meta?: { readonly runningSessionIds?: readonly string[] } };
        const response: ListResponse = await this.client.request<ListResponse>('session/list', {
          ...(cursor ? { cursor } : {}),
          meta: { aegis: { includeLastMessageSnippet: false } },
        });
        const running = new Set((response?._meta?.runningSessionIds ?? []).map(String));
        for (const row of response?.sessions ?? []) {
          if (typeof row.sessionId !== 'string' || row.sessionId.length === 0) continue;
          rows.push(
            summaryOf({
              id: sid(row.sessionId),
              title: this.renamed.get(row.sessionId) ?? row.title ?? 'Sesión',
              updatedAt: row.updatedAt ?? null,
              createdAt: row._meta?.createdAt ?? null,
              messageCount: row._meta?.messageCount ?? null,
              running: running.has(row.sessionId),
            }),
          );
        }
        cursor = response?.nextCursor ?? null;
        if (!cursor) break;
      }
      const archived = this.state.archived
        .map((id) => this.state.sessionIndex[id])
        .filter((s): s is NonNullable<typeof s> => Boolean(s))
        .map((s) => s.summary);
      this.dispatch({ type: 'sessions/replaced', sessions: rows, archived });
      return rows;
    } catch (error) {
      this.dispatch({ type: 'notice/push', level: 'warn', text: `No se pudo listar sesiones: ${messageOf(error)}` });
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Abrir / crear / cerrar
  // -------------------------------------------------------------------------

  async newSession(cwd?: string): Promise<SessionId | null> {
    try {
      const response = await this.client.request<WireSessionNewResponse>('session/new', {
        cwd: cwd ?? this.defaultCwd,
        mcpServers: [],
      });
      const id = sid(response.sessionId);
      const summary = summaryOf({ id, title: 'Chat nuevo', updatedAt: new Date(this.now()).toISOString() });
      this.dispatch({ type: 'sessions/upsert', session: summary });
      this.dispatch({
        type: 'session/open',
        summary,
        configOptions: (response.configOptions ?? []).map((option) => ({
          id: option.id,
          name: option.name,
          ...(option.description !== undefined ? { description: option.description } : {}),
          ...(option.currentValue !== undefined ? { currentValue: option.currentValue } : {}),
          ...(option.options !== undefined ? { options: option.options } : {}),
        })),
        modes: (response.modes?.availableModes ?? []).map((mode) => ({ id: mode.id, name: mode.name, ...(mode.description ? { description: mode.description } : {}) })),
        currentModeId: response.modes?.currentModeId ?? null,
      });
      this.loaded.add(id);
      this.watched.add(id);
      return id;
    } catch (error) {
      this.dispatch({ type: 'notice/push', level: 'error', text: `No se pudo crear el chat: ${messageOf(error)}` });
      return null;
    }
  }

  async openSession(id: SessionId, options: { full?: boolean } = {}): Promise<void> {
    if (this.loading.has(id)) return;
    const key = String(id);
    const known = this.state.sessionIndex[id];
    const summary: SessionSummary = known?.summary ?? summaryOf({ id, title: 'Sesión' });
    const reload = options.full === true || !this.loaded.has(id);
    if (reload) this.dispatch({ type: 'session/reset', sessionId: id });
    this.dispatch({ type: 'session/open', summary });
    if (!reload) {
      await this.watchSession(id, known?.lastAppliedCursor ?? null, known?.epoch ?? null).catch(() => {});
      return;
    }

    this.loading.add(key);
    try {
      const response = await this.client.request<WireSessionLoadResponse>('session/load', {
        sessionId: id,
        cwd: summary.cwd ?? this.defaultCwd,
        mcpServers: [],
        _meta: options.full
          ? { replayTail: 1_000_000_000 }
          : { replayTail: REPLAY_TAIL, replayMaxBlockBytes: REPLAY_MAX_BLOCK },
      });
      this.loaded.add(id);
      const events: AppEvent[] = [];
      if (Array.isArray(response.configOptions)) {
        events.push({
          type: 'session/config',
          sessionId: id,
          configOptions: response.configOptions.map((option) => ({
            id: option.id,
            name: option.name,
            ...(option.description !== undefined ? { description: option.description } : {}),
            ...(option.currentValue !== undefined ? { currentValue: option.currentValue } : {}),
            ...(option.options !== undefined ? { options: option.options } : {}),
          })),
        });
      }
      if (Array.isArray(response.modes?.availableModes)) {
        events.push({
          type: 'session/modes',
          sessionId: id,
          modes: response.modes.availableModes.map((mode) => ({ id: mode.id, name: mode.name, ...(mode.description ? { description: mode.description } : {}) })),
          currentModeId: response.modes.currentModeId ?? null,
        });
      }
      const skipped = response._meta?.replaySkipped;
      if (typeof skipped === 'number') {
        events.push({ type: 'session/replaySkipped', sessionId: id, skipped, full: options.full === true });
      }
      this.apply(events);
    } catch (error) {
      this.dispatch({ type: 'notice/push', level: 'error', text: `No se pudo cargar el chat: ${messageOf(error)}` });
    } finally {
      this.loading.delete(key);
    }
    await this.watchSession(id, null, null).catch(() => {
      this.dispatch({ type: 'session/watch', sessionId: id, status: 'unsupported' });
    });
  }

  async closeSession(): Promise<void> {
    const active = this.state.activeSessionId;
    if (active) await this.unwatchSession(active);
    this.dispatch({ type: 'session/close' });
  }

  private async watchSession(id: SessionId, since: number | null, epoch: string | null): Promise<void> {
    this.watched.add(id);
    const response = await this.client.request<WireSessionWatchResponse>('_aegis/unstable/session/watch', {
      sessionId: id,
      since,
      ...(epoch ? { epoch } : {}),
    });
    this.dispatch({
      type: 'session/watch',
      sessionId: id,
      status: 'watching',
      cursor: response.cursor,
      epoch: response.epoch,
    });
    for (const notification of response.replay ?? []) {
      this.onNotification(notification as unknown as JsonRpcNotification);
    }
    if (response.activeRunId) {
      this.dispatch({ type: 'run/started', sessionId: id, runId: response.activeRunId as never, adopted: true });
    } else {
      const session = this.state.sessionIndex[id];
      if (session && isRunning(session)) this.dispatch({ type: 'run/ended', sessionId: id });
      if (session) this.dispatch({ type: 'tools/interrupt', sessionId: id });
    }
  }

  private async unwatchSession(id: SessionId): Promise<void> {
    this.watched.delete(id);
    try {
      await this.client.request('_aegis/unstable/session/unwatch', { sessionId: id });
    } catch {
      // Si el socket ya no está, el hub desengancha solo.
    }
  }

  // -------------------------------------------------------------------------
  // Notificaciones
  // -------------------------------------------------------------------------

  private onNotification(message: JsonRpcNotification | JsonRpcServerRequest): void {
    const method = typeof message.method === 'string' ? message.method : '';
    if (method === 'session/update') {
      const params = message.params;
      if (!isRecord(params)) return;
      const events = translateSessionUpdate(params as never);
      this.apply(this.dedupeEcho(events));
      return;
    }
    if (method === '_aegis/unstable/session/update') {
      const params = message.params;
      if (!isRecord(params)) return;
      this.apply(translateAegisUpdate(params as never));
      return;
    }
    if (method === '_aegis/unstable/session/replay_gap') {
      const params = isRecord(message.params) ? message.params : {};
      const session = typeof params['sessionId'] === 'string' ? sid(params['sessionId']) : this.state.activeSessionId;
      if (!session) return;
      // Un gap dispara UNA recarga: si el watch siguiente repite el aviso, no se vuelve a cargar.
      if (this.reloading.has(session)) return;
      this.reloading.add(session);
      this.dispatch({ type: 'session/watch', sessionId: session, status: 'gap' });
      this.dispatch({
        type: 'notice/push',
        level: 'warn',
        text: 'El servidor descartó parte del replay; recargando el historial completo.',
      });
      void this.openSession(session, { full: true }).finally(() => {
        this.reloading.delete(session);
      });
      return;
    }
    if (method === 'session/request_permission') {
      this.onPermission(message as JsonRpcServerRequest);
      return;
    }
    if (typeof (message as JsonRpcServerRequest).id !== 'undefined') {
      const id = (message as JsonRpcServerRequest).id;
      this.client.respondError(id, -32601, `no soportado: ${method}`);
    }
  }

  /**
   * El eco del propio prompt vuelve como `user_message_chunk` con el id del servidor, y el replay
   * puede repetir un mensaje que ya está en pantalla. Regla: si el id ya existe, se descarta; si la
   * burbuja local sigue pendiente y el texto coincide, se adopta (no se duplica).
   */
  private dedupeEcho(events: readonly AppEvent[]): AppEvent[] {
    const out: AppEvent[] = [];
    for (const event of events) {
      if (event.type === 'message/chunk' && event.kind === 'user' && !event.messageId.startsWith('run:')) {
        const session = this.state.sessionIndex[event.sessionId];
        if (!session) {
          out.push(event);
          continue;
        }
        const existing = session.messageIndex[event.messageId];
        if (existing) continue;
        const local = session.messages
          .map((mid) => session.messageIndex[mid])
          .find(
            (message) =>
              message !== undefined &&
              message.kind === 'user' &&
              message.pending &&
              message.blocks.some((blockId) => session.blocks[blockId]?.text === event.text),
          );
        if (local) {
          out.push({ type: 'message/adopt', sessionId: event.sessionId, localId: local.id, serverId: event.messageId });
          continue;
        }
        out.push(event);
        continue;
      }
      out.push(event);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Permisos
  // -------------------------------------------------------------------------

  private onPermission(message: JsonRpcServerRequest): void {
    const params = message.params;
    if (!isRecord(params)) return;
    const wire = params as unknown as WirePermissionRequest;
    if (typeof wire.sessionId !== 'string' || wire.sessionId.length === 0) return;
    const id = permissionId(String(message.id));
    const request: PermissionRequest = {
      id,
      sessionId: sid(wire.sessionId),
      toolCallId: wire.toolCall?.toolCallId ? (wire.toolCall.toolCallId as never) : null,
      title: wire.toolCall?.title ?? wire.toolCall?.name ?? 'Confirmación',
      options: (wire.options ?? []).map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind,
      })),
      createdAt: this.now(),
    };
    this.pendingPermissions.set(String(id), { rpcId: message.id, sessionId: request.sessionId, request });
    this.dispatch({ type: 'permission/request', sessionId: request.sessionId, request });
    if (request.sessionId !== this.state.activeSessionId) {
      this.dispatch({ type: 'notice/push', level: 'warn', text: 'Otra sesión pide una confirmación.', id: `perm:${id}` });
    }
  }

  async respondPermission(id: string, optionId: string | null): Promise<void> {
    const entry = this.pendingPermissions.get(id);
    if (!entry) return;
    this.pendingPermissions.delete(id);
    if (optionId === null) {
      this.client.respond(entry.rpcId, { outcome: { outcome: 'cancelled' } });
    } else {
      this.client.respond(entry.rpcId, { outcome: { outcome: 'selected', optionId } });
    }
    this.dispatch({ type: 'permission/resolved', sessionId: entry.sessionId, permissionId: permissionId(id) });
  }

  /** Cancela todos los permisos pendientes de una sesión (al cancelar el turno, ACP lo exige). */
  cancelPermissions(sessionId: SessionId): void {
    for (const [id, entry] of [...this.pendingPermissions]) {
      if (entry.sessionId !== sessionId) continue;
      this.pendingPermissions.delete(id);
      this.client.respond(entry.rpcId, { outcome: { outcome: 'cancelled' } });
      this.dispatch({ type: 'permission/resolved', sessionId, permissionId: permissionId(id) });
    }
  }

  // -------------------------------------------------------------------------
  // Envío: prompt, cola y steer
  // -------------------------------------------------------------------------

  async submit(text: string, attachments: readonly Attachment[] = []): Promise<void> {
    const id = this.state.activeSessionId;
    if (!id) return;
    if (!text.trim() && attachments.length === 0) return;
    const session = this.state.sessionIndex[id];
    if (isRunning(session)) {
      await this.steer(id, text, attachments);
      return;
    }
    await this.prompt(id, text, attachments);
  }

  private async prompt(sessionId: SessionId, text: string, attachments: readonly Attachment[]): Promise<void> {
    const promptId = newPromptId();
    const local = `local:msg:${promptId}` as never;
    this.dispatch({
      type: 'message/local',
      sessionId,
      messageId: local,
      role: 'user',
      text,
      attachments,
      pending: true,
    });
    this.dispatch({ type: 'run/started', sessionId, runId: `local:run:${promptId}` as never, adopted: false, promptId });

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.client.request('session/prompt', {
          sessionId,
          prompt: promptBlocks(text, attachments),
          _meta: { promptId },
        });
        this.dispatch({ type: 'run/ended', sessionId, runId: `local:run:${promptId}` as never });
        this.dispatch({ type: 'message/confirmed', sessionId, messageId: local, serverId: local });
        void this.flushQueue();
        return;
      } catch (error) {
        lastError = error;
        const message = messageOf(error);
        if (!isTransientError(message) || attempt === 3) break;
        this.dispatch({
          type: 'notice/push',
          level: 'info',
          text: `Se cortó la conexión; verificando si tu mensaje llegó (intento ${attempt + 1} de 3).`,
        });
        await this.sleep(attempt * 3000);
      }
    }

    this.dispatch({ type: 'run/ended', sessionId, runId: `local:run:${promptId}` as never });
    this.dispatch({ type: 'message/confirmed', sessionId, messageId: local, serverId: local });
    this.dispatch({ type: 'notice/push', level: 'error', text: `No se pudo enviar: ${messageOf(lastError)}` });
  }

  async steer(sessionId: SessionId, text: string, attachments: readonly Attachment[] = []): Promise<void> {
    const session = this.state.sessionIndex[sessionId];
    const run = session?.run;
    if (!run || !isRunning(session)) {
      await this.prompt(sessionId, text, attachments);
      return;
    }
    try {
      const response = await this.client.request<WireSteerResponse>('_aegis/unstable/session/steer', {
        sessionId,
        prompt: promptBlocks(text, attachments),
        expectedRunId: run.id,
      });
      const mid = response.messageId as never;
      const steer: SteerMessage = {
        id: `steer:${response.messageId}`,
        messageId: mid,
        text,
        createdAt: this.now(),
        state: 'queued',
        serverQueued: true,
      };
      this.dispatch({ type: 'steer/add', steer });
      this.dispatch({
        type: 'message/local',
        sessionId,
        messageId: mid,
        role: 'user',
        text,
        attachments,
        pending: false,
      });
    } catch (error) {
      const message = messageOf(error);
      if (message.includes('run') || message.includes('409') || message.includes('already')) {
        // El run terminó entre el render y el envío: se encola como prompt normal.
        this.enqueue(text, attachments);
        return;
      }
      this.dispatch({ type: 'notice/push', level: 'error', text: `No se pudo mandar la indicación: ${message}` });
    }
  }

  enqueue(text: string, attachments: readonly Attachment[] = []): void {
    const prompt: QueuedPrompt = {
      id: `q:${this.now()}:${Math.random().toString(36).slice(2, 8)}`,
      text,
      attachments,
      createdAt: this.now(),
      state: 'queued',
    };
    this.dispatch({ type: 'queue/add', prompt });
  }

  async flushQueue(): Promise<void> {
    if (this.flushing) return;
    const id = this.state.activeSessionId;
    if (!id) return;
    const session = this.state.sessionIndex[id];
    if (isRunning(session)) return;
    const next = this.state.queue.find((item) => item.state === 'queued');
    if (!next) return;
    this.flushing = true;
    try {
      this.dispatch({ type: 'queue/update', id: next.id, state: 'sending' });
      await this.prompt(id, next.text, next.attachments);
      this.dispatch({ type: 'queue/remove', id: next.id });
    } finally {
      this.flushing = false;
    }
  }

  async cancel(): Promise<void> {
    const id = this.state.activeSessionId;
    if (!id) return;
    this.cancelPermissions(id);
    this.client.notify('session/cancel', { sessionId: id });
    const run = this.state.sessionIndex[id]?.run;
    if (run) this.dispatch({ type: 'run/ended', sessionId: id, runId: run.id, cancelled: true });
  }

  // -------------------------------------------------------------------------
  // Historial: rewind, retry, carga completa
  // -------------------------------------------------------------------------

  async rewind(back = 1): Promise<string | null> {
    const id = this.state.activeSessionId;
    if (!id) return null;
    try {
      const response = await this.client.request<WireRewindResponse>('_aegis/unstable/session/rewind', {
        sessionId: id,
        back,
      });
      this.dispatch({ type: 'session/hiddenFrom', sessionId: id, from: response.messageId as never });
      this.dispatch({
        type: 'notice/push',
        level: 'info',
        text: `${response.hidden} mensajes dejaron de mandarse al modelo. El turno volvió al compositor.`,
      });
      return response.text;
    } catch (error) {
      this.dispatch({ type: 'notice/push', level: 'error', text: `No se pudo rebobinar: ${messageOf(error)}` });
      return null;
    }
  }

  async retry(): Promise<string | null> {
    const id = this.state.activeSessionId;
    if (!id) return null;
    try {
      const response = await this.client.request<{ text: string; preview: string; hidden: number; profile: string }>(
        '_aegis/unstable/session/retry',
        { sessionId: id },
      );
      const session = this.state.sessionIndex[id];
      const lastUser = session?.messages
        .map((mid) => session.messageIndex[mid])
        .filter((m): m is NonNullable<typeof m> => Boolean(m) && m!.kind === 'user')
        .at(-1);
      if (lastUser) this.dispatch({ type: 'session/hiddenFrom', sessionId: id, from: lastUser.id });
      return response.text;
    } catch (error) {
      this.dispatch({ type: 'notice/push', level: 'error', text: `No se pudo regenerar: ${messageOf(error)}` });
      return null;
    }
  }

  async loadFullHistory(): Promise<void> {
    const id = this.state.activeSessionId;
    if (!id) return;
    await this.openSession(id, { full: true });
  }

  // -------------------------------------------------------------------------
  // Configuración de sesión
  // -------------------------------------------------------------------------

  async setConfigOption(configId: string, value: string): Promise<void> {
    const id = this.state.activeSessionId;
    if (!id) return;
    try {
      const response = await this.client.request<{ configOptions?: WireSessionLoadResponse['configOptions'] }>(
        'session/set_config_option',
        { sessionId: id, configId, value },
      );
      if (Array.isArray(response.configOptions)) {
        this.dispatch({
          type: 'session/config',
          sessionId: id,
          configOptions: response.configOptions.map((option) => ({
            id: option.id,
            name: option.name,
            ...(option.description !== undefined ? { description: option.description } : {}),
            ...(option.currentValue !== undefined ? { currentValue: option.currentValue } : {}),
            ...(option.options !== undefined ? { options: option.options } : {}),
          })),
        });
      }
    } catch (error) {
      this.dispatch({ type: 'notice/push', level: 'error', text: `No se pudo cambiar la opción: ${messageOf(error)}` });
    }
  }

  async setMode(modeId: string): Promise<void> {
    const id = this.state.activeSessionId;
    if (!id) return;
    try {
      await this.client.request('session/set_mode', { sessionId: id, modeId });
      const session = this.state.sessionIndex[id];
      if (session) {
        this.dispatch({ type: 'session/modes', sessionId: id, modes: session.modes, currentModeId: modeId });
      }
    } catch (error) {
      this.dispatch({ type: 'notice/push', level: 'error', text: `No se pudo cambiar el modo: ${messageOf(error)}` });
    }
  }

  async rename(title: string): Promise<void> {
    const id = this.state.activeSessionId;
    if (!id || !title.trim()) return;
    try {
      await this.client.request('_aegis/unstable/session/rename', { sessionId: id, title: title.trim() });
      this.renamed.set(id, title.trim());
      this.dispatch({ type: 'session/title', sessionId: id, title: title.trim() });
    } catch (error) {
      this.dispatch({ type: 'notice/push', level: 'error', text: `No se pudo renombrar: ${messageOf(error)}` });
    }
  }

  async archive(id: SessionId, archived: boolean): Promise<void> {
    try {
      await this.client.request(archived ? '_aegis/unstable/session/archive' : '_aegis/unstable/session/unarchive', {
        sessionId: id,
      });
      this.dispatch({ type: 'sessions/removed', sessionId: id, archived });
      await this.refreshSessions();
    } catch (error) {
      this.dispatch({ type: 'notice/push', level: 'error', text: `No se pudo archivar: ${messageOf(error)}` });
    }
  }

  async remove(id: SessionId): Promise<void> {
    try {
      await this.client.request('session/delete', { sessionId: id });
      this.dispatch({ type: 'sessions/removed', sessionId: id, archived: false });
    } catch (error) {
      this.dispatch({ type: 'notice/push', level: 'error', text: `No se pudo borrar: ${messageOf(error)}` });
    }
  }

  /** Passthrough tipado para paneles que hablan métodos ACP que no son parte del flujo del chat. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.client.request<T>(method, params);
  }

  /** Dictado: manda el WAV en base64 y devuelve el texto transcripto. */
  async transcribe(audioBase64: string, provider?: string): Promise<string> {
    const response = await this.client.request<{ text?: string }>('_aegis/unstable/dictation/transcribe', {
      audio: audioBase64,
      mimeType: 'audio/wav',
      ...(provider ? { provider } : {}),
    });
    return typeof response?.text === 'string' ? response.text : '';
  }

  async sessionInfo(id: SessionId): Promise<WireSessionInfoResponse['session'] | null> {    try {
      const response = await this.client.request<WireSessionInfoResponse>('_aegis/unstable/session/info', {
        sessionId: id,
      });
      return response.session ?? null;
    } catch {
      return null;
    }
  }

  /** Empuja al estado las sesiones que el servidor dice que están corriendo (lista periódica). */
  markRunning(ids: readonly string[]): void {
    const running = new Set(ids);
    for (const id of this.state.sessions) {
      const session = this.state.sessionIndex[id];
      if (!session) continue;
      const shouldRun = running.has(id);
      if (shouldRun && !session.summary.running) {
        this.dispatch({ type: 'run/started', sessionId: id, runId: `adopted:${id}` as never, adopted: true });
      } else if (!shouldRun && session.summary.running && !session.run) {
        this.dispatch({ type: 'run/ended', sessionId: id });
      }
    }
  }

  dismissNotice(id: string): void {
    this.dispatch({ type: 'notice/dismiss', id });
  }

  // Compatibilidad de la UI: nombres explícitos por sesión, sin depender de la sesión abierta.

  async rewindTo(messageIdRaw: string): Promise<string | null> {
    const id = this.state.activeSessionId;
    if (!id) return null;
    try {
      const response = await this.client.request<WireRewindResponse>('_aegis/unstable/session/rewind', {
        sessionId: id,
        messageId: messageIdRaw,
      });
      this.dispatch({ type: 'session/hiddenFrom', sessionId: id, from: response.messageId as never });
      return response.text;
    } catch (error) {
      this.dispatch({ type: 'notice/push', level: 'error', text: `No se pudo rebobinar: ${messageOf(error)}` });
      return null;
    }
  }

  async renameSession(id: SessionId, title: string): Promise<void> {
    if (!title.trim()) return;
    try {
      await this.client.request('_aegis/unstable/session/rename', { sessionId: id, title: title.trim() });
      this.renamed.set(id, title.trim());
      this.dispatch({ type: 'session/title', sessionId: id, title: title.trim() });
    } catch (error) {
      this.dispatch({ type: 'notice/push', level: 'error', text: `No se pudo renombrar: ${messageOf(error)}` });
    }
  }

  async removeSession(id: SessionId): Promise<void> {
    try {
      await this.client.request('session/delete', { sessionId: id });
      this.dispatch({ type: 'sessions/removed', sessionId: id, archived: false });
      if (this.state.activeSessionId === id) {
        const next = this.state.sessions.find((candidate) => candidate !== id);
        if (next) await this.openSession(next);
      }
    } catch (error) {
      this.dispatch({ type: 'notice/push', level: 'error', text: `No se pudo borrar: ${messageOf(error)}` });
    }
  }

  /** Pedidos de permiso vivos de una sesión, en orden de llegada. */
  permissionsOf(id: SessionId): PermissionRequest[] {
    const session = this.state.sessionIndex[id];
    if (!session) return [];
    return session.permissions
      .map((permissionIdRaw) => this.state.permissionIndex[permissionIdRaw])
      .filter((request): request is PermissionRequest => Boolean(request));
  }}

const messageOf = (error: unknown): string =>
  error instanceof AcpError
    ? error.message
    : error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : JSON.stringify(error);

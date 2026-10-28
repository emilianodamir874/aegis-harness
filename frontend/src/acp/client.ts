import {
  ACP_PROTOCOL_VERSION,
  isRecord,
  type JsonRpcError,
  type JsonRpcNotification,
  type JsonRpcResponse,
  type JsonRpcServerRequest,
} from './protocol';
import { WebSocketTransport, type SocketFactory, type Transport, type TransportEvent } from './transport';

export class AcpError extends Error {
  readonly code: number;
  readonly data: unknown;
  readonly method: string;

  constructor(error: JsonRpcError, method: string) {
    const detail =
      error.data === undefined || error.data === null
        ? ''
        : typeof error.data === 'string'
          ? error.data
          : JSON.stringify(error.data);
    super(`${error.message}${detail ? `: ${detail}` : ''} [método: ${method}]`);
    this.name = 'AcpError';
    this.code = error.code;
    this.data = error.data;
    this.method = method;
  }
}

export type AcpClientStatus = 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'closed';

export interface AcpClientOptions {
  readonly url: string;
  readonly socketFactory?: SocketFactory;
  readonly requestTimeoutMs?: number;
  readonly minBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly onStatus?: (status: AcpClientStatus, retryInMs: number | null) => void;
  readonly onParseError?: (raw: string) => void;
  /** Reloj inyectable para las pruebas. */
  readonly setTimeoutFn?: (fn: () => void, ms: number) => number;
  readonly clearTimeoutFn?: (id: number) => void;
}

interface Pending {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: number;
}

const INIT_PARAMS = {
  protocolVersion: ACP_PROTOCOL_VERSION,
  clientCapabilities: { _meta: { aegis: { customNotifications: true, toolCallLabelEnrichment: true } } },
  clientInfo: { name: 'aegis-web-react', version: '0.1.0' },
  _meta: { 'aegis/useLoginShellPath': true },
} as const;

/**
 * Cliente ACP tipado: JSON-RPC 2.0 sobre WebSocket, sin React y sin conocer el dominio.
 *
 * Responsabilidades: correlacionar pedidos con respuestas, rechazar lo pendiente cuando el socket
 * muere, reconectar con backoff y entregar notificaciones. Nada de estado de UI.
 */
export class AcpClient {
  private readonly transport: Transport;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationListeners = new Set<(message: JsonRpcNotification | JsonRpcServerRequest) => void>();
  private readonly statusListeners = new Set<(status: AcpClientStatus, retryInMs: number | null) => void>();
  private nextId = 1;
  private backoff: number;
  private retryTimer: number | null = null;
  private _status: AcpClientStatus = 'idle';
  private readonly timeout: number;
  private readonly minBackoff: number;
  private readonly maxBackoff: number;
  private readonly setT: (fn: () => void, ms: number) => number;
  private readonly clearT: (id: number) => void;
  /** Mientras el proceso de conexión corre, `connect()` espera el initialize. */
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((reason: unknown) => void) | null = null;

  constructor(private readonly options: AcpClientOptions) {
    this.transport = new WebSocketTransport(options.url, options.socketFactory);
    this.timeout = options.requestTimeoutMs ?? 120_000;
    this.minBackoff = options.minBackoffMs ?? 1_000;
    this.maxBackoff = options.maxBackoffMs ?? 15_000;
    this.backoff = this.minBackoff;
    this.setT = options.setTimeoutFn ?? ((fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number);
    this.clearT = options.clearTimeoutFn ?? ((id) => globalThis.clearTimeout(id));
    this.transport.on((event) => this.onTransportEvent(event));
  }

  get status(): AcpClientStatus {
    return this._status;
  }

  onNotification(listener: (message: JsonRpcNotification | JsonRpcServerRequest) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onStatus(listener: (status: AcpClientStatus, retryInMs: number | null) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(status: AcpClientStatus, retryInMs: number | null = null): void {
    this._status = status;
    this.options.onStatus?.(status, retryInMs);
    for (const listener of [...this.statusListeners]) listener(status, retryInMs);
  }

  /** Conecta y resuelve cuando `initialize` respondió. Reintenta solo si ya estaba conectado antes. */
  connect(): Promise<void> {
    if (this._status === 'ready') return Promise.resolve();
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.setStatus(this._status === 'idle' ? 'connecting' : 'reconnecting');
    this.transport.connect();
    return this.readyPromise;
  }

  private settleReady(error?: unknown): void {
    const resolve = this.readyResolve;
    const reject = this.readyReject;
    this.readyResolve = null;
    this.readyReject = null;
    this.readyPromise = null;
    if (error !== undefined) reject?.(error);
    else resolve?.();
  }

  private onTransportEvent(event: TransportEvent): void {
    switch (event.type) {
      case 'open': {
        this.request('initialize', INIT_PARAMS)
          .then(() => {
            this.backoff = this.minBackoff;
            this.setStatus('ready');
            this.settleReady();
          })
          .catch((error: unknown) => {
            this.options.onParseError?.(`initialize: ${String(error)}`);
            this.transport.close(4000, 'initialize falló');
          });
        break;
      }
      case 'message': {
        this.handleMessage(event.message);
        break;
      }
      case 'unreadable':
        this.options.onParseError?.(event.raw);
        break;
      case 'error':
        this.options.onParseError?.(event.message);
        break;
      case 'close': {
        this.failPending(new Error('conexión cerrada'));
        if (this._status === 'closed') break;
        this.settleReady(new Error('conexión cerrada antes de initialize'));
        const retryIn = this.backoff;
        this.setStatus('reconnecting', retryIn);
        this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
        this.retryTimer = this.setT(() => {
          this.retryTimer = null;
          this.connect().catch(() => {
            // Un fallo de reconexión vuelve a entrar por el cierre del socket; no se duplica acá.
          });
        }, retryIn);
        break;
      }
    }
  }

  private handleMessage(message: JsonRpcNotification | JsonRpcResponse | JsonRpcServerRequest): void {
    const maybeResponse = message as JsonRpcResponse;
    const hasMethod = typeof (message as JsonRpcNotification).method === 'string';
    if (!hasMethod && maybeResponse.id !== undefined) {
      const id = typeof maybeResponse.id === 'string' ? Number(maybeResponse.id) : maybeResponse.id;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      this.clearT(entry.timer);
      if (maybeResponse.error) entry.reject(new AcpError(maybeResponse.error, entry.method));
      else entry.resolve(maybeResponse.result);
      return;
    }
    const notification = message as JsonRpcNotification | JsonRpcServerRequest;
    for (const listener of [...this.notificationListeners]) listener(notification);  }

  private failPending(reason: unknown): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      this.clearT(entry.timer);
      entry.reject(reason);
    }
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = this.timeout): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const timer = this.setT(() => {
        this.pending.delete(id);
        reject(new Error(`timeout de ${timeoutMs} ms [método: ${method}]`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.transport.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        this.clearT(timer);
        reject(error);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    try {
      this.transport.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
    } catch {
      // Una notificación sin socket se descarta: el coordinador decide si encola.
    }
  }

  respond(id: number | string, result: unknown): void {
    try {
      this.transport.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
    } catch {
      // idem
    }
  }

  respondError(id: number | string, code: number, message: string): void {
    try {
      this.transport.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
    } catch {
      // idem
    }
  }

  close(): void {
    if (this.retryTimer !== null) {
      this.clearT(this.retryTimer);
      this.retryTimer = null;
    }
    this.setStatus('closed');
    this.transport.close();
    this.failPending(new Error('cliente cerrado'));
  }

  // -------------------------------------------------------------------------
  // Operaciones ACP usadas por el coordinador
  // -------------------------------------------------------------------------

  secure<T>(value: unknown): T {
    return value as T;
  }
}

export const isJsonRpcServerRequest = (message: JsonRpcNotification | JsonRpcServerRequest): message is JsonRpcServerRequest =>
  isRecord(message) && typeof message.method === 'string' && (typeof message.id === 'number' || typeof message.id === 'string');

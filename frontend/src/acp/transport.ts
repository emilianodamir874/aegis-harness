import { parseJsonRpc, type JsonRpcMessage, type JsonRpcServerRequest } from './protocol';

export type TransportEvent =
  | { type: 'open' }
  | { type: 'message'; message: JsonRpcMessage | JsonRpcServerRequest }
  | { type: 'unreadable'; raw: string }
  | { type: 'close'; code: number; reason: string; wasClean: boolean }
  | { type: 'error'; message: string };

export interface Transport {
  connect(): void;
  send(text: string): void;
  close(code?: number, reason?: string): void;
  readonly state: 'idle' | 'connecting' | 'open' | 'closed';
  on(listener: (event: TransportEvent) => void): () => void;
}

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: (event: { code: number; reason: string; wasClean: boolean }) => void): void;
  addEventListener(type: 'error', listener: () => void): void;
}

export type SocketFactory = (url: string) => WebSocketLike;

const defaultFactory: SocketFactory = (url) => new WebSocket(url) as unknown as WebSocketLike;

/**
 * Transporte WebSocket del ACP.
 *
 * No conoce el protocolo: entrega JSON-RPC parseado y avisa del cierre. La reconexión la decide el
 * cliente (que es quien sabe qué sesiones estaban enganchadas y con qué cursor).
 */
export class WebSocketTransport implements Transport {
  private socket: WebSocketLike | null = null;
  private listeners = new Set<(event: TransportEvent) => void>();
  private _state: Transport['state'] = 'idle';

  constructor(
    private readonly url: string,
    private readonly factory: SocketFactory = defaultFactory,
  ) {}

  get state(): Transport['state'] {
    return this._state;
  }

  on(listener: (event: TransportEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: TransportEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  connect(): void {
    if (this._state === 'connecting' || this._state === 'open') return;
    this._state = 'connecting';
    let socket: WebSocketLike;
    try {
      socket = this.factory(this.url);
    } catch (error) {
      this._state = 'closed';
      this.emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      return;
    }
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this._state = 'open';
      this.emit({ type: 'open' });
    });
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      const raw = typeof event.data === 'string' ? event.data : '';
      const message = parseJsonRpc(raw);
      if (!message) {
        this.emit({ type: 'unreadable', raw: raw.slice(0, 200) });
        return;
      }
      this.emit({ type: 'message', message });
    });
    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return;
      this._state = 'closed';
      this.socket = null;
      this.emit({ type: 'close', code: event.code, reason: event.reason, wasClean: event.wasClean });
    });
    socket.addEventListener('error', () => {
      if (this.socket !== socket) return;
      this.emit({ type: 'error', message: 'error de socket' });
    });
  }

  send(text: string): void {
    if (this._state !== 'open' || !this.socket) throw new Error('socket no conectado');
    this.socket.send(text);
  }

  close(code = 1000, reason = 'cliente'): void {
    const socket = this.socket;
    this.socket = null;
    this._state = 'closed';
    if (socket) {
      try {
        socket.close(code, reason);
      } catch {
        // Un socket ya cerrado no es un error.
      }
    }
  }
}

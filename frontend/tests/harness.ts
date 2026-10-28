import type { SocketFactory, WebSocketLike } from '../src/acp/transport';
import type { JsonRpcMessage } from '../src/acp/protocol';
import { AcpClient } from '../src/acp/client';
import { AegisStore } from '../src/domain/store';
import { FixtureAcpServer, type FixtureSession } from '../src/fixtures/server';

/** Socket de prueba: entrega respuestas en microtareas, sin red ni temporizadores reales. */
export class TestSocket implements WebSocketLike {
  readyState = 0;
  private listeners = new Map<string, ((event: never) => void)[]>();
  connection: { id: number; close: () => void } | null = null;
  sent: string[] = [];

  constructor(
    private readonly server: FixtureAcpServer,
    private readonly onSend?: (socket: TestSocket) => void,
  ) {}

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) (listener as (value: unknown) => void)(event);
  }

  open(): void {
    this.readyState = 1;
    this.connection = this.server.connect((message: JsonRpcMessage) => {
      this.emit('message', { data: JSON.stringify(message) });
    });
    this.emit('open', undefined);
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(data);
    this.onSend?.(this);
    if (!this.connection) return;
    const parsed = JSON.parse(data) as { id?: number; method?: string; params?: unknown };
    if (typeof parsed.method !== 'string') return;
    if (typeof parsed.id !== 'number') return;
    void this.server
      .handle(this.connection.id, { jsonrpc: '2.0', id: parsed.id, method: parsed.method, params: parsed.params })
      .then((response) => {
        if (response) this.emit('message', { data: JSON.stringify(response) });
      });
  }

  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.connection?.close();
    this.emit('close', { code, reason, wasClean: true });
  }

  /** Corte abrupto (como cuando se cae la red). */
  drop(): void {
    this.readyState = 3;
    this.connection?.close();
    this.emit('close', { code: 1006, reason: 'red', wasClean: false });
  }

  /** Simula una notificación del servidor (por fuera de un request). */
  deliver(message: JsonRpcMessage): void {
    this.emit('message', { data: JSON.stringify(message) });
  }
}

export interface Harness {
  readonly server: FixtureAcpServer;
  readonly client: AcpClient;
  readonly store: AegisStore;
  readonly sockets: TestSocket[];
  connect(): Promise<void>;
  /** Espera a que se vacíen las microtareas y promesas pendientes. */
  flush(times?: number): Promise<void>;
  lastSocket(): TestSocket;
}

export function createHarness(sessions: readonly FixtureSession[]): Harness {
  const server = new FixtureAcpServer({ sessions });
  const sockets: TestSocket[] = [];
  const factory: SocketFactory = () => {
    const socket = new TestSocket(server);
    sockets.push(socket);
    queueMicrotask(() => socket.open());
    return socket;
  };
  const client = new AcpClient({
    url: 'ws://fixture/acp',
    socketFactory: factory,
    requestTimeoutMs: 5000,
    minBackoffMs: 2,
    maxBackoffMs: 4,
  });
  const store = new AegisStore({ client, defaultCwd: 'C:/lab', sleep: () => Promise.resolve() });

  const flush = async (rounds = 6): Promise<void> => {
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  return {
    server,
    client,
    store,
    sockets,
    flush,
    lastSocket: () => sockets[sockets.length - 1] as TestSocket,
    connect: async () => {
      await store.connect();
      await flush();
    },
  };
}

import { StrictMode, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../App';
import { AegisProvider } from '../state/context';
import { AcpClient } from '../acp/client';
import { AegisStore } from '../domain/store';
import { devConfig } from '../config';
import { FixtureAcpServer } from '../fixtures/server';
import type { SocketFactory, WebSocketLike } from '../acp/transport';
import type { JsonRpcMessage } from '../acp/protocol';
import '../../../app/app.css';
import '../styles.css';

/**
 * Modo fixtures: la app completa contra un serve ACP de mentira.
 *
 * No toca Node, ni el túnel, ni la sesión viva. Sirve para abrir la UI sin motor y para que los
 * tests de navegador tengan un backend determinista (desconexiones, replay, permisos).
 */

class FakeSocket implements WebSocketLike {
  readyState = 0;
  private readonly listeners = new Map<string, ((event: never) => void)[]>();
  private connection: { id: number; close: () => void } | null = null;

  constructor(
    private readonly server: FixtureAcpServer,
    private readonly url: string,
  ) {
    void this.url;
    setTimeout(() => {
      this.readyState = 1;
      this.connection = this.server.connect((message: JsonRpcMessage) => this.emit('message', { data: JSON.stringify(message) } as never));
      this.emit('open', undefined as never);
    }, 30);
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) (listener as (value: unknown) => void)(event);
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    if (!this.connection) return;
    const parsed = JSON.parse(data) as { id?: number; method?: string; params?: unknown };
    if (typeof parsed.method !== 'string' || typeof parsed.id !== 'number') return;
    void this.server
      .handle(this.connection.id, { jsonrpc: '2.0', id: parsed.id, method: parsed.method, params: parsed.params })
      .then((response) => {
        if (response) this.emit('message', { data: JSON.stringify(response) } as never);
      });
  }

  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.connection?.close();
    this.emit('close', { code, reason, wasClean: true } as never);
  }
}

const server = new FixtureAcpServer({
  sessions: [
    {
      sessionId: 'fixture-largo',
      title: 'Historial largo (fixture)',
      cwd: 'C:/Aegis-Proyects',
      activeRunId: null,
      messages: Array.from({ length: 60 }, (_, index) => ({
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        text:
          index % 2 === 0
            ? `Mensaje ${index + 1}: probando el transcript con historial largo.`
            : `Respuesta ${index + 1}: **texto** con \`código\` y una lista.\n\n- uno\n- dos\n- tres`,
      })),
    },
    {
      sessionId: 'fixture-herramientas',
      title: 'Herramientas y diffs (fixture)',
      cwd: 'C:/Aegis-Proyects/web',
      activeRunId: null,
      messages: [],
      toolCall: {
        toolCallId: 'tool-1',
        title: 'Editar frontend/src/App.tsx',
        name: 'developer__edit',
        kind: 'edit',
        status: 'completed',
        diff: { path: 'frontend/src/App.tsx', oldText: 'const a = 1;\nconst b = 2;\n', newText: 'const a = 1;\nconst b = 3;\nconst c = 4;\n' },
      },
      permissionOnPrompt: true,
    },
    {
      sessionId: 'fixture-otro',
      title: 'Otro chat activo (fixture)',
      cwd: 'C:/Aegis-Proyects/src',
      activeRunId: 'run-otro',
      messages: [{ role: 'user', text: 'Trabajando en otra pestaña' }],
    },
  ],
});

const socketFactory: SocketFactory = (url) => new FakeSocket(server, url);

function FixturesApp() {
  const config = useMemo(() => devConfig(), []);
  const client = useMemo(() => new AcpClient({ url: config.acpUrl, socketFactory }), [config]);
  const store = useMemo(() => new AegisStore({ client, defaultCwd: config.cwd }), [client, config]);
  return (
    <AegisProvider store={store} config={config}>
      <App />
    </AegisProvider>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('falta #root');
createRoot(container).render(
  <StrictMode>
    <FixturesApp />
  </StrictMode>,
);

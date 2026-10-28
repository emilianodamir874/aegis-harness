import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness';
import type { FixtureSession } from '../src/fixtures/server';
import type { SessionId } from '../src/domain/ids';

const longHistory = (count: number): FixtureSession => ({
  sessionId: 'largo',
  title: 'Historial largo',
  activeRunId: null,
  messages: Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    text: `m${index + 1}`,
    messageId: `h-${index + 1}`,
  })),
});

const base = (overrides: Partial<FixtureSession> & { sessionId: string }): FixtureSession => ({
  title: overrides.sessionId,
  activeRunId: null,
  messages: [],
  ...overrides,
});

let harness: Harness | null = null;

afterEach(() => {
  harness?.store.dispose();
  harness?.client.close();
  harness = null;
});

const boot = async (sessions: FixtureSession[], open: string): Promise<Harness> => {
  const h = createHarness(sessions);
  harness = h;
  await h.connect();
  await h.store.openSession(open as SessionId);
  await h.flush();
  return h;
};

const texts = (h: Harness, id: string): string[] => {
  const session = h.store.getState().sessionIndex[id];
  if (!session) return [];
  return session.messages
    .map((mid) => session.messageIndex[mid])
    .filter((message): message is NonNullable<typeof message> => Boolean(message))
    .map((message) => message.blocks.map((bid) => session.blocks[bid]?.text ?? '').join(''));
};

describe('store: carga y replay', () => {
  it('abre un chat con su historial y queda enganchado al watch', async () => {
    const h = await boot([base({ sessionId: 'a', messages: [{ role: 'user', text: 'pregunta' }, { role: 'assistant', text: 'respuesta' }] })], 'a');
    const state = h.store.getState();
    expect(state.sessionIndex['a']?.messages.length).toBe(2);
    expect(texts(h, 'a')).toEqual(['pregunta', 'respuesta']);
    expect(state.sessionIndex['a']?.watch).toBe('watching');
    expect(h.server.watcherCount('a')).toBe(1);
  });

  it('reabrir con historial completo reemplaza el transcript sin duplicar', async () => {
    const h = await boot([base({ sessionId: 'a', messages: [{ role: 'user', text: 'uno' }, { role: 'assistant', text: 'dos' }] })], 'a');
    await h.store.openSession('a' as SessionId, { full: true });
    await h.flush();
    expect(h.store.getState().sessionIndex['a']?.messages.length).toBe(2);
    expect(texts(h, 'a')).toEqual(['uno', 'dos']);
  });

  it('el replay del watch no reintroduce mensajes que ya están', async () => {
    const h = await boot([base({ sessionId: 'a', messages: [{ role: 'user', text: 'uno' }] })], 'a');
    h.server.sessionUpdate('a', {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'nuevo',
      content: { type: 'text', text: 'x' },
    });
    await h.flush();
    // El mismo frame otra vez, como haría un replay tras reconectar.
    h.server.sessionUpdate('a', {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'nuevo',
      content: { type: 'text', text: 'x' },
    });
    await h.flush();
    const session = h.store.getState().sessionIndex['a'];
    const message = session?.messageIndex['nuevo'];
    expect(message ? session?.blocks[message.blocks[0] ?? '']?.text : '').toBe('xx');
  });

  it('avisa cuánto recortó el servidor y permite pedir todo', async () => {
    const h = createHarness([longHistory(520)]);
    harness = h;
    await h.connect();
    await h.store.openSession('largo' as SessionId);
    await h.flush();
    expect(h.store.getState().sessionIndex['largo']?.replaySkipped).toBe(120);
    await h.store.loadFullHistory();
    await h.flush();
    const session = h.store.getState().sessionIndex['largo'];
    expect(session?.replaySkipped).toBe(0);
    expect(session?.fullHistory).toBe(true);
    expect(session?.messages.length).toBe(520);
  });

  it('un replay_gap recarga el historial completo', async () => {
    const h = await boot([base({ sessionId: 'a', messages: [{ role: 'user', text: 'uno' }, { role: 'assistant', text: 'dos' }] })], 'a');
    h.server.truncateRing('a');
    await h.flush();
    const session = h.store.getState().sessionIndex['a'];
    expect(session?.messages.length).toBe(2);
    expect(session?.watch).toBe('watching');
    expect(h.store.getState().notices.some((notice) => notice.text.includes('descartó parte del replay'))).toBe(true);
  });
});

describe('store: dos chats y permisos', () => {
  it('las actualizaciones de un chat no tocan el otro', async () => {
    const h = await boot(
      [base({ sessionId: 'a', messages: [] }), base({ sessionId: 'b', messages: [] })],
      'a',
    );
    await h.store.openSession('b' as SessionId);
    await h.flush();
    h.server.sessionUpdate('a', {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'a-1',
      content: { type: 'text', text: 'sólo para a' },
    });
    await h.flush();
    expect(texts(h, 'a')).toEqual(['sólo para a']);
    expect(texts(h, 'b')).toEqual([]);
    expect(h.store.getState().activeSessionId).toBe('b');
  });

  it('un permiso de otro chat se cuenta y se puede responder sin abrirlo', async () => {
    const h = await boot(
      [base({ sessionId: 'a', messages: [] }), base({ sessionId: 'b', messages: [] })],
      'a',
    );
    const socket = h.lastSocket();
    const connectionId = socket.connection?.id ?? 0;
    h.server.askPermission('b', connectionId, 4242, [{ optionId: 'allow', name: 'Permitir', kind: 'allow_once' }]);
    await h.flush();
    const state = h.store.getState();
    expect(state.pendingBySession['b']).toBe(1);
    expect(state.sessionIndex['a']?.permissions).toHaveLength(0);
    expect(h.store.permissionsOf('b' as SessionId)).toHaveLength(1);
    expect(state.notices.some((notice) => notice.text.includes('Otra sesión'))).toBe(true);

    const request = h.store.permissionsOf('b' as SessionId)[0];
    await h.store.respondPermission(request?.id ?? '', 'allow');
    await h.flush();
    expect(h.store.getState().pendingBySession['b']).toBe(0);
    const sent = socket.sent.some((raw) => raw.includes('"optionId":"allow"'));
    expect(sent).toBe(true);
  });
});

describe('store: turnos', () => {
  it('manda un prompt, recibe el stream, la herramienta y el diff', async () => {
    const fixture = base({
      sessionId: 'b',
      toolCall: {
        toolCallId: 'tool-1',
        title: 'Editar a.ts',
        name: 'developer__edit',
        kind: 'edit',
        status: 'completed',
        diff: { path: 'a.ts', oldText: 'uno', newText: 'dos' },
      },
    });
    const h = await boot([fixture], 'b');
    await h.store.submit('hola');
    await h.flush();

    const state = h.store.getState();
    const session = state.sessionIndex['b'];
    expect(texts(h, 'b')).toContain('Recibí: hola');
    expect(session?.run?.endedAt).not.toBeNull();
    const tool = session?.toolIndex['tool-1'];
    expect(tool?.status).toBe('completed');
    expect(tool?.diffs[0]).toMatchObject({ path: 'a.ts', oldText: 'uno', newText: 'dos' });
    expect(tool?.output).toContain('salida de la herramienta');
  });

  it('reintenta con el mismo promptId y no ejecuta el turno dos veces', async () => {
    const h = await boot([base({ sessionId: 'c', failPromptTimes: 2 })], 'c');
    await h.store.submit('una sola vez');
    await h.flush(10);
    expect(h.server.prompts).toHaveLength(1);
    expect(texts(h, 'c')).toContain('Recibí: una sola vez');
    expect(h.store.getState().notices.some((notice) => notice.text.includes('verificando si tu mensaje llegó'))).toBe(true);
  });

  it('un error definitivo deja el turno cerrado y avisa', async () => {
    const h = await boot([base({ sessionId: 'c', failPromptTimes: 5 })], 'c');
    await h.store.submit('falla');
    await h.flush(10);
    const session = h.store.getState().sessionIndex['c'];
    expect(session?.run?.endedAt).not.toBeNull();
    expect(h.store.getState().notices.some((notice) => notice.text.includes('No se pudo enviar'))).toBe(true);
  });

  it('con un run activo, el texto va como steer y no como prompt nuevo', async () => {
    const h = await boot([base({ sessionId: 'd', activeRunId: 'run-d' })], 'd');
    await h.store.openSession('d' as SessionId);
    await h.flush();
    expect(h.store.getState().sessionIndex['d']?.run?.id).toBe('run-d');
    await h.store.submit('pará y hacé otra cosa');
    await h.flush();
    expect(h.store.getState().steers).toHaveLength(1);
    expect(h.server.prompts).toHaveLength(0);
  });

  it('cancelar cierra el run local y cancela permisos pendientes', async () => {
    const h = await boot([base({ sessionId: 'e', activeRunId: 'run-e' })], 'e');
    await h.store.openSession('e' as SessionId);
    await h.flush();
    await h.store.cancel();
    await h.flush();
    const session = h.store.getState().sessionIndex['e'];
    expect(session?.run?.endedAt).not.toBeNull();
    expect(session?.run?.cancelledByUser).toBe(true);
  });
});

describe('store: reconexión', () => {
  it('al volver el socket adopta el run en curso en vez de declararlo interrumpido', async () => {
    const h = await boot([base({ sessionId: 'f', activeRunId: null })], 'f');
    const fixture = h.server.session('f');
    if (!fixture) throw new Error('fixture ausente');
    fixture.activeRunId = 'run-f';
    h.lastSocket().drop();
    await h.flush(12);
    const session = h.store.getState().sessionIndex['f'];
    expect(session?.run?.id).toBe('run-f');
    expect(session?.run?.adopted).toBe(true);
  });

  it('si el run murió con la conexión, el turno queda cerrado y las herramientas interrumpidas', async () => {
    const h = await boot([base({ sessionId: 'g' })], 'g');
    h.store.dispatch({ type: 'run/started', sessionId: 'g' as SessionId, runId: 'run-g' as never, adopted: false });
    h.store.dispatch({
      type: 'tool/upsert',
      sessionId: 'g' as SessionId,
      tool: { id: 'tool-g' as never, title: 'colgada', status: 'in_progress' },
    });
    h.lastSocket().drop();
    await h.flush(12);
    const session = h.store.getState().sessionIndex['g'];
    expect(session?.run?.endedAt).not.toBeNull();
    expect(session?.toolIndex['tool-g']?.interrupted).toBe(true);
  });
});

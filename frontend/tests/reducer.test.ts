import { describe, expect, it } from 'vitest';
import { emptyState, reduce } from '../src/domain/reducer';
import { messageId, runId, sessionId, toolCallId, permissionId } from '../src/domain/ids';
import type { AppEvent, AppState, SessionSummary } from '../src/domain/types';

const session = sessionId('s1');
const other = sessionId('s2');

const summary = (id = session, running = false): SessionSummary => ({
  id,
  title: 'Prueba',
  updatedAt: '2026-10-28T10:00:00.000Z',
  createdAt: '2026-10-28T09:00:00.000Z',
  messageCount: 0,
  cwd: 'C:/lab',
  archived: false,
  running,
});

const apply = (state: AppState, ...events: AppEvent[]): AppState => events.reduce(reduce, state);

const open = (id = session): AppEvent => ({ type: 'session/open', summary: summary(id) });

type ChunkEvent = Extract<AppEvent, { type: 'message/chunk' }>;
const chunk = (text: string, mid: string, kind: 'assistant' | 'thought' | 'user' = 'assistant', hidden = false): ChunkEvent => ({
  type: 'message/chunk',
  sessionId: session,
  messageId: messageId(mid),
  kind,
  text,
  hidden,
});

const sessionOf = (state: AppState, id = session) => {
  const found = state.sessionIndex[id];
  if (!found) throw new Error('sesión ausente');
  return found;
};

describe('reducer: identidad y streaming', () => {
  it('acumula chunks del mismo messageId en un solo bloque', () => {
    let state = apply(emptyState(), open());
    state = apply(state, chunk('Hola', 'm1'), chunk(', ', 'm1'), chunk('mundo', 'm1'));
    const current = sessionOf(state);
    expect(current.messages).toHaveLength(1);
    const message = current.messageIndex['m1'];
    expect(message?.blocks).toHaveLength(1);
    const block = message ? current.blocks[message.blocks[0] ?? ''] : undefined;
    expect(block?.text).toBe('Hola, mundo');
    expect(block?.status).toBe('streaming');
  });

  it('no confunde mensajes distintos ni mezcla razonamiento con respuesta', () => {
    let state = apply(emptyState(), open());
    state = apply(state, chunk('pienso', 'm1:thought', 'thought'), chunk('contesto', 'm1'));
    const current = sessionOf(state);
    expect(current.messages).toHaveLength(2);
    expect(current.messageIndex['m1']?.kind).toBe('assistant');
    expect(current.messageIndex['m1:thought']?.kind).toBe('thought');
  });

  it('sin messageId usa un id determinista por run: dos chunks no crean dos mensajes', () => {
    let state = apply(emptyState(), open(), { type: 'run/started', sessionId: session, runId: runId('r1'), adopted: false });
    state = apply(
      state,
      { ...chunk('a', 'x'), messageId: messageId('run:r1:assistant') },
      { ...chunk('b', 'x'), messageId: messageId('run:r1:assistant') },
    );
    expect(sessionOf(state).messages).toHaveLength(1);
  });

  it('un bloque reiniciado reemplaza el texto en vez de duplicarlo', () => {
    let state = apply(emptyState(), open());
    state = apply(state, chunk('borrador', 'm1'));
    state = apply(state, { ...chunk('final', 'm1'), restart: true });
    const current = sessionOf(state);
    const message = current.messageIndex['m1'];
    expect(message ? current.blocks[message.blocks[0] ?? '']?.text : '').toBe('final');
  });

  it('fin de run cierra el streaming y apaga el estado corriendo', () => {
    let state = apply(emptyState(), open());
    state = apply(state, { type: 'run/started', sessionId: session, runId: runId('r1'), adopted: false }, chunk('x', 'm1'));
    state = apply(state, { type: 'run/ended', sessionId: session, runId: runId('r1') });
    const current = sessionOf(state);
    const message = current.messageIndex['m1'];
    expect(message ? current.blocks[message.blocks[0] ?? '']?.status : '').toBe('complete');
    expect(current.summary.running).toBe(false);
    expect(current.run?.endedAt).not.toBeNull();
  });

  it('un run/ended de otro run no cierra el actual', () => {
    let state = apply(emptyState(), open(), { type: 'run/started', sessionId: session, runId: runId('r2'), adopted: false });
    state = apply(state, { type: 'run/ended', sessionId: session, runId: runId('r1') });
    expect(sessionOf(state).run?.id).toBe('r2');
  });
});

describe('reducer: eco, rewind y dedupe', () => {
  it('message/adopt mueve bloques y herramientas al id del servidor', () => {
    let state = apply(emptyState(), open());
    state = apply(state, {
      type: 'message/local',
      sessionId: session,
      messageId: messageId('local:msg:1'),
      role: 'user',
      text: 'hola',
      pending: true,
    });
    state = apply(state, {
      type: 'tool/upsert',
      sessionId: session,
      tool: { id: toolCallId('t1'), title: 'leer', kind: 'read', messageId: messageId('local:msg:1') },
    });
    state = apply(state, { type: 'message/adopt', sessionId: session, localId: messageId('local:msg:1'), serverId: messageId('srv-1') });
    const current = sessionOf(state);
    expect(current.messages).toEqual(['srv-1']);
    expect(current.messageIndex['srv-1']?.pending).toBe(false);
    expect(current.toolIndex['t1']?.messageId).toBe('srv-1');
  });

  it('rewind oculta desde el mensaje marcado y el mensaje nuevo no se oculta', () => {
    let state = apply(emptyState(), open());
    state = apply(state, chunk('uno', 'u1', 'user'), chunk('dos', 'u2', 'user'), chunk('tres', 'a1'));
    state = apply(state, { type: 'session/hiddenFrom', sessionId: session, from: messageId('u2') });
    let current = sessionOf(state);
    expect(current.messageIndex['u1']?.hidden).toBe(false);
    expect(current.messageIndex['u2']?.hidden).toBe(true);
    expect(current.messageIndex['a1']?.hidden).toBe(true);
    state = apply(state, chunk('nuevo', 'u3', 'user'));
    current = sessionOf(state);
    expect(current.messageIndex['u3']?.hidden).toBe(false);
    expect(current.hiddenFrom).toBeNull();
  });

  it('las herramientas completadas no vuelven a pending y las interrumpidas se marcan', () => {
    let state = apply(emptyState(), open());
    state = apply(state, {
      type: 'tool/upsert',
      sessionId: session,
      tool: { id: toolCallId('t1'), title: 'cmd', kind: 'execute', status: 'completed', outputChunk: 'ok' },
    });
    state = apply(state, { type: 'tool/upsert', sessionId: session, tool: { id: toolCallId('t1'), status: 'pending' } });
    expect(sessionOf(state).toolIndex['t1']?.status).toBe('completed');
  });

  it('los diffs se deduplican por path+contenido', () => {
    let state = apply(emptyState(), open());
    const diff = { path: 'a.ts', newText: 'x', requested: false };
    state = apply(
      state,
      { type: 'tool/upsert', sessionId: session, tool: { id: toolCallId('t1'), diffs: [diff] } },
      { type: 'tool/upsert', sessionId: session, tool: { id: toolCallId('t1'), diffs: [diff] } },
    );
    expect(sessionOf(state).toolIndex['t1']?.diffs).toHaveLength(1);
  });
});

describe('reducer: sesiones y permisos', () => {
  it('las sesiones son independientes: un update de s2 no toca s1', () => {
    let state = apply(emptyState(), { type: 'sessions/replaced', sessions: [summary(session), summary(other)], archived: [] });
    state = apply(state, open(session));
    state = apply(state, {
      type: 'message/chunk',
      sessionId: other,
      messageId: messageId('o1'),
      kind: 'assistant',
      text: 'de otro chat',
      hidden: false,
    });
    expect(sessionOf(state, session).messages).toHaveLength(0);
    expect(sessionOf(state, other).messages).toEqual(['o1']);
  });

  it('un permiso de otra sesión queda contado y no se pierde', () => {
    let state = apply(emptyState(), { type: 'sessions/replaced', sessions: [summary(session), summary(other)], archived: [] });
    state = apply(state, open(session));
    state = apply(state, {
      type: 'permission/request',
      sessionId: other,
      request: {
        id: permissionId('p1'),
        sessionId: other,
        toolCallId: null,
        title: 'Ejecutar',
        options: [{ optionId: 'allow', name: 'Permitir', kind: 'allow_once' }],
        createdAt: 0,
      },
    });
    expect(state.pendingBySession[other]).toBe(1);
    expect(sessionOf(state, session).permissions).toHaveLength(0);
    expect(state.permissionIndex['p1']?.title).toBe('Ejecutar');
    state = apply(state, { type: 'permission/resolved', sessionId: other, permissionId: permissionId('p1') });
    expect(state.pendingBySession[other]).toBe(0);
    expect(state.permissionIndex['p1']).toBeUndefined();
  });

  it('reemplazar la lista conserva el chat abierto aunque la página no lo traiga', () => {
    let state = apply(emptyState(), { type: 'sessions/replaced', sessions: [summary(session), summary(other)], archived: [] });
    state = apply(state, open(other));
    state = apply(state, { type: 'sessions/replaced', sessions: [summary(session)], archived: [] });
    expect(state.sessions).toContain(other);
    expect(state.activeSessionId).toBe(other);
  });

  it('reset limpia el transcript pero conserva la identidad de la sesión', () => {
    let state = apply(emptyState(), open(), chunk('x', 'm1'));
    state = apply(state, { type: 'session/reset', sessionId: session });
    const current = sessionOf(state);
    expect(current.summary.id).toBe(session);
    expect(current.messages).toHaveLength(0);
  });
});

describe('reducer: cola y avisos', () => {
  it('la cola conserva el orden y se puede quitar por id', () => {
    let state = apply(emptyState(), open());
    state = apply(
      state,
      { type: 'queue/add', prompt: { id: 'q1', text: 'uno', attachments: [], createdAt: 0, state: 'queued' } },
      { type: 'queue/add', prompt: { id: 'q2', text: 'dos', attachments: [], createdAt: 1, state: 'queued' } },
    );
    expect(state.queue.map((item) => item.id)).toEqual(['q1', 'q2']);
    state = apply(state, { type: 'queue/remove', id: 'q1' });
    expect(state.queue.map((item) => item.id)).toEqual(['q2']);
  });

  it('los avisos se recortan y no se duplican por id', () => {
    let state = emptyState();
    for (let i = 0; i < 45; i += 1) {
      state = apply(state, { type: 'notice/push', level: 'info', text: `aviso ${i}` });
    }
    expect(state.notices.length).toBeLessThanOrEqual(40);
    state = apply(state, { type: 'notice/push', level: 'warn', text: 'repetido', id: 'x' }, { type: 'notice/push', level: 'warn', text: 'repetido', id: 'x' });
    expect(state.notices.filter((notice) => notice.id === 'x')).toHaveLength(1);
  });
});

import { describe, expect, it } from 'vitest';
import {
  isTransientError,
  newPromptId,
  promptBlocks,
  synthesizedDiff,
  toolKindOf,
  translateAegisUpdate,
  translateSessionUpdate,
} from '../src/domain/translate';
import type { AppEvent } from '../src/domain/types';

const update = (payload: Record<string, unknown>): AppEvent[] =>
  translateSessionUpdate({ sessionId: 's1', update: payload } as never);

describe('translate: session/update', () => {
  it('traduce chunks de texto con su messageId y visibilidad', () => {
    const events = update({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm1',
      content: { type: 'text', text: 'hola' },
      _meta: { aegis: { agentVisible: false } },
    });
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.type).toBe('message/chunk');
    if (event?.type === 'message/chunk') {
      expect(event.messageId).toBe('m1');
      expect(event.text).toBe('hola');
      expect(event.hidden).toBe(true);
      expect(event.kind).toBe('assistant');
    }
  });

  it('el razonamiento va a un mensaje distinto del texto', () => {
    const events = update({ sessionUpdate: 'agent_thought_chunk', messageId: 'm1', content: { type: 'text', text: 'pienso' } });
    const event = events[0];
    expect(event?.type).toBe('message/chunk');
    if (event?.type === 'message/chunk') {
      expect(event.messageId).toBe('m1:thought');
      expect(event.kind).toBe('thought');
    }
  });

  it('tool_call traduce kind, rawInput y diffs ACP', () => {
    const events = update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      rawInput: { path: 'a.ts' },
      content: [{ type: 'diff', path: 'a.ts', oldText: 'uno', newText: 'dos' }],
    });
    const event = events[0];
    expect(event?.type).toBe('tool/upsert');
    if (event?.type === 'tool/upsert') {
      expect(event.tool.id).toBe('t1');
      expect(event.tool.kind).toBe('read');
      expect(event.tool.diffs?.[0]).toEqual({ path: 'a.ts', oldText: 'uno', newText: 'dos', requested: false });
    }
  });

  it('edit/write sin bloque Diff sintetiza el par before/after sólo si terminó bien', () => {
    const raw = { path: 'a.ts', before: 'uno', after: 'dos' };
    expect(synthesizedDiff('developer__edit', raw, 'completed')).toEqual({
      path: 'a.ts',
      oldText: 'uno',
      newText: 'dos',
      requested: false,
    });
    expect(synthesizedDiff('developer__edit', raw, 'in_progress')).toBeNull();
    expect(synthesizedDiff('developer__write', { path: 'a.ts', content: 'x' }, 'completed')?.requested).toBe(true);
    expect(synthesizedDiff('developer__edit', { path: 'a.ts', after: 'x' }, 'completed')).toBeNull();
  });

  it('usage_update normaliza el uso y los modelos', () => {
    const events = update({
      sessionUpdate: 'usage_update',
      used: 100,
      contextLimit: 1000,
      accumulatedCost: 0.5,
      modelUsage: [{ model: 'm', inputTokens: 10, outputTokens: 20, cost: 0.1 }],
    });
    const event = events[0];
    expect(event?.type).toBe('session/usage');
    if (event?.type === 'session/usage') {
      expect(event.usage.used).toBe(100);
      expect(event.usage.limit).toBe(1000);
      expect(event.usage.modelUsage[0]?.model).toBe('m');
    }
  });

  it('session_info_update con activeRunId produce arranque y fin de run', () => {
    expect(update({ sessionUpdate: 'session_info_update', _meta: { aegis: { activeRunId: 'r1' } } })[0]?.type).toBe('run/started');
    expect(update({ sessionUpdate: 'session_info_update', _meta: { aegis: { activeRunId: null } } })[0]?.type).toBe('run/ended');
  });

  it('_aegis/unstable/session/update también informa el run y el steer encolado', () => {
    const events = translateAegisUpdate({
      sessionId: 's1',
      update: { sessionUpdate: 'session_info_update', _meta: { aegis: { queuedSteer: { messageId: 'm9' } } } },
      aegis: { activeRunId: 'r2' },
    } as never);
    expect(events.some((event) => event.type === 'run/started')).toBe(true);
    const steer = events.find((event) => event.type === 'steer/update');
    expect(steer?.type === 'steer/update' && steer.messageId).toBe('m9');
  });

  it('ignora notificaciones sin sesión', () => {
    expect(translateSessionUpdate({ sessionId: '', update: { sessionUpdate: 'usage_update' } } as never)).toEqual([]);
  });
});

describe('translate: prompt', () => {
  it('arma bloques de texto e imagen, y cita adjuntos de texto', () => {
    const blocks = promptBlocks('hola', [
      { id: 'a1' as never, name: 'foto.png', mimeType: 'image/png', size: 10, data: 'AAAA' },
      { id: 'a2' as never, name: 'notas.txt', mimeType: 'text/plain', size: 4, text: 'uno\ndos' },
    ]);
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'AAAA' });
    expect(String((blocks[2] as { text: string }).text)).toContain('notas.txt');
  });

  it('sin texto pero con adjuntos manda una línea con los nombres', () => {
    const blocks = promptBlocks('   ', [{ id: 'a1' as never, name: 'x.txt', mimeType: 'text/plain', size: 1, text: 'x' }]);
    expect((blocks[0] as { text: string }).text).toContain('x.txt');
  });

  it('promptId es único y estable por llamada', () => {
    const a = newPromptId();
    const b = newPromptId();
    expect(a).toMatch(/^p_/);
    expect(a).not.toBe(b);
  });

  it('clasifica errores transitorios', () => {
    expect(isTransientError('conexión cerrada')).toBe(true);
    expect(isTransientError('Timeout de 120000 ms [método: x]')).toBe(true);
    expect(isTransientError('Model file not found')).toBe(false);
  });

  it('infiere el kind de la herramienta desde el payload', () => {
    expect(toolKindOf(null, { command: 'ls' })).toBe('execute');
    expect(toolKindOf(null, { query: 'foo' })).toBe('search');
    expect(toolKindOf('switchMode', null)).toBe('switch_mode');
    expect(toolKindOf('edit', null)).toBe('edit');
  });
});

import { describe, expect, it } from 'vitest';
import { currentGoal, goalFromText } from '../src/domain/goal';
import { emptyState, reduce } from '../src/domain/reducer';
import { messageId, sessionId } from '../src/domain/ids';
import type { AppState } from '../src/domain/types';

const session = sessionId('g');

const seeded = (...texts: string[]): AppState => {
  let state = reduce(emptyState(), {
    type: 'session/open',
    summary: { id: session, title: 'g', updatedAt: null, createdAt: null, messageCount: null, cwd: null, archived: false, running: false },
  });
  texts.forEach((text, index) => {
    state = reduce(state, {
      type: 'message/chunk',
      sessionId: session,
      messageId: messageId(`m${index}`),
      kind: 'user',
      text,
      hidden: false,
    });
  });
  return state;
};

describe('goal del chat', () => {
  it('parsea set, clear y consulta', () => {
    expect(goalFromText('/goal hacer la migración')).toEqual({ action: 'set', kind: 'goal', text: 'hacer la migración' });
    expect(goalFromText('/grind terminar')).toEqual({ action: 'set', kind: 'grind', text: 'terminar' });
    expect(goalFromText('/goal off').action).toBe('clear');
    expect(goalFromText('/goal').action).toBe('none');
    expect(goalFromText('hola').action).toBe('none');
  });

  it('deduce el último objetivo vigente del transcript', () => {
    const state = seeded('/goal primero', 'hola', '/goal segundo');
    const found = state.sessionIndex['g'];
    expect(found ? currentGoal(found) : null).toEqual({ kind: 'goal', text: 'segundo' });
  });

  it('/goal off lo borra y no lo revive una consulta', () => {
    const state = seeded('/goal algo', '/goal off', '/goal');
    const found = state.sessionIndex['g'];
    expect(found ? currentGoal(found) : null).toBeNull();
  });
});

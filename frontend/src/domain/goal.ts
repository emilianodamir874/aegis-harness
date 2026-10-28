import type { SessionState } from './types';

export interface GoalFromText {
  readonly action: 'set' | 'clear' | 'none';
  readonly kind: 'goal' | 'grind';
  readonly text?: string;
}

/**
 * `/goal <texto>` fija el objetivo del chat, `/goal off|clear|none` lo borra y `/goal` pelado no
 * cambia nada. Misma semántica que `goalFromText` del cliente actual (`src/app.ts`).
 */
export const goalFromText = (text: string): GoalFromText => {
  const trimmed = String(text ?? '').trim();
  const match = /^\/(goal|grind)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) return { action: 'none', kind: 'goal' };
  const kind = (match[1] ?? 'goal').toLowerCase() === 'grind' ? 'grind' : 'goal';
  const params = (match[2] ?? '').trim();
  if (!params) return { action: 'none', kind };
  if (/^(off|clear|none)$/i.test(params)) return { action: 'clear', kind };
  return { action: 'set', kind, text: params };
};

/** Último objetivo vigente del chat, deducido de la conversación (el serve no lo expone por ACP). */
export const currentGoal = (session: SessionState): { kind: 'goal' | 'grind'; text: string } | null => {
  let goal: { kind: 'goal' | 'grind'; text: string } | null = null;
  for (const id of session.messages) {
    const message = session.messageIndex[id];
    if (!message || message.kind !== 'user' || message.pending) continue;
    const text = message.blocks.map((blockId) => session.blocks[blockId]?.text ?? '').join('');
    const parsed = goalFromText(text);
    if (parsed.action === 'set' && parsed.text) goal = { kind: parsed.kind, text: parsed.text };
    else if (parsed.action === 'clear') goal = null;
  }
  return goal;
};

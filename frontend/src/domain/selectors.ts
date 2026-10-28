import type { AppState, SessionState } from './types';

/** Un run terminado se conserva (para saber cuándo acabó), pero ya no está en curso. */
export const isRunning = (session: SessionState | null | undefined): boolean =>
  Boolean(session?.run && session.run.endedAt === null);

export const sessionList = (state: AppState): SessionState[] =>
  state.sessions.map((id) => state.sessionIndex[id]).filter((session): session is SessionState => Boolean(session));

export const archivedList = (state: AppState): SessionState[] =>
  state.archived.map((id) => state.sessionIndex[id]).filter((session): session is SessionState => Boolean(session));

export const activeSession = (state: AppState): SessionState | null =>
  state.activeSessionId ? state.sessionIndex[state.activeSessionId] ?? null : null;

/** Mensajes visibles, en orden. */
export const transcriptOf = (session: SessionState) =>
  session.messages.map((id) => session.messageIndex[id]).filter((message): message is NonNullable<typeof message> => Boolean(message));

export const lastAssistantText = (session: SessionState): string => {
  const message = transcriptOf(session)
    .filter((item) => item.kind === 'assistant')
    .at(-1);
  if (!message) return '';
  return message.blocks.map((id) => session.blocks[id]?.text ?? '').join('\n');
};

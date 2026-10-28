import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { AegisStore } from '../domain/store';
import type { AppState } from '../domain/types';
import type { AppConfig } from '../config';

interface AegisContextValue {
  readonly store: AegisStore;
  readonly config: AppConfig;
}

const AegisContext = createContext<AegisContextValue | null>(null);

export function AegisProvider({ store, config, children }: { store: AegisStore; config: AppConfig; children: ReactNode }) {
  const value = useMemo(() => ({ store, config }), [store, config]);
  return <AegisContext.Provider value={value}>{children}</AegisContext.Provider>;
}

function useAegisContext(): AegisContextValue {
  const value = useContext(AegisContext);
  if (!value) throw new Error('AegisProvider falta en el árbol');
  return value;
}

export const useStore = (): AegisStore => useAegisContext().store;
export const useConfig = (): AppConfig => useAegisContext().config;

/** Estado completo. React sólo re-renderiza cuando cambia la referencia de `AppState`. */
export function useAppState(): AppState {
  const { store } = useAegisContext();
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

export function useActiveSession() {
  const state = useAppState();
  return state.activeSessionId ? state.sessionIndex[state.activeSessionId] ?? null : null;
}

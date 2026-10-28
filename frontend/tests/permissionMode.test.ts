import { describe, expect, it } from 'vitest';
import {
  PERMISSION_MODE_STORAGE_KEY,
  entriesForMode,
  isPermissionMode,
  nextMode,
  readStoredMode,
  writeStoredMode,
} from '../src/domain/sessionMode';

const memoryStorage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    dump: () => Object.fromEntries(data),
  };
};

describe('modo de permisos', () => {
  it('plan deja las tools de escritura en never_allow y las de lectura siempre permitidas', () => {
    const entries = entriesForMode('plan');
    expect(entries.filter((entry) => entry.permission === 'never_allow').map((entry) => entry.toolName)).toEqual([
      'shell',
      'edit',
      'write',
    ]);
    expect(entries.find((entry) => entry.toolName === 'read_file')?.permission).toBe('always_allow');
  });

  it('revisar pide permiso antes de escribir', () => {
    const entries = entriesForMode('revisar');
    expect(entries.filter((entry) => entry.permission === 'ask_before').map((entry) => entry.toolName)).toEqual([
      'shell',
      'edit',
      'write',
    ]);
  });

  it('ejecutar borra los overrides con una lista vacía', () => {
    expect(entriesForMode('ejecutar')).toEqual([]);
  });

  it('persiste y valida el modo guardado', () => {
    const storage = memoryStorage();
    expect(readStoredMode(storage)).toBe('ejecutar');
    writeStoredMode('plan', storage);
    expect(storage.dump()[PERMISSION_MODE_STORAGE_KEY]).toBe('plan');
    expect(readStoredMode(storage)).toBe('plan');
    expect(readStoredMode(null)).toBe('ejecutar');
    expect(isPermissionMode('nada')).toBe(false);
  });

  it('cicla plan → ejecutar → revisar → plan', () => {
    expect(nextMode('plan')).toBe('ejecutar');
    expect(nextMode('ejecutar')).toBe('revisar');
    expect(nextMode('revisar')).toBe('plan');
  });
});

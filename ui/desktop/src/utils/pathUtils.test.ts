import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAbsoluteAegisPath, resolveAegisPathRoot, sanitizeAegisPathRoot } from './pathUtils';

describe('resolveAegisPathRoot', () => {
  it('rejects empty and relative values', () => {
    expect(resolveAegisPathRoot(undefined)).toBeUndefined();
    expect(resolveAegisPathRoot('   ')).toBeUndefined();
    expect(resolveAegisPathRoot('relative/root')).toBeUndefined();
  });

  it('retains absolute paths without requiring them to exist', () => {
    const absolute = path.resolve('nonexistent-aegis-root');
    expect(resolveAegisPathRoot(`  ${absolute}  `)).toBe(absolute);
  });

  it('expands a home-relative root before validation', () => {
    expect(resolveAegisPathRoot('~')).toBe(os.homedir());
  });

  it('removes a rejected value from the child-process environment', () => {
    const env = { AEGIS_PATH_ROOT: 'relative/root' };
    expect(sanitizeAegisPathRoot(env)).toBeUndefined();
    expect(env).not.toHaveProperty('AEGIS_PATH_ROOT');
  });

  it('matches Rust absolute-path handling on Windows', () => {
    expect(isAbsoluteAegisPath('C:\\aegis\\root', 'win32')).toBe(true);
    expect(isAbsoluteAegisPath('\\\\server\\share\\aegis', 'win32')).toBe(true);
    expect(isAbsoluteAegisPath('C:aegis\\root', 'win32')).toBe(false);
    expect(isAbsoluteAegisPath('\\aegis\\root', 'win32')).toBe(false);
    expect(isAbsoluteAegisPath('/aegis/root', 'win32')).toBe(false);
  });
});

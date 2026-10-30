/* Git snapshot for a cwd ALREADY authorized by its caller. Not an HTTP endpoint.
 * Never use this CLI directly with an untrusted cwd: the server must enforce its
 * workspace allowlist before spawning it. Git reports filesystem changes only;
 * it cannot identify which agent or person made them.
 *
 * node changes-index.mjs --cwd <authorized-directory> -> {kind, cwd, entries, truncated}
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

interface Entry {
  path: string;
  staged: string;
  worktree: string;
  diff: string;
  stagedAdded?: number | null;
  stagedRemoved?: number | null;
  worktreeAdded?: number | null;
  worktreeRemoved?: number | null;
  truncated?: boolean;
}
const MAX_FILES = 60;
const MAX_DIFF = 8_192;
const MAX_TOTAL_DIFF = 96_000;
const SECRET_PATH = /(^|[/\\])(?:\.env(?:[.\w-]*)?|\.git|\.ssh|\.aws|\.npmrc|\.pypirc|(?:auth(?:entication)?|credentials?|secrets?|tokens?|permission|config)(?:[._-][^/\\]*)?|id_(?:rsa|ed25519)|[^/\\]+\.(?:pem|key|p12|pfx|keystore|db|sqlite[0-9]*))(?=$|[/\\])/i;
const SECRET_LINE = /(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|authorization\s*:|-----BEGIN (?:[A-Z ]* )?PRIVATE KEY-----|\b(?:sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9_]{12,})\b)/i;
const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_EXTERNAL_DIFF: '' };

function git(cwd: string, args: string[], maxBuffer = 128 * 1024): Buffer {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], {
    encoding: 'buffer', env, timeout: 5_000, maxBuffer, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function safePath(root: string, path: string): boolean {
  if (!path || isAbsolute(path) || path.includes('\\') || path.includes(':') || SECRET_PATH.test(path)
    || /[\x00-\x1f\x7f]/.test(path)) return false;
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return false;
  // Git pathspecs are literal, but never resolve a diff through a linked directory/file.
  // In particular, Windows junctions can escape the repository without a '..' component.
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
  }
  return true;
}
type Patch = { text: string; truncated: boolean; added: number | null; removed: number | null };
function diff(cwd: string, path: string, staged: boolean): Patch {
  // Git numstat counts the entire patch (not the clipped or redacted display text),
  // including lines in hunks beyond MAX_DIFF. Binary/unavailable counts stay unknown.
  const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames',
    ...(staged ? ['--cached'] : []), '--', `:(literal)${path}`];
  let added: number | null = null, removed: number | null = null;
  try {
    const records = git(cwd, [...args.slice(0, -2), '--numstat', '-z', ...args.slice(-2)], 256 * 1024)
      .toString('utf8').split('\0').filter(Boolean);
    if (records.length === 1) {
      const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(records[0]);
      if (match && match[3] === path) {
        const a = Number(match[1]), r = Number(match[2]);
        if (match[1] !== '-' && match[2] !== '-' && Number.isSafeInteger(a) && Number.isSafeInteger(r)) {
          added = a; removed = r;
        }
      }
    }
  } catch { /* No invented counts when numstat fails. */ }
  try {
    const output = git(cwd, [...args.slice(0, -2), '--unified=2', ...args.slice(-2)], 256 * 1024);
    const raw = output.toString('utf8');
    // Fail closed on the whole patch, not just visible lines: clipping first might hide a credential.
    if (raw.split(/\r?\n/).some(line => SECRET_LINE.test(line)))
      return { text: '[Diff oculto: posible credencial]', truncated: false, added, removed };
    return { text: raw.slice(0, MAX_DIFF), truncated: raw.length > MAX_DIFF, added, removed };
  } catch {
    return { text: '[Diff no disponible]', truncated: true, added, removed };
  }
}
function snapshot(cwd: string): object {
  let root: string;
  try {
    root = git(cwd, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
  } catch {
    return { kind: 'not-git', cwd, entries: [], truncated: false };
  }
  // -z is mandatory: filenames may contain spaces, tabs and newlines.
  // --no-renames yields D + A rather than the two-path rename record.
  const prefix = relative(root, cwd).replaceAll('\\', '/');
  const status = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', '.'], 1024 * 1024);
  const records = status.toString('utf8').split('\0');
  const entries: Entry[] = [];
  let totalDiff = 0;
  let truncated = false;
  for (const record of records) {
    if (!record) continue;
    if (entries.length >= MAX_FILES) { truncated = true; break; }
    if (record.length < 4 || record[2] !== ' ') { truncated = true; continue; }
    const path = record.slice(3);
    if (prefix && !path.startsWith(prefix + '/')) continue;
    if (!safePath(root, path)) continue;
    const staged = record[0], worktree = record[1];
    const entry: Entry = { path: prefix ? path.slice(prefix.length + 1) : path, staged, worktree, diff: '' };
    // Untracked files have no Git diff; never read their contents. Counts are
    // independent of the display budget (and never inferred from a clipped patch).
    if (worktree !== '?') {
      const patches = [
        ...(staged !== ' ' ? [{ patch: diff(root, path, true), side: 'staged' as const }] : []),
        ...(worktree !== ' ' ? [{ patch: diff(root, path, false), side: 'worktree' as const }] : []),
      ];
      for (const { patch, side } of patches) {
        if (side === 'staged') { entry.stagedAdded = patch.added; entry.stagedRemoved = patch.removed; }
        else { entry.worktreeAdded = patch.added; entry.worktreeRemoved = patch.removed; }
        const remaining = Math.max(0, MAX_TOTAL_DIFF - totalDiff);
        entry.diff += patch.text.slice(0, remaining);
        totalDiff += Math.min(remaining, patch.text.length);
        if (patch.truncated || patch.text.length > remaining || !remaining) { entry.truncated = true; truncated = true; }
      }
    }
    entries.push(entry);
  }
  return { kind: 'git', cwd, root, entries, truncated };
}

// Un workspace puede contener subcarpetas de un monorepo y tambien repos independientes.
// El escaneo devuelve proyectos con conteos, nunca diffs; el diff se pide solo al abrir uno.
type RepoResumen = { root: string; rel: string; files: number; truncated: boolean };
const IGNORAR = /^(?:\.|state$|node_modules$|dist-ts$|dist$|build$|target$|vendor$|\.git$)/i;

function contarCambios(repo: string): number {
  try {
    const status = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--no-renames', '--', '.'], 512 * 1024);
    return status.toString('utf8').split('\0').filter((r) => r.length >= 4 && r[2] === ' ').length;
  } catch { return 0; }
}

function isGitProject(path: string, name: string): boolean {
  try {
    const top = resolve(git(path, ['rev-parse', '--show-toplevel']).toString('utf8').trim()).toLowerCase();
    const real = resolve(realpathSync(path)).toLowerCase();
    if (top === real) return true;
    if (['src', 'web', 'core', 'docs'].includes(name.toLowerCase())
      && top === resolve(real, '..').toLowerCase()) return true;
    return name.toLowerCase() === 'core/ops' && top === resolve(real, '..', '..').toLowerCase();
  } catch { return false; }
}

function escanearRepos(cwd: string): object {
  let nombres: string[];
  try {
    nombres = readdirSync(cwd, { withFileTypes: true })
      .filter((d) => (d.isDirectory() || (d.isSymbolicLink() && ['src', 'web', 'core', 'docs'].includes(d.name.toLowerCase())))
        && !IGNORAR.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return { kind: 'not-git', cwd, repos: [], entries: [], truncated: false };
  }
  const repos: RepoResumen[] = [];
  for (const nombre of nombres.slice(0, 40)) {
    const hijo = join(cwd, nombre);
    // El web historico puede conservar logs abiertos por otros procesos: queda un shell
    // de runtime con enlaces a codigo, mientras el Git fisico vive en harness/web.
    if (nombre.toLowerCase() === 'web' && !isGitProject(hijo, nombre)) {
      const physical = join(cwd, 'harness', 'web');
      if (isGitProject(physical, nombre)) {
        repos.push({ root: physical, rel: 'web', files: contarCambios(physical), truncated: false });
      }
      continue;
    }
    // core conserva bin/state en el padre; solo ops es codigo del monorepo.
    if (nombre.toLowerCase() === 'core' && !isGitProject(hijo, nombre)) {
      const ops = join(hijo, 'ops');
      if (isGitProject(ops, 'core/ops')) {
        repos.push({ root: ops, rel: 'core/ops', files: contarCambios(ops), truncated: false });
      }
      continue;
    }
    if (!isGitProject(hijo, nombre)) continue;
    const files = contarCambios(hijo);
    repos.push({ root: hijo, rel: nombre, files, truncated: false });
  }
  // Primero lo que tiene cambios: es lo que el operador quiere ver.
  repos.sort((a, b) => b.files - a.files || a.rel.localeCompare(b.rel, 'es'));
  if (!repos.length) return { kind: 'not-git', cwd, repos: [], entries: [], truncated: false };
  return { kind: 'repos', cwd, repos, entries: [], truncated: false };
}

const args = process.argv.slice(2);
const index = args.indexOf('--cwd');
const cwd = index >= 0 && index + 1 < args.length ? args[index + 1] : '';
const scan = args.includes('--scan');
try {
  if (!cwd || !isAbsolute(cwd)) throw new Error('Se requiere --cwd absoluto y autorizado');
  const primero = snapshot(resolve(cwd));
  // El escaneo explicito conserva el selector de proyectos aun dentro del monorepo.
  process.stdout.write(JSON.stringify(scan ? escanearRepos(resolve(cwd)) : primero));
} catch (error) {
  process.stdout.write(JSON.stringify({ kind: 'error', entries: [], truncated: false,
    error: String(error instanceof Error ? error.message : error).slice(0, 180) }));
}

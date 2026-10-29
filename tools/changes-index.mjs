import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
const MAX_FILES = 60;
const MAX_DIFF = 8192;
const MAX_TOTAL_DIFF = 96e3;
const SECRET_PATH = /(^|[/\\])(?:\.env(?:[.\w-]*)?|\.git|\.ssh|\.aws|\.npmrc|\.pypirc|(?:auth(?:entication)?|credentials?|secrets?|tokens?|permission|config)(?:[._-][^/\\]*)?|id_(?:rsa|ed25519)|[^/\\]+\.(?:pem|key|p12|pfx|keystore|db|sqlite[0-9]*))(?=$|[/\\])/i;
const SECRET_LINE = /(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|authorization\s*:|-----BEGIN (?:[A-Z ]* )?PRIVATE KEY-----|\b(?:sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9_]{12,})\b)/i;
const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_EXTERNAL_DIFF: "" };
function git(cwd2, args2, maxBuffer = 128 * 1024) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd2, ...args2], {
    encoding: "buffer",
    env,
    timeout: 5e3,
    maxBuffer,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
}
function safePath(root, path) {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes(":") || SECRET_PATH.test(path) || /[\x00-\x1f\x7f]/.test(path)) return false;
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return false;
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return false;
    } catch (error) {
      if (error.code !== "ENOENT") return false;
    }
  }
  return true;
}
function diff(cwd2, path, staged) {
  const args2 = [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--no-renames",
    ...staged ? ["--cached"] : [],
    "--",
    `:(literal)${path}`
  ];
  let added = null, removed = null;
  try {
    const records = git(cwd2, [...args2.slice(0, -2), "--numstat", "-z", ...args2.slice(-2)], 256 * 1024).toString("utf8").split("\0").filter(Boolean);
    if (records.length === 1) {
      const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(records[0]);
      if (match && match[3] === path) {
        const a = Number(match[1]), r = Number(match[2]);
        if (match[1] !== "-" && match[2] !== "-" && Number.isSafeInteger(a) && Number.isSafeInteger(r)) {
          added = a;
          removed = r;
        }
      }
    }
  } catch {
  }
  try {
    const output = git(cwd2, [...args2.slice(0, -2), "--unified=2", ...args2.slice(-2)], 256 * 1024);
    const raw = output.toString("utf8");
    if (raw.split(/\r?\n/).some((line) => SECRET_LINE.test(line)))
      return { text: "[Diff oculto: posible credencial]", truncated: false, added, removed };
    return { text: raw.slice(0, MAX_DIFF), truncated: raw.length > MAX_DIFF, added, removed };
  } catch {
    return { text: "[Diff no disponible]", truncated: true, added, removed };
  }
}
function snapshot(cwd2) {
  let root;
  try {
    root = git(cwd2, ["rev-parse", "--show-toplevel"]).toString("utf8").trim();
  } catch {
    return { kind: "not-git", cwd: cwd2, entries: [], truncated: false };
  }
  const status = git(cwd2, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], 1024 * 1024);
  const records = status.toString("utf8").split("\0");
  const entries = [];
  let totalDiff = 0;
  let truncated = false;
  for (const record of records) {
    if (!record) continue;
    if (entries.length >= MAX_FILES) {
      truncated = true;
      break;
    }
    if (record.length < 4 || record[2] !== " ") {
      truncated = true;
      continue;
    }
    const path = record.slice(3);
    if (!safePath(root, path)) continue;
    const staged = record[0], worktree = record[1];
    const entry = { path, staged, worktree, diff: "" };
    if (worktree !== "?") {
      const patches = [
        ...staged !== " " ? [{ patch: diff(cwd2, path, true), side: "staged" }] : [],
        ...worktree !== " " ? [{ patch: diff(cwd2, path, false), side: "worktree" }] : []
      ];
      for (const { patch, side } of patches) {
        if (side === "staged") {
          entry.stagedAdded = patch.added;
          entry.stagedRemoved = patch.removed;
        } else {
          entry.worktreeAdded = patch.added;
          entry.worktreeRemoved = patch.removed;
        }
        const remaining = Math.max(0, MAX_TOTAL_DIFF - totalDiff);
        entry.diff += patch.text.slice(0, remaining);
        totalDiff += Math.min(remaining, patch.text.length);
        if (patch.truncated || patch.text.length > remaining || !remaining) {
          entry.truncated = true;
          truncated = true;
        }
      }
    }
    entries.push(entry);
  }
  return { kind: "git", cwd: cwd2, root, entries, truncated };
}
const IGNORAR = /^(?:\.|state$|node_modules$|dist-ts$|dist$|build$|target$|vendor$|\.git$)/i;
function contarCambios(repo) {
  try {
    const status = git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--no-renames"], 512 * 1024);
    return status.toString("utf8").split("\0").filter((r) => r.length >= 4 && r[2] === " ").length;
  } catch {
    return 0;
  }
}
function escanearRepos(cwd2) {
  let nombres;
  try {
    nombres = readdirSync(cwd2, { withFileTypes: true }).filter((d) => d.isDirectory() && !IGNORAR.test(d.name)).map((d) => d.name).sort();
  } catch {
    return { kind: "not-git", cwd: cwd2, repos: [], entries: [], truncated: false };
  }
  const repos = [];
  for (const nombre of nombres.slice(0, 40)) {
    const hijo = join(cwd2, nombre);
    let tope;
    try {
      tope = git(hijo, ["rev-parse", "--show-toplevel"]).toString("utf8").trim();
    } catch {
      continue;
    }
    if (!tope || resolve(tope).toLowerCase() !== resolve(hijo).toLowerCase()) continue;
    const files = contarCambios(hijo);
    repos.push({ root: hijo, rel: nombre, files, truncated: false });
  }
  repos.sort((a, b) => b.files - a.files || a.rel.localeCompare(b.rel, "es"));
  if (!repos.length) return { kind: "not-git", cwd: cwd2, repos: [], entries: [], truncated: false };
  return { kind: "repos", cwd: cwd2, repos, entries: [], truncated: false };
}
const args = process.argv.slice(2);
const index = args.indexOf("--cwd");
const cwd = index >= 0 && index + 1 < args.length ? args[index + 1] : "";
const scan = args.includes("--scan");
try {
  if (!cwd || !isAbsolute(cwd)) throw new Error("Se requiere --cwd absoluto y autorizado");
  process.stdout.write(JSON.stringify(scan ? escanearRepos(resolve(cwd)) : snapshot(resolve(cwd))));
} catch (error) {
  process.stdout.write(JSON.stringify({
    kind: "error",
    entries: [],
    truncated: false,
    error: String(error instanceof Error ? error.message : error).slice(0, 180)
  }));
}

import { execFileSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
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
function safePath(path) {
  return !!path && !path.includes("\0") && !path.includes("\\") && !SECRET_PATH.test(path) && !/[\x00-\x1f\x7f]/.test(path) && !path.split("/").some((part) => part === ".." || part === "." || !part);
}
function diff(cwd2, path, staged) {
  try {
    const output = git(cwd2, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--no-renames",
      "--unified=2",
      ...staged ? ["--cached"] : [],
      "--",
      `:(literal)${path}`
    ], 256 * 1024);
    const raw = output.toString("utf8");
    if (raw.split(/\r?\n/).some((line) => SECRET_LINE.test(line)))
      return { text: "[Diff oculto: posible credencial]", truncated: false };
    return { text: raw.slice(0, MAX_DIFF), truncated: raw.length > MAX_DIFF };
  } catch {
    return { text: "[Diff no disponible]", truncated: true };
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
    if (!safePath(path)) continue;
    const staged = record[0], worktree = record[1];
    const entry = { path, staged, worktree, diff: "" };
    if (worktree !== "?" && totalDiff < MAX_TOTAL_DIFF) {
      const patches = [
        ...staged !== " " ? [diff(cwd2, path, true)] : [],
        ...worktree !== " " ? [diff(cwd2, path, false)] : []
      ];
      for (const patch of patches) {
        const remaining = MAX_TOTAL_DIFF - totalDiff;
        entry.diff += patch.text.slice(0, remaining);
        totalDiff += Math.min(remaining, patch.text.length);
        if (patch.truncated || patch.text.length > remaining) {
          entry.truncated = true;
          truncated = true;
        }
      }
    } else if (worktree !== "?" && totalDiff >= MAX_TOTAL_DIFF) {
      entry.truncated = true;
      truncated = true;
    }
    entries.push(entry);
  }
  return { kind: "git", cwd: cwd2, root, entries, truncated };
}
const args = process.argv.slice(2);
const index = args.indexOf("--cwd");
const cwd = index >= 0 && index + 1 < args.length ? args[index + 1] : "";
try {
  if (!cwd || !isAbsolute(cwd)) throw new Error("Se requiere --cwd absoluto y autorizado");
  process.stdout.write(JSON.stringify(snapshot(resolve(cwd))));
} catch (error) {
  process.stdout.write(JSON.stringify({
    kind: "error",
    entries: [],
    truncated: false,
    error: String(error instanceof Error ? error.message : error).slice(0, 180)
  }));
}

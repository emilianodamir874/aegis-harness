//! Read-only file inspection tools: `read_file` and `grep`.
//!
//! They exist so the model does not have to shell out (`cat`, `rg`) to look at
//! code: the output is already line-numbered, size-capped and gitignore-aware,
//! and they are also exposed as callbacks inside code execution.

use std::fs;
use std::path::{Path, PathBuf};

use ignore::WalkBuilder;
use regex::RegexBuilder;
use rmcp::model::{CallToolResult, ContentBlock};
use schemars::JsonSchema;
use serde::Deserialize;

/// Inclusive line cap for a single read; the caller can paginate with `offset`.
const READ_MAX_LINES: usize = 2_000;
/// Byte cap for a single read, applied after the line cap.
const READ_MAX_BYTES: usize = 60_000;
const GREP_MAX_RESULTS_DEFAULT: usize = 100;
const GREP_MAX_RESULTS_LIMIT: usize = 500;
const GREP_MAX_CONTEXT: usize = 5;
/// Files bigger than this are skipped by grep (they are usually data, not code).
const GREP_MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReadFileParams {
    /// Path to the file. Relative paths resolve against the session working directory.
    pub path: String,
    /// 1-based first line to read. Defaults to 1.
    #[serde(default)]
    pub offset: Option<usize>,
    /// Maximum number of lines to return.
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GrepParams {
    /// Rust regular expression, matched per line.
    pub pattern: String,
    /// File or directory to search. Defaults to the session working directory.
    #[serde(default)]
    pub path: Option<String>,
    /// Optional glob filter for file names, e.g. `*.rs` or `app.*`.
    #[serde(default)]
    pub glob: Option<String>,
    #[serde(default)]
    pub ignore_case: Option<bool>,
    /// Maximum matching lines to return (default 100, max 500).
    #[serde(default)]
    pub max_results: Option<usize>,
    /// Matching lines of context before and after each hit (max 5).
    #[serde(default)]
    pub context: Option<usize>,
}

pub struct ReadTool;

impl ReadTool {
    pub fn new() -> Self {
        Self
    }

    pub fn read_file_with_cwd(
        &self,
        params: ReadFileParams,
        working_dir: Option<&Path>,
    ) -> CallToolResult {
        let path = resolve(&params.path, working_dir);
        if !path.exists() {
            return error(format!("File does not exist: {}", path.display()));
        }
        if path.is_dir() {
            return error(format!(
                "{} is a directory; use the tree tool to list it",
                path.display()
            ));
        }
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(err) => return error(format!("Could not read {}: {err}", path.display())),
        };
        if bytes.iter().take(8_192).any(|b| *b == 0) {
            return error(format!(
                "{} looks binary; refusing to read it as text",
                path.display()
            ));
        }
        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = text.lines().collect();
        let total = lines.len();
        let start = params.offset.unwrap_or(1).max(1) - 1;
        if start >= total && total > 0 {
            return error(format!(
                "offset {start} is past the end of {} ({total} lines)",
                path.display()
            ));
        }
        let requested = params.limit.unwrap_or(READ_MAX_LINES).max(1);
        let take = requested.min(READ_MAX_LINES);
        let slice: Vec<(usize, &str)> = lines
            .iter()
            .enumerate()
            .skip(start)
            .take(take)
            .map(|(i, line)| (i + 1, *line))
            .collect();

        let mut out = String::new();
        let mut bytes_used = 0usize;
        let mut shown = 0usize;
        for (number, line) in &slice {
            let rendered = format!("{number:>6} | {line}\n");
            if bytes_used + rendered.len() > READ_MAX_BYTES {
                break;
            }
            bytes_used += rendered.len();
            out.push_str(&rendered);
            shown += 1;
        }
        let last = start + shown;
        if last < total {
            out.push_str(&format!(
                "\n[{} de {} lineas mostradas; segui con offset={}]\n",
                shown,
                total,
                last + 1
            ));
        } else if total == 0 {
            out.push_str("[archivo vacio]\n");
        }
        CallToolResult::success(vec![ContentBlock::text(out)])
    }

    pub fn grep_with_cwd(&self, params: GrepParams, working_dir: Option<&Path>) -> CallToolResult {
        let root = params
            .path
            .as_deref()
            .map(|p| resolve(p, working_dir))
            .or_else(|| working_dir.map(Path::to_path_buf))
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from("."));
        if !root.exists() {
            return error(format!("Path does not exist: {}", root.display()));
        }
        let regex = match RegexBuilder::new(&params.pattern)
            .case_insensitive(params.ignore_case.unwrap_or(false))
            .build()
        {
            Ok(regex) => regex,
            Err(err) => return error(format!("Invalid regex: {err}")),
        };
        let glob = params
            .glob
            .as_deref()
            .and_then(|pattern| glob_regex(pattern).ok());
        let max_results = params
            .max_results
            .unwrap_or(GREP_MAX_RESULTS_DEFAULT)
            .clamp(1, GREP_MAX_RESULTS_LIMIT);
        let context = params.context.unwrap_or(0).min(GREP_MAX_CONTEXT);

        let mut out = String::new();
        let mut hits = 0usize;
        let mut scanned = 0usize;
        let mut truncated = false;

        let files: Vec<PathBuf> = if root.is_file() {
            vec![root.clone()]
        } else {
            WalkBuilder::new(&root)
                .hidden(false)
                .build()
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry.file_type().is_some_and(|t| t.is_file()))
                .map(|entry| entry.into_path())
                .collect()
        };

        'files: for file in files {
            if let Some(glob) = &glob {
                let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !glob.is_match(name) {
                    continue;
                }
            }
            if fs::metadata(&file).map(|m| m.len() > GREP_MAX_FILE_BYTES).unwrap_or(true) {
                continue;
            }
            let bytes = match fs::read(&file) {
                Ok(bytes) => bytes,
                Err(_) => continue,
            };
            if bytes.iter().take(8_192).any(|b| *b == 0) {
                continue;
            }
            scanned += 1;
            let text = String::from_utf8_lossy(&bytes);
            let lines: Vec<&str> = text.lines().collect();
            let display = relative_display(&file, &root);
            for (index, line) in lines.iter().enumerate() {
                if !regex.is_match(line) {
                    continue;
                }
                if hits >= max_results {
                    truncated = true;
                    break 'files;
                }
                if context > 0 {
                    let from = index.saturating_sub(context);
                    let to = (index + context + 1).min(lines.len());
                    for (offset, ctx) in lines[from..to].iter().enumerate() {
                        let number = from + offset + 1;
                        let marker = if from + offset == index { ':' } else { '-' };
                        out.push_str(&format!("{display}{marker}{number}{marker}{ctx}\n"));
                    }
                    out.push_str("--\n");
                } else {
                    out.push_str(&format!("{display}:{}: {}\n", index + 1, line.trim_end()));
                }
                hits += 1;
            }
        }

        if hits == 0 {
            return CallToolResult::success(vec![ContentBlock::text(format!(
                "No matches for {pattern:?} in {root} ({scanned} archivos escaneados)",
                pattern = params.pattern,
                root = root.display()
            ))]);
        }
        if truncated {
            out.push_str(&format!(
                "[cortado en {max_results} coincidencias; acota el patron o usa glob]\n"
            ));
        }
        out.push_str(&format!(
            "[{hits} coincidencias en {scanned} archivos]\n"
        ));
        CallToolResult::success(vec![ContentBlock::text(out)])
    }
}

fn error(message: String) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(message)])
}

fn resolve(path: &str, working_dir: Option<&Path>) -> PathBuf {
    let candidate = PathBuf::from(path);
    if candidate.is_absolute() {
        return candidate;
    }
    working_dir
        .map(Path::to_path_buf)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
        .join(candidate)
}

/// Turns a `*.rs` style glob into a regex over the file name.
fn glob_regex(pattern: &str) -> Result<regex::Regex, regex::Error> {
    let mut out = String::from("^(?i)");
    for ch in pattern.chars() {
        match ch {
            '*' => out.push_str(".*"),
            '?' => out.push('.'),
            other => out.push_str(&regex::escape(&other.to_string())),
        }
    }
    out.push('$');
    regex::Regex::new(&out)
}

fn relative_display(file: &Path, root: &Path) -> String {
    if root.is_file() {
        return file.display().to_string();
    }
    file.strip_prefix(root)
        .unwrap_or(file)
        .display()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("goose-read-tool-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn text_of(result: &CallToolResult) -> String {
        result
            .content
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text(text) => Some(text.text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn read_file_numbers_lines_and_paginates() {
        let dir = temp_dir("paginate");
        let path = dir.join("sample.txt");
        let mut file = fs::File::create(&path).expect("create");
        for index in 1..=10 {
            writeln!(file, "linea {index}").expect("write");
        }
        drop(file);

        let tool = ReadTool::new();
        let first = tool.read_file_with_cwd(
            ReadFileParams {
                path: "sample.txt".to_string(),
                offset: Some(1),
                limit: Some(3),
            },
            Some(&dir),
        );
        let text = text_of(&first);
        assert!(text.contains("     1 | linea 1"));
        assert!(text.contains("     3 | linea 3"));
        assert!(!text.contains("linea 4"));
        assert!(text.contains("offset=4"));

        let second = tool.read_file_with_cwd(
            ReadFileParams {
                path: "sample.txt".to_string(),
                offset: Some(9),
                limit: None,
            },
            Some(&dir),
        );
        let text = text_of(&second);
        assert!(text.contains("    10 | linea 10"));
        assert!(!text.contains("de 10 lineas mostradas"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_file_rejects_directories_and_binaries() {
        let dir = temp_dir("rejects");
        let binary = dir.join("blob.bin");
        fs::write(&binary, [0u8, 1, 2, 3, 0, 9]).expect("write");

        let tool = ReadTool::new();
        let dir_result = tool.read_file_with_cwd(
            ReadFileParams { path: ".".to_string(), offset: None, limit: None },
            Some(&dir),
        );
        assert!(dir_result.is_error.unwrap_or(false));
        let binary_result = tool.read_file_with_cwd(
            ReadFileParams { path: "blob.bin".to_string(), offset: None, limit: None },
            Some(&dir),
        );
        assert!(binary_result.is_error.unwrap_or(false));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn grep_filters_by_glob_and_reports_counts() {
        let dir = temp_dir("grep");
        fs::write(dir.join("a.rs"), "fn main() {}\nlet hit = 1;\n").expect("write");
        fs::write(dir.join("b.txt"), "let hit = 2;\n").expect("write");

        let tool = ReadTool::new();
        let all = tool.grep_with_cwd(
            GrepParams {
                pattern: "let hit".to_string(),
                path: Some(".".to_string()),
                glob: None,
                ignore_case: None,
                max_results: None,
                context: None,
            },
            Some(&dir),
        );
        let text = text_of(&all);
        assert!(text.contains("a.rs:2"));
        assert!(text.contains("b.txt:1"));
        assert!(text.contains("2 coincidencias"));

        let only_rust = tool.grep_with_cwd(
            GrepParams {
                pattern: "let hit".to_string(),
                path: Some(".".to_string()),
                glob: Some("*.rs".to_string()),
                ignore_case: None,
                max_results: None,
                context: None,
            },
            Some(&dir),
        );
        let text = text_of(&only_rust);
        assert!(text.contains("a.rs:2"));
        assert!(!text.contains("b.txt"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn grep_reports_no_matches_and_invalid_regex() {
        let dir = temp_dir("empty");
        fs::write(dir.join("a.txt"), "nada\n").expect("write");
        let tool = ReadTool::new();
        let none = tool.grep_with_cwd(
            GrepParams {
                pattern: "zzz".to_string(),
                path: Some(".".to_string()),
                glob: None,
                ignore_case: None,
                max_results: None,
                context: None,
            },
            Some(&dir),
        );
        assert!(text_of(&none).contains("No matches"));
        let bad = tool.grep_with_cwd(
            GrepParams {
                pattern: "([".to_string(),
                path: Some(".".to_string()),
                glob: None,
                ignore_case: None,
                max_results: None,
                context: None,
            },
            Some(&dir),
        );
        assert!(bad.is_error.unwrap_or(false));
        let _ = fs::remove_dir_all(&dir);
    }
}

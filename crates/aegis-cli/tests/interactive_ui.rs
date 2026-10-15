//! Interactive end-to-end tests for the CLI.
//!
//! `cargo test` runs without a TTY, so the interactive path — concurrent
//! composer, bracketed paste, resize events, modal prompts — is never exercised
//! by unit tests: `is_terminal()` is false and the code takes the plain branch.
//! These tests hand the real binary a pseudo-terminal, answer its model requests
//! with a deterministic SSE server, and rebuild the screen from the ANSI stream,
//! so they assert on what a user would actually see rather than on raw bytes.

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

// --------------------------------------------------------------- mock model

const WORDS: &[&str] = &["El", "mar", "respira", "lento", "bajo", "la", "luna."];
const TOOL_COMMAND: &str = "echo mock-tool-ok";
const MODEL: &str = "mock-model";

/// Deterministic OpenAI-compatible server.
///
/// Request 1 streams a short story. Request 2 streams a few words and then asks
/// for `developer__shell`, so an interactive test can drive the approval modal
/// while the turn is still live. Later requests just close the turn.
struct MockModel {
    port: u16,
    requests: Arc<AtomicUsize>,
    bodies: Arc<Mutex<Vec<String>>>,
}

impl MockModel {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock model");
        let port = listener.local_addr().expect("mock addr").port();
        let requests = Arc::new(AtomicUsize::new(0));
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let counter = Arc::clone(&requests);
        let captured = Arc::clone(&bodies);
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let counter = Arc::clone(&counter);
                let captured = Arc::clone(&captured);
                thread::spawn(move || {
                    let _ = serve(stream, counter, captured);
                });
            }
        });
        Self {
            port,
            requests,
            bodies,
        }
    }

    fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    fn requests(&self) -> usize {
        self.requests.load(Ordering::SeqCst)
    }

    /// Chat-completion request bodies the mock saw, oldest first.
    fn bodies(&self) -> Vec<String> {
        self.bodies.lock().expect("bodies lock").clone()
    }
}

fn serve(
    mut stream: TcpStream,
    requests: Arc<AtomicUsize>,
    bodies: Arc<Mutex<Vec<String>>>,
) -> std::io::Result<()> {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while head.len() < 16384 {
        if stream.read(&mut byte)? == 0 {
            return Ok(());
        }
        head.push(byte[0]);
        if head.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    let head = String::from_utf8_lossy(&head).to_string();
    let request_line = head.lines().next().unwrap_or_default().to_string();
    let content_length = head
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())?
        })
        .unwrap_or(0);
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        stream.read_exact(&mut body)?;
    }

    if request_line.starts_with("GET") {
        let payload = json!({"object": "list", "data": [{"id": MODEL, "object": "model"}]});
        return respond_json(&mut stream, &payload);
    }

    requests.fetch_add(1, Ordering::SeqCst);
    let payload = String::from_utf8_lossy(&body);
    if let Ok(mut captured) = bodies.lock() {
        captured.push(payload.to_string());
    }
    let step = if payload.contains("PRESENTACION_TERMINAL_PROBE") {
        if payload.contains("This is an interactive terminal chat") {
            4
        } else {
            5
        }
    } else if payload.contains("call_mock_1") || payload.contains("mock-tool-ok") {
        3
    } else if payload.contains("segundo") {
        2
    } else {
        1
    };
    respond_sse(&mut stream, step)
}

fn respond_json(stream: &mut TcpStream, payload: &Value) -> std::io::Result<()> {
    let body = payload.to_string();
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )?;
    stream.flush()
}

fn respond_sse(stream: &mut TcpStream, index: usize) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
    )?;
    stream.flush()?;

    if index == 4 || index == 5 {
        let marker = if index == 4 {
            "PROMPT_TERMINAL_OK"
        } else {
            "PROMPT_TERMINAL_MISSING"
        };
        for part in [
            format!("{marker}\n\n| Proyecto | Estado | Descripción |\n| --- | --- | --- |\n| Servo | activo | Una comparación larga que no cabe en columnas y debe leerse en vertical. "),
            "Incluye detalles sin perder una sola celda. |\n| Gosub | beta | Motor alternativo en Rust. |\n\nListo.".to_string(),
        ] {
            chunk(stream, &content_chunk(&part))?;
            thread::sleep(Duration::from_millis(40));
        }
        chunk(
            stream,
            &json!({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}).to_string(),
        )?;
    } else if index == 2 {
        for word in ["Necesito", "una", "herramienta."] {
            chunk(stream, &content_chunk(word))?;
        }
        thread::sleep(Duration::from_millis(800));
        chunk(
            stream,
            &json!({"choices": [{"index": 0, "delta": {"tool_calls": [{
                "index": 0, "id": "call_mock_1", "type": "function",
                "function": {"name": "developer__shell", "arguments": ""}}]},
                "finish_reason": null}]})
            .to_string(),
        )?;
        chunk(
            stream,
            &json!({"choices": [{"index": 0, "delta": {"tool_calls": [{
                "index": 0,
                "function": {"arguments": json!({"command": TOOL_COMMAND}).to_string()}}]},
                "finish_reason": null}]})
            .to_string(),
        )?;
        chunk(
            stream,
            &json!({"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}],
                "usage": {"prompt_tokens": 30, "completion_tokens": 12, "total_tokens": 42}})
            .to_string(),
        )?;
    } else {
        let words: &[&str] = if index == 1 {
            WORDS
        } else {
            &["Listo.", "Herramienta", "ejecutada."]
        };
        for (position, word) in words.iter().enumerate() {
            let piece = if position == 0 {
                (*word).to_string()
            } else {
                format!(" {word}")
            };
            chunk(stream, &content_chunk(&piece))?;
            thread::sleep(Duration::from_millis(40));
        }
        chunk(
            stream,
            &json!({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 12, "completion_tokens": words.len(), "total_tokens": 12 + words.len()}})
            .to_string(),
        )?;
    }
    write!(stream, "0\r\n\r\n")?;
    stream.flush()
}

fn content_chunk(text: &str) -> String {
    json!({
        "id": "chatcmpl-mock",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": MODEL,
        "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": null}]
    })
    .to_string()
}

fn chunk(stream: &mut TcpStream, payload: &str) -> std::io::Result<()> {
    let frame = format!("data: {payload}\n\n");
    write!(stream, "{:X}\r\n{}\r\n", frame.len(), frame)?;
    stream.flush()
}

// ----------------------------------------------------------- screen emulator

/// Enough of the ANSI subset aegis, rustyline and cliclack emit to rebuild the
/// visible grid. Deliberately ignores styling: these tests care about text.
#[derive(Default)]
struct Screen {
    grid: Vec<Vec<char>>,
    rows: usize,
    cols: usize,
    row: usize,
    col: usize,
    top: usize,
    bottom: usize,
    saved: (usize, usize),
}

impl Screen {
    fn new(rows: usize, cols: usize) -> Self {
        Self {
            grid: vec![vec![' '; cols]; rows],
            rows,
            cols,
            bottom: rows.saturating_sub(1),
            ..Default::default()
        }
    }

    fn resize(&mut self, rows: usize, cols: usize) {
        let mut grid = vec![vec![' '; cols]; rows];
        for (row, source) in self.grid.iter().take(rows).enumerate() {
            for (col, cell) in source.iter().take(cols).enumerate() {
                grid[row][col] = *cell;
            }
        }
        self.grid = grid;
        self.rows = rows;
        self.cols = cols;
        self.row = self.row.min(rows.saturating_sub(1));
        self.col = self.col.min(cols.saturating_sub(1));
        self.top = 0;
        self.bottom = rows.saturating_sub(1);
    }

    fn scroll_up(&mut self) {
        self.grid.remove(self.top);
        self.grid.insert(self.bottom, vec![' '; self.cols]);
    }

    fn newline(&mut self) {
        if self.row == self.bottom {
            self.scroll_up();
        } else if self.row < self.rows.saturating_sub(1) {
            self.row += 1;
        }
    }

    fn put(&mut self, glyph: char) {
        if self.col >= self.cols {
            self.col = 0;
            self.newline();
        }
        if self.row < self.rows && self.col < self.cols {
            self.grid[self.row][self.col] = glyph;
        }
        self.col += 1;
    }

    fn feed(&mut self, data: &str) {
        let chars: Vec<char> = data.chars().collect();
        let mut index = 0;
        while index < chars.len() {
            match chars[index] {
                '\u{1b}' => index = self.escape(&chars, index + 1),
                '\r' => {
                    self.col = 0;
                    index += 1;
                }
                '\n' => {
                    self.newline();
                    index += 1;
                }
                '\u{8}' => {
                    self.col = self.col.saturating_sub(1);
                    index += 1;
                }
                '\t' => {
                    self.col = ((self.col / 8 + 1) * 8).min(self.cols.saturating_sub(1));
                    index += 1;
                }
                glyph if (glyph as u32) >= 32 => {
                    self.put(glyph);
                    index += 1;
                }
                _ => index += 1,
            }
        }
    }

    fn escape(&mut self, chars: &[char], mut index: usize) -> usize {
        let Some(&kind) = chars.get(index) else {
            return index;
        };
        match kind {
            '[' => {
                let start = index + 1;
                let mut end = start;
                while end < chars.len() && !('@'..='~').contains(&chars[end]) {
                    end += 1;
                }
                if end >= chars.len() {
                    return end;
                }
                let params: String = chars[start..end].iter().collect();
                let final_byte = chars[end];
                self.csi(&params, final_byte);
                end + 1
            }
            ']' => {
                while index < chars.len() {
                    if chars[index] == '\u{7}' {
                        return index + 1;
                    }
                    if chars[index] == '\u{1b}' && chars.get(index + 1) == Some(&'\\') {
                        return index + 2;
                    }
                    index += 1;
                }
                index
            }
            '7' => {
                self.saved = (self.row, self.col);
                index + 1
            }
            '8' => {
                (self.row, self.col) = self.saved;
                index + 1
            }
            _ => index + 1,
        }
    }

    fn csi(&mut self, raw: &str, final_byte: char) {
        let raw = raw.trim_start_matches(['?', '>', '!']);
        let params: Vec<usize> = if raw.is_empty() {
            Vec::new()
        } else {
            raw.split(';')
                .map(|part| part.parse().unwrap_or(0))
                .collect()
        };
        let first = params.first().copied().unwrap_or(0);
        let count = if first == 0 { 1 } else { first };
        match final_byte {
            'H' | 'f' => {
                self.row = first.saturating_sub(1).min(self.rows.saturating_sub(1));
                self.col = params
                    .get(1)
                    .copied()
                    .unwrap_or(1)
                    .saturating_sub(1)
                    .min(self.cols.saturating_sub(1));
            }
            'A' => self.row = self.row.saturating_sub(count).max(self.top),
            'B' => self.row = (self.row + count).min(self.bottom),
            'C' => self.col = (self.col + count).min(self.cols.saturating_sub(1)),
            'D' => self.col = self.col.saturating_sub(count),
            'G' => self.col = count.saturating_sub(1).min(self.cols.saturating_sub(1)),
            'd' => self.row = count.saturating_sub(1).min(self.rows.saturating_sub(1)),
            'J' => {
                let start = match first {
                    2 => 0,
                    1 => 0,
                    _ => self.row,
                };
                let end = match first {
                    2 => self.rows,
                    1 => self.row + 1,
                    _ => self.rows,
                };
                for row in start..end {
                    self.grid[row] = vec![' '; self.cols];
                }
            }
            'K' => {
                if let Some(line) = self.grid.get_mut(self.row) {
                    match first {
                        1 => line[..=self.col.min(self.cols.saturating_sub(1))].fill(' '),
                        2 => line.fill(' '),
                        _ => line[self.col.min(self.cols.saturating_sub(1))..].fill(' '),
                    }
                }
            }
            'r' => {
                let top = first.saturating_sub(1);
                let bottom = params
                    .get(1)
                    .copied()
                    .unwrap_or(self.rows)
                    .saturating_sub(1);
                if top < bottom && bottom < self.rows {
                    self.top = top;
                    self.bottom = bottom;
                }
                self.row = self.top;
                self.col = 0;
            }
            _ => {}
        }
    }

    fn text(&self) -> String {
        self.grid
            .iter()
            .map(|row| row.iter().collect::<String>().trim_end().to_string())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

// ------------------------------------------------------------------- driver

struct Terminal {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    screen: Arc<Mutex<Screen>>,
    raw: Arc<Mutex<String>>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    master: Box<dyn portable_pty::MasterPty + Send>,
}

impl Terminal {
    fn spawn(
        exe: &str,
        args: &[&str],
        env: &HashMap<String, String>,
        rows: u16,
        cols: u16,
    ) -> Self {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open pty");
        let mut builder = CommandBuilder::new(exe);
        for arg in args {
            builder.arg(arg);
        }
        for (key, value) in env {
            builder.env(key, value);
        }
        builder.cwd(std::env::temp_dir());
        let child = pair.slave.spawn_command(builder).expect("spawn aegis");
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("pty reader");
        let writer = Arc::new(Mutex::new(pair.master.take_writer().expect("pty writer")));
        let screen = Arc::new(Mutex::new(Screen::new(rows as usize, cols as usize)));
        let raw = Arc::new(Mutex::new(String::new()));

        let sink = Arc::clone(&screen);
        let log = Arc::clone(&raw);
        let reply = Arc::clone(&writer);
        thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            let mut pending = String::new();
            while let Ok(read) = reader.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                let text = String::from_utf8_lossy(&buffer[..read]).to_string();
                pending.push_str(&text);
                while let Some(pos) = pending.find("\x1b[6n") {
                    pending.replace_range(..pos + 4, "");
                    if let Ok(mut writer) = reply.lock() {
                        let _ = write!(writer, "\x1b[1;1R");
                        let _ = writer.flush();
                    }
                }
                if pending.len() > 16 {
                    pending = pending
                        .chars()
                        .rev()
                        .take(16)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect();
                }
                if let Ok(mut screen) = sink.lock() {
                    screen.feed(&text);
                }
                if let Ok(mut log) = log.lock() {
                    log.push_str(&text);
                }
            }
        });

        Self {
            writer,
            screen,
            raw,
            child,
            master: pair.master,
        }
    }

    fn type_text(&mut self, text: &str) {
        let mut writer = self.writer.lock().expect("pty writer lock");
        let _ = writer.write_all(text.as_bytes());
        let _ = writer.flush();
    }

    fn press_enter(&mut self) {
        let mut writer = self.writer.lock().expect("pty writer lock");
        let _ = writer.write_all(b"\r");
        let _ = writer.flush();
    }

    fn screen(&self) -> String {
        self.screen.lock().expect("screen lock").text()
    }

    fn raw(&self) -> String {
        self.raw.lock().expect("raw lock").clone()
    }

    fn resize(&mut self, rows: u16, cols: u16) {
        let _ = self.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
        self.screen
            .lock()
            .expect("screen lock")
            .resize(rows as usize, cols as usize);
    }

    fn wait_for<F: Fn(&str) -> bool>(&self, predicate: F, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if predicate(&self.screen()) {
                return true;
            }
            thread::sleep(Duration::from_millis(50));
        }
        predicate(&self.screen())
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn aegis_exe() -> &'static str {
    env!("CARGO_BIN_EXE_aegis")
}

/// Each run gets a fresh pid-tagged root. Stale roots from earlier runs are
/// pruned on the way in (older than two hours — parallel tests in this run
/// share the pid and must not be disturbed), so the temp dir does not
/// accumulate one sandbox per test run.
fn sandbox(tag: &str) -> PathBuf {
    let base = std::env::temp_dir();
    if let Ok(entries) = std::fs::read_dir(&base) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name.to_string_lossy().starts_with("aegis-ui-") {
                let stale = entry
                    .metadata()
                    .and_then(|meta| meta.modified())
                    .map(|modified| {
                        modified
                            .elapsed()
                            .map_or(false, |age| age.as_secs() > 7200)
                    })
                    .unwrap_or(false);
                if stale {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
    }
    let root = base.join(format!("aegis-ui-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("sandbox root");
    root
}

fn session_env(model: &MockModel, root: &Path, extra: &[(&str, &str)]) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    env.insert("OPENAI_HOST".into(), model.base_url());
    env.insert("OPENAI_API_KEY".into(), "dummy".into());
    env.insert("OPENAI_BASE_PATH".into(), "/v1".into());
    env.insert("AEGIS_DISABLE_KEYRING".into(), "1".into());
    env.insert("AEGIS_PATH_ROOT".into(), root.to_string_lossy().to_string());
    env.insert("TERM".into(), "xterm-256color".into());
    env.remove("NO_COLOR");
    env.remove("AEGIS_CLI_PLAIN");
    for (key, value) in extra {
        env.insert((*key).into(), (*value).into());
    }
    env
}

/// SGR sequences that actually carry a colour. Reverse video (`7m`), dim (`2m`)
/// and reset are not colour, and the composer relies on `7m` for its caret.
fn color_sequences(raw: &str) -> Vec<String> {
    let mut found = Vec::new();
    let bytes: Vec<char> = raw.chars().collect();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == '\u{1b}' && bytes.get(index + 1) == Some(&'[') {
            let mut end = index + 2;
            while end < bytes.len() && !('@'..='~').contains(&bytes[end]) {
                end += 1;
            }
            if bytes.get(end) == Some(&'m') {
                let params: String = bytes[index + 2..end].iter().collect();
                let colored = params.split(';').any(|part| {
                    let code: u32 = part.parse().unwrap_or(0);
                    matches!(code, 30..=38 | 40..=48 | 90..=98 | 100..=108)
                });
                if colored {
                    found.push(format!("\u{1b}[{params}m"));
                }
            }
            index = end + 1;
        } else {
            index += 1;
        }
    }
    found
}

// -------------------------------------------------------------------- tests

#[test]
fn terminal_chat_uses_effective_prompt_and_streams_wide_table_as_cards() {
    let model = MockModel::start();
    let root = sandbox("adaptive-table");
    let env = session_env(
        &model,
        &root,
        &[("AEGIS_CLI_PLAIN", "1"), ("AEGIS_MODE", "auto")],
    );
    let mut terminal = Terminal::spawn(
        aegis_exe(),
        &[
            "session",
            "--provider",
            "openai",
            "--model",
            "mock-model",
            "--no-profile",
        ],
        &env,
        30,
        80,
    );
    assert!(
        terminal.wait_for(
            |screen| screen.contains("Chat interactivo"),
            Duration::from_secs(60)
        ),
        "chat did not start: {}",
        terminal.screen()
    );
    terminal.type_text("PRESENTACION_TERMINAL_PROBE");
    terminal.press_enter();
    assert!(
        terminal.wait_for(
            |screen| screen.contains("Listo.") && screen.contains("Proyecto: Servo"),
            Duration::from_secs(40)
        ),
        "table did not render: {}",
        terminal.screen()
    );
    let screen = terminal.screen();
    assert!(
        screen.contains("PROMPT_TERMINAL_OK"),
        "effective model prompt missing: {screen}"
    );
    assert!(
        screen.contains("Estado: activo"),
        "first row lost: {screen}"
    );
    assert!(
        screen.contains("Proyecto: Gosub"),
        "second row lost: {screen}"
    );
    assert!(
        screen.contains("sin perder una sola celda"),
        "streamed long cell lost: {screen}"
    );
    assert!(
        !screen.contains("| ---"),
        "unrendered Markdown table: {screen}"
    );
    assert!(
        screen.contains("Aegis"),
        "assistant label missing: {screen}"
    );
    assert!(terminal.raw().contains("Listo."));
}

#[test]
fn concurrent_ui_streams_without_colour_and_keeps_one_line_turn_summary() {
    let model = MockModel::start();
    let root = sandbox("plain");
    let env = session_env(
        &model,
        &root,
        &[("AEGIS_CLI_PLAIN", "1"), ("AEGIS_MODE", "auto")],
    );
    let mut terminal = Terminal::spawn(
        aegis_exe(),
        &[
            "session",
            "--provider",
            "openai",
            "--model",
            "mock-model",
            "--no-profile",
        ],
        &env,
        30,
        100,
    );

    assert!(
        terminal.wait_for(
            |screen| screen.contains("aegis is ready"),
            Duration::from_secs(60)
        ),
        "session never reached the ready banner:\n{}\nRAW: {:?}",
        terminal.screen(),
        terminal.raw()
    );

    terminal.type_text("contame una historia");
    terminal.press_enter();

    assert!(
        terminal.wait_for(
            |screen| screen.contains("El mar respira"),
            Duration::from_secs(30)
        ),
        "streamed text never appeared:\n{}",
        terminal.screen()
    );

    // A Unicode multiline paste typed mid-stream must survive resize and turn completion.
    terminal.resize(32, 90);
    let draft = "borrador ñ中\nsegunda línea";
    terminal.type_text(&format!("\x1b[200~{draft}\x1b[201~"));
    assert!(
        terminal.wait_for(
            |screen| screen.contains("borrador ñ中↵segunda línea"),
            Duration::from_secs(10)
        ),
        "the composer never echoed the pasted draft after resize:\n{}",
        terminal.screen()
    );

    assert!(
        terminal.wait_for(|screen| screen.contains("turn "), Duration::from_secs(90)),
        "the turn never completed:\n{}",
        terminal.screen()
    );

    let screen = terminal.screen();
    let summary = screen
        .lines()
        .find(|line| line.trim_start().starts_with("turn "))
        .unwrap_or_default()
        .to_string();
    assert!(
        summary.contains(" tok"),
        "turn summary should be a single compact line, got: {summary:?}"
    );
    assert!(
        !summary.contains("Turn started")
            && !screen.contains("Turn started:")
            && !screen.contains("Changed lines:"),
        "the verbose per-turn block is back:\n{screen}"
    );

    assert!(
        terminal.wait_for(
            |screen| screen.contains("borrador ñ中\nsegunda línea"),
            Duration::from_secs(10)
        ),
        "the draft was lost when the turn ended:\n{}",
        terminal.screen()
    );

    assert!(model.requests() >= 2, "mock did not receive the user turn");
    let colors = color_sequences(&terminal.raw());
    assert!(
        colors.is_empty(),
        "plain mode still emitted colour sequences: {:?}",
        &colors[..colors.len().min(5)]
    );
}

#[test]
fn redirected_json_output_has_no_control_bytes_and_no_banner() {
    let model = MockModel::start();
    let root = sandbox("json");
    let env = session_env(&model, &root, &[("AEGIS_MODE", "auto")]);

    let output = std::process::Command::new(aegis_exe())
        .args([
            "run",
            "--provider",
            "openai",
            "--model",
            "mock-model",
            "--no-profile",
            "--output-format",
            "json",
            "-t",
            "deci hola",
        ])
        .envs(&env)
        .output()
        .expect("run aegis");

    assert!(
        output.status.success(),
        "run failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    assert!(
        !stdout.contains('\u{1b}'),
        "redirected output carried escape sequences: {stdout:?}"
    );
    assert!(
        !stdout.contains("aegis is ready"),
        "the session banner leaked into machine-readable output: {stdout:?}"
    );
    let parsed: Value = serde_json::from_str(&stdout)
        .unwrap_or_else(|error| panic!("stdout is not a JSON document ({error}): {stdout:?}"));
    assert!(
        parsed.is_array() || parsed.is_object(),
        "unexpected JSON shape: {parsed:?}"
    );
}

#[test]
fn approval_modal_suspends_the_composer_and_the_draft_survives() {
    let model = MockModel::start();
    let root = sandbox("modal");
    let env = session_env(
        &model,
        &root,
        &[("AEGIS_CLI_PLAIN", "1"), ("AEGIS_MODE", "approve")],
    );
    let mut terminal = Terminal::spawn(
        aegis_exe(),
        &[
            "session",
            "--provider",
            "openai",
            "--model",
            "mock-model",
            "--no-profile",
            "--with-builtin",
            "developer",
        ],
        &env,
        30,
        100,
    );

    assert!(
        terminal.wait_for(
            |screen| screen.contains("aegis is ready"),
            Duration::from_secs(60)
        ),
        "session never reached the ready banner:\n{}\nRAW: {:?}",
        terminal.screen(),
        terminal.raw()
    );

    // Turn 1: plain story, no tool call.
    terminal.type_text("primero");
    terminal.press_enter();
    assert!(
        terminal.wait_for(|screen| screen.contains("turn "), Duration::from_secs(90)),
        "turn one never completed:\n{}",
        terminal.screen()
    );

    // Turn 2: the mock answers with a tool call, so the approval modal opens.
    terminal.type_text("segundo");
    terminal.press_enter();
    assert!(
        terminal.wait_for(
            |screen| screen.contains("Necesitounaherramienta"),
            Duration::from_secs(30)
        ),
        "second turn never streamed: {}",
        terminal.screen()
    );
    let draft = "borrador durante el modal";
    terminal.type_text(draft);
    assert!(terminal.wait_for(|screen| screen.contains(draft), Duration::from_secs(5)));
    assert!(
        terminal.wait_for(
            |screen| screen.contains("do you allow") || screen.contains("Allow"),
            Duration::from_secs(60)
        ),
        "the approval modal never appeared:\n{}",
        terminal.screen()
    );
    assert!(terminal.screen().contains("Tool approval request"));
    terminal.type_text("\x1b");
    assert!(
        terminal.wait_for(
            |screen| screen.contains(draft) && screen.contains("turn "),
            Duration::from_secs(120)
        ),
        "turn did not finish with draft retained: {}",
        terminal.screen()
    );
    assert!(
        terminal
            .screen()
            .contains("Tool call cancelled. Returning to chat"),
        "cancel outcome missing: {}",
        terminal.screen()
    );
    assert!(model.requests() >= 3, "mock did not receive the tool turn");
}

#[test]
fn lone_slash_opens_the_command_picker_without_enter() {
    let model = MockModel::start();
    let root = sandbox("slashmenu");
    let env = session_env(&model, &root, &[("AEGIS_CLI_PLAIN", "1")]);
    let mut terminal = Terminal::spawn(
        aegis_exe(),
        &[
            "session",
            "--provider",
            "openai",
            "--model",
            "mock-model",
            "--no-profile",
        ],
        &env,
        30,
        100,
    );

    assert!(
        terminal.wait_for(
            |screen| screen.contains("aegis is ready"),
            Duration::from_secs(60)
        ),
        "session never reached the ready banner:\n{}",
        terminal.screen()
    );

    // A lone `/` must open the picker immediately, without pressing Enter.
    terminal.type_text("/");
    assert!(
        terminal.wait_for(
            |screen| screen.contains("Slash commands"),
            Duration::from_secs(30)
        ),
        "the command picker never opened:\n{}",
        terminal.screen()
    );

    // Filter down to /usage and pick it; the choice lands in the prompt.
    terminal.type_text("usage");
    terminal.press_enter();
    assert!(
        terminal.wait_for(
            |screen| screen.contains("> /usage"),
            Duration::from_secs(10)
        ),
        "the picked command never reached the prompt:\n{}",
        terminal.screen()
    );
}

#[test]
fn rewind_picks_an_earlier_turn_and_the_model_stops_seeing_its_tail() {
    let model = MockModel::start();
    let root = sandbox("rewind");
    let env = session_env(
        &model,
        &root,
        &[
            ("AEGIS_CLI_PLAIN", "1"),
            ("AEGIS_DISABLE_SESSION_NAMING", "true"),
        ],
    );
    let mut terminal = Terminal::spawn(
        aegis_exe(),
        &[
            "session",
            "--provider",
            "openai",
            "--model",
            "mock-model",
            "--no-profile",
        ],
        &env,
        30,
        100,
    );

    assert!(
        terminal.wait_for(
            |screen| screen.contains("aegis is ready"),
            Duration::from_secs(60)
        ),
        "session never reached the ready banner:\n{}",
        terminal.screen()
    );

    // First turn: the message the user will later rewind to.
    terminal.type_text("alpha_origin");
    terminal.press_enter();
    assert!(
        terminal.wait_for(|screen| screen.contains("luna."), Duration::from_secs(60)),
        "the first reply never arrived:\n{}",
        terminal.screen()
    );
    assert!(
        model
            .bodies()
            .iter()
            .any(|body| body.contains("alpha_origin")),
        "the mock never saw the first turn"
    );

    // /rewind opens the picker; with a single turn it is preselected.
    terminal.type_text("/rewind");
    terminal.press_enter();
    assert!(
        terminal.wait_for(
            |screen| screen.contains("Rewind to an earlier turn")
                && screen.contains("alpha_origin"),
            Duration::from_secs(30)
        ),
        "the rewind picker never listed the earlier turn:\n{}",
        terminal.screen()
    );
    terminal.press_enter();
    assert!(
        terminal.wait_for(
            |screen| screen.contains("> alpha_origin"),
            Duration::from_secs(15)
        ),
        "the chosen message never reached the prompt:\n{}",
        terminal.screen()
    );

    // Edit the prefilled turn and resend it: from here on the model must see
    // the edited message but not the reply that was rewound away.
    terminal.type_text(" v2");
    terminal.press_enter();
    assert!(
        terminal.wait_for(
            |screen| screen.matches("luna.").count() >= 2,
            Duration::from_secs(60)
        ),
        "the edited resend never completed:\n{}",
        terminal.screen()
    );

    let resent_requests: Vec<String> = model
        .bodies()
        .into_iter()
        .filter(|body| body.contains("alpha_origin v2"))
        .collect();
    assert!(
        !resent_requests.is_empty(),
        "the mock never received the edited resend"
    );
    for body in resent_requests {
        assert!(
            !body.contains("respira"),
            "a request sent after the rewind still carried the rewound turn's reply:\n{body}"
        );
    }
}

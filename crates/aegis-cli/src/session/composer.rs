//! Concurrent, single-row input for the streaming CLI. Only one owner may read stdin:
//! suspend before invoking rustyline/cliclack/approval prompts and resume afterward.
//! The caller must keep polling `next` while streaming and put Submitted messages
//! in its own pending-turn queue; this module never starts an agent turn itself.

use anyhow::Result;
use crossterm::cursor;
use crossterm::event::{
    DisableBracketedPaste, EnableBracketedPaste, Event, EventStream, KeyCode, KeyEvent,
    KeyEventKind, KeyModifiers,
};
use crossterm::terminal::{disable_raw_mode, enable_raw_mode};
use futures::StreamExt;
use std::collections::VecDeque;
use std::io::{self, IsTerminal, Write};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

#[derive(Debug, PartialEq, Eq)]
pub enum ComposerEvent {
    Submitted(String),
    Cancel,
}

#[derive(Default)]
struct EditBuffer {
    text: String,
    cursor: usize, // byte boundary between extended grapheme clusters
    pending: VecDeque<String>,
}

impl EditBuffer {
    fn insert(&mut self, text: &str) {
        let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
        self.text.insert_str(self.cursor, &normalized);
        self.cursor += normalized.len();
    }

    fn previous(&self) -> usize {
        let (before_cursor, _) = self.text.split_at(self.cursor);
        before_cursor
            .grapheme_indices(true)
            .next_back()
            .map(|(index, _)| index)
            .unwrap_or(0)
    }

    fn following(&self) -> usize {
        let (_, at_cursor) = self.text.split_at(self.cursor);
        at_cursor
            .graphemes(true)
            .next()
            .map(|part| self.cursor + part.len())
            .unwrap_or(self.text.len())
    }

    fn handle_key(&mut self, key: KeyEvent) -> Option<ComposerEvent> {
        if key.kind == KeyEventKind::Release {
            return None;
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        match key.code {
            KeyCode::Enter if !key.modifiers.contains(KeyModifiers::SHIFT) && !ctrl => {
                if !self.text.trim().is_empty() {
                    self.pending.push_back(std::mem::take(&mut self.text));
                    self.cursor = 0;
                }
            }
            KeyCode::Enter => self.insert("\n"),
            KeyCode::Char('j') if ctrl => self.insert("\n"),
            KeyCode::Char('c') if ctrl => {
                if self.text.is_empty() {
                    return Some(ComposerEvent::Cancel);
                }
                self.text.clear();
                self.cursor = 0;
            }
            KeyCode::Home => self.cursor = 0,
            KeyCode::End => self.cursor = self.text.len(),
            KeyCode::Char('a') if ctrl => self.cursor = 0,
            KeyCode::Char('e') if ctrl => self.cursor = self.text.len(),
            KeyCode::Char('u') if ctrl => {
                self.text.replace_range(..self.cursor, "");
                self.cursor = 0;
            }
            KeyCode::Char('k') if ctrl => self.text.truncate(self.cursor),
            KeyCode::Left => self.cursor = self.previous(),
            KeyCode::Right => self.cursor = self.following(),
            KeyCode::Backspace if self.cursor > 0 => {
                let prev = self.previous();
                self.text.replace_range(prev..self.cursor, "");
                self.cursor = prev;
            }
            KeyCode::Delete if self.cursor < self.text.len() => {
                self.text.replace_range(self.cursor..self.following(), "");
            }
            KeyCode::Char(c) if !ctrl && !key.modifiers.contains(KeyModifiers::ALT) => {
                self.insert(&c.to_string());
            }
            _ => {}
        }
        None
    }

    fn pop(&mut self) -> Option<ComposerEvent> {
        self.pending.pop_front().map(ComposerEvent::Submitted)
    }

    fn set_text(&mut self, text: &str) {
        self.text = text.to_string();
        self.cursor = self.text.len();
    }
}

/// In-session recall for the composer: Up/Down walk the messages submitted
/// in this process and restore the in-progress draft past the newest entry.
#[derive(Default)]
struct History {
    entries: Vec<String>,
    index: Option<usize>,
    saved: String,
}

impl History {
    fn commit(&mut self, text: &str) {
        self.entries.push(text.to_string());
        self.index = None;
        self.saved.clear();
    }

    fn previous(&mut self, buffer: &mut EditBuffer) -> bool {
        if self.entries.is_empty() {
            return false;
        }
        let next = match self.index {
            None => {
                self.saved = buffer.text.clone();
                self.entries.len() - 1
            }
            Some(0) => return false,
            Some(index) => index - 1,
        };
        self.index = Some(next);
        buffer.set_text(&self.entries[next]);
        true
    }

    fn next(&mut self, buffer: &mut EditBuffer) -> bool {
        let Some(index) = self.index else {
            return false;
        };
        if index + 1 < self.entries.len() {
            self.index = Some(index + 1);
            buffer.set_text(&self.entries[index + 1]);
        } else {
            self.index = None;
            buffer.set_text(&std::mem::take(&mut self.saved));
        }
        true
    }
}

/// Last completion offered for a `/command` prefix, so repeated Tab presses
/// cycle through the matches instead of restarting.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Completion {
    prefix: String,
    index: usize,
    shown: String,
}

fn completion_cycle(text: &str, previous: Option<&Completion>) -> Option<Completion> {
    if text.contains('\n') || text.contains(' ') || !text.starts_with('/') {
        return None;
    }
    let prefix = match previous {
        Some(previous) if previous.shown == text => previous.prefix.as_str(),
        _ => text,
    };
    let candidates: Vec<&str> = super::input::COMPLETION_COMMANDS
        .iter()
        .copied()
        .filter(|command| command.starts_with(prefix))
        .collect();
    if candidates.is_empty() {
        return None;
    }
    let index = match previous {
        Some(previous) if previous.shown == text && previous.prefix == prefix => {
            (previous.index + 1) % candidates.len()
        }
        _ => 0,
    };
    Some(Completion {
        prefix: prefix.to_string(),
        index,
        shown: candidates[index].to_string(),
    })
}

/// Live candidate menu for the footer's status row while a slash command is
/// being typed: `/` alone lists every command, typing narrows the list.
fn command_suggestions(text: &str) -> Option<String> {
    if !text.starts_with('/') || text.contains(' ') || text.contains('\n') {
        return None;
    }
    let matches: Vec<&str> = super::input::COMPLETION_COMMANDS
        .iter()
        .copied()
        .filter(|command| command.starts_with(text) && *command != text)
        .collect();
    if matches.is_empty() {
        return None;
    }
    Some(format!("  {}", matches.join(" ")))
}

/// Owns raw stdin and the terminal's scroll region while active. Never call a
/// blocking input prompt until `suspend()` has returned. Resume afterwards.
/// Keep this on the same thread as the CLI event loop (not a spawned input task).
pub struct Composer {
    buffer: EditBuffer,
    input: Option<EventStream>,
    height: Option<u16>,
    status: String,
    history: History,
    completion: Option<Completion>,
}

impl Composer {
    /// Returns None for redirected streams or terminals too small for a footer.
    pub fn new(enabled: bool) -> Result<Option<Self>> {
        if !enabled || !io::stdin().is_terminal() || !io::stdout().is_terminal() {
            return Ok(None);
        }
        let (width, height) = crossterm::terminal::size()?;
        if width < 12 || height < 5 {
            return Ok(None);
        }
        let mut composer = Self {
            buffer: EditBuffer::default(),
            input: None,
            height: None,
            status: "Responding".into(),
            history: History::default(),
            completion: None,
        };
        composer.resume()?;
        Ok(Some(composer))
    }

    /// Async, cancellation-safe; poll inside `tokio::select!` beside the agent stream.
    /// Each Submitted is delivered exactly once; empty Enter never enqueues.
    pub async fn next(&mut self) -> Result<ComposerEvent> {
        loop {
            if let Some(submission) = self.buffer.pop() {
                if let ComposerEvent::Submitted(text) = &submission {
                    self.history.commit(text);
                }
                return Ok(submission);
            }
            let Some(input) = &mut self.input else {
                return Err(anyhow::anyhow!("composer is suspended"));
            };
            match input.next().await {
                Some(Ok(Event::Key(key))) => {
                    let outcome = match key.code {
                        KeyCode::Up => {
                            self.completion = None;
                            self.history.previous(&mut self.buffer);
                            None
                        }
                        KeyCode::Down => {
                            self.completion = None;
                            self.history.next(&mut self.buffer);
                            None
                        }
                        KeyCode::Tab => {
                            self.complete();
                            None
                        }
                        _ => {
                            self.completion = None;
                            self.buffer.handle_key(key)
                        }
                    };
                    self.render()?;
                    if let Some(event) = outcome {
                        return Ok(event);
                    }
                }
                Some(Ok(Event::Paste(text))) => {
                    self.buffer.insert(&text);
                    self.render()?;
                }
                Some(Ok(Event::Resize(_, _))) => self.refresh()?,
                Some(Ok(_)) => {}
                Some(Err(error)) => return Err(error.into()),
                None => return Err(anyhow::anyhow!("terminal input stream closed")),
            }
        }
    }

    /// Repaint after output, or update the status label. Does not consume input.
    pub fn refresh(&mut self) -> Result<()> {
        let (width, height) = crossterm::terminal::size()?;
        if width < 12 || height < 5 {
            // Keep the input stream alive: the next resize event can restore
            // the footer when the terminal grows again.
            self.release_region()?;
        } else if self.input.is_some() {
            if self.height != Some(height) {
                self.release_region()?;
                self.install_region(height)?;
            }
            self.render()?;
        }
        Ok(())
    }

    pub fn set_status(&mut self, status: &str) -> Result<()> {
        // Never emit untrusted control bytes into the footer.
        self.status = status
            .chars()
            .filter(|ch| !ch.is_control() && *ch != '\u{1b}')
            .collect();
        self.refresh()
    }

    /// Tab-complete a `/command` in the draft; repeats cycle the matches.
    fn complete(&mut self) {
        if let Some(next) = completion_cycle(&self.buffer.text, self.completion.as_ref()) {
            self.buffer.set_text(&next.shown);
            self.completion = Some(next);
        }
    }

    /// End raw input and restore the full scroll region before modal prompts.
    /// Draft and already queued messages survive suspension.
    pub fn suspend(&mut self) -> Result<()> {
        if self.input.is_none() && self.height.is_none() {
            return Ok(());
        }
        self.input.take(); // Drop the reader (and wake its background polling thread) first.
        self.release_region()?;
        disable_raw_mode()?;
        Ok(())
    }

    pub fn resume(&mut self) -> Result<()> {
        if self.input.is_some() {
            return Ok(());
        }
        let (width, height) = crossterm::terminal::size()?;
        if width < 12 || height < 5 {
            return Ok(());
        }
        enable_raw_mode()?;
        // Undo raw mode on a failure to establish the output region.
        if let Err(error) = self.install_region(height) {
            let _ = disable_raw_mode();
            return Err(error);
        }
        self.input = Some(EventStream::new());
        self.render()?;
        Ok(())
    }

    pub fn set_draft(&mut self, text: &str) -> Result<()> {
        self.buffer.text.clear();
        self.buffer.cursor = 0;
        self.buffer.insert(text);
        self.render()
    }

    pub fn take_draft(&mut self) -> String {
        self.buffer.cursor = 0;
        std::mem::take(&mut self.buffer.text)
    }

    fn install_region(&mut self, height: u16) -> Result<()> {
        let last = height - 2;
        // Anchor streamed output right after the transcript instead of the
        // screen bottom, so a short session does not open a tall blank gap.
        // On Windows this reads the console cursor without touching stdin.
        let current = cursor::position()
            .map(|(_, row)| row.saturating_add(1))
            .unwrap_or(last);
        let anchor = current.clamp(1, last);
        let mut out = io::stdout().lock();
        // Keep two rows fixed: metrics above, editable draft below. Agent output
        // scrolls exclusively in rows 1..height-2.
        write!(
            out,
            "\x1b[?25l\x1b[1;{}r\x1b[{};1H\x1b[2K\x1b[{};1H\x1b[2K\x1b[{};1H",
            last,
            height - 1,
            height,
            anchor
        )?;
        crossterm::execute!(out, EnableBracketedPaste)?;
        out.flush()?;
        self.height = Some(height);
        Ok(())
    }

    fn release_region(&mut self) -> Result<()> {
        if let Some(height) = self.height.take() {
            let mut out = io::stdout().lock();
            crossterm::execute!(out, DisableBracketedPaste)?;
            // Reset the region and clear both footer rows, restoring the
            // streaming cursor so the following output continues in place.
            write!(
                out,
                "\x1b7\x1b[r\x1b[{};1H\x1b[2K\x1b[{};1H\x1b[2K\x1b8\x1b[?25h",
                height - 1,
                height
            )?;
            out.flush()?;
        }
        Ok(())
    }

    fn render(&self) -> Result<()> {
        let Some(height) = self.height else {
            return Ok(());
        };
        let (width, _) = crossterm::terminal::size()?;
        let columns = usize::from(width.saturating_sub(1));
        let label = "  >  ";
        let available = columns.saturating_sub(UnicodeWidthStr::width(label));
        let (before_cursor, at_cursor) = self.buffer.text.split_at(self.buffer.cursor);
        let left = display_text(before_cursor);
        let right = display_text(at_cursor);
        let offset = left
            .graphemes(true)
            .rev()
            .scan(0usize, |total, g| {
                let w = UnicodeWidthStr::width(g);
                if *total + w > available.saturating_sub(1) {
                    None
                } else {
                    *total += w;
                    Some(w)
                }
            })
            .sum::<usize>();
        let left_visible = suffix_cells(&left, offset);
        let remaining = available.saturating_sub(UnicodeWidthStr::width(left_visible.as_str()));
        let right_visible = trim_cells(&right, remaining);
        let (caret, after_caret) = if right_visible.is_empty() {
            (" ", "")
        } else {
            let grapheme = right_visible.graphemes(true).next().unwrap_or(" ");
            let rest = right_visible.strip_prefix(grapheme).unwrap_or("");
            (grapheme, rest)
        };
        let mut out = io::stdout().lock();
        // Save/restore the streaming cursor while holding stdout's process-wide lock.
        let status = match command_suggestions(&self.buffer.text) {
            Some(suggestions) => trim_cells(&suggestions, columns),
            None => trim_cells(&format!("  {}", self.status), columns),
        };
        write!(
            out,
            "\x1b7\x1b[{};1H\x1b[2K{}\x1b[{};1H\x1b[2K{}{}\x1b[7m{}\x1b[27m{}\x1b8",
            height - 1,
            status,
            height,
            label,
            left_visible,
            caret,
            after_caret
        )?;
        // Do not move the real cursor to the footer: arbitrary streamed println!
        // calls would then paint over the draft instead of scrolling above it.
        out.flush()?;
        Ok(())
    }
}

impl Drop for Composer {
    fn drop(&mut self) {
        let _ = self.suspend();
    }
}

fn display_text(text: &str) -> String {
    text.chars()
        .map(|ch| {
            if ch == '\n' {
                '↵'
            } else if ch.is_control() {
                ' '
            } else {
                ch
            }
        })
        .collect()
}

fn trim_cells(text: &str, max: usize) -> String {
    let mut total = 0;
    let mut rendered = String::new();
    for g in text.graphemes(true) {
        let w = UnicodeWidthStr::width(g);
        if total + w > max {
            break;
        }
        total += w;
        rendered.push_str(g);
    }
    rendered
}

fn suffix_cells(text: &str, max: usize) -> String {
    let mut total = 0;
    let mut visible = Vec::new();
    for g in text.graphemes(true).rev() {
        let w = UnicodeWidthStr::width(g);
        if total + w > max {
            break;
        }
        total += w;
        visible.push(g);
    }
    visible.into_iter().rev().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    #[test]
    fn editing_graphemes_and_navigation() {
        let mut b = EditBuffer::default();
        b.insert("a👩‍💻é");
        b.handle_key(key(KeyCode::Left));
        b.handle_key(key(KeyCode::Backspace));
        assert_eq!(b.text, "aé");
        assert_eq!(b.cursor, 1);
        b.insert("中");
        b.handle_key(key(KeyCode::Delete));
        assert_eq!(b.text, "a中");
        b.handle_key(key(KeyCode::Home));
        b.handle_key(key(KeyCode::Right));
        assert_eq!(b.cursor, 1);
    }

    #[test]
    fn queue_is_fifo_and_empty_enter_does_not_submit() {
        let mut b = EditBuffer::default();
        b.handle_key(key(KeyCode::Enter));
        b.insert("first");
        b.handle_key(key(KeyCode::Enter));
        b.insert("second");
        b.handle_key(key(KeyCode::Enter));
        assert_eq!(b.pop(), Some(ComposerEvent::Submitted("first".into())));
        assert_eq!(b.pop(), Some(ComposerEvent::Submitted("second".into())));
        assert_eq!(b.pop(), None);
        assert!(b.text.is_empty());
    }

    #[test]
    fn paste_newlines_preserved_without_auto_submit() {
        let mut b = EditBuffer::default();
        b.insert("one\r\ntwo\rthree\nfour");
        assert_eq!(b.text, "one\ntwo\nthree\nfour");
        assert_eq!(b.pop(), None);
        b.handle_key(key(KeyCode::Enter));
        assert_eq!(
            b.pop(),
            Some(ComposerEvent::Submitted("one\ntwo\nthree\nfour".into()))
        );
    }

    #[test]
    fn ctrl_c_clears_draft_then_cancels() {
        let mut b = EditBuffer::default();
        b.insert("draft");
        let ctrl_c = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert_eq!(b.handle_key(ctrl_c), None);
        assert!(b.text.is_empty());
        assert_eq!(b.handle_key(ctrl_c), Some(ComposerEvent::Cancel));
    }

    #[test]
    fn display_is_cell_bounded() {
        assert_eq!(trim_cells("中a👩‍💻x", 5), "中a👩‍💻");
        assert_eq!(suffix_cells("中ab", 2), "ab");
        assert_eq!(display_text("a\nb"), "a↵b");


    }

    #[test]
    fn history_restores_draft_and_walks_entries() {
        let mut history = History::default();
        let mut buffer = EditBuffer::default();
        history.commit("one");
        history.commit("two");
        buffer.insert("draft");
        assert!(history.previous(&mut buffer));
        assert_eq!(buffer.text, "two");
        assert!(history.previous(&mut buffer));
        assert_eq!(buffer.text, "one");
        assert!(!history.previous(&mut buffer));
        assert!(history.next(&mut buffer));
        assert_eq!(buffer.text, "two");
        assert!(history.next(&mut buffer));
        assert_eq!(buffer.text, "draft");
        assert!(!history.next(&mut buffer));
    }

    #[test]
    fn tab_completion_cycles_prefix_matches() {
        let mut completion = None;
        for expected in ["/clear", "/compact", "/ctx", "/clear"] {
            let text = completion
                .as_ref()
                .map(|last: &Completion| last.shown.clone())
                .unwrap_or_else(|| "/c".to_string());
            let next = completion_cycle(&text, completion.as_ref()).unwrap();
            assert_eq!(next.shown, expected);
            completion = Some(next);
        }
        assert!(completion_cycle("plain", None).is_none());
        assert!(completion_cycle("/x", None).is_none());
    }

    #[test]
    fn draft_command_lists_suggestions_in_the_status_row() {
        let all = command_suggestions("/").expect("bare slash lists every command");
        assert!(all.contains("/clear"));
        assert!(all.contains("/usage"));
        let narrowed = command_suggestions("/mo").expect("typing narrows the menu");
        assert!(narrowed.contains("/mode"));
        assert!(narrowed.contains("/model"));
        assert!(!narrowed.contains("/clear"));
        assert!(command_suggestions("/usage").is_none());
        // `/mode` is a prefix of `/model`, so the longer command stays offered.
        assert_eq!(command_suggestions("/mode").as_deref(), Some("  /model"));
        assert!(command_suggestions("/mode x").is_none());
        assert!(command_suggestions("plain").is_none());
    }
}

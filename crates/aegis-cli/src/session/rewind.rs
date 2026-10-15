//! Rewind picker: choose one of the user turns the model can still see.
//!
//! The conversation logic — which turns are rewindable, how a "n turns back"
//! request resolves, how the tail is hidden — lives in
//! `aegis::conversation::rewind`, shared with the ACP server's
//! `_aegis/unstable/session/rewind`. Only the interactive picker is CLI-only.

pub(super) use aegis::conversation::rewind::{collect_turns, resolve_back, Turn as RewindTurn};

/// Interactive picker, newest first; returns the picked turn's stored index.
/// Esc (or a real interruption) cancels.
pub(super) fn pick_turn(turns: &[RewindTurn], total_messages: usize) -> Option<usize> {
    let items: Vec<(usize, String, String)> = turns
        .iter()
        .rev()
        .map(|turn| {
            (
                turn.message_index,
                turn.preview.clone(),
                format!("hides {} message(s)", total_messages - turn.message_index),
            )
        })
        .collect();
    cliclack::select("Rewind to an earlier turn")
        .items(&items)
        .max_rows(15)
        .filter_mode()
        .interact()
        .ok()
}

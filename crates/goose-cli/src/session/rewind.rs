//! Rewind: hand the agent back to an earlier point in the conversation.
//!
//! Nothing is deleted. Every message from the chosen turn onwards gets marked
//! `agent_visible = false` — the same visibility mechanics the compaction
//! pipeline uses for replaced history — so the transcript stays intact for the
//! user while the model stops seeing the tail. The chosen turn's text comes
//! back so the prompt can be prefilled for editing and resending.

use goose::conversation::message::{Message, MessageContent};
use goose::conversation::Conversation;
use goose::utils::safe_truncate;
use rmcp::model::Role;

/// A rewindable user turn: where it sits in the stored conversation, a
/// one-line preview for the picker, and the full text for the prompt prefill.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct RewindTurn {
    pub message_index: usize,
    pub preview: String,
    pub text: String,
}

/// Whether a stored message is a turn the user can rewind to: a plain text
/// message from the user that the agent can currently see. Tool traffic,
/// turn-context events, agent-invisible messages and unpersisted messages
/// are not turns.
fn is_rewindable_turn(message: &Message) -> bool {
    message.role == Role::User
        && message.id.is_some()
        && message.is_agent_visible()
        && !message.metadata.turn_context
        && message
            .content
            .iter()
            .any(|block| matches!(block, MessageContent::Text(_)))
        && !message.content.iter().any(|block| {
            matches!(
                block,
                MessageContent::ToolResponse(_) | MessageContent::ToolConfirmationRequest(_)
            )
        })
}

/// First non-empty text block, whitespace collapsed to a single line.
fn first_text(message: &Message) -> Option<String> {
    message.content.iter().find_map(|block| match block {
        MessageContent::Text(text) => {
            let collapsed = text
                .text
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            (!collapsed.is_empty()).then_some(collapsed)
        }
        _ => None,
    })
}

/// The user turns the model can currently see, oldest first, with the stored
/// conversation index each one sits at.
pub(super) fn collect_turns(conversation: &Conversation) -> Vec<RewindTurn> {
    conversation
        .messages()
        .iter()
        .enumerate()
        .filter(|(_, message)| is_rewindable_turn(message))
        .filter_map(|(message_index, message)| {
            let text = first_text(message)?;
            Some(RewindTurn {
                message_index,
                preview: safe_truncate(&text, 72),
                text,
            })
        })
        .collect()
}

/// The stored index of the turn `back` positions from the end (1 = last).
pub(super) fn resolve_back(turns: &[RewindTurn], back: usize) -> Option<usize> {
    (back >= 1 && back <= turns.len()).then(|| turns[turns.len() - back].message_index)
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::model::CallToolResult;

    fn user_with_id(id: &str, text: &str) -> Message {
        let mut message = Message::user().with_text(text);
        message.id = Some(id.to_string());
        message
    }

    #[test]
    fn collects_only_plain_agent_visible_user_turns() {
        let already_rewound = user_with_id("u0", "already compacted").with_visibility(true, false);
        let never_persisted = Message::user().with_text("never persisted");
        let assistant = {
            let mut message = Message::assistant().with_text("reply");
            message.id = Some("a1".into());
            message
        };
        let tool_traffic = {
            let result = CallToolResult::success(Vec::<rmcp::model::ContentBlock>::new());
            let mut message = Message::new(
                Role::User,
                0,
                vec![MessageContent::tool_response("call_1", Ok(result))],
            );
            message.id = Some("t1".into());
            message
        };
        let turn_context = {
            let mut message = user_with_id("u2", "context event");
            message.metadata.turn_context = true;
            message
        };
        let blank = user_with_id("u3", "   ");
        let real = user_with_id("u4", "fix the login bug");
        let conversation = Conversation::new_unvalidated(vec![
            already_rewound,
            never_persisted,
            assistant,
            tool_traffic,
            turn_context,
            blank,
            real,
        ]);

        let turns = collect_turns(&conversation);
        assert_eq!(
            turns.len(),
            1,
            "only the plain persisted user turn qualifies: {turns:?}"
        );
        assert_eq!(turns[0].message_index, 6);
        assert_eq!(turns[0].text, "fix the login bug");
    }

    #[test]
    fn previews_collapse_whitespace_and_truncate() {
        let long = user_with_id("u1", &format!("line one\nline two {}", "x".repeat(200)));
        let conversation = Conversation::new_unvalidated(vec![long]);
        let turns = collect_turns(&conversation);
        assert_eq!(turns.len(), 1);
        assert!(turns[0].preview.starts_with("line one line two"));
        assert!(turns[0].preview.ends_with("..."));
        assert!(turns[0].preview.chars().count() <= 72);
    }

    #[test]
    fn resolve_back_is_one_based_from_the_end() {
        let turns = vec![
            RewindTurn {
                message_index: 0,
                preview: "a".into(),
                text: "a".into(),
            },
            RewindTurn {
                message_index: 4,
                preview: "b".into(),
                text: "b".into(),
            },
            RewindTurn {
                message_index: 9,
                preview: "c".into(),
                text: "c".into(),
            },
        ];
        assert_eq!(resolve_back(&turns, 1), Some(9));
        assert_eq!(resolve_back(&turns, 3), Some(0));
        assert_eq!(resolve_back(&turns, 4), None);
    }
}

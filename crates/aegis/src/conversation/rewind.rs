//! Rewind: hand the agent back to an earlier point in the conversation.
//!
//! Nothing is deleted. Every message from the chosen turn onwards gets marked
//! `agent_visible = false` — the same visibility mechanics the compaction
//! pipeline uses for replaced history — so the transcript stays intact for the
//! user while the model stops seeing the tail. The chosen turn's text comes
//! back so a client can prefill its prompt for editing and resending.
//!
//! This module holds the conversation logic only: which turns are rewindable,
//! how a "n turns back" request resolves, and how the tail is hidden. The CLI
//! drives it from `/rewind` and `/undo`, the ACP server from
//! `_aegis/unstable/session/rewind`.

use crate::conversation::message::{Message, MessageContent};
use crate::conversation::Conversation;
use crate::session::session_manager::SessionManager;
use crate::utils::safe_truncate;
use anyhow::Result;
use rmcp::model::Role;

/// Longest turn preview kept for pickers, in characters.
pub const PREVIEW_CHARS: usize = 72;

/// A rewindable user turn: where it sits in the stored conversation, the id of
/// the stored message, a one-line preview, and the full text for a prefill.
#[derive(Debug, Clone, PartialEq)]
pub struct Turn {
    pub message_index: usize,
    pub message_id: String,
    pub preview: String,
    pub text: String,
}

/// Whether a stored message is a turn the user can rewind to: a plain text
/// message from the user that the agent can currently see. Tool traffic,
/// turn-context events, agent-invisible messages and unpersisted messages are
/// not turns.
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
            let collapsed = text.text.split_whitespace().collect::<Vec<_>>().join(" ");
            (!collapsed.is_empty()).then_some(collapsed)
        }
        _ => None,
    })
}

/// The user turns the model can currently see, oldest first, with the stored
/// conversation index and message id each one carries.
pub fn collect_turns(conversation: &Conversation) -> Vec<Turn> {
    conversation
        .messages()
        .iter()
        .enumerate()
        .filter(|(_, message)| is_rewindable_turn(message))
        .filter_map(|(message_index, message)| {
            let text = first_text(message)?;
            Some(Turn {
                message_index,
                message_id: message.id.clone().unwrap_or_default(),
                preview: safe_truncate(&text, PREVIEW_CHARS),
                text,
            })
        })
        .collect()
}

/// Flip `agent_visible` back on for every stored message after the last visible
/// one, and return how many returned. This is the inverse of [`hide_tail_from`]:
/// it can only restore a rewound tail, never compacted history, because
/// compaction hides messages before the last visible message, not after it.
///
/// Turn-context events are skipped: they are agent-only by design and must stay
/// out of the user's transcript.
pub async fn show_tail_after_last_visible(
    session_manager: &SessionManager,
    session_id: &str,
    conversation: &Conversation,
) -> Result<usize> {
    let messages = conversation.messages();
    let Some(last_visible) = messages
        .iter()
        .rposition(|message| message.is_agent_visible() && !message.metadata.turn_context)
    else {
        return Ok(0);
    };

    let mut restored = 0usize;
    for message in messages.iter().skip(last_visible + 1) {
        if message.is_agent_visible() || message.metadata.turn_context {
            continue;
        }
        if let Some(message_id) = message.id.as_deref() {
            session_manager
                .update_message_metadata(session_id, message_id, |mut metadata| {
                    metadata.agent_visible = true;
                    metadata
                })
                .await?;
            restored += 1;
        }
    }
    Ok(restored)
}

/// The stored index of the turn `back` positions from the end (1 = last).
pub fn resolve_back(turns: &[Turn], back: usize) -> Option<usize> {
    (back >= 1 && back <= turns.len()).then(|| turns[turns.len() - back].message_index)
}

/// Flip `agent_visible` off for every stored message from `from_index` on, and
/// return how many the model stopped seeing.
pub async fn hide_tail_from(
    session_manager: &SessionManager,
    session_id: &str,
    conversation: &Conversation,
    from_index: usize,
) -> Result<usize> {
    let mut hidden = 0usize;
    for message in conversation.messages().iter().skip(from_index) {
        if !message.is_agent_visible() {
            continue;
        }
        if let Some(message_id) = message.id.as_deref() {
            session_manager
                .update_message_metadata(session_id, message_id, |mut metadata| {
                    metadata.agent_visible = false;
                    metadata
                })
                .await?;
        }
        hidden += 1;
    }
    Ok(hidden)
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
        assert_eq!(turns[0].message_id, "u4");
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
        assert!(turns[0].preview.chars().count() <= PREVIEW_CHARS);
    }

    #[test]
    fn resolve_back_is_one_based_from_the_end() {
        let turns = vec![
            Turn {
                message_index: 0,
                message_id: "a".into(),
                preview: "a".into(),
                text: "a".into(),
            },
            Turn {
                message_index: 4,
                message_id: "b".into(),
                preview: "b".into(),
                text: "b".into(),
            },
            Turn {
                message_index: 9,
                message_id: "c".into(),
                preview: "c".into(),
                text: "c".into(),
            },
        ];
        assert_eq!(resolve_back(&turns, 1), Some(9));
        assert_eq!(resolve_back(&turns, 3), Some(0));
        assert_eq!(resolve_back(&turns, 4), None);
        assert_eq!(resolve_back(&turns, 0), None);
    }
}

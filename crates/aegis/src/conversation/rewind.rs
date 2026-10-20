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

use crate::conversation::message::{Message, MessageContent, MessageMetadata};
use crate::conversation::Conversation;
use crate::session::session_manager::SessionManager;
use crate::utils::safe_truncate;
use anyhow::{Context, Result};
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

const REWIND_OPERATION: &str = "rewind";
const BATCH_KEY: &str = "batch";

fn rewind_batch(metadata: &MessageMetadata) -> Option<&str> {
    metadata
        .operation_note(REWIND_OPERATION, BATCH_KEY)?
        .as_str()
}

fn restore_indices(messages: &[Message]) -> Vec<usize> {
    let start = messages
        .iter()
        .rposition(|message| message.is_agent_visible() && !message.metadata.turn_context)
        .map_or(0, |index| index + 1);
    let Some(batch) = messages[start..]
        .iter()
        .find_map(|message| rewind_batch(&message.metadata))
    else {
        return Vec::new();
    };
    messages
        .iter()
        .enumerate()
        .skip(start)
        .filter(|(_, message)| {
            !message.is_agent_visible()
                && message.id.is_some()
                && rewind_batch(&message.metadata) == Some(batch)
        })
        .map(|(index, _)| index)
        .collect()
}

/// Restore only the newest reachable rewind batch, never unmarked messages
/// hidden by compaction or another operation. Also works when the first user
/// turn was rewound and no visible messages remain.
pub async fn show_tail_after_last_visible(
    session_manager: &SessionManager,
    session_id: &str,
    conversation: &Conversation,
) -> Result<usize> {
    let messages = conversation.messages();
    let indices = restore_indices(messages);
    let mut restored: Vec<&Message> = Vec::new();
    for index in indices {
        let message_id = messages[index]
            .id
            .as_deref()
            .expect("selected persisted message");
        let result = session_manager
            .update_message_metadata(session_id, message_id, |mut metadata| {
                metadata.agent_visible = true;
                if let Some(operations) = metadata.operations.as_mut() {
                    operations.remove(REWIND_OPERATION);
                }
                metadata
            })
            .await;
        if let Err(error) = result {
            for prior in restored.iter().rev() {
                let id = prior.id.as_deref().expect("persisted message");
                session_manager
                    .update_message_metadata(session_id, id, |mut metadata| {
                        metadata.agent_visible = false;
                        metadata.operations = prior.metadata.operations.clone();
                        metadata
                    })
                    .await
                    .context("Failed to roll back partial unrewind")?;
            }
            return Err(error);
        }
        restored.push(&messages[index]);
    }
    Ok(restored.len())
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
    let batch = uuid::Uuid::new_v4().to_string();
    let mut hidden: Vec<&Message> = Vec::new();
    for message in conversation.messages().iter().skip(from_index) {
        if !message.is_agent_visible() {
            continue;
        }
        let Some(message_id) = message.id.as_deref() else {
            continue;
        };
        let result = session_manager
            .update_message_metadata(session_id, message_id, |mut metadata| {
                metadata.agent_visible = false;
                metadata.set_operation_note(REWIND_OPERATION, BATCH_KEY, serde_json::json!(batch));
                metadata
            })
            .await;
        if let Err(error) = result {
            for prior in hidden.iter().rev() {
                let id = prior.id.as_deref().expect("persisted message");
                session_manager
                    .update_message_metadata(session_id, id, |mut metadata| {
                        metadata.agent_visible = true;
                        metadata.operations = prior.metadata.operations.clone();
                        metadata
                    })
                    .await
                    .context("Failed to roll back partial rewind")?;
            }
            return Err(error);
        }
        hidden.push(message);
    }
    Ok(hidden.len())
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

    fn tagged(mut message: Message, batch: &str) -> Message {
        message.metadata.agent_visible = false;
        message
            .metadata
            .set_operation_note(REWIND_OPERATION, BATCH_KEY, serde_json::json!(batch));
        message
    }

    #[test]
    fn unrewind_selects_only_latest_reachable_batch() {
        let visible = user_with_id("u1", "first");
        let old_compacted = user_with_id("c", "compacted").with_visibility(true, false);
        let second = tagged(user_with_id("u2", "second"), "rewind-two");
        let third = tagged(user_with_id("u3", "third"), "rewind-three");
        let never_visible = user_with_id("hidden", "user only").with_visibility(true, false);
        let conversation = vec![old_compacted, visible, second.clone(), third, never_visible];
        assert_eq!(restore_indices(&conversation), vec![2]);
        let mut restored = conversation;
        restored[2].metadata.agent_visible = true;
        restored[2].metadata.operations = None;
        assert_eq!(restore_indices(&restored), vec![3]);
    }

    #[test]
    fn unrewind_first_turn_ignores_compaction_and_turn_context() {
        let compacted = user_with_id("old", "old").with_visibility(true, false);
        let turn = tagged(user_with_id("u1", "first"), "first-batch");
        let mut context = tagged(user_with_id("context", "context"), "first-batch");
        context.metadata.turn_context = true;
        let unrelated = user_with_id("other", "hidden").with_visibility(true, false);
        assert_eq!(
            restore_indices(&[compacted, turn, context, unrelated]),
            vec![1, 2]
        );
        assert!(
            restore_indices(&[user_with_id("old", "old").with_visibility(true, false)]).is_empty()
        );
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

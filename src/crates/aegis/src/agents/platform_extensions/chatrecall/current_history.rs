use crate::conversation::Conversation;
use aegis_context_management::format_message_for_compacting;

fn searchable_messages(conversation: &Conversation) -> impl Iterator<Item = (String, String)> + '_ {
    conversation.messages().iter().filter_map(|message| {
        if message.is_turn_context()
            || !(message.metadata.user_visible || message.is_tool_response())
        {
            return None;
        }
        let projected = message.agent_visible_content();
        if projected.content.is_empty() {
            return None;
        }
        let id = message.id.as_ref()?.clone();
        Some((id, format_message_for_compacting(&projected)))
    })
}

fn slice_chars(text: &str, start: usize, length: usize) -> String {
    text.chars().skip(start).take(length).collect()
}

pub(super) fn retrieve(
    conversation: &Conversation,
    query: Option<&str>,
    message_id: Option<&str>,
    limit: usize,
    offset: usize,
    max_chars: usize,
) -> Result<String, String> {
    let max_chars = max_chars.clamp(1, 12_000);
    if let Some(id) = message_id {
        let (_, text) = searchable_messages(conversation)
            .find(|(candidate, _)| candidate == id)
            .ok_or_else(|| format!("Message {id} not found in the current session"))?;
        let total = text.chars().count();
        if offset >= total {
            return Err(format!("Offset {offset} exceeds message length {total}"));
        }
        let end = offset.saturating_add(max_chars).min(total);
        return Ok(format!(
            "Current session message {id}, characters {offset}..{end}/{total}\n{}\nNext offset: {}",
            slice_chars(&text, offset, max_chars),
            if end < total {
                end.to_string()
            } else {
                "none".to_string()
            }
        ));
    }

    let terms: Vec<String> = query
        .unwrap_or_default()
        .split_whitespace()
        .map(str::to_lowercase)
        .collect();
    if terms.is_empty() {
        return Err("Supply query or message_id for current-session recall".to_string());
    }
    let mut matches = Vec::new();
    for (id, text) in searchable_messages(conversation) {
        let folded = text.to_lowercase();
        if terms.iter().all(|term| folded.contains(term)) {
            let preview = slice_chars(&text, 0, max_chars.min(900));
            let length = text.chars().count();
            matches.push(format!("Message ID: {id} ({length} chars)\n{preview}"));
        }
    }
    matches.reverse();
    let total = matches.len();
    let count = limit.clamp(1, 20).min(total);
    let mut output = format!(
        "Current session: {total} matching messages. Showing {count} newest. Use message_id to fetch exact text and offset to page through it.\n"
    );
    for item in matches.into_iter().take(count) {
        output.push('\n');
        output.push_str(&item);
        output.push('\n');
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conversation::message::{Message, MessageContent, MessageMetadata};
    use rmcp::model::{Annotations, Role, TextContent};

    #[test]
    fn compacted_original_is_searchable_and_paged_without_user_only_blocks() {
        let mut original = Message::user()
            .with_text("Decisión final: no publicar 🦀; conserva este detalle histórico.")
            .with_content(MessageContent::Text(
                TextContent::new("solo usuario")
                    .with_annotations(Annotations::default().with_audience(vec![Role::User])),
            ))
            .with_metadata(MessageMetadata::user_only());
        original.id = Some("original-42".to_string());
        let conversation = Conversation::new_unvalidated(vec![original]);
        let found = retrieve(&conversation, Some("publicar"), None, 10, 0, 100).unwrap();
        assert!(found.contains("original-42"));
        assert!(!found.contains("solo usuario"));
        let first = retrieve(&conversation, None, Some("original-42"), 10, 0, 26).unwrap();
        assert!(first.contains("Next offset: 26"));
        let next = retrieve(&conversation, None, Some("original-42"), 10, 26, 100).unwrap();
        assert!(next.contains("🦀"));
        assert!(retrieve(&conversation, None, Some("missing"), 10, 0, 100).is_err());
    }
}

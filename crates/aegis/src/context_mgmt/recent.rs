use crate::conversation::message::{Message, MessageContent};
use crate::token_counter::create_token_counter;
use anyhow::Result;
use rmcp::model::Role;

pub(super) async fn recent_start(
    messages: &[Message],
    context_limit: usize,
) -> Result<Option<usize>> {
    // Proportional to the window: a flat 32k cap threw away verbatim turns a large
    // window can afford to keep, and the prompt cache already paid for them.
    let budget = (context_limit / 8).min(128_000);
    if budget == 0 {
        return Ok(None);
    }
    let counter = create_token_counter().await.map_err(anyhow::Error::msg)?;
    let mut used = 0usize;
    let mut start = None;
    for (index, message) in messages.iter().enumerate().rev() {
        if !message.is_agent_visible() || message.is_turn_context() {
            continue;
        }
        let projected = message.agent_visible_content();
        let tokens = counter.count_chat_tokens("", std::slice::from_ref(&projected), &[]);
        if used.saturating_add(tokens) > budget {
            break;
        }
        used += tokens;
        if index > 0
            && message.role == Role::User
            && !message.is_tool_response()
            && !message.is_tool_call()
            && projected
                .content
                .iter()
                .any(|part| matches!(part, MessageContent::Text(_)))
        {
            start = Some(index);
        }
    }
    Ok(start.filter(|&index| messages[..index].iter().any(Message::is_agent_visible)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn keeps_complete_recent_turns_and_not_an_orphan_tool_response() {
        let messages = vec![
            Message::user().with_text("ancient request"),
            Message::assistant().with_text("ancient result"),
            Message::user().with_text("latest user request"),
            Message::assistant().with_text("latest response"),
        ];
        assert_eq!(recent_start(&messages, 128_000).await.unwrap(), Some(2));
        assert_eq!(recent_start(&messages, 16).await.unwrap(), None);
    }
}

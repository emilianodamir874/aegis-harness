mod recent;

pub use aegis_context_management::structured;

use crate::conversation::message::{Message, MessageContent};
use crate::conversation::message::{MessageMetadata, MessageUsage};
use crate::conversation::{merge_consecutive_messages, Conversation};
use crate::providers::base::Provider;
#[cfg(test)]
use crate::providers::base::{stream_from_single_message, MessageStream};
use crate::{config::Config, token_counter::create_token_counter};
use aegis_providers::conversation::token_usage::ProviderUsage;
use aegis_providers::errors::ProviderError;
use aegis_providers::model::ModelConfig;
use anyhow::Result;
use indoc::indoc;
use rmcp::model::Role;
#[cfg(test)]
use rmcp::model::{Annotations, ContentBlock, TextContent};
use std::sync::Arc;
use tokio::task::JoinHandle;
use tracing::info;
use tracing::log::warn;

pub use aegis_context_management::DEFAULT_COMPACTION_THRESHOLD;

pub(crate) const TOOLCALL_SUMMARIZATION_BATCH_SIZE: usize = 10;

/// Optional per-process absolute cap for users who intentionally prefer early compaction.
/// Without an explicit cap, the model's own context window and threshold apply.
pub fn auto_compact_threshold(context_limit: usize) -> f64 {
    let config = Config::global();
    let threshold = config
        .get_param::<f64>("AEGIS_AUTO_COMPACT_THRESHOLD")
        .unwrap_or(DEFAULT_COMPACTION_THRESHOLD);
    if threshold <= 0.0 || threshold >= 1.0 || context_limit == 0 {
        return threshold;
    }
    config
        .get_param::<usize>("AEGIS_AUTO_COMPACT_TOKEN_LIMIT")
        .ok()
        .filter(|limit| *limit > 0)
        .map_or(threshold, |limit| {
            threshold.min(limit as f64 / context_limit as f64)
        })
}

pub(crate) fn tool_pair_summarization_enabled() -> bool {
    Config::global()
        .get_param::<bool>("AEGIS_TOOL_PAIR_SUMMARIZATION")
        .unwrap_or(false)
}

const CONVERSATION_CONTINUATION_TEXT: &str =
    "Your context was compacted. The previous message contains a summary of the conversation so far.
Do not mention that you read a summary or that conversation summarization occurred.
Recent turns may follow verbatim. If an older detail is needed, use chatrecall with current_session=true when available to retrieve the original message rather than guessing.
Just continue the conversation naturally based on the summarized context.";

const TOOL_LOOP_CONTINUATION_TEXT: &str =
    "Your context was compacted. The previous message contains a summary of the conversation so far.
Do not mention that you read a summary or that conversation summarization occurred.
Recent turns may follow verbatim. Retrieve missing older details through chatrecall current_session=true when available.
Continue calling tools as necessary to complete the task.";

const MANUAL_COMPACT_CONTINUATION_TEXT: &str =
    "Your context was compacted at the user's request. The previous message contains a summary of the conversation so far.
Do not mention that you read a summary or that conversation summarization occurred.
Recent turns may follow verbatim. If an older detail is needed, use chatrecall with current_session=true when available to retrieve the original message rather than guessing.
Just continue the conversation naturally based on the summarized context.";

pub struct CompactionResult {
    pub conversation: Conversation,
    /// Billable usage of the summarization call, counting the raw model
    /// output even when it is rewritten to the rendered structured summary.
    pub usage: ProviderUsage,
    /// Estimated tokens of the agent-visible context retained after
    /// compaction. Smaller than the billable output when the raw response was
    /// rewritten to the rendered structured summary.
    pub retained_context_tokens: i32,
}

/// Compact messages by summarizing them
///
/// This function performs the actual compaction by summarizing messages and updating
/// their visibility metadata. It does not check thresholds - use `check_if_compaction_needed`
/// first to determine if compaction is necessary.
///
/// # Arguments
/// * `provider` - The provider to use for summarization
/// * `session_id` - The session to use for summarization
/// * `conversation` - The current conversation history
/// * `manual_compact` - If true, this is a manual compaction (don't preserve user message)
pub async fn compact_messages(
    provider: &dyn Provider,
    model_config: &ModelConfig,
    session_id: &str,
    conversation: &Conversation,
    manual_compact: bool,
) -> Result<CompactionResult> {
    info!("Performing message compaction");

    let messages = conversation.messages();

    let has_text_only = |msg: &Message| {
        let has_text = msg
            .content
            .iter()
            .any(|c| matches!(c, MessageContent::Text(_)));
        let has_tool_content = msg.content.iter().any(|c| {
            matches!(
                c,
                MessageContent::ToolRequest(_) | MessageContent::ToolResponse(_)
            )
        });
        has_text && !has_tool_content
    };

    // Turn-context events are agent-appended, never the message to preserve.
    let (preserved_user_message, preserved_idx, is_most_recent) = if !manual_compact {
        let found_msg = messages.iter().enumerate().rev().find_map(|(idx, msg)| {
            if !msg.is_agent_visible()
                || msg.is_turn_context()
                || !matches!(msg.role, rmcp::model::Role::User)
            {
                return None;
            }

            let projected = msg.agent_visible_content();
            if !has_text_only(&projected) {
                return None;
            }

            let preserved = projected
                .content
                .into_iter()
                .filter(|content| matches!(content, MessageContent::Text(_)))
                .fold(
                    Message::user().with_metadata(MessageMetadata::agent_only()),
                    Message::with_content,
                );
            Some((idx, preserved))
        });

        if let Some((idx, msg)) = found_msg {
            let is_last = messages[idx + 1..].iter().all(Message::is_turn_context);
            (Some(msg), Some(idx), is_last)
        } else {
            (None, None, false)
        }
    } else {
        (None, None, false)
    };

    let messages_to_compact = messages.as_slice();
    let context_limit =
        crate::context_limit::get_context_limit(provider, &model_config.model_name).await?;
    let recent_start = recent::recent_start(messages_to_compact, context_limit).await?;
    let older_messages = recent_start
        .map(|index| &messages_to_compact[..index])
        .unwrap_or(messages_to_compact);

    let (summary_message, summarization_usage) =
        do_compact(provider, model_config, session_id, older_messages).await?;

    // Create the final message list with updated visibility metadata:
    // 1. Original messages become user_visible but not agent_visible
    // 2. Summary message becomes agent_visible but not user_visible
    // 3. Assistant messages to continue the conversation are also agent_visible but not user_visible
    let mut final_messages = Vec::new();

    for msg in messages_to_compact {
        let updated_metadata = msg.metadata.clone().with_agent_invisible();
        let updated_msg = msg.clone().with_metadata(updated_metadata);
        final_messages.push(updated_msg);
    }

    let summary_msg = summary_message.with_metadata(MessageMetadata::agent_only());

    let mut continuation_messages = vec![summary_msg];

    let continuation_text = if manual_compact {
        MANUAL_COMPACT_CONTINUATION_TEXT
    } else if is_most_recent {
        CONVERSATION_CONTINUATION_TEXT
    } else {
        TOOL_LOOP_CONTINUATION_TEXT
    };

    let continuation_msg = Message::assistant()
        .with_text(continuation_text)
        .with_metadata(MessageMetadata::agent_only());
    let continuation_created = continuation_msg.created;
    continuation_messages.push(continuation_msg);

    let (merged_continuation, _issues) = merge_consecutive_messages(continuation_messages);
    final_messages.extend(merged_continuation);
    if let Some(start) = recent_start {
        for message in &messages_to_compact[start..] {
            if message.is_agent_visible() && !message.is_turn_context() {
                let mut replay = message.agent_visible_content().with_visibility(false, true);
                replay.id = None;
                replay.created = continuation_created;
                final_messages.push(replay);
            }
        }
    }

    if let Some(mut user_msg) = preserved_user_message {
        if !preserved_idx.is_some_and(|index| recent_start.is_some_and(|start| index >= start)) {
            user_msg.created = continuation_created;
            final_messages.push(user_msg);
        }
    }

    // Carry the turn's own context event (it follows the preserved prompt) so
    // a mid-turn retry keeps it; anything earlier belongs to a previous turn.
    if let Some(carry_from) = preserved_idx.map(|idx| idx + 1) {
        if let Some(turn_context) = messages_to_compact[carry_from..]
            .iter()
            .rev()
            .find(|msg| msg.is_turn_context() && msg.is_agent_visible())
        {
            let mut carried = turn_context.clone();
            carried.id = None;
            // Storage reloads order by created_timestamp; the copy must keep
            // its appended position, not resurface at the original event's time.
            if let Some(latest) = final_messages.iter().map(|msg| msg.created).max() {
                carried.created = carried.created.max(latest);
            }
            final_messages.push(carried);
        }
    }

    let conversation = Conversation::new_unvalidated(final_messages);
    let retained_context_tokens = match count_context_tokens(conversation.messages()).await {
        Ok(tokens) => tokens,
        Err(error) => {
            warn!("Failed to count retained context tokens, using billable output tokens: {error}");
            summarization_usage.usage.output_tokens.unwrap_or(0)
        }
    };

    Ok(CompactionResult {
        conversation,
        usage: summarization_usage,
        retained_context_tokens,
    })
}

/// Estimate the tokens of the agent-visible messages, counted the same way
/// as the fallback estimation in `check_if_compaction_needed`.
pub(crate) async fn count_context_tokens(messages: &[Message]) -> Result<i32> {
    let counter = create_token_counter()
        .await
        .map_err(|error| anyhow::anyhow!("Failed to create token counter: {error}"))?;
    let total: usize = messages
        .iter()
        .filter(|message| message.is_agent_visible())
        .map(|message| counter.count_chat_tokens("", std::slice::from_ref(message), &[]))
        .sum();
    Ok(total.try_into()?)
}

/// Check if messages exceed the auto-compaction threshold
pub async fn check_if_compaction_needed(
    provider: &dyn Provider,
    conversation: &Conversation,
    threshold_override: Option<f64>,
    session: &crate::session::Session,
) -> Result<bool> {
    if provider.manages_own_context() {
        return Ok(false);
    }

    let messages = conversation.messages();
    let config = Config::global();
    let threshold = threshold_override.unwrap_or_else(|| {
        config
            .get_param::<f64>("AEGIS_AUTO_COMPACT_THRESHOLD")
            .unwrap_or(DEFAULT_COMPACTION_THRESHOLD)
    });

    let model_config = session
        .model_config
        .clone()
        .unwrap_or_else(|| ModelConfig::new("unknown"));
    let context_limit =
        crate::context_limit::get_context_limit(provider, &model_config.model_name).await?;

    let (current_tokens, _token_source) = match session.usage.total_tokens {
        Some(tokens) => (tokens as usize, "session metadata"),
        None => {
            let token_counter = create_token_counter()
                .await
                .map_err(|e| anyhow::anyhow!("Failed to create token counter: {}", e))?;

            let token_counts: Vec<_> = messages
                .iter()
                .filter(|m| m.is_agent_visible())
                .map(|msg| token_counter.count_chat_tokens("", std::slice::from_ref(msg), &[]))
                .collect();

            (token_counts.iter().sum(), "estimated")
        }
    };

    let usage_ratio = current_tokens as f64 / context_limit as f64;

    let needs_compaction = if threshold <= 0.0 || threshold >= 1.0 {
        false // Auto-compact is disabled.
    } else {
        usage_ratio > threshold
    };
    Ok(needs_compaction)
}

struct AegisCompactionModel<'a> {
    provider: &'a dyn Provider,
    model_config: &'a ModelConfig,
    session_id: &'a str,
    output_budget: i32,
}

#[async_trait::async_trait]
impl aegis_context_management::CompactionModel for AegisCompactionModel<'_> {
    async fn complete(
        &self,
        system: &str,
        messages: &[Message],
    ) -> Result<(Message, ProviderUsage), ProviderError> {
        crate::model_config::complete_one_shot(
            self.provider,
            &self
                .model_config
                .clone()
                .with_max_tokens(Some(self.output_budget)),
            self.session_id,
            system,
            messages,
            &[],
        )
        .await
    }
}

struct AegisTokenEstimator {
    counter: crate::token_counter::TokenCounter,
}

#[async_trait::async_trait]
impl aegis_context_management::TokenEstimator for AegisTokenEstimator {
    async fn count_chat_tokens(&self, system: &str, messages: &[Message]) -> usize {
        self.counter.count_chat_tokens(system, messages, &[])
    }

    async fn count_text_tokens(&self, text: &str) -> usize {
        self.counter.count_tokens(text)
    }
}

fn compaction_templates() -> Result<aegis_context_management::Templates> {
    Ok(aegis_context_management::Templates {
        compaction: crate::prompt_template::template_source("compaction.md")?,
        summary: crate::prompt_template::template_source("compaction_summary.md")?,
    })
}

async fn do_compact(
    provider: &dyn Provider,
    model_config: &ModelConfig,
    session_id: &str,
    messages: &[Message],
) -> Result<(Message, ProviderUsage), anyhow::Error> {
    // Keep stale per-turn state out of the summary.
    let agent_visible_messages = Conversation::new_unvalidated(
        messages
            .iter()
            .filter(|msg| !msg.is_turn_context())
            .cloned(),
    )
    .agent_visible_messages();

    let context_limit =
        crate::context_limit::get_context_limit(provider, &model_config.model_name).await?;
    let output_budget = (context_limit / 8).clamp(1_024, 8_192);
    let model = AegisCompactionModel {
        provider,
        model_config,
        session_id,
        output_budget: output_budget as i32,
    };
    let estimator = AegisTokenEstimator {
        counter: create_token_counter().await.map_err(anyhow::Error::msg)?,
    };
    let summary = aegis_context_management::summarize_in_chunks(
        &model,
        &estimator,
        &compaction_templates()?,
        &agent_visible_messages,
        (context_limit * 3 / 5).min(64_000),
        output_budget,
    )
    .await?;

    Ok((summary.message, summary.usage))
}

pub use aegis_context_management::format_message_for_compacting;

pub fn compute_tool_call_cutoff(context_limit: usize, compaction_threshold: f64) -> usize {
    let threshold = if compaction_threshold > 0.0 && compaction_threshold <= 1.0 {
        compaction_threshold
    } else {
        DEFAULT_COMPACTION_THRESHOLD
    };
    let effective_limit = (context_limit as f64 * threshold) as usize;
    (3 * effective_limit / 20_000).clamp(10, 500)
}

pub fn tool_ids_to_summarize(
    conversation: &Conversation,
    cutoff: usize,
    protect_last_n: usize,
) -> Vec<String> {
    tool_ids_to_summarize_limited(
        conversation,
        cutoff,
        protect_last_n,
        TOOLCALL_SUMMARIZATION_BATCH_SIZE,
    )
}

/// Same as [`tool_ids_to_summarize`] but with an explicit cap, so a caller can pull
/// several batches at once and run their summarization calls concurrently.
pub fn tool_ids_to_summarize_limited(
    conversation: &Conversation,
    cutoff: usize,
    protect_last_n: usize,
    limit: usize,
) -> Vec<String> {
    let messages = conversation.messages();

    let mut tool_call_ids: Vec<String> = Vec::new();

    for msg in messages.iter() {
        if !msg.is_agent_visible() {
            continue;
        }

        for content in &msg.content {
            if let MessageContent::ToolRequest(req) = content {
                tool_call_ids.push(req.id.clone());
            }
        }
    }

    // Never summarize the last N tool calls (current turn)
    let eligible = tool_call_ids.len().saturating_sub(protect_last_n);
    if eligible <= cutoff + TOOLCALL_SUMMARIZATION_BATCH_SIZE {
        return Vec::new();
    }

    tool_call_ids
        .into_iter()
        .take(limit.min(eligible - cutoff))
        .collect()
}

fn agent_visible_tool_pair(conversation: &Conversation, tool_id: &str) -> Result<Vec<Message>> {
    let matching_messages = conversation
        .messages()
        .iter()
        .filter(|m| {
            m.content.iter().any(|c| match c {
                MessageContent::ToolRequest(req) => req.id == tool_id,
                MessageContent::ToolResponse(resp) => resp.id == tool_id,
                _ => false,
            })
        })
        .cloned()
        .collect::<Vec<_>>();
    let matching_messages =
        Conversation::new_unvalidated(matching_messages).agent_visible_messages();

    let has_request = matching_messages.iter().any(|message| {
        message.content.iter().any(
            |content| matches!(content, MessageContent::ToolRequest(request) if request.id == tool_id),
        )
    });
    let has_response = matching_messages.iter().any(|message| {
        message.content.iter().any(
            |content| matches!(content, MessageContent::ToolResponse(response) if response.id == tool_id),
        )
    });
    if !has_request || !has_response {
        return Err(anyhow::anyhow!(
            "No agent-visible tool pair found for tool id: {}",
            tool_id
        ));
    }
    Ok(matching_messages)
}

pub async fn summarize_tool_call(
    provider: &dyn Provider,
    model_config: &ModelConfig,
    session_id: &str,
    conversation: &Conversation,
    tool_id: &str,
) -> Result<Message> {
    let matching_messages = agent_visible_tool_pair(conversation, tool_id)?;
    summarize_tool_pair(provider, model_config, session_id, &matching_messages).await
}

/// Summarizes one tool request/response pair that the caller already extracted.
///
/// The pair is passed in (instead of a conversation plus an id) so a detached task can
/// summarize pairs it owns, without borrowing the conversation that is still moving.
pub async fn summarize_tool_pair(
    provider: &dyn Provider,
    model_config: &ModelConfig,
    session_id: &str,
    matching_messages: &[Message],
) -> Result<Message> {
    let formatted = matching_messages
        .iter()
        .map(format_message_for_compacting)
        .collect::<Vec<_>>()
        .join("\n");

    let user_message = Message::user().with_text(formatted);
    let summarization_request = vec![user_message];

    let system_prompt = indoc! {r#"
                Your task is to summarize a tool call & response pair to save tokens.

                Reply with a single message that describes what happened. Typically a tool call
                asks for something using a bunch of parameters and then the result is also some
                structured output. So the tool might ask to look up something on github and the
                reply might be a json document. So you could reply with something like:

                "A call to github was made to get the project status"

                if that is what it was.
            "#};

    let (mut response, usage) = crate::model_config::complete_one_shot(
        provider,
        model_config,
        session_id,
        system_prompt,
        &summarization_request,
        &[],
    )
    .await?;

    response.role = Role::User;
    response.created = matching_messages.last().unwrap().created;
    response.metadata = MessageMetadata::agent_only();
    // The summarization call is billed but leaves no assistant message, which is why the
    // cost of compaction was invisible. Keep its usage on the summary, marked as such.
    response.metadata.usage = Some(Box::new(MessageUsage::from_provider_usage(&usage, true)));

    Ok(response.with_generated_id())
}

/// Summarizes several tool call & response groups with a single model call.
///
/// groups holds, in order, the messages of each pair to compact: normally one
/// request message plus one response message, but a message can carry several
/// parallel tool calls, which is why the unit is the group and not a tool id.
///
/// Returns one summary message per group, in the same order. An error - which
/// includes a reply that does not yield exactly one usable summary per group -
/// tells the caller to fall back to the per-pair path: batching is faster, never
/// authoritative.
pub async fn summarize_tool_call_groups(
    provider: &dyn Provider,
    model_config: &ModelConfig,
    session_id: &str,
    groups: &[Vec<Message>],
) -> Result<Vec<Message>> {
    let count = groups.len();
    if count == 0 {
        return Ok(Vec::new());
    }

    let mut formatted = String::new();
    for (index, group) in groups.iter().enumerate() {
        formatted.push_str(&format!("\n### Pair {}\n", index + 1));
        for message in group {
            formatted.push_str(&format_message_for_compacting(message));
            formatted.push('\n');
        }
    }

    let system_prompt = format!(
        indoc! {r#"
            Your task is to summarize {0} tool call & response pairs to save tokens.

            The message below lists each pair under a heading that reads ### Pair N; reply with
            {0} lines, one per pair, each line starting with a number followed by a period, then
            the summary of that pair - nothing else: no preamble, no headings, no blank lines,
            no commentary.

            Say what each call did. A pair asks for something with parameters and the response is
            usually structured output, so a line such as - A call to github was made to get the project status - is
            the shape we want. Keep the details that are expensive to rediscover - file paths,
            commands, error text, numbers - and drop boilerplate.
        "#},
        count
    );

    let (response, usage) = crate::model_config::complete_one_shot(
        provider,
        model_config,
        session_id,
        &system_prompt,
        &[Message::user().with_text(formatted)],
        &[],
    )
    .await?;

    let summaries =
        parse_numbered_summaries(&response.as_concat_text(), count).ok_or_else(|| {
            anyhow::anyhow!("Batched summarization reply did not map to {count} tool pairs")
        })?;

    Ok(summaries
        .into_iter()
        .enumerate()
        .map(|(index, text)| {
            let mut message = Message::assistant().with_text(text);
            message.role = Role::User;
            if let Some(last) = groups[index].last() {
                message.created = last.created;
            }
            message.metadata = MessageMetadata::agent_only();
            if index == 0 {
                // One call covered the whole batch: book it once, on the first summary.
                message.metadata.usage =
                    Some(Box::new(MessageUsage::from_provider_usage(&usage, true)));
            }
            message.with_generated_id()
        })
        .collect())
}

/// Parses a reply that should hold one numbered summary line per pair.
///
/// Tolerates the punctuation and markdown models drift into (a period, a close
/// paren or a colon after the number), and folds continuation lines into the
/// entry they follow, but insists on exactly expected distinct entries numbered
/// 1..=expected: anything else means the reply cannot be trusted to line up with
/// the pairs.
fn parse_numbered_summaries(reply: &str, expected: usize) -> Option<Vec<String>> {
    if expected == 0 {
        return Some(Vec::new());
    }

    let mut entries: Vec<Option<String>> = vec![None; expected];
    let mut current: Option<usize> = None;
    for raw in reply.lines() {
        let line = raw.trim().trim_start_matches(['*', '-', '#', ' ']).trim();
        if line.is_empty() {
            continue;
        }
        match numbered_prefix(line) {
            Some((number, rest)) => {
                if number == 0 || number > expected || entries[number - 1].is_some() {
                    return None;
                }
                entries[number - 1] = Some(rest.trim().to_string());
                current = Some(number);
            }
            None => match current {
                Some(number) => {
                    if let Some(existing) = entries[number - 1].as_mut() {
                        if !existing.is_empty() {
                            existing.push(' ');
                        }
                        existing.push_str(line);
                    }
                }
                None => return None,
            },
        }
    }

    entries.into_iter().collect()
}

/// Recognizes a number followed by a period, a close paren or a colon at the
/// start of a line, returning the number and the rest of the line.
fn numbered_prefix(line: &str) -> Option<(usize, &str)> {
    let digits = line.len() - line.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    if digits == 0 {
        return None;
    }
    let (number, rest) = line.split_at(digits);
    let rest = rest
        .trim_start()
        .trim_start_matches(['.', ')', ':', '*', '#', '-', ' ']);
    Some((number.parse::<usize>().ok()?, rest))
}

#[cfg(test)]
mod tool_pair_summary_tests {
    use super::parse_numbered_summaries;

    #[test]
    fn parses_one_line_per_pair() {
        let parsed = parse_numbered_summaries(
            "1. A call to shell ran cargo check\n2. read_file read web.ts",
            2,
        );
        assert_eq!(
            parsed,
            Some(vec![
                "A call to shell ran cargo check".to_string(),
                "read_file read web.ts".to_string()
            ])
        );
    }

    #[test]
    fn tolerates_punctuation_and_markdown() {
        let parsed = parse_numbered_summaries("**1.** first\n2) second\n3: third", 3);
        assert_eq!(
            parsed,
            Some(vec![
                "first".to_string(),
                "second".to_string(),
                "third".to_string()
            ])
        );
    }

    #[test]
    fn folds_continuation_lines() {
        let parsed = parse_numbered_summaries("1. first part\ncontinued here\n2. second", 2);
        assert_eq!(
            parsed,
            Some(vec![
                "first part continued here".to_string(),
                "second".to_string()
            ])
        );
    }

    #[test]
    fn rejects_wrong_or_duplicated_counts() {
        assert_eq!(parse_numbered_summaries("1. only one", 2), None);
        assert_eq!(parse_numbered_summaries("1. a\n1. b", 2), None);
        assert_eq!(parse_numbered_summaries("2. b\n3. c", 2), None);
        assert_eq!(parse_numbered_summaries("", 1), None);
        assert_eq!(parse_numbered_summaries("no numbering at all", 1), None);
    }

    #[test]
    fn rejects_a_bare_number_that_is_not_a_marker() {
        // 12 files changed is not pair 12 of 2, so the reply is rejected instead
        // of being mismatched to the pairs.
        assert_eq!(parse_numbered_summaries("12 files changed", 2), None);
    }
}

pub fn maybe_summarize_tool_pairs(
    provider: Arc<dyn Provider>,
    model_config: ModelConfig,
    session_id: String,
    conversation: Conversation,
    cutoff: usize,
    protect_last_n: usize,
) -> Option<JoinHandle<Vec<(Message, String)>>> {
    if !tool_pair_summarization_enabled() || provider.manages_own_context() {
        return None;
    }

    let tool_ids = tool_ids_to_summarize(&conversation, cutoff, protect_last_n);
    if tool_ids.is_empty() {
        return None;
    }

    // A request/response message can contain multiple parallel tool calls.
    // Summarization formats whole messages, so sibling IDs in the same pair
    // must be compacted as one group or we'd issue duplicate summary calls.
    let mut seen_message_pairs = std::collections::HashSet::new();
    let mut grouped_tool_ids = Vec::new();
    for tool_id in tool_ids {
        let pair = match agent_visible_tool_pair(&conversation, &tool_id) {
            Ok(pair) => pair,
            Err(error) => {
                warn!("Failed to identify tool pair for summarization: {}", error);
                continue;
            }
        };
        if pair.len() != 2 {
            warn!(
                "Expected a tool request/response pair for '{}', found {} messages",
                tool_id,
                pair.len()
            );
            continue;
        }

        let request_ids: std::collections::HashSet<&str> = pair
            .iter()
            .flat_map(|message| message.get_tool_request_ids())
            .collect();
        let response_ids: std::collections::HashSet<&str> = pair
            .iter()
            .flat_map(|message| message.get_tool_response_ids())
            .collect();
        if request_ids != response_ids {
            warn!(
                "Tool pair for '{}' has siblings answered elsewhere; skipping",
                tool_id
            );
            continue;
        }

        let mut message_ids = pair
            .iter()
            .filter_map(|message| message.id.clone())
            .collect::<Vec<_>>();
        if message_ids.len() != 2 {
            warn!(
                "Expected two persisted messages for tool pair '{}', found {}",
                tool_id,
                message_ids.len()
            );
            continue;
        }
        message_ids.sort_unstable();
        if seen_message_pairs.insert(message_ids) {
            grouped_tool_ids.push(tool_id);
        }
    }

    if grouped_tool_ids.is_empty() {
        return None;
    }

    Some(tokio::spawn(async move {
        let mut results = Vec::new();
        for tool_id in grouped_tool_ids {
            match summarize_tool_call(
                provider.as_ref(),
                &model_config,
                &session_id,
                &conversation,
                &tool_id,
            )
            .await
            {
                Ok(summary) => results.push((summary, tool_id)),
                Err(e) => {
                    warn!("Failed to summarize tool pair: {}", e);
                }
            }
        }
        results
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aegis_providers::conversation::token_usage::Usage;
    use async_trait::async_trait;
    use rmcp::model::{CallToolRequestParams, Tool};

    fn create_tool_pair(
        call_id: &str,
        response_id: &str,
        tool_name: &str,
        response_text: &str,
    ) -> Vec<Message> {
        vec![
            Message::assistant()
                .with_tool_request(
                    call_id,
                    Ok(CallToolRequestParams::new(tool_name.to_string())),
                )
                .with_id(call_id),
            Message::user()
                .with_tool_response(
                    call_id,
                    Ok(rmcp::model::CallToolResult::success(vec![
                        ContentBlock::text(response_text),
                    ])),
                )
                .with_id(response_id),
        ]
    }

    struct MockProvider {
        message: Message,
        config: ModelConfig,
        max_tool_responses: Option<usize>,
        captured_system: std::sync::Mutex<Option<String>>,
        calls: std::sync::atomic::AtomicUsize,
    }

    impl MockProvider {
        fn new(message: Message, context_limit: usize) -> Self {
            let message =
                if aegis_context_management::StructuredSummary::parse(&message.as_concat_text())
                    .is_some()
                {
                    message
                } else {
                    Message::assistant().with_text(
                        serde_json::json!({"user_intent": [message.as_concat_text()]}).to_string(),
                    )
                };
            Self {
                message,
                config: ModelConfig {
                    model_name: "test".to_string(),
                    context_limit: Some(context_limit),
                    temperature: None,
                    max_tokens: None,
                    toolshim: false,
                    toolshim_model: None,
                    request_params: None,
                    reasoning: None,
                    supports_vision: None,
                    request_headers: None,
                },
                max_tool_responses: None,
                captured_system: std::sync::Mutex::new(None),
                calls: std::sync::atomic::AtomicUsize::new(0),
            }
        }

        fn with_max_tool_responses(mut self, max: usize) -> Self {
            self.max_tool_responses = Some(max);
            self
        }

        fn call_count(&self) -> usize {
            self.calls.load(std::sync::atomic::Ordering::Relaxed)
        }
    }

    #[async_trait]
    impl Provider for MockProvider {
        fn get_name(&self) -> &str {
            "mock"
        }

        async fn stream(
            &self,
            _model_config: &ModelConfig,
            system: &str,
            _messages: &[Message],
            _tools: &[Tool],
        ) -> Result<MessageStream, ProviderError> {
            self.calls
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            *self.captured_system.lock().unwrap() = Some(system.to_string());
            // If max_tool_responses is set, fail if we have too many
            if let Some(max) = self.max_tool_responses {
                let tool_response_count = system.matches("response").count();

                if tool_response_count > max {
                    return Err(ProviderError::ContextLengthExceeded(format!(
                        "Too many tool responses: {} > {}",
                        tool_response_count, max
                    )));
                }
            }

            let message = self.message.clone();
            let usage = ProviderUsage::new("mock-model".to_string(), Usage::default());
            Ok(stream_from_single_message(message, usage))
        }

        async fn get_context_limit(&self, _model: &str, override_limit: Option<usize>) -> usize {
            override_limit.unwrap_or_else(|| self.config.context_limit())
        }
    }

    #[tokio::test]
    async fn test_keeps_tool_request() {
        let response_message = Message::assistant().with_text("<mock summary>");
        let provider = MockProvider::new(response_message, 128_000);
        let basic_conversation = vec![
            Message::user().with_text("read hello.txt"),
            Message::assistant()
                .with_tool_request("tool_0", Ok(CallToolRequestParams::new("read_file"))),
            Message::user().with_tool_response(
                "tool_0",
                Ok(rmcp::model::CallToolResult::success(vec![
                    ContentBlock::text("hello, world"),
                ])),
            ),
        ];

        let conversation = Conversation::new_unvalidated(basic_conversation);
        let model_config = provider.config.clone();
        let compaction = compact_messages(
            &provider,
            &model_config,
            "test-session-id",
            &conversation,
            false,
        )
        .await
        .unwrap();

        let agent_conversation = compaction.conversation.agent_visible_messages();

        let _ = Conversation::new(agent_conversation)
            .expect("compaction should produce a valid conversation");
    }

    #[tokio::test]
    async fn test_structured_summary_is_rendered() {
        let structured_response = r#"<analysis>User asked to fix a bug; I patched parser.rs.</analysis>
```json
{
  "user_intent": ["Fix the parser bug"],
  "files": [{"path": "src/parser.rs", "summary": "Fixed off-by-one"}],
  "pending_tasks": ["Add a regression test"],
  "current_work": "Writing the regression test"
}
```"#;
        let provider =
            MockProvider::new(Message::assistant().with_text(structured_response), 100_000);
        let conversation = Conversation::new_unvalidated(vec![
            Message::user().with_text("fix the parser bug"),
            Message::assistant().with_text("Looking into it"),
        ]);

        let model_config = provider.config.clone();
        let compaction = compact_messages(
            &provider,
            &model_config,
            "test-session-id",
            &conversation,
            true,
        )
        .await
        .unwrap();

        let summary_text = compaction.conversation.agent_visible_messages()[0].as_concat_text();
        assert!(summary_text.contains("# Conversation Summary"));
        assert!(summary_text.contains("## Current User Intent and Constraints"));
        assert!(summary_text.contains("- Fix the parser bug"));
        assert!(summary_text.contains("## Current Work and Verification"));
        assert!(summary_text.contains("## Pending Tasks"));
        assert!(
            summary_text.find("## Pending Tasks").unwrap()
                < summary_text.find("### src/parser.rs").unwrap()
        );
        assert!(summary_text.contains("### src/parser.rs"));
        assert!(
            !summary_text.contains("```json"),
            "raw JSON should be replaced"
        );
        assert!(
            !summary_text.contains("<analysis>"),
            "analysis scratchpad should be dropped"
        );
        assert!(compaction.retained_context_tokens > 0);
        assert!(
            compaction.usage.usage.output_tokens.is_some(),
            "billable output tokens must survive the rewrite"
        );
    }

    #[tokio::test]
    async fn retained_context_counts_preserved_user_message() {
        async fn retained(final_user_text: &str) -> i32 {
            let provider =
                MockProvider::new(Message::assistant().with_text("<mock summary>"), 100_000);
            let conversation = Conversation::new_unvalidated(vec![
                Message::user().with_text("start"),
                Message::assistant().with_text("ok"),
                Message::user().with_text(final_user_text),
            ]);
            let model_config = provider.config.clone();
            compact_messages(
                &provider,
                &model_config,
                "test-session-id",
                &conversation,
                false,
            )
            .await
            .unwrap()
            .retained_context_tokens
        }

        let short = retained("continue").await;
        let long = retained(&"long preserved user message ".repeat(200)).await;
        assert!(
            long > short,
            "the preserved user message must be part of the retained context ({short} vs {long})"
        );
    }

    #[tokio::test]
    async fn preserved_user_message_keeps_audience_projection_after_compaction() {
        let annotated_text = |text: &str, audience| {
            MessageContent::Text(
                TextContent::new(text)
                    .with_annotations(Annotations::default().with_audience(audience)),
            )
        };
        let current_request = Message::user()
            .with_text("visible current request")
            .with_content(annotated_text("user-only secret", vec![Role::User]))
            .with_content(annotated_text(
                "assistant-only preprompt",
                vec![Role::Assistant],
            ));
        let conversation = Conversation::new_unvalidated([
            Message::user().with_text("earlier request"),
            Message::assistant().with_text("earlier response"),
            current_request,
        ]);
        let provider = MockProvider::new(Message::assistant().with_text("summary"), 128_000);

        let compacted = compact_messages(
            &provider,
            &provider.config,
            "test-session-id",
            &conversation,
            false,
        )
        .await
        .unwrap()
        .conversation;

        let preserved_copies = compacted
            .messages()
            .iter()
            .filter(|message| message.as_concat_text().contains("visible current request"))
            .collect::<Vec<_>>();
        assert_eq!(preserved_copies.len(), 2);
        let archived = preserved_copies
            .iter()
            .find(|message| message.is_user_visible())
            .unwrap();
        assert!(!archived.is_agent_visible());
        assert!(archived.as_concat_text().contains("user-only secret"));
        let replay = preserved_copies
            .iter()
            .find(|message| message.is_agent_visible())
            .unwrap();
        assert!(!replay.is_user_visible());
        assert!(replay.as_concat_text().contains("assistant-only preprompt"));
        assert!(!replay.as_concat_text().contains("user-only secret"));

        let agent_text = compacted
            .agent_visible_messages()
            .iter()
            .map(Message::as_concat_text)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(agent_text.contains("visible current request"));
        assert!(agent_text.contains("assistant-only preprompt"));
        assert!(!agent_text.contains("user-only secret"));

        let user_text = compacted
            .user_visible_messages()
            .iter()
            .map(Message::as_concat_text)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(user_text.contains("user-only secret"));
        assert!(!user_text.contains("assistant-only preprompt"));
    }

    #[tokio::test]
    async fn preserved_user_message_skips_turn_context_events() {
        let conversation = Conversation::new_unvalidated([
            Message::user().with_text("earlier request"),
            Message::assistant().with_text("earlier response"),
            Message::user().with_text("the real current request"),
            Message::user()
                .with_text("<turn-context>frozen block</turn-context>")
                .with_metadata(MessageMetadata::agent_only().with_turn_context()),
        ]);
        let provider = MockProvider::new(Message::assistant().with_text("summary"), 128_000);

        let compacted = compact_messages(
            &provider,
            &provider.config,
            "test-session-id",
            &conversation,
            false,
        )
        .await
        .unwrap()
        .conversation;

        let preserved: Vec<_> = compacted
            .messages()
            .iter()
            .filter(|message| message.is_agent_visible() && message.role == Role::User)
            .collect();
        let turn_context_events: Vec<_> = preserved
            .iter()
            .filter(|message| message.is_turn_context())
            .collect();
        let [carried_block] = turn_context_events.as_slice() else {
            panic!("expected exactly one carried turn-context event");
        };
        assert!(
            carried_block.as_concat_text().contains("frozen block"),
            "the turn's context event must be carried forward for the mid-turn retry"
        );
        let last = compacted.messages().last().unwrap();
        assert!(
            last.is_turn_context() && last.is_agent_visible(),
            "the carried event must trail the preserved user message"
        );
        let user_prompt = preserved[preserved.len() - 2];
        assert!(
            user_prompt
                .as_concat_text()
                .contains("the real current request"),
            "the user's prompt must survive compaction verbatim"
        );
        assert!(!user_prompt.is_turn_context());

        let continuation = compacted
            .messages()
            .iter()
            .find(|message| message.role == Role::Assistant && message.is_agent_visible())
            .unwrap()
            .as_concat_text();
        assert!(
            continuation.contains(CONVERSATION_CONTINUATION_TEXT),
            "a trailing turn-context event must not demote the compaction to a tool-loop continuation"
        );
    }

    #[tokio::test]
    async fn stale_turn_context_from_an_earlier_turn_is_not_carried() {
        let conversation = Conversation::new_unvalidated([
            Message::user().with_text("earlier request"),
            Message::user()
                .with_text("<turn-context>stale block</turn-context>")
                .with_metadata(MessageMetadata::agent_only().with_turn_context()),
            Message::assistant().with_text("earlier response"),
            Message::user().with_text("the new prompt"),
        ]);
        let provider = MockProvider::new(Message::assistant().with_text("summary"), 128_000);

        let compacted = compact_messages(
            &provider,
            &provider.config,
            "test-session-id",
            &conversation,
            false,
        )
        .await
        .unwrap()
        .conversation;

        assert!(
            !compacted
                .messages()
                .iter()
                .any(|message| message.is_agent_visible() && message.is_turn_context()),
            "pre-turn compaction must not resurrect a previous turn's context event"
        );
        let last = compacted.messages().last().unwrap();
        assert_eq!(last.as_concat_text(), "the new prompt");
    }

    #[tokio::test]
    async fn recent_literal_tail_survives_storage_reload_without_duplicate_user_prompt() {
        let provider = MockProvider::new(Message::assistant().with_text("older summary"), 128_000);
        let mut archived = Message::user().with_text("ancient evidence");
        archived.created -= 3600;
        let mut response = Message::assistant().with_text("ancient answer");
        response.created -= 3600;
        let conversation = Conversation::new_unvalidated([
            archived,
            response,
            Message::user().with_text("recent exact request 🦀"),
        ]);
        let compacted = compact_messages(
            &provider,
            &provider.config,
            "test-session-id",
            &conversation,
            false,
        )
        .await
        .unwrap()
        .conversation;
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = crate::session::SessionManager::new(temp_dir.path().to_path_buf());
        let session = manager
            .create_session(
                temp_dir.path().to_path_buf(),
                "literal tail".to_string(),
                crate::session::session_manager::SessionType::User,
                crate::config::AegisMode::default(),
            )
            .await
            .unwrap();
        manager
            .replace_conversation(&session.id, &compacted)
            .await
            .unwrap();
        let stored = manager
            .get_session(&session.id, true)
            .await
            .unwrap()
            .conversation
            .unwrap();
        let visible = stored.agent_visible_messages();
        assert!(visible[0].as_concat_text().contains("older summary"));
        assert_eq!(
            visible
                .iter()
                .filter(|message| message.as_concat_text().contains("recent exact request 🦀"))
                .count(),
            1
        );
        assert_eq!(
            visible.last().unwrap().as_concat_text(),
            "recent exact request 🦀"
        );
        assert!(stored.messages().iter().any(|message| {
            message.as_concat_text().contains("ancient evidence") && !message.is_agent_visible()
        }));
    }

    #[tokio::test]
    async fn carried_turn_context_stays_last_after_persist_and_reload() {
        let provider = MockProvider::new(Message::assistant().with_text("summary"), 128_000);
        let mut prompt = Message::user().with_text("the real current request");
        prompt.created -= 3600;
        let mut block = Message::user()
            .with_text("<turn-context>frozen block</turn-context>")
            .with_metadata(MessageMetadata::agent_only().with_turn_context());
        block.created -= 3600;
        let conversation = Conversation::new_unvalidated([prompt, block]);

        let compacted = compact_messages(
            &provider,
            &provider.config,
            "test-session-id",
            &conversation,
            false,
        )
        .await
        .unwrap()
        .conversation;
        assert!(compacted.messages().last().unwrap().is_turn_context());

        let temp_dir = tempfile::tempdir().unwrap();
        let manager = crate::session::SessionManager::new(temp_dir.path().to_path_buf());
        let session = manager
            .create_session(
                std::path::PathBuf::from("/tmp/test"),
                "carry order".to_string(),
                crate::session::session_manager::SessionType::User,
                crate::config::AegisMode::default(),
            )
            .await
            .unwrap();
        manager
            .replace_conversation(&session.id, &compacted)
            .await
            .unwrap();

        let reloaded = manager
            .get_session(&session.id, true)
            .await
            .unwrap()
            .conversation
            .unwrap();
        assert_eq!(reloaded.messages().len(), compacted.messages().len());
        let last = reloaded.messages().last().unwrap();
        assert!(
            last.is_turn_context(),
            "the carried event must not resurface at its original timestamp on reload"
        );
    }

    #[tokio::test]
    async fn summarizer_input_excludes_turn_context_events() {
        let provider = MockProvider::new(Message::assistant().with_text("summary"), 128_000);
        let turn_context = |text: &str| {
            Message::user()
                .with_text(text)
                .with_metadata(MessageMetadata::agent_only().with_turn_context())
        };
        let conversation = Conversation::new_unvalidated([
            Message::user().with_text("please refactor the parser"),
            turn_context("<turn-context>cwd /old/dir</turn-context>"),
            Message::assistant().with_text("working on it"),
            turn_context("<turn-context>cwd /new/dir</turn-context>"),
        ]);

        let compacted = compact_messages(
            &provider,
            &provider.config,
            "test-session-id",
            &conversation,
            false,
        )
        .await
        .unwrap()
        .conversation;

        let system = provider.captured_system.lock().unwrap().clone().unwrap();
        assert!(system.contains("please refactor the parser"));
        assert!(
            !system.contains("/old/dir") && !system.contains("/new/dir"),
            "turn-context events must not reach the summarizer as dialogue"
        );

        let carried = compacted.messages().last().unwrap();
        assert!(
            carried.is_turn_context() && carried.as_concat_text().contains("/new/dir"),
            "the newest turn-context event must still be carried forward"
        );
    }

    #[tokio::test]
    async fn tool_pair_summary_projects_nested_audiences_before_provider_input() {
        let provider = MockProvider::new(Message::assistant().with_text("summary"), 128_000);
        let conversation =
            Conversation::new_unvalidated([
                Message::assistant()
                    .with_tool_request("tool_0", Ok(CallToolRequestParams::new("read_file"))),
                Message::user().with_tool_response(
                    "tool_0",
                    Ok(rmcp::model::CallToolResult::success(vec![
                        ContentBlock::text("visible result"),
                        ContentBlock::Text(TextContent::new("user-only secret").with_annotations(
                            Annotations::default().with_audience(vec![Role::User]),
                        )),
                    ])),
                ),
            ]);

        let projected = agent_visible_tool_pair(&conversation, "tool_0").unwrap();
        let formatted = projected
            .iter()
            .map(format_message_for_compacting)
            .collect::<Vec<_>>()
            .join("\n");

        assert!(formatted.contains("visible result"));
        assert!(!formatted.contains("user-only secret"));

        let user_only_conversation =
            Conversation::new_unvalidated([
                Message::assistant()
                    .with_tool_request("tool_1", Ok(CallToolRequestParams::new("read_file"))),
                Message::user().with_tool_response(
                    "tool_1",
                    Ok(rmcp::model::CallToolResult::success(vec![
                        ContentBlock::Text(TextContent::new("user-only secret").with_annotations(
                            Annotations::default().with_audience(vec![Role::User]),
                        )),
                    ])),
                ),
            ]);
        let user_only_formatted = agent_visible_tool_pair(&user_only_conversation, "tool_1")
            .unwrap()
            .iter()
            .map(format_message_for_compacting)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!user_only_formatted.contains("user-only secret"));

        summarize_tool_call(
            &provider,
            &provider.config,
            "test-session-id",
            &conversation,
            "tool_0",
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn tool_pair_summary_rejects_agent_hidden_response() {
        let provider = MockProvider::new(Message::assistant().with_text("summary"), 128_000);
        let conversation = Conversation::new_unvalidated([
            Message::assistant()
                .with_tool_request("tool_0", Ok(CallToolRequestParams::new("read_file"))),
            Message::user()
                .with_tool_response(
                    "tool_0",
                    Ok(rmcp::model::CallToolResult::success(vec![
                        ContentBlock::text("user-only secret"),
                    ])),
                )
                .with_metadata(MessageMetadata::user_only()),
        ]);

        let error = summarize_tool_call(
            &provider,
            &provider.config,
            "test-session-id",
            &conversation,
            "tool_0",
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("No agent-visible tool pair"));
    }

    #[tokio::test]
    async fn parallel_tool_calls_share_one_summary_request() {
        let _guard = env_lock::lock_env([("AEGIS_TOOL_PAIR_SUMMARIZATION", Some("true"))]);
        let provider = Arc::new(MockProvider::new(
            Message::assistant().with_text("summary"),
            1000,
        ));
        let mut messages = vec![Message::user().with_text("start")];
        for index in 0..7 {
            let first_id = format!("tool_{index}a");
            let second_id = format!("tool_{index}b");
            messages.push(
                Message::assistant()
                    .with_tool_request(&first_id, Ok(CallToolRequestParams::new("read_file")))
                    .with_tool_request(&second_id, Ok(CallToolRequestParams::new("read_file")))
                    .with_id(format!("request_{index}")),
            );
            messages.push(
                Message::user()
                    .with_tool_response(
                        &first_id,
                        Ok(rmcp::model::CallToolResult::success(vec![
                            ContentBlock::text("first result"),
                        ])),
                    )
                    .with_tool_response(
                        &second_id,
                        Ok(rmcp::model::CallToolResult::success(vec![
                            ContentBlock::text("second result"),
                        ])),
                    )
                    .with_id(format!("response_{index}")),
            );
        }

        let conversation = Conversation::new_unvalidated(messages);
        let summaries = maybe_summarize_tool_pairs(
            provider.clone(),
            provider.config.clone(),
            "test-session-id".to_string(),
            conversation,
            2,
            0,
        )
        .unwrap()
        .await
        .unwrap();

        assert_eq!(summaries.len(), 5);
        assert_eq!(provider.call_count(), 5);
    }

    #[tokio::test]
    async fn test_provider_overflow_does_not_silently_drop_tool_responses() {
        let response_message = Message::assistant().with_text("<mock summary>");
        let provider = MockProvider::new(response_message, 128_000).with_max_tool_responses(0);

        // Create a conversation with many tool responses
        let mut messages = vec![Message::user().with_text("start")];
        for i in 0..10 {
            messages.push(Message::assistant().with_tool_request(
                format!("tool_{}", i),
                Ok(CallToolRequestParams::new("read_file")),
            ));
            messages.push(Message::user().with_tool_response(
                format!("tool_{}", i),
                Ok(rmcp::model::CallToolResult::success(vec![
                    ContentBlock::text(format!("response{}", i)),
                ])),
            ));
        }

        let conversation = Conversation::new_unvalidated(messages);
        let model_config = provider.config.clone();
        let result = compact_messages(
            &provider,
            &model_config,
            "test-session-id",
            &conversation,
            false,
        )
        .await;

        assert!(
            result.is_err(),
            "provider refused an unsplittable tool response"
        );
        assert!(
            conversation
                .messages()
                .iter()
                .filter(|m| m.is_tool_response())
                .count()
                == 10
        );
    }

    #[test]
    fn test_compute_tool_call_cutoff_scales_with_context() {
        // Default threshold (0.8)
        assert_eq!(compute_tool_call_cutoff(128_000, 0.8), 15); // 102K effective
        assert_eq!(compute_tool_call_cutoff(200_000, 0.8), 24); // 160K effective
        assert_eq!(compute_tool_call_cutoff(1_000_000, 0.8), 120); // 800K effective
                                                                   // Clamp at minimum
        assert_eq!(compute_tool_call_cutoff(50_000, 0.8), 10);
        assert_eq!(compute_tool_call_cutoff(10_000, 0.8), 10);
        // Clamp at maximum (500)
        assert_eq!(compute_tool_call_cutoff(10_000_000, 0.8), 500);
        // Lower compaction threshold means earlier summarization
        assert_eq!(compute_tool_call_cutoff(200_000, 0.3), 10); // 60K effective
        assert_eq!(compute_tool_call_cutoff(1_000_000, 0.5), 75); // 500K effective
                                                                  // Invalid threshold falls back to default 0.8
        assert_eq!(compute_tool_call_cutoff(200_000, 0.0), 24); // falls back to 0.8
        assert_eq!(compute_tool_call_cutoff(200_000, -1.0), 24); // falls back to 0.8
    }

    #[test]
    fn test_tool_ids_to_summarize_triggers_at_cutoff_plus_batch() {
        // cutoff=5, so we need >5+10=15 to trigger. 15 exactly should NOT trigger.
        let mut messages = vec![Message::user().with_text("hello")];
        for i in 0..15 {
            messages.extend(create_tool_pair(
                &format!("call{}", i),
                &format!("resp{}", i),
                "read_file",
                "content",
            ));
        }
        let conversation = Conversation::new_unvalidated(messages);
        let result = tool_ids_to_summarize(&conversation, 5, 0);
        assert!(result.is_empty(), "Exactly cutoff+batch should not trigger");

        // 16 tool calls: now exceeds cutoff+10, should return a batch of 10
        let mut messages = vec![Message::user().with_text("hello")];
        for i in 0..16 {
            messages.extend(create_tool_pair(
                &format!("call{}", i),
                &format!("resp{}", i),
                "read_file",
                "content",
            ));
        }
        let conversation = Conversation::new_unvalidated(messages);
        let result = tool_ids_to_summarize(&conversation, 5, 0);
        assert_eq!(result.len(), TOOLCALL_SUMMARIZATION_BATCH_SIZE);
        assert_eq!(result[0], "call0");
        assert_eq!(result[9], "call9");
    }

    #[test]
    fn test_tool_ids_to_summarize_protects_current_turn() {
        // 20 tool pairs, cutoff=2 → 20 > 12, would normally trigger
        let mut messages = vec![Message::user().with_text("hello")];
        for i in 0..20 {
            messages.extend(create_tool_pair(
                &format!("call{}", i),
                &format!("resp{}", i),
                "read_file",
                "content",
            ));
        }
        let conversation = Conversation::new_unvalidated(messages);

        // No protection: 20 eligible, 20 > 12 → batch of 10
        let result = tool_ids_to_summarize(&conversation, 2, 0);
        assert_eq!(result.len(), TOOLCALL_SUMMARIZATION_BATCH_SIZE);

        // Protect last 8: 12 eligible, 12 <= 12 → nothing
        let result = tool_ids_to_summarize(&conversation, 2, 8);
        assert!(
            result.is_empty(),
            "Should not summarize when protected count leaves eligible <= cutoff + batch"
        );

        // Protect last 7: 13 eligible, 13 > 12 → batch of 10
        let result = tool_ids_to_summarize(&conversation, 2, 7);
        assert_eq!(result.len(), TOOLCALL_SUMMARIZATION_BATCH_SIZE);
        assert_eq!(result[0], "call0");
    }
}

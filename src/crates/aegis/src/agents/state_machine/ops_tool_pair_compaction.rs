//! Replaces one batch of old tool request and response pairs with compact summaries.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use async_trait::async_trait;
use tracing_futures::Instrument;

use crate::agents::state_machine::ops_llm::chat_span;
use crate::agents::state_machine::{
    applied, messages_since_kickoff, not_applicable, AegisEffect, ConversationEffect, Emitter,
    Operation, OperationResult,
};
use crate::config::Config;
use crate::context_mgmt::{
    summarize_tool_call_groups, summarize_tool_pair, tool_ids_to_summarize_limited,
    TOOLCALL_SUMMARIZATION_BATCH_SIZE,
};
use crate::conversation::message::{Message, MessageContent, SystemNotificationType};
use crate::conversation::Conversation;
use crate::providers::base::Provider;
use crate::session::Session;
use aegis_providers::model::ModelConfig;

/// Summarization work in flight. The model calls run detached from the turn so the user
/// message reaches the model right away; the effects are built only when the result is
/// collected, on a later pass. A task that is never collected costs nothing: the pairs stay
/// untouched and eligible for the next turn.
struct PendingCompaction {
    handle: tokio::task::JoinHandle<PendingOutcome>,
    groups: Vec<(String, Vec<Message>)>,
    kickoff_id: String,
}

struct PendingOutcome {
    summaries: Vec<Option<Message>>,
}

/// Detached part: several batches (chunks of ten) in flight at once, and one call per pair
/// for whatever a batched reply could not cover. The pair is owned here, so this runs
/// without borrowing the conversation that keeps moving.
async fn summarize_detached(
    provider: Arc<dyn Provider>,
    model_config: ModelConfig,
    session_id: String,
    groups: Vec<(String, Vec<Message>)>,
) -> PendingOutcome {
    let group_messages: Vec<Vec<Message>> = groups.iter().map(|(_, pair)| pair.clone()).collect();
    let mut summaries: Vec<Option<Message>> = Vec::with_capacity(group_messages.len());
    let mut batched = false;
    if group_messages.len() > 1 {
        let chunks: Vec<Vec<Vec<Message>>> = group_messages
            .chunks(TOOLCALL_SUMMARIZATION_BATCH_SIZE)
            .map(|chunk| chunk.to_vec())
            .collect();
        let results = futures::future::join_all(chunks.iter().map(|chunk| {
            summarize_tool_call_groups(provider.as_ref(), &model_config, &session_id, chunk)
        }))
        .await;
        let mut all_ok = true;
        for (chunk, result) in chunks.iter().zip(results) {
            match result {
                Ok(messages) if messages.len() == chunk.len() => {
                    summaries.extend(messages.into_iter().map(Some));
                }
                Ok(messages) => {
                    tracing::warn!(
                        "Batched tool pair summarization returned {} summaries for {} groups;
                         falling back to one call per pair",
                        messages.len(),
                        chunk.len()
                    );
                    all_ok = false;
                    break;
                }
                Err(e) => {
                    tracing::warn!(
                        "Batched tool pair summarization failed ({}); falling back to one call per pair",
                        format!("{e:#}")
                    );
                    all_ok = false;
                    break;
                }
            }
        }
        batched = all_ok;
        if !batched {
            summaries.clear();
        }
    }
    if !batched {
        summaries.clear();
        for (_, pair) in groups.iter() {
            let span = chat_span(
                provider.as_ref(),
                &model_config,
                &session_id,
                "tool_pair_compaction",
            );
            match summarize_tool_pair(provider.as_ref(), &model_config, &session_id, pair)
                .instrument(span.clone())
                .await
            {
                Ok(summary) => summaries.push(Some(summary)),
                Err(e) => {
                    span.record("error.type", "tool_pair_compaction_error");
                    tracing::warn!("Failed to summarize tool pair: {e}");
                    summaries.push(None);
                }
            }
        }
    }
    PendingOutcome { summaries }
}

pub struct SessionPending {
    provider: Arc<dyn Provider>,
    model_key: String,
    pending: PendingCompaction,
}

pub type PendingToolPairCompactions = Arc<Mutex<HashMap<String, SessionPending>>>;

pub(crate) fn cancel_pending_compaction(pending: &PendingToolPairCompactions, session_id: &str) {
    if let Some(entry) = pending.lock().unwrap().remove(session_id) {
        entry.pending.handle.abort();
    }
}

#[cfg(test)]
pub(crate) async fn wait_for_pending_compaction(
    pending: &PendingToolPairCompactions,
    session_id: &str,
) -> Result<()> {
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            let finished = pending
                .lock()
                .unwrap()
                .get(session_id)
                .is_some_and(|entry| entry.pending.handle.is_finished());
            if finished {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .map_err(|_| anyhow::anyhow!("timed out waiting for detached tool pair summary"))
}

pub struct ToolPairCompactionOperation {
    provider: Arc<dyn Provider>,
    model_config: ModelConfig,
    cutoff: usize,
    enabled: bool,
    min_usage_tokens: usize,
    pending: PendingToolPairCompactions,
}

impl ToolPairCompactionOperation {
    pub fn new(
        provider: Arc<dyn Provider>,
        model_config: ModelConfig,
        cutoff: usize,
        enabled: bool,
        min_usage_tokens: usize,
        pending: PendingToolPairCompactions,
    ) -> Self {
        Self {
            provider,
            model_config,
            cutoff,
            enabled,
            min_usage_tokens,
            pending,
        }
    }

    fn apply_summaries(
        conversation: &Conversation,
        groups: Vec<(String, Vec<Message>)>,
        summaries: Vec<Option<Message>>,
    ) -> (usize, Vec<AegisEffect>) {
        let mut effects = Vec::new();
        let mut summarized = 0;
        for ((_, pair), summary) in groups.into_iter().zip(summaries) {
            let Some(summary) = summary else { continue };
            if !pair.iter().all(|original| {
                original.id.as_ref().is_some_and(|id| {
                    conversation.messages().iter().any(|current| {
                        current.id.as_ref() == Some(id)
                            && current.is_agent_visible()
                            && current.role == original.role
                            && current.content == original.content
                    })
                })
            }) {
                continue;
            }
            let request_ids: std::collections::HashSet<&str> = pair
                .iter()
                .flat_map(Message::get_tool_request_ids)
                .collect();
            let matching_count = conversation
                .messages()
                .iter()
                .filter(|message| {
                    message.content.iter().any(|content| match content {
                        MessageContent::ToolRequest(request) => {
                            request_ids.contains(request.id.as_str())
                        }
                        MessageContent::ToolResponse(response) => {
                            request_ids.contains(response.id.as_str())
                        }
                        _ => false,
                    })
                })
                .count();
            if matching_count != pair.len() {
                continue;
            }
            summarized += 1;
            for message in pair {
                effects.push(
                    ConversationEffect::SetMessageVisibility {
                        message_id: message.id.clone().expect("selected pair has an id"),
                        user_visible: message.is_user_visible(),
                        agent_visible: false,
                    }
                    .into(),
                );
            }
            effects.push(summary.into());
        }
        (summarized, effects)
    }
}

#[async_trait]
impl Operation<Session, AegisEffect> for ToolPairCompactionOperation {
    fn name(&self) -> &'static str {
        "tool_pair_compaction"
    }

    async fn run(
        &self,
        session: &Session,
        conversation: &Conversation,
        emit: &Emitter,
    ) -> Result<OperationResult<AegisEffect>> {
        if !self.enabled {
            cancel_pending_compaction(&self.pending, &session.id);
            return not_applicable();
        }

        let turn = messages_since_kickoff(conversation)?;
        let kickoff_id = turn
            .first()
            .and_then(|message| message.id.as_ref())
            .ok_or_else(|| anyhow::anyhow!("turn kickoff has no message id"))?;
        let model_key = serde_json::to_string(&self.model_config)?;
        let pending = {
            let mut entries = self.pending.lock().unwrap();
            if entries.get(&session.id).is_some_and(|entry| {
                !Arc::ptr_eq(&entry.provider, &self.provider) || entry.model_key != model_key
            }) {
                if let Some(entry) = entries.remove(&session.id) {
                    entry.pending.handle.abort();
                }
            }
            if let Some(entry) = entries.get(&session.id) {
                if entry.pending.kickoff_id == *kickoff_id || !entry.pending.handle.is_finished() {
                    return not_applicable();
                }
            }
            entries.remove(&session.id).map(|entry| entry.pending)
        };
        if let Some(PendingCompaction { handle, groups, .. }) = pending {
            match handle.await {
                Ok(outcome) => {
                    let (summarized, effects) =
                        Self::apply_summaries(conversation, groups, outcome.summaries);
                    if summarized > 0 {
                        emit.message(Message::assistant().with_system_notification(
                            SystemNotificationType::ProgressMessage,
                            format!(
                                "Compacted {summarized} old tool call {}.",
                                if summarized == 1 { "pair" } else { "pairs" }
                            ),
                        ));
                        return applied(effects);
                    }
                }
                Err(error) => tracing::warn!("Tool pair compaction task failed: {error}"),
            }
            return not_applicable();
        }
        // Lazy gate: only compact once the context is actually approaching the compaction
        // trigger (see AEGIS_TOOL_PAIR_COMPACT_MIN_RATIO). 0 = always compact.
        if self.min_usage_tokens > 0 {
            let used = session.usage.total_tokens.unwrap_or(0).max(0) as usize;
            if used < self.min_usage_tokens {
                return not_applicable();
            }
        }

        let protected = messages_since_kickoff(conversation)?
            .iter()
            .flat_map(|message| &message.content)
            .filter(|content| matches!(content, MessageContent::ToolRequest(_)))
            .count();
        // Several batches are pulled at once and their calls run concurrently: they are
        // independent one-shot completions, so N in flight cut the wait without touching
        // the order of the effects applied below.
        let concurrency = Config::global()
            .get_param::<usize>("AEGIS_TOOL_PAIR_COMPACT_CONCURRENCY")
            .unwrap_or(4)
            .clamp(1, 8);
        let eligible_before_turn = conversation
            .messages()
            .iter()
            .take_while(|message| message.id.as_deref() != Some(kickoff_id.as_str()))
            .filter(|message| message.is_agent_visible())
            .flat_map(|message| &message.content)
            .filter(|content| matches!(content, MessageContent::ToolRequest(_)))
            .count();
        let eligible = eligible_before_turn.saturating_sub(self.cutoff);
        let limit = (TOOLCALL_SUMMARIZATION_BATCH_SIZE * concurrency).min(eligible);
        let tool_ids = tool_ids_to_summarize_limited(conversation, self.cutoff, protected, limit);
        if tool_ids.is_empty() {
            return not_applicable();
        }

        let mut hidden_messages: std::collections::HashSet<String> = Default::default();
        let mut groups: Vec<(String, Vec<Message>)> = Vec::new();
        for tool_id in tool_ids {
            let pair: Vec<_> = conversation
                .messages()
                .iter()
                .filter(|message| {
                    message.id.is_some()
                        && message.content.iter().any(|content| match content {
                            MessageContent::ToolRequest(request) => request.id == tool_id,
                            MessageContent::ToolResponse(response) => response.id == tool_id,
                            _ => false,
                        })
                })
                .collect();
            if pair
                .iter()
                .any(|message| turn.iter().any(|current| current.id == message.id))
            {
                continue;
            }
            if pair.len() != 2 {
                tracing::warn!(
                    "Expected a tool request/response pair for {} , found {} messages",
                    tool_id,
                    pair.len()
                );
                continue;
            }

            // A message can carry several tool calls (parallel requests, and
            // the execution op batches a turn's responses into one message).
            // Hiding is per message, so the pair is summarized as a group: the
            // summary formats both messages wholesale, covering every sibling
            // call - which then must not be summarized (or hidden) again.
            if pair.iter().any(|message| {
                message
                    .id
                    .as_ref()
                    .is_some_and(|id| hidden_messages.contains(id))
            }) {
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
                tracing::warn!(
                    "Tool pair for {} has siblings answered elsewhere; skipping",
                    tool_id
                );
                continue;
            }

            for message in &pair {
                if let Some(message_id) = message.id.clone() {
                    hidden_messages.insert(message_id);
                }
            }
            groups.push((tool_id, pair.into_iter().cloned().collect()));
        }

        if groups.is_empty() {
            return not_applicable();
        }

        // The calls go out detached: the user message reaches the model right away and the
        // summaries are applied on a later pass, when this op collects the finished task.
        let batch = groups.len();
        emit.message(Message::assistant().with_system_notification(
            SystemNotificationType::ProgressMessage,
            format!(
                "Compacting {batch} old tool call {} in the background; your message goes through now.",
                if batch == 1 { "pair" } else { "pairs" }
            ),
        ));
        let groups_for_task = groups.clone();
        let provider = Arc::clone(&self.provider);
        let model_config = self.model_config.clone();
        let session_id = session.id.clone();
        let handle = tokio::spawn(async move {
            summarize_detached(provider, model_config, session_id, groups_for_task).await
        });
        self.pending.lock().unwrap().insert(
            session.id.clone(),
            SessionPending {
                provider: Arc::clone(&self.provider),
                model_key,
                pending: PendingCompaction {
                    handle,
                    groups,
                    kickoff_id: kickoff_id.clone(),
                },
            },
        );
        not_applicable()
    }
}

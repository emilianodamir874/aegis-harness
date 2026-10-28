//! Compacts conversation history when it is too large for the configured context window.

use std::sync::Arc;

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use tracing_futures::Instrument;

use crate::agents::final_output_tool::FinalOutputTool;
use crate::agents::state_machine::ops_llm::{chat_span, record_chat_usage};
use crate::agents::state_machine::{
    applied, awaits_tool_responses, last_effective_role, messages_since_kickoff, not_applicable,
    trailing_error, yielded, yielded_with, AegisEffect, ConversationEffect, Emitter, Operation,
    OperationResult, SlashCommand,
};
use crate::context_mgmt::{compact_messages, count_context_tokens};
use crate::conversation::message::{Message, MessageErrorKind, SystemNotificationType};
use crate::conversation::{Conversation, EffectiveRole};
use crate::providers::base::Provider;
use crate::session::extension_data::ExtensionState;
use crate::session::{CompactRequestState, Session, SessionManager};
use aegis_providers::model::ModelConfig;

const COMPACTION_THINKING_TEXT: &str = "aegis is compacting the conversation...";

pub(super) const MAX_CONTEXT_ERROR_COMPACTIONS: usize = 2;

fn compaction_part(
    total_tokens: Option<i32>,
    context_limit: usize,
    threshold: f64,
) -> Option<String> {
    let total_tokens = total_tokens?;
    if total_tokens <= 0 || context_limit == 0 || threshold <= 0.0 || threshold >= 1.0 {
        return None;
    }

    let compaction_at = (context_limit as f64 * threshold) as i32;
    if compaction_at <= 0 || (total_tokens as f64 / compaction_at as f64) < 0.5 {
        return None;
    }

    Some(format!(
        "<compaction>~{}k tokens remaining</compaction>",
        compaction_at.saturating_sub(total_tokens) / 1000
    ))
}

/// Reported usage stops at the inference that requested the tools, so the
/// results that answered it are not counted until the next request.
async fn unreported_tool_tokens(conversation: &Conversation) -> Result<i32> {
    let messages = conversation.messages();
    if last_effective_role(messages)? != EffectiveRole::Tool {
        return Ok(0);
    }
    let after_request = messages
        .iter()
        .rposition(Message::is_tool_call)
        .map_or(0, |index| index + 1);
    count_context_tokens(&messages[after_request..]).await
}

pub struct CompactionOperation {
    provider: Arc<dyn Provider>,
    model_config: ModelConfig,
    context_limit: usize,
    threshold: f64,
    manages_own_context: bool,
    /// Para apagar la marca que deja la tool `compact_context` (los tests corren sin store).
    session_manager: Option<Arc<SessionManager>>,
}

impl CompactionOperation {
    pub fn new(
        provider: Arc<dyn Provider>,
        model_config: ModelConfig,
        context_limit: usize,
        threshold: f64,
    ) -> Self {
        let manages_own_context = provider.manages_own_context();
        Self {
            provider,
            model_config,
            context_limit,
            threshold,
            manages_own_context,
            session_manager: None,
        }
    }

    /// Sin esto la marca del pedido no se puede apagar; la compactacion en si no lo necesita.
    pub fn with_session_manager(mut self, session_manager: Arc<SessionManager>) -> Self {
        self.session_manager = Some(session_manager);
        self
    }

    /// `true` si el modelo pidio compactar con la tool `compact_context` en este turno.
    fn compact_requested(&self, session: &Session) -> bool {
        CompactRequestState::from_extension_data(&session.extension_data)
            .map(|state| state.is_pending())
            .unwrap_or(false)
    }

    /// Consume la marca: sin esto el pedido se repetiria en cada turno.
    async fn clear_compact_request(&self, session_id: &str) {
        let Some(session_manager) = self.session_manager.as_ref() else {
            return;
        };
        let cleared = CompactRequestState::default();
        if let Err(error) = session_manager
            .set_extension_state(session_id, &cleared)
            .await
        {
            tracing::warn!("compaction: no se pudo apagar el pedido de la tool: {error:#}");
        }
    }

    fn over_threshold(&self, tokens: usize) -> bool {
        if self.threshold <= 0.0 || self.threshold >= 1.0 {
            return false;
        }
        (tokens as f64 / self.context_limit as f64) > self.threshold
    }

    /// `session.usage` reports the last inference's tokens, so it describes the
    /// prompt that inference saw and nothing that arrived after it: during a tool
    /// loop it stays small while the history the next request will carry is
    /// already over the ceiling, and it is absent when the provider reports no
    /// usage at all. The agent visible history is what gets sent, so the count is
    /// the floor and a larger report can only raise it.
    async fn context_tokens(&self, session: &Session, conversation: &Conversation) -> Result<i32> {
        let counted = count_context_tokens(conversation.messages()).await?;
        match session.usage.total_tokens {
            Some(tokens) => Ok(tokens
                .saturating_add(unreported_tool_tokens(conversation).await?)
                .max(counted)),
            None => Ok(counted),
        }
    }

    fn command_error(
        conversation: &Conversation,
        message: String,
        emit: &Emitter,
    ) -> Result<OperationResult<AegisEffect>> {
        let command = messages_since_kickoff(conversation)?
            .first()
            .cloned()
            .ok_or_else(|| anyhow!("compact command conversation has no kickoff message"))?;
        let message_id = command
            .id
            .clone()
            .ok_or_else(|| anyhow!("Persisted slash command message has no id"))?;
        let command = command.with_visibility(true, false);
        let response = Message::assistant()
            .with_text(message)
            .with_visibility(true, false);
        emit.message(command);
        let response = emit.message(response);
        yielded_with([
            ConversationEffect::SetMessageVisibility {
                message_id,
                user_visible: true,
                agent_visible: false,
            }
            .into(),
            response.into(),
        ])
    }

    fn clear(conversation: &Conversation, emit: &Emitter) -> Result<OperationResult<AegisEffect>> {
        let command = messages_since_kickoff(conversation)?
            .first()
            .cloned()
            .ok_or_else(|| anyhow!("clear command conversation has no kickoff message"))?
            .with_visibility(true, false);
        let response = Message::assistant()
            .with_text("Conversation cleared")
            .with_visibility(true, false);
        let command = emit.message(command);
        let response = emit.message(response);
        yielded_with([
            Conversation::default().into(),
            command.into(),
            response.into(),
        ])
    }
}

#[async_trait]
impl Operation<Session, AegisEffect> for CompactionOperation {
    fn name(&self) -> &'static str {
        "compaction"
    }

    async fn run_command(
        &self,
        command: &SlashCommand<'_>,
        session: &Session,
        conversation: &Conversation,
        emit: &Emitter,
    ) -> Result<OperationResult<AegisEffect>> {
        match command.command {
            "clear" => return Self::clear(conversation, emit),
            "compact" => {}
            _ => return not_applicable(),
        }

        let span = chat_span(
            self.provider.as_ref(),
            &self.model_config,
            &session.id,
            "compaction",
        );
        let result = match compact_messages(
            self.provider.as_ref(),
            &self.model_config,
            &session.id,
            conversation,
            true,
        )
        .instrument(span.clone())
        .await
        {
            Ok(result) => result,
            Err(error) => {
                span.record("error.type", "compaction_error");
                return Self::command_error(conversation, format!("{error:#}"), emit);
            }
        };
        let compacted = result.conversation;
        let usage = result.usage;
        record_chat_usage(&span, &usage);

        let command = messages_since_kickoff(conversation)?
            .first()
            .cloned()
            .ok_or_else(|| anyhow!("compact command conversation has no kickoff message"))?
            .with_visibility(true, false);
        let response = Message::assistant()
            .with_text("Compaction complete")
            .with_visibility(true, false);
        emit.message(command);
        let response = emit.message(response);
        yielded_with([
            AegisEffect::CompactConversation {
                conversation: compacted,
                usage: Some(usage),
            },
            response.into(),
        ])
    }

    async fn moim_parts(
        &self,
        session: &Session,
        conversation: &Conversation,
    ) -> Result<Vec<String>> {
        if self.manages_own_context {
            return Ok(Vec::new());
        }
        Ok(compaction_part(
            Some(self.context_tokens(session, conversation).await?),
            self.context_limit,
            self.threshold,
        )
        .into_iter()
        .collect())
    }

    async fn run(
        &self,
        session: &Session,
        conversation: &Conversation,
        emit: &Emitter,
    ) -> Result<OperationResult<AegisEffect>> {
        if self.manages_own_context {
            tracing::debug!("compaction: el provider maneja su propio contexto, no aplica");
            return not_applicable();
        }

        // Un pedido explicito del modelo (tool `compact_context`) compacta ahora: no tiene sentido
        // hacerlo esperar al umbral cuando ya sabe que va a necesitar la ventana.
        let requested_by_tool = self.compact_requested(session);
        let messages = messages_since_kickoff(conversation)?;
        let reactive_context_error = matches!(
            trailing_error(conversation),
            Some(MessageErrorKind::ContextLengthExceeded)
        );

        if reactive_context_error {
            let context_errors = messages
                .iter()
                .filter(|message| {
                    message.error_kind() == Some(MessageErrorKind::ContextLengthExceeded)
                        && !message.is_agent_visible()
                })
                .count();
            if context_errors > MAX_CONTEXT_ERROR_COMPACTIONS {
                return not_applicable();
            }
        } else {
            // Compact only ahead of an inference. An assistant tail ends the turn or
            // awaits tool responses, hiding an unanswered request orphans its result,
            // and RecipeOperation delivers a successful final output from a tool tail.
            let tail = last_effective_role(messages)?;
            // Con un pedido explicito se compacta aunque el turno espere el resultado de una tool:
            // `compact_context` ya respondio y lo que sigue es la inferencia que necesita la ventana.
            if !requested_by_tool
                && (tail == EffectiveRole::Assistant
                    || awaits_tool_responses(messages)
                    || (tail == EffectiveRole::Tool
                        && FinalOutputTool::successful_output(messages).is_some()))
            {
                return not_applicable();
            }
            let tokens = self.context_tokens(session, conversation).await?;
            tracing::debug!(
                tokens,
                limite = self.context_limit,
                threshold = self.threshold,
                total_reportado = ?session.usage.total_tokens,
                "compaction: evaluando umbral"
            );
            if !requested_by_tool && (tokens <= 0 || !self.over_threshold(tokens as usize)) {
                return not_applicable();
            }
        }

        let conversation_with_hidden_error;
        let conversation = if reactive_context_error {
            let mut messages = conversation.messages().to_vec();
            let Some(last) = messages.last_mut() else {
                return not_applicable();
            };
            last.metadata.agent_visible = false;
            conversation_with_hidden_error = Conversation::new_unvalidated(messages);
            &conversation_with_hidden_error
        } else {
            conversation
        };

        let threshold_k_tokens = (self.context_limit as f64 * self.threshold / 1000.0) as usize;
        emit.message(Message::assistant().with_system_notification(
            SystemNotificationType::InlineMessage,
            if requested_by_tool {
                "El modelo pidi├ö├Â┬ú├ö├Â├® compactar. Compactando el contexto...".to_string()
            } else {
                format!(
                    "Exceeded auto-compact threshold of {threshold_k_tokens}k tokens. \
                         Performing auto-compaction..."
                )
            },
        ));
        emit.message(Message::assistant().with_system_notification(
            SystemNotificationType::ThinkingMessage,
            COMPACTION_THINKING_TEXT,
        ));

        let span = chat_span(
            self.provider.as_ref(),
            &self.model_config,
            &session.id,
            "compaction",
        );
        match compact_messages(
            self.provider.as_ref(),
            &self.model_config,
            &session.id,
            conversation,
            false,
        )
        .instrument(span.clone())
        .await
        {
            Ok(result) => {
                if requested_by_tool {
                    self.clear_compact_request(&session.id).await;
                }
                let compacted = result.conversation;
                let usage = result.usage;
                record_chat_usage(&span, &usage);
                emit.message(Message::assistant().with_system_notification(
                    SystemNotificationType::InlineMessage,
                    "Compaction complete",
                ));
                applied([AegisEffect::CompactConversation {
                    conversation: compacted,
                    usage: Some(usage),
                }])
            }
            Err(e) => {
                span.record("error.type", "compaction_error");
                // The whole chain, not just the outermost label: a bare
                // "Compaction stage 1 batch 6..7" told nobody anything.
                let details = format!("{e:#}");
                tracing::warn!(error = %details, "Compaction failed; original context preserved");
                emit.message(Message::assistant().with_text(format!(
                    "Ran into this error trying to compact: {details}.\n\n\
                     Please try again or create a new session"
                )));
                yielded()
            }
        }
    }
}

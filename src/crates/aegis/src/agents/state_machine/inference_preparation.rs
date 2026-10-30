//! Aegis-specific inference request preparation.

use crate::agents::extension_manager::{ExtensionLease, ExtensionManager};
use crate::agents::state_machine::awaits_tool_responses;
use crate::agents::PromptManager;
use crate::config::permission::{PermissionLevel, PermissionManager};
use crate::config::AegisMode;
use crate::session::Session;
use crate::tool_inspection::ToolInspectionManager;
use aegis_agent::inference::{InferenceRequestPreparer, PreparedInferenceRequest};
use aegis_agent::operation::{messages_since_kickoff, InferenceInput};
use aegis_providers::conversation::message::Message;
use aegis_providers::conversation::Conversation;
use anyhow::Result;
use async_trait::async_trait;
use std::sync::{Arc, Mutex as StdMutex};

pub struct AegisInferenceRequestPreparer<'a> {
    pub(crate) extension_manager: Arc<ExtensionManager>,
    pub(crate) extension_lease: Arc<StdMutex<Option<Arc<ExtensionLease>>>>,
    pub(crate) tool_inspection_manager: &'a ToolInspectionManager,
    pub(crate) permission_manager: Arc<PermissionManager>,
    pub(crate) context_limit: usize,
}

/// Saca del set las tools que la sesion tiene en `never_allow`. No es cosmetico: un modo plan que
/// solo bloquea deja al modelo gastando el turno intentando escribir; sin la tool en el set, ni lo
/// intenta. El nombre puede venir con prefijo de extension, por eso se consulta la variante tolerante.
pub fn filter_denied_tools(
    tools: Vec<rmcp::model::Tool>,
    denied: impl Fn(&str) -> bool,
) -> Vec<rmcp::model::Tool> {
    tools
        .into_iter()
        .filter(|tool| !denied(tool.name.as_ref()))
        .collect()
}

#[async_trait]
impl InferenceRequestPreparer<Session> for AegisInferenceRequestPreparer<'_> {
    async fn prepare_session(&self, session: &Session) -> Result<Option<Session>> {
        let (session, lease) = self
            .extension_manager
            .current_session_snapshot(session)
            .await?;
        // Tool requests run under the lease of the inference that made them, so an
        // approval answered after that lease is gone expires instead of picking up a new one.
        let awaiting = match &session.conversation {
            Some(conversation) => awaits_tool_responses(messages_since_kickoff(conversation)?),
            None => false,
        };
        if !awaiting {
            *self
                .extension_lease
                .lock()
                .expect("extension lease unavailable") = Some(Arc::new(lease));
        }
        Ok(Some(session))
    }

    async fn prepare(
        &self,
        session: &Session,
        conversation: &Conversation,
        input: InferenceInput,
    ) -> Result<PreparedInferenceRequest> {
        let aegis_mode = session.aegis_mode;
        if aegis_mode == AegisMode::SmartApprove {
            self.tool_inspection_manager
                .apply_tool_annotations(&input.tools);
        }
        let session_id = session.id.to_string();
        let tools_libres = filter_denied_tools(input.tools, |name| {
            self.permission_manager
                .session_permission_for_tool(&session_id, name)
                == Some(PermissionLevel::NeverAllow)
        });
        let tools = crate::agents::reply_parts::prepare_inference_tools(tools_libres);
        let system_prompt =
            PromptManager::new().build_system_prompt(session, input.prompt_parts, aegis_mode);
        let turn = messages_since_kickoff(conversation)?;
        let turn_start = turn
            .first()
            .and_then(|message| chrono::DateTime::from_timestamp(message.created, 0))
            .map(|timestamp| timestamp.with_timezone(&chrono::Local))
            .unwrap_or_else(chrono::Local::now);
        let last = turn
            .iter()
            .rev()
            .find(|message| message.is_turn_context())
            .map(Message::as_concat_text);
        let context_limit = Some(self.context_limit);
        let additional_messages = crate::agents::moim::turn_context_event(
            &session.working_dir,
            context_limit,
            input.moim_parts,
            turn_start,
        )
        .filter(|event| Some(event.as_concat_text()) != last)
        .into_iter()
        .collect();
        Ok(PreparedInferenceRequest {
            system_prompt,
            tools,
            additional_messages,
        })
    }
}

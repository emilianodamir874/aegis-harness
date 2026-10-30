//! Ends a turn that ran past its tool-call ceiling or its wall-clock budget.
//!
//! `MaxTurnsOperation` bounds a turn at `AEGIS_MAX_TURNS` assistant turns, 1000 by
//! default. That is far above what a runaway turn costs: the two harness cases that
//! explore without closing (C13, C21 in `evals/harness`) burned 900-1200 s each and
//! were ended by the eval timeout, never by the engine. The turn budget is a
//! different quantity than the turn count — 40 tool calls of 20 KB are two assistant
//! turns — so this operation bounds the work itself, not the number of inferences.
//!
//! Rules are read from config when the machine is built:
//!
//! - `AEGIS_TURN_TOOL_CALL_LIMIT` (0 = off): tool calls allowed per turn.
//! - `AEGIS_TURN_DEADLINE_SECONDS` (0 = off): wall-clock budget per turn, measured
//!   from the kickoff message's `created` timestamp so it survives a restart.
//!
//! Both are ceilings with a forced closure: the operation emits a message that says
//! what was reached, which keeps the work done so far and hands the decision back to
//! the operator instead of leaving the turn open.

use crate::agents::state_machine::effects::AegisEffect;
use crate::agents::state_machine::{
    messages_since_kickoff, not_applicable, yielded_with, Emitter, Operation, OperationResult,
};
use crate::conversation::message::{Message, MessageContent};
use crate::conversation::Conversation;
use crate::session::Session;
use anyhow::Result;
use async_trait::async_trait;
use chrono::Utc;

/// Tool calls allowed in one turn when the config sets no ceiling.
///
/// The heaviest harness case that closes on its own (C9) uses ~30. 120 leaves room
/// for a real editing session and still ends an exploration loop inside two minutes
/// of model time instead of fifteen.
pub const DEFAULT_TOOL_CALL_LIMIT: u32 = 120;

/// Seconds a turn may run when the config sets no deadline. Zero disables the rule,
/// which is the default: a wall clock cannot tell an agent waiting on a slow tool
/// from one that is looping, so it is opt-in per workspace.
pub const DEFAULT_TURN_DEADLINE_SECONDS: u64 = 0;

/// The model is told the ceiling is near at this fraction, so it can close by
/// itself instead of being cut mid-plan.
const WARN_AT_FRACTION: u32 = 2; // warn once `used * WARN_AT_FRACTION >= limit`

pub struct TurnCeilingOperation {
    tool_call_limit: u32,
    deadline_seconds: u64,
}

pub fn turn_tool_call_limit() -> u32 {
    crate::config::Config::global()
        .get_param::<u32>("AEGIS_TURN_TOOL_CALL_LIMIT")
        .unwrap_or(DEFAULT_TOOL_CALL_LIMIT)
}

pub fn turn_deadline_seconds() -> u64 {
    crate::config::Config::global()
        .get_param::<u64>("AEGIS_TURN_DEADLINE_SECONDS")
        .unwrap_or(DEFAULT_TURN_DEADLINE_SECONDS)
}

impl TurnCeilingOperation {
    pub fn new(tool_call_limit: u32, deadline_seconds: u64) -> Self {
        Self {
            tool_call_limit,
            deadline_seconds,
        }
    }

    fn enabled(&self) -> bool {
        self.tool_call_limit > 0 || self.deadline_seconds > 0
    }
}

fn tool_call_count(messages: &[Message]) -> u32 {
    messages
        .iter()
        .flat_map(|message| &message.content)
        .filter_map(MessageContent::as_tool_request)
        .count() as u32
}

fn ceiling_message(reason: &str, progress: &str) -> Message {
    Message::assistant().with_text(format!(
        "Stopped: this turn reached its {reason}. {progress} \
         The work done so far is kept. Ask me to continue and I will pick it up from here."
    ))
}

#[async_trait]
impl Operation<Session, AegisEffect> for TurnCeilingOperation {
    fn name(&self) -> &'static str {
        "turn_ceiling"
    }

    async fn moim_parts(
        &self,
        _session: &Session,
        conversation: &Conversation,
    ) -> Result<Vec<String>> {
        if !self.enabled() {
            return Ok(Vec::new());
        }
        let messages = messages_since_kickoff(conversation)?;
        let used = tool_call_count(messages);
        if self.tool_call_limit == 0
            || used == 0
            || used.saturating_mul(WARN_AT_FRACTION) < self.tool_call_limit
        {
            return Ok(Vec::new());
        }
        Ok(vec![format!(
            "<turn-ceiling>{used}/{} tool calls used</turn-ceiling>",
            self.tool_call_limit
        )])
    }

    async fn run(
        &self,
        _session: &Session,
        conversation: &Conversation,
        emit: &Emitter,
    ) -> Result<OperationResult<AegisEffect>> {
        if !self.enabled() {
            return not_applicable();
        }
        let messages = messages_since_kickoff(conversation)?;
        let used = tool_call_count(messages);

        if self.tool_call_limit > 0 && used >= self.tool_call_limit {
            let message = ceiling_message(
                &format!(
                    "tool-call ceiling ({used} calls, limit {})",
                    self.tool_call_limit
                ),
                "",
            );
            let message = emit.message(message);
            return yielded_with([message.into()]);
        }

        if self.deadline_seconds > 0 {
            if let Some(kickoff) = messages.first() {
                let elapsed = Utc::now().timestamp().saturating_sub(kickoff.created);
                if elapsed >= 0 && elapsed as u64 >= self.deadline_seconds {
                    let message = ceiling_message(
                        &format!("time budget ({elapsed} s, limit {})", self.deadline_seconds),
                        &format!("It ran {used} tool calls before I stopped it.").to_string(),
                    );
                    let message = emit.message(message);
                    return yielded_with([message.into()]);
                }
            }
        }

        not_applicable()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conversation::Conversation;
    use rmcp::model::CallToolRequestParams;

    fn tool_call(id: &str) -> Message {
        let mut params = CallToolRequestParams::default();
        params.name = "shell".into();
        Message::assistant().with_tool_request(id, Ok(params))
    }

    fn turn(tool_calls: usize) -> Conversation {
        let mut messages = vec![Message::user().with_text("explorá el repo")];
        for index in 0..tool_calls {
            messages.push(tool_call(&format!("call-{index}")));
        }
        Conversation::new_unvalidated(messages)
    }

    fn emitter() -> (
        Emitter,
        tokio::sync::mpsc::UnboundedReceiver<crate::agents::AgentEvent>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        (
            Emitter::new(tx, tokio_util::sync::CancellationToken::new()),
            rx,
        )
    }

    fn set_kickoff_age(conversation: &mut Conversation, seconds: i64) {
        conversation.messages_mut()[0].created = Utc::now().timestamp() - seconds;
    }

    fn yielded(result: &OperationResult<AegisEffect>) -> bool {
        matches!(
            result,
            OperationResult::Applied(step) if step.status == crate::agents::state_machine::RunStatus::Yielded
        )
    }

    fn text_of(result: OperationResult<AegisEffect>) -> String {
        match result {
            OperationResult::Applied(step) => step
                .effects
                .into_iter()
                .filter_map(|effect| match effect {
                    AegisEffect::Conversation(
                        crate::agents::state_machine::ConversationEffect::AppendMessage(message),
                    ) => Some(message.as_concat_text()),
                    _ => None,
                })
                .collect(),
            OperationResult::NotApplicable => String::new(),
        }
    }

    #[tokio::test]
    async fn a_turn_below_the_ceiling_is_left_alone() -> Result<()> {
        let operation = TurnCeilingOperation::new(3, 0);
        let (emit, _rx) = emitter();
        let result = operation.run(&Session::default(), &turn(2), &emit).await?;
        assert!(!yielded(&result), "two calls against a ceiling of three");
        Ok(())
    }

    #[tokio::test]
    async fn the_ceiling_closes_the_turn_and_says_what_was_reached() -> Result<()> {
        let operation = TurnCeilingOperation::new(3, 0);
        let (emit, _rx) = emitter();
        let result = operation.run(&Session::default(), &turn(3), &emit).await?;
        assert!(yielded(&result));
        let text = text_of(result);
        assert!(
            text.contains("tool-call ceiling (3 calls, limit 3)"),
            "{text}"
        );
        Ok(())
    }

    #[tokio::test]
    async fn the_model_is_warned_before_the_ceiling() -> Result<()> {
        let operation = TurnCeilingOperation::new(4, 0);
        let session = Session::default();
        assert!(operation.moim_parts(&session, &turn(1)).await?.is_empty());
        let warning = operation.moim_parts(&session, &turn(2)).await?;
        assert_eq!(
            warning,
            vec!["<turn-ceiling>2/4 tool calls used</turn-ceiling>"]
        );
        Ok(())
    }

    #[tokio::test]
    async fn the_deadline_closes_a_turn_that_ran_too_long() -> Result<()> {
        let operation = TurnCeilingOperation::new(0, 60);
        let (emit, _rx) = emitter();
        let mut conversation = turn(2);
        set_kickoff_age(&mut conversation, 120);

        let result = operation
            .run(&Session::default(), &conversation, &emit)
            .await?;
        assert!(yielded(&result));
        let text = text_of(result);
        assert!(text.contains("time budget"), "{text}");
        Ok(())
    }

    #[tokio::test]
    async fn disabled_rules_never_fire() -> Result<()> {
        let operation = TurnCeilingOperation::new(0, 0);
        let (emit, _rx) = emitter();
        let mut conversation = turn(500);
        set_kickoff_age(&mut conversation, 86_400);
        let result = operation
            .run(&Session::default(), &conversation, &emit)
            .await?;
        assert!(!yielded(&result));
        assert!(operation
            .moim_parts(&Session::default(), &conversation)
            .await?
            .is_empty());
        Ok(())
    }
}
